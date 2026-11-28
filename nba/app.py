"""
app.py — Python glue for nba/index.html, run by py-worker.js.

Calls the real fetch_lines_nba.py and PE_NBA.py that the page loaded from the
private repo (no engine code lives in this public repo) and hands plain JSON
back to the page.

On the Mac, two read-only commands give the same fingerprints the phone shows, to
check a phone fetch or run against a Mac one on the same files:
    python3 app.py summary ~/Downloads/OddsAPI_NBA_*_<date>_<time>.csv
    python3 app.py fp ~/Desktop/PropEdge ~/Desktop/PropEdge/NBA_Edge_*_<date>_<time>.csv
fetch() and run() refuse to run outside the browser (they clear ~/Downloads).
"""
import contextlib
import glob
import hashlib
import io
import json
import os
import re
import sys
import time
import traceback

HOME = os.path.expanduser('~')
DOWNLOADS = os.path.join(HOME, 'Downloads')


def summarize(paths):
    """Rows and a short fingerprint of each OddsAPI CSV (row order ignored)."""
    import pandas as pd
    out = []
    for p in sorted(paths):
        name = os.path.basename(p)
        df = pd.read_csv(p)
        rows = sorted('|'.join(str(v) for v in r) for r in df.itertuples(index=False, name=None))
        out.append({'name': name, 'platform': name.split('_')[2], 'rows': len(df),
                    'fp': hashlib.sha256('\n'.join(rows).encode()).hexdigest()[:12]})
    return out


def _browser_only():
    # fetch() and run() empty ~/Downloads first. In the browser that's Pyodide's own
    # throwaway file system; on a Mac it would be the real Downloads folder.
    if sys.platform != 'emscripten':
        raise RuntimeError('app.fetch() / app.run() only run in the browser: they clear ~/Downloads.')


def fetch(key, base_url=''):
    """Run fetch_lines_nba.py as on the Mac; return its CSVs, summary and output."""
    _browser_only()
    import fetch_lines_nba as F
    for p in glob.glob(os.path.join(DOWNLOADS, 'OddsAPI_NBA_*.csv')):
        os.remove(p)
    if base_url:                       # local test on the Mac only: a mock Odds API
        F.BASE_URL = base_url
    key_file = os.path.join(HOME, 'odds_api_key.txt')   # the fetcher reads it from the cwd
    with open(key_file, 'w') as fh:
        fh.write(key)
    os.chdir(HOME)
    sys.argv = ['fetch_lines_nba.py']
    log, code, t0 = io.StringIO(), 0, time.time()
    try:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            try:
                F.main()
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
            except Exception:
                traceback.print_exc()
                code = 1
    finally:
        os.remove(key_file)

    text = log.getvalue()
    paths = glob.glob(os.path.join(DOWNLOADS, 'OddsAPI_NBA_*.csv'))
    files = {}
    for p in paths:
        with open(p) as fh:
            files[os.path.basename(p)] = fh.read()
    left = re.search(r'API credits remaining: (\S+)', text)
    games = re.search(r'(\d+) games on (\d{4}-\d\d-\d\d)', text)
    return json.dumps({
        'code': code, 'secs': round(time.time() - t0, 1), 'log': text[-20000:],
        'files': files, 'summary': summarize(paths),
        'remaining': left.group(1) if left else None,
        'games': int(games.group(1)) if games else None,
        'slate': games.group(2) if games else None,
    })


ANSI = re.compile(r'\x1b\[[0-9;]*m')
_results = None      # last run's plays (the NBA_Edge CSVs read back), for views()
TEAM_CANON = {'GS': 'GSW', 'NO': 'NOP', 'NY': 'NYK', 'SA': 'SAS', 'WSH': 'WAS',
              'UTAH': 'UTA', 'PHO': 'PHX'}   # same as pe_nba_web.py


def _write(name, text, when):
    path = os.path.join(DOWNLOADS, name)
    with open(path, 'w') as fh:
        fh.write(text)
    os.utime(path, (when, when))   # the engine picks files by modified time


