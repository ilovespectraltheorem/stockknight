'use strict';
// Measures the Elo of each strength ladder point in web/engine-tasks.js by self-play.
//
//   node web/calibrate.js [--games N] [--threads N] [--out FILE] [--only i,j] [--legacy]
//
// Adjacent points (i, i+1) and points two apart (i, i+2) play each other. Every pair plays
// N games (default 40), as N/2 random four-ply openings, each played once with each colour.
// Every engine searches by node budget only (no clock), so the result does not depend on how
// fast or busy the machine is. Ratings come from a Bradley–Terry (Elo) fit over all games,
// anchored at the top point = 3000, with standard errors from a bootstrap over games.
// --legacy adds the old Page, Squire and Knight opponents, each against its two nearest points.
// Results go to a JSON file (default calibration.json) and are printed as a table; games already
// in the output file are kept, so an interrupted run can be resumed.
//
//   node web/calibrate.js --apply [--out FILE] [--floor ELO]
//
// writes the measured ratings into the ladder in engine-tasks.js. With --floor, the measured
// scale is compressed (or stretched) linearly so the top stays at 3000 and the weakest point
// lands at ELO; equal measured gaps stay equal either way.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SK = require('../reference/engine.js');
const T = require('./engine-tasks.js');

const MAX_PLIES = 240;
const ADJ_SCORE = 1500, ADJ_PLIES = 6;

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function opening(seed) {
  const rnd = mulberry(seed * 7919 + 13);
  for (;;) {
    const pos = new SK.Position();
    const moves = [];
    for (let i = 0; i < 4; i++) {
      const legal = pos.legalMoves();
      const m = legal[Math.floor(rnd() * legal.length)];
      moves.push(pos.moveToUci(m));
      pos.makeMove(m);
    }
    if (pos.status().state === 'ongoing') return moves;
  }
}

// A player: a ladder setting { nodes, temp } or a legacy level { legacy: 'page' }.
function mover(spec, rnd) {
  const searcher = new SK.Searcher();
  if (spec.legacy) {
    const limits = { ...T.LEVELS[spec.legacy], random: rnd };
    return pos => {
      const r = searcher.think(pos, limits);
      return { best: r.best, raw: r.score };
    };
  }
  return pos => {
    const r = T.thinkAt(pos, spec, { random: rnd, searcher });
    return { best: r.best, raw: r.rawScore };
  };
}

// Plays one game; returns White's points (1, 0.5, 0) and the length.
function playGame(white, black, moves, seed) {
  const rnd = mulberry(seed);
  const side = [mover(white, rnd), mover(black, rnd)];
  const pos = new SK.Position();
  for (const t of moves) pos.makeMove(pos.moveFromUci(t));
  const lastRaw = [0, 0];
  let streak = 0;
  for (let ply = moves.length; ply < MAX_PLIES; ply++) {
    const st = pos.status();
    if (st.state === 'draw') return { w: 0.5, plies: ply, how: st.reason };
    if (st.state === 'win') return { w: st.winner === SK.WHITE ? 1 : 0, plies: ply, how: st.reason };
    const us = pos.side;
    const r = side[us](pos);
    lastRaw[us] = r.raw;
    // Both engines agree one side is far ahead for a few plies in a row: adjudicate.
    const whiteView = us === SK.WHITE ? r.raw : -r.raw;
    const otherWhite = us === SK.WHITE ? -lastRaw[1] : lastRaw[0];
    if (Math.abs(whiteView) >= ADJ_SCORE && Math.sign(whiteView) === Math.sign(otherWhite) && Math.abs(otherWhite) >= ADJ_SCORE) streak++;
    else streak = 0;
    if (streak >= ADJ_PLIES) return { w: whiteView > 0 ? 1 : 0, plies: ply, how: 'adjudicated' };
    pos.makeMove(r.best);
  }
  return { w: 0.5, plies: MAX_PLIES, how: 'length' };
}

if (!isMainThread) {
  parentPort.on('message', job => {
    if (job === 'stop') process.exit(0);
    const res = playGame(job.white, job.black, job.moves, job.seed);
    parentPort.postMessage({ ...job, ...res });
  });
  return;
}

// --- main thread -------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const GAMES = +opt('--games', 40);
const THREADS = +opt('--threads', os.cpus().length);
const OUT = opt('--out', 'calibration.json');
const ONLY = opt('--only', null);
const LEGACY = args.includes('--legacy');

