"""
harness.py — Pyodide phone test for the NBA engine (nba-test/index.html).

Runs the engine file the phone loaded (never stored in this public repo) on the
CSVs in ~/Downloads, the way `PE_NBA.py all 1` runs on the Mac, then rebuilds
the lineups and the Pick6 check list the way the Mac's web page does. Returns
timings, counts and short fingerprints of the plays, lineups, leftovers and
check list. The Mac runs this same file on the same CSVs to make the reference
fingerprints, so a match means the phone shows the same plays as the Mac.
"""
import contextlib
import glob
import hashlib
import importlib
import io
import os
import platform
import sys
import time


def _fp(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def _line(v):
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return '-'


def _play(p):
    return f"{p['Player']}|{p['Stat']}|{p['Side']}|{_line(p['Line'])}"


def run(engine_dir, ss_count=1):
    import numpy as np
    import pandas as pd

    t0 = time.time()
    if engine_dir not in sys.path:
        sys.path.insert(0, engine_dir)
    import PE_NBA
    importlib.reload(PE_NBA)
    for f in glob.glob(os.path.join(engine_dir, 'NBA_Edge_*.csv')):
        os.remove(f)
    sys.argv = ['PE_NBA.py', 'all', str(ss_count)]
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        PE_NBA.main()
    t_engine = time.time() - t0

    files = sorted(glob.glob(os.path.join(engine_dir, 'NBA_Edge_*.csv')))
    if not files:
        return {'ok': False, 'error': 'The engine wrote no NBA_Edge CSV.',
                'log': log.getvalue()[-20000:]}
    res = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    res['Inj Flag'] = res['Inj Flag'].fillna('')   # same as pe_nba_web.py

    t1 = time.time()
    _, by_platform, leftovers = PE_NBA.recommended_lineups(res)
    checklist = PE_NBA.pick6_checklist_rows(res)
    t_views = time.time() - t1

    cols = ['Platform', 'Player', 'Stat', 'Side', 'Line', 'SS Proj', 'Raw Edge %', 'Min', 'Inj Flag']
    plays = res[cols].copy()
    for c in ['Line', 'SS Proj', 'Raw Edge %', 'Min']:
        plays[c] = pd.to_numeric(plays[c], errors='coerce').round(3)
    plays = plays.sort_values(cols[:5]).to_csv(index=False)
    lineups = '\n'.join(f"{plat} {i}: " + ' / '.join(_play(p) for p in lineup)
                        for plat, ls in by_platform for i, lineup in enumerate(ls, 1))
    left = '\n'.join(f"{p['Platform']}: {_play(p)}" for p in leftovers)
    check = '\n'.join(f"{e['_tag']}|{e['Player']}|{e['Stat']}|need {_line(e['_need'])}"
                      for e in checklist)

    version = next((ln.split(':', 1)[1].strip() for ln in open(PE_NBA.__file__)
                    if ln.startswith('# Version:')), '?')
    return {
        'ok': True,
        'engine_version': version,
        'python': platform.python_version(), 'pandas': pd.__version__, 'numpy': np.__version__,
        't_engine': round(t_engine, 2), 't_views': round(t_views, 2),
        'plays': {k: int(v) for k, v in res['Platform'].value_counts().sort_index().items()},
        'lineups': {plat: len(ls) for plat, ls in by_platform},
        'n_leftovers': len(leftovers), 'n_checklist': len(checklist),
        'fp': {'plays': _fp(plays), 'lineups': _fp(lineups),
               'leftovers': _fp(left), 'checklist': _fp(check)},
        'first_lineup': lineups.split('\n')[0] if lineups else '',
        'log': log.getvalue()[-20000:],
    }


if __name__ == '__main__':
    # Mac reference: HOME=<test home> python3 harness.py <engine dir>
    import json
    r = run(sys.argv[1])
    r.pop('log')
    print(json.dumps(r, indent=1))
