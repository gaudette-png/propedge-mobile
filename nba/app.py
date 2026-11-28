"""
app.py — Python glue for nba/index.html, run by py-worker.js.

Calls the real fetch_lines_nba.py and PE_NBA.py that the page loaded from the
private repo (no engine code lives in this public repo) and hands plain JSON
back to the page.

The Mac can run the same summary on its own CSVs, so a phone fetch can be
checked against a Mac fetch made at the same time:
    python3 app.py summary ~/Downloads/OddsAPI_NBA_*_<date>_<time>.csv
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


def fetch(key, base_url=''):
    """Run fetch_lines_nba.py as on the Mac; return its CSVs, summary and output."""
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


if __name__ == '__main__':
    if sys.argv[1:2] == ['summary']:
        print(json.dumps(summarize(sys.argv[2:]), indent=1))
    else:
        print(__doc__)
