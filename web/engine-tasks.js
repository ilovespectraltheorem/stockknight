'use strict';
// Engine work for the website: playing a move at a strength level, and analysing a position
// with an exact score for every legal move (what game review needs). Runs inside the Web Worker
// (engine-worker.js) and, when workers are unavailable (file://), on the page itself.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const MATE_BOUND = SK.MATE - 1000;

  // The four opponents. Pony, Squire and Knight reuse the reference engine's levels.
  const LEVELS = {
    page: { depth: 1, randomMargin: 260 },
    squire: SK.LEVELS.casual,
    knight: SK.LEVELS.club,
    champion: SK.LEVELS.strong,
  };

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

  // { fen, moves, level } -> { best, score, depth, pv } (score from the side to move's view)
  function play({ fen, moves, level }) {
    const pos = build(fen, moves);
    const r = getSearcher().think(pos, { ...(LEVELS[level] || LEVELS.squire) });
    if (!r.best) return { best: null, score: r.score, depth: 0, pv: [] };
    return { best: pos.moveToUci(r.best), score: r.score, depth: r.depth, pv: lineToUci(pos, r.pv) };
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

  const api = { LEVELS, play, analyse, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EngineTasks = api;
})(typeof self !== 'undefined' ? self : globalThis);