def _clean(v):
    """JSON-safe: numpy scalars to Python, NaN to None."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if hasattr(v, 'item') and not isinstance(v, (str, bytes)):
        v = v.item()
    if isinstance(v, float) and v != v:
        return None
    return v


def run(inputs_json):
    """
    `PE_NBA.py all N` as on the Mac: SaberSim files (N = how many) and the fetched
    lines go into ~/Downloads with their real times, the engine writes its
    NBA_Edge CSVs, and they're read back the way pe_nba_web.py reads them.
    inputs: {'sabersim': [{name, at (ms), text}], 'lines': {name: text}, 'lines_at': ms}
    """
    _browser_only()
    import importlib
    import pandas as pd
    import PE_NBA
    importlib.reload(PE_NBA)            # a fresh engine each run, like a new process
    inp = json.loads(inputs_json)
    os.makedirs(DOWNLOADS, exist_ok=True)
    for p in glob.glob(os.path.join(DOWNLOADS, '*')):
        os.remove(p)
    for f in inp['sabersim']:
        name = f['name'] if f['name'].startswith('NBA_') else 'NBA_' + f['name']
        _write(name, f['text'], f['at'] / 1000)
    for name, text in inp['lines'].items():
        _write(name, text, inp['lines_at'] / 1000)
    engine_dir = os.path.dirname(PE_NBA.__file__)
    for p in glob.glob(os.path.join(engine_dir, 'NBA_Edge_*.csv')):
        os.remove(p)

    n = len(inp['sabersim'])
    sys.argv = ['PE_NBA.py', 'all', str(n)]
    log, t0 = io.StringIO(), time.time()
    with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        try:
            PE_NBA.main()
        except SystemExit:
            pass
        except Exception:
            traceback.print_exc()
    text = ANSI.sub('', log.getvalue())[-60000:]

    files = sorted(glob.glob(os.path.join(engine_dir, 'NBA_Edge_*.csv')))
    if not files:
        problems = [ln.strip() for ln in text.splitlines() if ln.strip().startswith(('❌', '⚠️'))]
        return json.dumps({'ok': False, 'log': text,
                           'error': ' '.join(problems[-3:]) or 'The engine wrote no plays.'})
    global _results
    res = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    res['Inj Flag'] = res['Inj Flag'].fillna('')   # same as pe_nba_web.py
    _results = res
    out = {
        'ok': True, 'log': text, 'secs': round(time.time() - t0, 2), 'n': n,
        'platforms': sorted({os.path.basename(f).split('_')[2] for f in files}),
        'dates': sorted(str(d) for d in res['Date'].dropna().unique()),
        'games': int(res['Game'].nunique()),
        # each game's two team codes, for matching ESPN's scoreboard (tip times, started games)
        'matchups': sorted({tuple(sorted((str(t), str(o))))
                            for t, o in zip(res['Team'], res['Opp']) if pd.notna(t) and pd.notna(o)}),
        'const': {'hi': PE_NBA.REC_HIGHLIGHT_WIN_RATE, 'per_game': PE_NBA.LINEUP_MAX_PER_GAME,
                  'slip': PE_NBA.SLIP_SIZE, 'warning': PE_NBA.REC_SAMPLE_WARNING},
    }
    out.update(json.loads(views()))
    return json.dumps(_clean(out))


def _canon(t):
    return TEAM_CANON.get(str(t), str(t))


def views(started_json='[]'):
    """
    Lineups, leftovers, Pick6 check list and promos from the last run, built by the
    engine's own functions (as pe_nba_web.py does). started: team codes whose game
    has tipped; those games are left out and the lineups rebuilt without them.
    """
    import PE_NBA
    started = {_canon(t) for t in json.loads(started_json)}
    res = _results
    if started:
        keep = [_canon(t) not in started and _canon(o) not in started
                for t, o in zip(res['Team'], res['Opp'])]
        res = res[keep].reset_index(drop=True)
    qualifying, by_platform, leftovers = PE_NBA.recommended_lineups(res)
    checklist = PE_NBA.pick6_checklist_rows(res)
    promos = res[res['Promo'] == True].sort_values('Raw Edge %', ascending=False)

    def play(p):
        return {'plt': PE_NBA.PLT_SHORT.get(p['Platform'], p['Platform']), 'player': p['Player'],
                'team': p.get('Team'), 'opp': p.get('Opp'), 'side': p['Side'], 'stat': p['Stat'],
                'line': p['Line'], 'proj': p['SS Proj'],
                'min': PE_NBA._fmt_min(p.get('Min')) + ('b' if PE_NBA.is_bench(p) else ''),
                'gap': p['Raw Edge %'], 'win': p['_win_rate'], 'band': str(p['_wr_src']),
                'inj': str(p.get('Inj Flag') or '')}

    def check(e):
        return {'tag': e['_tag'], 'player': e['Player'], 'team': e.get('Team'), 'opp': e.get('Opp'),
                'stat': e['Stat'], 'pp': e['PP'], 'ud': e['UD'], 'need': e['_need'],
                'proj': e['SS Proj'], 'min': PE_NBA._fmt_min(e.get('Min')),
                'win': e['_win_rate'], 'band': str(e['_wr_src'])}

    def promo(p):
        return {'player': p['Player'], 'team': p.get('Team'), 'opp': p.get('Opp'), 'side': p['Side'],
                'stat': p['Stat'], 'line': p['Line'], 'proj': p['SS Proj'], 'gap': p['Raw Edge %'],
                'inj': str(p.get('Inj Flag') or '')}

    return json.dumps(_clean({
        'left_out': len(_results) - len(res),
        'n_qualifying': len(qualifying),
        'lineups': [[plat, [[play(p) for p in lu] for lu in lus]] for plat, lus in by_platform],
        'leftovers': [play(p) for p in leftovers],
        'checklist': [check(e) for e in checklist],
        'promos': [promo(p) for p in promos.to_dict('records')],
        'fp': _fingerprints(res, by_platform, leftovers, checklist),
    }))


def _fingerprints(res, by_platform, leftovers, checklist):
    """Short hashes of the plays, lineups, leftovers and check list, so a phone run can be
    checked against a Mac run (`python3 app.py fp …`)."""
    import pandas as pd

    def fp(text):
        return hashlib.sha256(text.encode()).hexdigest()[:12]

    def line(v):
        try:
            return f"{float(v):.1f}"
        except (TypeError, ValueError):
            return '-'

    def play(p):
        return f"{p['Player']}|{p['Stat']}|{p['Side']}|{line(p['Line'])}"

    cols = ['Platform', 'Player', 'Stat', 'Side', 'Line', 'SS Proj', 'Raw Edge %', 'Min', 'Inj Flag']
    plays = res[cols].copy()
    for c in ['Line', 'SS Proj', 'Raw Edge %', 'Min']:
        plays[c] = pd.to_numeric(plays[c], errors='coerce').round(3)
    plays = plays.sort_values(cols[:5]).to_csv(index=False)
    lineups = '\n'.join(f"{plat} {i}: " + ' / '.join(play(p) for p in lu)
                        for plat, lus in by_platform for i, lu in enumerate(lus, 1))
    left = '\n'.join(f"{p['Platform']}: {play(p)}" for p in leftovers)
    check = '\n'.join(f"{e['_tag']}|{e['Player']}|{e['Stat']}|need {line(e['_need'])}" for e in checklist)
    return {'plays': fp(plays), 'lineups': fp(lineups), 'leftovers': fp(left), 'checklist': fp(check)}


def fp_from_csvs(engine_dir, paths):
    """Fingerprints of a finished Mac run's NBA_Edge CSVs (read-only), to compare with the
    'fingerprints' line at the end of the phone's run output."""
    import pandas as pd
    sys.dont_write_bytecode = True
    sys.path.insert(0, engine_dir)
    import PE_NBA
    res = pd.concat([pd.read_csv(p) for p in sorted(paths)], ignore_index=True)
    res['Inj Flag'] = res['Inj Flag'].fillna('')
    _, by_platform, leftovers = PE_NBA.recommended_lineups(res)
    return _fingerprints(res, by_platform, leftovers, PE_NBA.pick6_checklist_rows(res))


if __name__ == '__main__':
    if sys.argv[1:2] == ['summary']:
        print(json.dumps(summarize(sys.argv[2:]), indent=1))
    elif sys.argv[1:2] == ['fp'] and len(sys.argv) > 3:
        print(json.dumps(fp_from_csvs(sys.argv[2], sys.argv[3:])))
    else:
        print(__doc__)