const ladder = T.STRENGTH.ladder.map(({ nodes, temp }) => ({ nodes, temp }));
const players = ladder.map((s, i) => ({ id: `L${i}`, spec: s }));
const pairs = [];
for (let i = 0; i < ladder.length; i++) {
  if (i + 1 < ladder.length) pairs.push([`L${i}`, `L${i + 1}`]);
  if (i + 2 < ladder.length) pairs.push([`L${i}`, `L${i + 2}`]);
}
if (LEGACY) {
  // Neighbours picked by a pilot run; adjust if a legacy level lands elsewhere.
  const near = { page: ['L1', 'L3', 'L5'], squire: ['L6', 'L8', 'L10'], knight: ['L14', 'L16', 'L18'] };
  for (const [lvl, ns] of Object.entries(near)) {
    players.push({ id: lvl, spec: { legacy: lvl } });
    for (const n of ns) pairs.push([lvl, n]);
  }
}
const specOf = Object.fromEntries(players.map(p => [p.id, p.spec]));

let saved = { ladder, games: [] };
if (fs.existsSync(OUT)) {
  saved = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (JSON.stringify(saved.ladder) !== JSON.stringify(ladder)) {
    console.error(`${OUT} was made with a different ladder; use another --out`);
    process.exit(1);
  }
}
const done = new Set(saved.games.map(g => `${g.pair}#${g.k}`));
const jobs = [];
for (const [a, b] of pairs) {
  if (ONLY && !ONLY.split(',').every(x => x === a || x === b) && !ONLY.split(',').includes(`${a}-${b}`)) continue;
  const pair = `${a}-${b}`;
  for (let k = 0; k < GAMES; k++) {
    if (done.has(`${pair}#${k}`)) continue;
    const swap = k % 2 === 1;
    const [w, bl] = swap ? [b, a] : [a, b];
    jobs.push({ pair, k, white: specOf[w], black: specOf[bl], wId: w, bId: bl, moves: opening(Math.floor(k / 2) + 1), seed: k * 1000 + pairs.findIndex(p => p[0] === a && p[1] === b) });
  }
}
// Expensive pairs first, so the run ends on short games and keeps every thread busy.
const cost = j => (j.white.nodes || 3e5) + (j.black.nodes || 3e5);
jobs.sort((x, y) => cost(y) - cost(x));
console.log(`${jobs.length} games to play on ${THREADS} threads`);

function fit(games, ids) {
  const idx = Object.fromEntries(ids.map((id, i) => [id, i]));
  const r = new Float64Array(ids.length);
  const top = idx[`L${ladder.length - 1}`];
  for (let it = 0; it < 3000; it++) {
    const g = new Float64Array(ids.length), h = new Float64Array(ids.length);
    for (const x of games) {
      const i = idx[x.wId], j = idx[x.bId];
      const e = 1 / (1 + Math.pow(10, (r[j] - r[i]) / 400));
      const d = x.w - e;
      g[i] += d;
      g[j] -= d;
      h[i] += e * (1 - e);
      h[j] += e * (1 - e);
    }
    let move = 0;
    for (let i = 0; i < ids.length; i++) {
      if (i === top || !h[i]) continue;
      const step = Math.max(-200, Math.min(200, (400 / Math.LN10) * g[i] / (h[i] + 0.5)));
      r[i] += step * 0.7;
      move = Math.max(move, Math.abs(step));
    }
    if (move < 0.01) break;
  }
  const out = {};
  for (const id of ids) out[id] = r[idx[id]] - r[top] + 3000;
  return out;
}

function report(games) {
  const ids = players.map(p => p.id).filter(id => games.some(g => g.wId === id || g.bId === id));
  if (!ids.includes(`L${ladder.length - 1}`)) return;
  const elo = fit(games, ids);
  const rnd = mulberry(99);
  const boots = [];
  for (let b = 0; b < 100; b++) {
    const sample = games.map(() => games[Math.floor(rnd() * games.length)]);
    boots.push(fit(sample, ids));
  }
  const se = {};
  for (const id of ids) {
    const v = boots.map(x => x[id]);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    se[id] = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  }
  console.log('\nplayer      nodes   temp     Elo    ±');
  for (const id of ids) {
    const s = specOf[id];
    const desc = s.legacy ? `${'(old level)'.padStart(14)}` : `${String(s.nodes).padStart(8)} ${String(s.temp).padStart(5)}`;
    console.log(`${id.padEnd(8)} ${desc} ${elo[id].toFixed(0).padStart(7)} ${se[id].toFixed(0).padStart(4)}`);
  }
  console.log('\npair          games  score   draws  plies');
  for (const [a, b] of pairs) {
    const pg = games.filter(g => g.pair === `${a}-${b}`);
    if (!pg.length) continue;
    const pts = pg.reduce((s, g) => s + (g.wId === b ? g.w : 1 - g.w), 0); // b's points
    const draws = pg.filter(g => g.w === 0.5).length;
    const plies = pg.reduce((s, g) => s + g.plies, 0) / pg.length;
    console.log(`${`${a}-${b}`.padEnd(13)} ${String(pg.length).padStart(5)} ${(100 * pts / pg.length).toFixed(0).padStart(5)}% ${String(draws).padStart(6)} ${plies.toFixed(0).padStart(6)}`);
  }
  return { elo, se };
}

