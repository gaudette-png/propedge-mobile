// =============================================================================
// halftime/logic.js — NBA halftime scanner rules, ported from PropEdge
// halftime_nba.py v1.8. Pure functions only (no page, no network) so the same
// games can be checked against the Python version.
//
// KEEP IN SYNC with halftime_nba.py: thresholds, STATS, HIT_RATE, Fair
// (second_half_minutes / stat_rows), player_rank, live_cols.
// =============================================================================

const HT = (() => {
  const RULES = {
    margin: 10,        // close game = halftime margin <= this
    hotPct: 55,        // stands out = 1H stat >= this % of full-game projection
    coldPct: 35,       // cold start = 1H stat <= this % of projection
  };
  const FOUL_FLAG = 3;
  const MIN_SS_MINUTES = 12;
  const MAX_STATS_SHOWN = 2;
  const HOT_CUSHION = 1;
  const COLD_CUSHION = 2;
  const REM_MIN_FLOOR = 0.75;
  const COLD_MIN_SS_MINUTES = 24;
  const COLD_MIN_1H_SHARE = 0.35;
  const COLD_MIN_PROJ = { 'Points': 12, 'Rebounds': 6, 'Assists': 4, 'Pts+Rebs': 18,
    'Pts+Asts': 18, 'Rebs+Asts': 9, 'Pts+Rebs+Asts': 22 };

  // Stat label → [box score keys, SaberSim columns, min 1H value to show]
  const STATS = {
    'Points':        [['PTS'],               ['PTS'],              8],
    'Rebounds':      [['REB'],               ['RB'],               5],
    'Assists':       [['AST'],               ['AST'],              4],
    'Threes':        [['FG3M'],              ['3PT'],              3],
    'Pts+Rebs':      [['PTS', 'REB'],        ['PTS', 'RB'],        12],
    'Pts+Asts':      [['PTS', 'AST'],        ['PTS', 'AST'],       12],
    'Rebs+Asts':     [['REB', 'AST'],        ['RB', 'AST'],        8],
    'Pts+Rebs+Asts': [['PTS', 'REB', 'AST'], ['PTS', 'RB', 'AST'], 15],
  };
  const SS_COLS = ['Min', 'PTS', 'RB', 'AST', '3PT'];

  const PICK6_MARKETS = {
    player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists',
    player_threes: 'Threes', player_points_rebounds: 'Pts+Rebs',
    player_points_assists: 'Pts+Asts', player_rebounds_assists: 'Rebs+Asts',
    player_points_rebounds_assists: 'Pts+Rebs+Asts',
  };
  const LIVE_MIN_HIT = 60;
  const HIT_RATE_CAP = 90;
  // Study hit rates by gap = floor(Fair − line), clamped −3..3: [Over %, Under %]
  const HIT_RATE = {
    'HOT|single':  { '-3': [23, 77], '-2': [32, 68], '-1': [44, 56], '0': [58, 42], '1': [73, 27], '2': [83, 17], '3': [89, 11] },
    'HOT|combo':   { '-3': [35, 65], '-2': [42, 58], '-1': [50, 50], '0': [59, 41], '1': [67, 33], '2': [75, 25], '3': [81, 19] },
    'HOT|threes':  { '-3': [5, 95],  '-2': [13, 87], '-1': [31, 69], '0': [64, 36], '1': [96, 4],  '2': [100, 0], '3': [100, 0] },
    'COLD|single': { '-3': [19, 81], '-2': [26, 74], '-1': [35, 65], '0': [48, 52], '1': [63, 37], '2': [75, 25], '3': [82, 18] },
    'COLD|combo':  { '-3': [25, 75], '-2': [32, 68], '-1': [39, 61], '0': [47, 53], '1': [54, 46], '2': [62, 38], '3': [70, 30] },
  };
  const RAW_FALLBACK = { 'Points': 14, 'Rebounds': 7, 'Assists': 6, 'Threes': 3 };
  const NAME_ALIASES = {};

  // ESPN abbreviation → NBA tricode where they differ
  const ESPN_TRI = { WSH: 'WAS', GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', PHO: 'PHX' };
  // Odds API team name → NBA tricode
  const TEAM_TRI = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
    'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
    'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'LA Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP',
    'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI',
    'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
  };

  const tri = abbr => ESPN_TRI[abbr] || abbr;
  const isNum = v => typeof v === 'number' && !Number.isNaN(v);

  function normalizeName(s) {
    return String(s).normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
      .replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/, '').replace(/[^a-z]/g, '');
  }

  // ---------------------------------------------------------------- SaberSim
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(r => r.length > 1);
  }

  // One SaberSim CSV → {normName: {name, team, Min, PTS, RB, AST, 3PT}} (SS Proj > 0 only),
  // or null when it isn't a SaberSim NBA export.
  function sabersimFromCSV(text) {
    const rows = parseCSV(text);
    const hdr = rows[0] || [];
    const ix = c => hdr.indexOf(c);
    if (ix('Name') < 0 || ix('SS Proj') < 0) return null;
    const out = {};
    for (const r of rows.slice(1)) {
      if (!(parseFloat(r[ix('SS Proj')]) > 0)) continue;
      const rec = { name: r[ix('Name')], team: ix('Team') >= 0 ? r[ix('Team')] : '' };
      for (const c of SS_COLS) {
        const v = ix(c) >= 0 ? parseFloat(r[ix(c)]) : NaN;
        rec[c] = Number.isNaN(v) ? null : v;
      }
      const k = normalizeName(rec.name);
      if (!(k in out)) out[k] = rec;
    }
    return out;
  }

  // Merge several files' players, newest file first: first one wins per player.
  function mergeSabersim(files) {
    const ss = {};
    for (const f of files.slice().sort((a, b) => b.modified - a.modified)) {
      for (const [k, v] of Object.entries(f.players)) if (!(k in ss)) ss[k] = v;
    }
    return ss;
  }

  // ------------------------------------------------------------------ ESPN
  function gamesFromScoreboard(sb) {
    return (sb.events || []).map(e => {
      const comps = e.competitions[0].competitors;
      const away = comps.find(c => c.homeAway === 'away'), home = comps.find(c => c.homeAway === 'home');
      const st = e.status || {}, type = st.type || {};
      const g = { id: e.id, away: tri(away.team.abbreviation), home: tri(home.team.abbreviation),
        period: st.period || 0, state: type.name || '', detail: type.shortDetail || '',
        awayPts: +away.score || 0, homePts: +home.score || 0, start: e.date };
      g.label = `${g.away} @ ${g.home}`;
      if (g.state === 'STATUS_HALFTIME') { g.status = 2; g.text = 'Halftime'; }
      else if (g.state === 'STATUS_FINAL') { g.status = 3; g.text = 'Final'; }
      else if (g.state === 'STATUS_SCHEDULED') { g.status = 1; g.text = g.detail.split(' - ').pop(); }
      else { g.status = 2; g.text = g.detail; }
      return g;
    });
  }

  // True once the 1st half is over (halftime, or later)
  function atOrPastHalf(g) {
    if (g.status === 3) return true;
    if (g.status !== 2) return false;
    const t = g.text.toLowerCase();
    if (t.includes('half')) return true;
    if (g.period >= 3) return true;
    return g.period === 2 && t.startsWith('end');
  }

  // ESPN summary → {players, teamPts}
  function boxFromSummary(data) {
    const teamPts = {};
    const comps = (((data.header || {}).competitions || [{}])[0] || {}).competitors || [];
    for (const c of comps) teamPts[tri(c.team.abbreviation)] = parseInt(c.score, 10) || 0;
    const split = v => { const m = /(\d+)-(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2]] : [0, 0]; };
    const int = v => parseInt(v, 10) || 0;
    const players = [];
    for (const team of ((data.boxscore || {}).players || [])) {
      const t = tri(team.team.abbreviation);
      for (const block of (team.statistics || [])) {
        const keys = block.keys || [];
        for (const a of (block.athletes || [])) {
          if (a.didNotPlay || !a.stats || !a.stats.length) continue;
          const st = {}; keys.forEach((k, i) => { st[k] = a.stats[i]; });
          const mins = parseFloat(st.minutes) || 0;
          if (mins <= 0) continue;
          const [fgm, fga] = split(st['fieldGoalsMade-fieldGoalsAttempted']);
          const [tpm, tpa] = split(st['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);
          players.push({ name: (a.athlete || {}).displayName || '', team: t, min: mins,
            PTS: int(st.points), REB: int(st.rebounds), AST: int(st.assists), FG3M: tpm,
            PF: int(st.fouls), FGM: fgm, FGA: fga, FG3A: tpa });
        }
      }
    }
    return { players, teamPts };
  }

  // ---------------------------------------------------------------- Pick6
  // Odds API event odds → {"normName|Stat": {O: line, U: line}}
  function pick6Lines(odds) {
    const lines = {};
    for (const bk of (odds.bookmakers || [])) {
      for (const mk of (bk.markets || [])) {
        const stat = PICK6_MARKETS[mk.key];
        for (const o of (mk.outcomes || [])) {
          const side = { Over: 'O', Under: 'U' }[o.name];
          if (!stat || !side || o.point == null) continue;
          const k = normalizeName(o.description || '') + '|' + stat;
          lines[k] = lines[k] || {};
          if (!(side in lines[k])) lines[k][side] = +o.point;
        }
      }
    }
    return lines;
  }

  function hitRate(r, line, side) {
    const kind = r.stat === 'Threes' ? 'threes' : r.stat.includes('+') ? 'combo' : 'single';
    const table = HIT_RATE[r.list + '|' + kind];
    if (!table) return null;
    const gap = Math.max(-3, Math.min(3, Math.floor(r.cool - line)));
    return Math.min(table[String(gap)][side === 'O' ? 0 : 1], HIT_RATE_CAP);
  }

  const fmtLine = v => String(+v);   // 7.5 → "7.5", 7 → "7" (Python :g)

  // Live and Bet for one row: {live: '21.5', side: 'O', rate: 73, ok: true} or blanks.
  // flag=false (game past halftime): line only, no Bet.
  function liveCols(r, lines, flag) {
    const ln = lines[normalizeName(r.p.name) + '|' + r.stat];
    if (!ln) return { live: '', side: '', rate: null, ok: false };
    const o = ln.O, u = ln.U;
    let live;
    if (o != null && u != null && o === u) live = fmtLine(o);
    else live = [['O', o], ['U', u]].filter(([, v]) => v != null).map(([s, v]) => `${s} ${fmtLine(v)}`).join('/');
    let best = null;
    for (const [s, v] of [['O', o], ['U', u]]) {
      if (v == null) continue;
      const rate = hitRate(r, v, s);
      if (best === null || (rate ?? -1) > (best.rate ?? -1)) best = { rate, side: s };
    }
    if (!best || best.rate === null || !flag) return { live, side: '', rate: null, ok: false };
    return { live, side: best.side, rate: best.rate, ok: best.rate >= LIVE_MIN_HIT };
  }

  // ------------------------------------------------------------ scan logic
  function secondHalfMinutes(p, ssMin) {
    if (!isNum(ssMin) || ssMin <= 0) return null;
    return Math.max(ssMin - p.min, REM_MIN_FLOOR * p.min);
  }

  function statRows(p, ss, rules) {
    const ssMin = ss.Min;
    const rem = secondHalfMinutes(p, ssMin);
    const rows = [];
    for (const [stat, [boxKeys, ssCols, min1h]] of Object.entries(STATS)) {
      if (ssCols.some(c => !isNum(ss[c]))) continue;
      const proj = ssCols.reduce((a, c) => a + ss[c], 0);
      if (proj <= 0) continue;
      const actual = boxKeys.reduce((a, k) => a + p[k], 0);
      const pct = actual / proj * 100;
      const cool = actual + (rem !== null ? proj / ssMin * rem : proj / 2);
      let list = '';
      if (isNum(ssMin) && ssMin < MIN_SS_MINUTES) { /* skip */ }
      else if (actual >= min1h && pct >= rules.hotPct) list = 'HOT';
      else if (stat in COLD_MIN_PROJ && proj >= COLD_MIN_PROJ[stat] && pct <= rules.coldPct
               && isNum(ssMin) && ssMin >= COLD_MIN_SS_MINUTES && p.min >= COLD_MIN_1H_SHARE * ssMin) list = 'COLD';
      rows.push({ p, stat, h1: actual, proj, pct, cool, ssMin, rem, list });
    }
    return rows;
  }

  function evaluate(players, ss, rules) {
    const hot = [], cold = [], raw = [];
    const haveSS = ss && Object.keys(ss).length > 0;
    for (const p of players) {
      if (!haveSS) {
        for (const [stat, need] of Object.entries(RAW_FALLBACK)) {
          const actual = STATS[stat][0].reduce((a, k) => a + p[k], 0);
          if (actual >= need) raw.push({ p, stat, h1: actual });
        }
        continue;
      }
      const norm = normalizeName(p.name);
      const row = ss[NAME_ALIASES[norm] || norm];
      if (!row) continue;
      for (const r of statRows(p, row, rules)) {
        if (r.list === 'HOT') hot.push(r);
        else if (r.list === 'COLD') cold.push(r);
      }
    }
    return { hot, cold, raw };
  }

  function minShare(p, ssMin) {
    return isNum(ssMin) && ssMin > 0 ? p.min / ssMin : null;
  }

  // Players sort by 1H minutes-share tier (study beat-Fair rates):
  // 0.55–0.60 → 0.50–0.55 → over 0.60 → under 0.50; 3+ PF last.
  function playerRank(rs) {
    const p = rs[0].p, share = minShare(p, rs[0].ssMin);
    if (share === null) return [p.PF >= FOUL_FLAG ? 1 : 0, 4, -p.min];
    const tier = share >= 0.55 && share <= 0.60 ? 0 : share >= 0.50 && share < 0.55 ? 1 : share > 0.60 ? 2 : 3;
    return [p.PF >= FOUL_FLAG ? 1 : 0, tier, -share];
  }
  const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };

  const STAT_KEYS = {
    HOT: r => [r.stat.includes('+') ? 0 : 1, -r.pct],   // combos first, then furthest above
    COLD: r => [r.pct],
    RAW: r => [-r.h1],
  };

  // Rows → players in display order, each with up to MAX_STATS_SHOWN plays.
  // lines = Pick6 lines or null; flag=false → no Bet (game past halftime).
  function buildList(rows, kind, lines, flag) {
    const byPlayer = new Map();
    for (const r of rows) {
      if (!byPlayer.has(r.p.name)) byPlayer.set(r.p.name, []);
      byPlayer.get(r.p.name).push(r);
    }
    const order = [...byPlayer.values()].map(rs => ({ rs, key: playerRank(rs) }))
      .sort((a, b) => cmpTuple(a.key, b.key)).map(x => x.rs);
    const cushion = kind === 'HOT' ? HOT_CUSHION : kind === 'COLD' ? COLD_CUSHION : null;
    const sk = STAT_KEYS[kind];
    return order.map((rs, i) => {
      const p = rs[0].p, ssMin = rs[0].ssMin;
      const share = cushion === null ? null : minShare(p, ssMin);
      const plays = rs.map(r => ({ r, key: sk(r) })).sort((a, b) => cmpTuple(a.key, b.key))
        .slice(0, MAX_STATS_SHOWN).map(({ r }) => {
          const out = { stat: r.stat, h1: r.h1 };
          if (cushion !== null) {
            Object.assign(out, { proj: r.proj, fair: r.cool, over: r.cool - cushion });
            if (lines) Object.assign(out, liveCols(r, lines, flag));
          }
          return out;
        });
      return { n: i + 1, name: p.name, team: p.team, min: p.min, ssMin: isNum(ssMin) ? ssMin : null,
        share, fgm: p.FGM, fga: p.FGA, pf: p.PF, fouls: p.PF >= FOUL_FLAG, plays };
    });
  }

  return { RULES, HOT_CUSHION, COLD_CUSHION, LIVE_MIN_HIT, PICK6_MARKETS, TEAM_TRI, MIN_SS_MINUTES,
    normalizeName, parseCSV, sabersimFromCSV, mergeSabersim, gamesFromScoreboard, atOrPastHalf,
    boxFromSummary, pick6Lines, hitRate, liveCols, statRows, evaluate, buildList };
})();

if (typeof module !== 'undefined') module.exports = HT;
