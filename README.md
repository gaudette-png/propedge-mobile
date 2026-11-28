# propedge-mobile

Phone pages for PropEdge, served by GitHub Pages. Each tool lives in its own folder.

- `halftime/` — NBA halftime scanner, ported from PropEdge `halftime_nba.py` v1.8. Rules live in `halftime/logic.js`; keep them in sync with the Python script. `#demo` runs it on last night's finals as a layout check. `halftime/test.html` is the connection test.
- `nba/` — NBA plays on the phone: the Mac page (`pe_nba_web.py`) minus logging. Runs the real PropEdge `PE_NBA.py` and `fetch_lines_nba.py` with Pyodide (`nba/py-worker.js`, glue in `nba/app.py`, which holds no engine code). Those files are never stored here: the page loads them from the private repo with a read-only GitHub token saved on the phone, and keeps a copy in that browser for when GitHub can't be reached.
- `nba-test/` — the Pyodide feasibility test (2026-11-25). `harness.py` holds no engine code.

No keys, data or engine code live here: the Odds API key, GitHub token and SaberSim CSV are entered on the phone and stay in that browser's storage.