let next = 0, running = 0, since = 0;
const started = Date.now();
const save = () => {
  const r = report(saved.games);
  if (r) {
    saved.elo = r.elo;
    saved.se = r.se;
  }
  fs.writeFileSync(OUT, JSON.stringify(saved, null, 1));
};
if (args.includes('--apply')) {
  apply(saved, opt('--floor', null));
  process.exit(0);
}

function apply(data, floor) {
  if (!data.elo) throw new Error(`no ratings in ${OUT}; run the games first`);
  const n = ladder.length;
  let raw = ladder.map((_, i) => data.elo[`L${i}`]);
  // Pool adjacent violators, so a noisy pair can never make a stronger setting rate lower.
  const blocks = raw.map(v => ({ sum: v, n: 1 }));
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i - 1].sum / blocks[i - 1].n >= blocks[i].sum / blocks[i].n) {
      blocks[i - 1].sum += blocks[i].sum;
      blocks[i - 1].n += blocks[i].n;
      blocks.splice(i, 1);
      i = Math.max(0, i - 2);
    }
  }
  raw = blocks.flatMap(b => Array(b.n).fill(b.sum / b.n));
  const k = floor === null ? 1 : (3000 - +floor) / (3000 - raw[0]);
  const scale = r => 3000 - k * (3000 - r);
  const elo = raw.map((r, i) => (i === n - 1 ? 3000 : Math.round(scale(r))));
  for (let i = 1; i < n; i++) if (elo[i] <= elo[i - 1]) elo[i] = elo[i - 1] + 1; // tied after pooling
  const file = path.join(__dirname, 'engine-tasks.js');
  let src = fs.readFileSync(file, 'utf8');
  const rows = ladder.map((s, i) => `      { nodes: ${s.nodes}, temp: ${s.temp}, elo: ${elo[i]} },`).join('\n');
  src = src.replace(/(\/\/ CALIBRATION:BEGIN\n)[\s\S]*?(\n\s*\/\/ CALIBRATION:END)/, `$1${rows}$2`);
  const legacy = {};
  for (const lvl of ['page', 'squire', 'knight']) {
    if (data.elo[lvl] !== undefined) legacy[lvl] = Math.max(elo[0], Math.round(scale(data.elo[lvl]) / 50) * 50);
  }
  legacy.champion = 3000;
  src = src.replace(/legacy: \{[^}]*\}/, `legacy: ${JSON.stringify(legacy).replace(/"/g, '').replace(/,/g, ', ').replace(/:/g, ': ').replace('{', '{ ').replace(/\}$/, ' }')}`);
  fs.writeFileSync(file, src);
  console.log(`compression ${k.toFixed(3)}: one displayed Elo point = ${(1 / k).toFixed(2)} self-play points`);
  console.log(ladder.map((s, i) => `L${i} ${String(s.nodes).padStart(8)} ${String(s.temp).padStart(4)}  raw ${data.elo[`L${i}`].toFixed(0).padStart(6)}  shown ${elo[i]}`).join('\n'));
  console.log('legacy', legacy);
}

if (!jobs.length) {
  save();
  process.exit(0);
}
for (let t = 0; t < Math.min(THREADS, jobs.length); t++) {
  const w = new Worker(__filename);
  const feed = () => {
    if (next < jobs.length) {
      w.postMessage(jobs[next++]);
      running++;
    } else w.postMessage('stop');
  };
  w.on('message', res => {
    running--;
    const { white, black, moves, ...rec } = res;
    saved.games.push(rec);
    since++;
    const n = saved.games.length;
    process.stdout.write(`\r${since}/${jobs.length} games, ${((Date.now() - started) / 60000).toFixed(1)} min  `);
    if (since % 25 === 0) fs.writeFileSync(OUT, JSON.stringify(saved, null, 1));
    feed();
    if (since === jobs.length) save();
    void n;
  });
  feed();
}
