// py-worker.js — Python (Pyodide 0.28.3) for nba/index.html, off the page's main
// thread: the page stays responsive while Python starts, and requests can use
// synchronous XHR, which fetch_lines_nba.py needs.
// The engine files come from the page (loaded from the private propedge repo);
// none of them are stored in this public repo.
importScripts('https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js');

const HOME = '/home/pyodide';
let py = null;

const booting = (async () => {
  const t0 = performance.now();
  py = await loadPyodide();
  const t1 = performance.now();
  await py.loadPackage(['pandas', 'requests', 'tzdata']);   // tzdata: ZoneInfo has no system zones here
  const app = await fetch('app.py?v=4', { cache: 'no-store' });
  if (!app.ok) throw new Error(`app.py: ${app.status}`);
  py.FS.mkdirTree(`${HOME}/app`);
  py.FS.writeFile(`${HOME}/app/app.py`, await app.text());
  const v = JSON.parse(py.runPython(`
import json, platform, sys
sys.path.insert(0, '${HOME}/app')
import pandas, numpy, requests
from zoneinfo import ZoneInfo
ZoneInfo('America/New_York')          # fetch_lines_nba.py needs the time zone data
sys.dont_write_bytecode = True        # always run the engine file just written
json.dumps({'python': platform.python_version(), 'pandas': pandas.__version__})`));
  return { ...v, t_python: t1 - t0, t_packages: performance.now() - t1 };
})();

const handlers = {
  boot: () => booting,

  // Write the engine files and import them, so a broken file shows up now
  // rather than at Fetch + Run.
  async engine({ files }) {
    await booting;
    const dir = `${HOME}/engine`;
    py.FS.mkdirTree(dir);
    py.FS.mkdirTree(`${HOME}/Downloads`);
    for (const [name, text] of Object.entries(files)) py.FS.writeFile(`${dir}/${name}`, text);
    py.globals.set('_mods', py.toPy(Object.keys(files).map(n => n.replace(/\.py$/, ''))));
    return JSON.parse(py.runPython(`
import importlib, json, sys
if '${dir}' not in sys.path:
    sys.path.insert(0, '${dir}')
for _m in _mods:
    if _m in sys.modules:
        importlib.reload(sys.modules[_m])
    else:
        importlib.import_module(_m)
json.dumps(list(_mods))`));
  },

  // Run fetch_lines_nba.py. requests makes synchronous calls here, which only a
  // worker allows. The key is written to a file for the run and removed after.
  async fetch({ key, base }) {
    await booting;
    py.globals.set('_key', key);
    py.globals.set('_base', base || '');
    try {
      return JSON.parse(py.runPython('import app\napp.fetch(_key, _base)'));
    } finally {
      py.runPython("globals().pop('_key', None)");
    }
  },

  // PE_NBA.py all N on the SaberSim files + fetched lines; returns the tabs' rows.
  async run({ inputs }) {
    await booting;
    py.globals.set('_inp', JSON.stringify(inputs));
    try {
      return JSON.parse(py.runPython('import app\napp.run(_inp)'));
    } finally {
      py.runPython("globals().pop('_inp', None)");
    }
  },

  // Rebuild the tabs from the last run, leaving out games that have started.
  async views({ started }) {
    await booting;
    py.globals.set('_started', JSON.stringify(started || []));
    return JSON.parse(py.runPython('import app\napp.views(_started)'));
  },
};

onmessage = async ({ data }) => {
  const { id, cmd } = data;
  try {
    postMessage({ id, ok: true, result: await handlers[cmd](data) });
  } catch (e) {
    postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
