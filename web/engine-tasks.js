'use strict';
// Engine work for the website: playing a move at a chosen Elo, and analysing a position
// with an exact score for every legal move (what game review needs). Runs inside the Web Worker
// (engine-worker.js) and, when workers are unavailable (file://), on the page itself.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const MATE_BOUND = SK.MATE - 1000;

  // The old four opponents, kept so saved games and stored settings still map to something.
  // New games pick a strength by Elo instead (see STRENGTH below and docs/STRENGTH.md).
  const LEVELS = {
    page: { depth: 1, randomMargin: 260 },
    squire: SK.LEVELS.casual,
    knight: SK.LEVELS.club,
    champion: SK.LEVELS.strong,
  };

  // Playing strength by Elo. Each ladder point is a setting: a node budget for the search and a
  // move-choice temperature in centipawns. With a temperature, every root move gets an exact
  // score and the move is drawn with probability proportional to exp((score - best) / temp), so
  // a weak setting mostly plays reasonable moves and now and then a worse one, the worse the
  // rarer. Between points, the node budget is interpolated in log space and the temperature
  // linearly, so the strength changes smoothly. Each point's Elo was measured by self-play
  // between the points (web/calibrate.js), anchored at full strength = 3000.
  const STRENGTH = {
    min: 0, // filled from the ladder below
    max: 3000,
    step: 50,
    movetime: 3000, // wall-clock cap per move, so a slow device never waits much longer than this
    ladder: [
      // CALIBRATION:BEGIN
      { nodes: 1, temp: 600, elo: 81 },
      { nodes: 1, temp: 400, elo: 141 },
      { nodes: 1, temp: 280, elo: 171 },
      { nodes: 1, temp: 200, elo: 243 },
      { nodes: 500, temp: 160, elo: 335 },
      { nodes: 1000, temp: 130, elo: 464 },
      { nodes: 2000, temp: 105, elo: 633 },
      { nodes: 3500, temp: 88, elo: 766 },
      { nodes: 6000, temp: 74, elo: 939 },
      { nodes: 10000, temp: 62, elo: 1090 },
      { nodes: 16000, temp: 52, elo: 1315 },
      { nodes: 25000, temp: 44, elo: 1552 },
      { nodes: 40000, temp: 37, elo: 1735 },
      { nodes: 65000, temp: 30, elo: 1962 },
      { nodes: 100000, temp: 24, elo: 2202 },
      { nodes: 160000, temp: 18, elo: 2405 },
      { nodes: 250000, temp: 13, elo: 2569 },
      { nodes: 400000, temp: 8, elo: 2668 },
      { nodes: 650000, temp: 4, elo: 2806 },
      { nodes: 1000000, temp: 0, elo: 3000 },
      // CALIBRATION:END
    ],
    // What the old opponents measured at, for games and settings saved before the change.
    legacy: { page: 400, squire: 1200, knight: 2850, champion: 3000 },
  };
  STRENGTH.min = Math.ceil(STRENGTH.ladder[0].elo / STRENGTH.step) * STRENGTH.step;

  // Elo -> { nodes, temp }, interpolated between the two ladder points around it.
  function settingFor(elo) {
    const L = STRENGTH.ladder;
    if (!(elo > L[0].elo)) return { nodes: L[0].nodes, temp: L[0].temp };
    for (let i = 1; i < L.length; i++) {
      if (elo <= L[i].elo) {
        const a = L[i - 1], b = L[i];
        const f = (elo - a.elo) / (b.elo - a.elo);
        return {
          nodes: Math.round(Math.exp(Math.log(a.nodes) + f * (Math.log(b.nodes) - Math.log(a.nodes)))),
          temp: a.temp + f * (b.temp - a.temp),
        };
      }
    }
    const top = L[L.length - 1];
    return { nodes: top.nodes, temp: top.temp };
  }

  function clampElo(elo) {
    const e = Math.round(+elo / STRENGTH.step) * STRENGTH.step;
    if (!Number.isFinite(e)) return 1500;
    return Math.max(STRENGTH.min, Math.min(STRENGTH.max, e));
  }

  // Search with a node budget and pick a move at a temperature. Returns the same shape as play.
  // opts: { random, movetime, searcher } (searcher: a separate SK.Searcher, for self-play).
  function thinkAt(pos, setting, opts = {}) {
    const root = pos.legalMoves();
    if (!root.length) return { best: 0, score: -SK.MATE, depth: 0, pv: [], nodes: 0 };
    const s = opts.searcher || getSearcher();
    const random = opts.random || Math.random;
    const temp = setting.temp > 0.5 ? setting.temp : 0;
    s.pos = pos;
    s.nodes = 0;
    s.stopped = false;
    s.start = Date.now();
    s.maxNodes = Infinity;
    s.deadline = Infinity; // depth 1 always completes
    s.killers.fill(0);
    for (let i = 0; i < s.history.length; i++) s.history[i] >>= 2;

    let order = root.slice(), out = null;
    for (let d = 1; d <= 60; d++) {
      const r = s.searchRoot(order, d, temp > 0);
      if (!r.complete) break;
      out = { best: r.best, score: r.score, depth: d, moveScores: r.moveScores };
      if (temp > 0) order = root.slice().sort((a, b) => r.moveScores.get(b) - r.moveScores.get(a));
      else order = [r.best, ...order.filter(m => m !== r.best)];
      if (d === 1) {
        s.maxNodes = setting.nodes;
        s.deadline = opts.movetime ? s.start + opts.movetime : Infinity;
      }
      if (Math.abs(r.score) >= MATE_BOUND && d >= SK.MATE - Math.abs(r.score)) break;
      if (s.nodes >= setting.nodes) break;
    }

    let best = out.best, score = out.score;
    if (temp > 0 && root.length > 1) {
      const w = root.map(m => Math.exp(Math.max(-50, (out.moveScores.get(m) - out.score) / temp)));
      let x = random() * w.reduce((a, b) => a + b, 0);
      let i = 0;
      while (i < root.length - 1 && (x -= w[i]) > 0) i++;
      best = root[i];
      score = out.moveScores.get(best);
    }
    const pv = best === out.best ? s.principalVariation(best, out.depth) : [best];
    return { best, score, rawScore: out.score, depth: out.depth, pv, nodes: s.nodes };
  }

  let searcher = null;
  const getSearcher = () => searcher || (searcher = new SK.Searcher());

  function build(fen, moves) {
    const pos = new SK.Position(fen || SK.START_FEN);
    for (const text of moves || []) {
      const m = pos.moveFromUci(text);
      if (!m) throw new Error(`illegal move ${text}`);
      pos.makeMove(m);
    }
    return pos;
  }

  function lineToUci(pos, line) {
    const out = [];
    for (const m of line) {
      out.push(pos.moveToUci(m));
      pos.makeMove(m);
    }
    for (let i = 0; i < line.length; i++) pos.unmakeMove();
    return out;
  }

  // { fen, moves, elo } -> { best, score, depth, pv, elo } (score from the side to move's view).
  // An old { level } is mapped to the Elo that level measured at.
  function play({ fen, moves, elo, level }) {
    const pos = build(fen, moves);
    if (elo === undefined || elo === null) elo = STRENGTH.legacy[level] ?? 1500;
    elo = clampElo(elo);
    const r = thinkAt(pos, settingFor(elo), { movetime: STRENGTH.movetime });
    if (!r.best) return { best: null, score: r.score, depth: 0, pv: [], elo };
    return { best: pos.moveToUci(r.best), score: r.score, depth: r.depth, pv: lineToUci(pos, r.pv), elo };
  }

  // { fen, moves, movetime, depth } -> { legal, best, score, depth, scores: { uci: score }, pv }
  // Every root move is searched with a full window, so each move's score is exact at the final
  // depth and a played move can be compared with the best one on equal terms.
  function analyse({ fen, moves, movetime = 400, depth = 12 }) {
    const pos = build(fen, moves);
    const root = pos.legalMoves();
    if (!root.length) return { legal: 0, best: null, score: -SK.MATE, depth: 0, scores: {}, pv: [] };

    const s = getSearcher();
    s.pos = pos;
    s.nodes = 0;
    s.stopped = false;
    s.start = Date.now();
    s.maxNodes = Infinity;
    s.deadline = Infinity; // depth 1 always completes, so every move gets a score
    s.killers.fill(0);
    for (let i = 0; i < s.history.length; i++) s.history[i] >>= 2;

    let order = root.slice(), out = null;
    for (let d = 1; d <= depth; d++) {
      const r = s.searchRoot(order, d, true);
      if (!r.complete) break;
      out = { best: r.best, score: r.score, depth: d, moveScores: r.moveScores };
      order = root.slice().sort((a, b) => r.moveScores.get(b) - r.moveScores.get(a));
      if (d === 1) s.deadline = s.start + movetime;
      if (Math.abs(r.score) >= MATE_BOUND && d >= SK.MATE - Math.abs(r.score)) break;
      if (Date.now() - s.start > movetime / 2) break; // the next depth would not finish
    }
    const pv = s.principalVariation(out.best, out.depth);
    const scores = {};
    for (const [m, v] of out.moveScores) scores[pos.moveToUci(m)] = v;
    return {
      legal: root.length,
      best: pos.moveToUci(out.best),
      score: out.score,
      depth: out.depth,
      scores,
      pv: lineToUci(pos, pv),
    };
  }

  // { fen, moves, movetime, depth, multipv } -> { legal, depth, nodes, lines: [{ move, score, pv }] }
  // The analysis board's search: the best `multipv` root moves, each with an exact score and its
  // line, best first. The first `multipv` moves get a full window; every other move is tested
  // with a null window against the current k-th best score and searched fully only when it beats
  // it, so the board searches about as deep as a single-line search. Scores are from the side
  // to move's view. The searcher keeps its hash table between calls, so calling again on the
  // same position with a longer movetime picks up where the last call left off.
  function lines({ fen, moves, movetime = 1000, depth = 40, multipv = 3 }) {
    const pos = build(fen, moves);
    const root = pos.legalMoves();
    if (!root.length) return { legal: 0, depth: 0, nodes: 0, lines: [] };
    const k = Math.max(1, Math.min(multipv | 0 || 1, root.length));
    const full = SK.MATE + 1;

    const s = getSearcher();
    s.pos = pos;
    s.nodes = 0;
    s.stopped = false;
    s.start = Date.now();
    s.maxNodes = Infinity;
    s.deadline = Infinity; // depth 1 always completes
    s.killers.fill(0);
    for (let i = 0; i < s.history.length; i++) s.history[i] >>= 2;

    let order = root.slice(), out = null;
    const maxDepth = Math.min(depth, 80);
    for (let d = 1; d <= maxDepth; d++) {
      const scores = new Map(); // exact for the top k, an upper bound for the rest
      const top = []; // [score, move, pv], best first, at most k
      let complete = true;
      for (const m of order) {
        pos.makeMove(m);
        let score;
        if (top.length < k) {
          score = -s.negamax(d - 1, -full, full, 1);
        } else {
          const bar = top[k - 1][0];
          score = -s.negamax(d - 1, -bar - 1, -bar, 1);
          if (score > bar && !s.stopped) score = -s.negamax(d - 1, -full, full, 1);
        }
        pos.unmakeMove();
        if (s.stopped) {
          complete = false;
          break;
        }
        scores.set(m, score);
        if (top.length < k || score > top[k - 1][0]) {
          // Read the line now, while the hash table still holds this move's search.
          top.push([score, m, s.principalVariation(m, d)]);
          top.sort((a, b) => b[0] - a[0]);
          if (top.length > k) top.pop();
        }
      }
      if (!complete) break;
      out = { depth: d, top };
      order = root.slice().sort((a, b) => scores.get(b) - scores.get(a));
      if (d === 1) s.deadline = s.start + movetime;
      const best = top[0][0];
      if (Math.abs(best) >= MATE_BOUND && d >= SK.MATE - Math.abs(best)) break;
      if (Date.now() - s.start > movetime / 2) break; // the next depth would not finish
    }
    return {
      legal: root.length,
      depth: out.depth,
      nodes: s.nodes,
      lines: out.top.map(([score, m, pv]) => ({ move: pos.moveToUci(m), score, pv: lineToUci(pos, pv) })),
    };
  }

  const api = { LEVELS, STRENGTH, settingFor, clampElo, thinkAt, play, analyse, lines, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EngineTasks = api;
})(typeof self !== 'undefined' ? self : globalThis);
