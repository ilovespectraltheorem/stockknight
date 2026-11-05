'use strict';
// Exact play for the lone-piece endings: one side has a king and one or two minor pieces
// (bishops and knights) on the board, the other a bare king, and both reserves are empty.
// `Endgame.probe(pos)` solves the ending once per material (by retrograde analysis, level by
// level as sk-tb does) and returns the result for the side to move and the value of every legal
// move. A result counts plies to the end of the game, which in Maki is the moment the side to
// move has no legal move: checkmate or stalemate. See docs/ENDGAMES.md.
//
// Works in Node, in the engine Web Worker and on the page.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const { WHITE, BLACK, KNIGHT, BISHOP, KING } = SK;

  const NONE = 36; // a piece slot that is empty: never on the board, or captured
  const INVALID = -32768;

  const fileOf = s => s % 6, rankOf = s => (s / 6) | 0;
  const near = (a, b) => a !== b && Math.abs(fileOf(a) - fileOf(b)) <= 1 && Math.abs(rankOf(a) - rankOf(b)) <= 1;

  function steps(deltas) {
    const out = [];
    for (let s = 0; s < 36; s++) {
      const list = [];
      for (const [df, dr] of deltas) {
        const f = fileOf(s) + df, r = rankOf(s) + dr;
        if (f >= 0 && f < 6 && r >= 0 && r < 6) list.push(r * 6 + f);
      }
      out.push(list);
    }
    return out;
  }
  const KING_TO = steps([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]);
  const KNIGHT_TO = steps([[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]);
  const DIAGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(d => steps([d])); // one diagonal step
  const IS_KNIGHT_JUMP = Array.from({ length: 36 }, (_, a) => {
    const row = new Uint8Array(36);
    for (const b of KNIGHT_TO[a]) row[b] = 1;
    return row;
  });

  // Does a piece of `type` on `from` attack `to`, with `occ(sq)` telling which squares are full?
  function attacks(type, from, to, occ) {
    if (type === KNIGHT) return IS_KNIGHT_JUMP[from][to] === 1;
    const df = fileOf(to) - fileOf(from), dr = rankOf(to) - rankOf(from);
    if (df === 0 || Math.abs(df) !== Math.abs(dr)) return false;
    const d = DIAGS[(dr > 0 ? 0 : 1) + (df > 0 ? 0 : 2)];
    for (let s = d[from][0]; s !== to; s = d[s][0]) if (occ(s)) return false;
    return true;
  }

  // --- one table per material ---------------------------------------------------------------
  //
  // The strong side is "A" (always moves up the board as White would; a Black strong side is
  // read through a mirror of the ranks, which the rules for kings, bishops and knights do not
  // see). Index = (((stm * 36 + aKing) * 36 + dKing) * 37 + p0) * 37 + p1, stm 0 = A to move.
  // With two pieces of one kind, only p0 >= p1 is used. Values: d + 1 = the side to move wins
  // in d plies, -(d + 1) = it loses in d plies, 0 = draw, INVALID = no such position.

  class Table {
    // goal 'end' plays Maki: the side with no legal move loses, checkmated or stalemated.
    // goal 'checkmate' asks a different question: can A force checkmate itself? There, a
    // stalemated bare king counts as a draw, so the bare king may run into stalemate.
    constructor(types, goal = 'end') {
      this.types = types.slice(); // e.g. [KNIGHT, KNIGHT] or [BISHOP]
      this.goal = goal;
      this.n = types.length;
      this.same = this.n === 2 && types[0] === types[1];
      this.size = 2 * 36 * 36 * 37 * (this.n === 2 ? 37 : 1);
      this.val = new Int16Array(this.size);
      this.out = new Int32Array(64);
      this.solve();
    }

    index(stm, ak, dk, p0, p1) {
      if (this.n === 1) return ((stm * 36 + ak) * 36 + dk) * 37 + p0;
      if (this.same && p0 < p1) { const t = p0; p0 = p1; p1 = t; }
      return (((stm * 36 + ak) * 36 + dk) * 37 + p0) * 37 + p1;
    }

    decode(i) {
      let p1 = NONE;
      if (this.n === 2) { p1 = i % 37; i = (i / 37) | 0; }
      const p0 = i % 37; i = (i / 37) | 0;
      const dk = i % 36; i = (i / 36) | 0;
      const ak = i % 36;
      return [(i / 36) | 0, ak, dk, p0, p1];
    }

    // Is the defending king on dk attacked by a piece, with the given squares full?
    pieceAttacks(sq, ak, dk, p0, p1) {
      const occ = s => s === ak || s === dk || s === p0 || s === p1;
      return (p0 !== NONE && p0 !== sq && attacks(this.types[0], p0, sq, occ)) ||
        (p1 !== NONE && p1 !== sq && attacks(this.types[1], p1, sq, occ));
    }

    valid(stm, ak, dk, p0, p1) {
      if (ak === dk || near(ak, dk)) return false;
      if (this.n === 2 && p0 === NONE && p1 === NONE) return false; // bare kings: not stored
      if (this.n === 1 && p0 === NONE) return false;
      for (const p of [p0, p1]) if (p !== NONE && (p === ak || p === dk)) return false;
      if (p0 !== NONE && p0 === p1) return false;
      if (this.same && p0 < p1) return false;
      // The side not to move may not stand in check; A's king is never attacked.
      if (stm === 0 && this.pieceAttacks(dk, ak, dk, p0, p1)) return false;
      return true;
    }

    // Successor indices into this.out; -1 for a move that leaves bare kings (a draw).
    gen(stm, ak, dk, p0, p1) {
      const out = this.out;
      let n = 0;
      const full = s => s === ak || s === dk || s === p0 || s === p1;
      if (stm === 0) {
        for (const s of KING_TO[ak]) if (!full(s) && !near(s, dk)) out[n++] = this.index(1, s, dk, p0, p1);
        for (let i = 0; i < this.n; i++) {
          const from = i === 0 ? p0 : p1;
          if (from === NONE) continue;
          const put = s => (i === 0 ? this.index(1, ak, dk, s, p1) : this.index(1, ak, dk, p0, s));
          if (this.types[i] === KNIGHT) {
            for (const s of KNIGHT_TO[from]) if (!full(s)) out[n++] = put(s);
          } else {
            for (const d of DIAGS) for (let s = d[from][0]; s !== undefined && !full(s); s = d[s][0]) out[n++] = put(s);
          }
        }
      } else {
        for (const s of KING_TO[dk]) {
          if (s === ak || near(s, ak)) continue;
          const q0 = p0 === s ? NONE : p0, q1 = p1 === s ? NONE : p1;
          if (this.pieceAttacks(s, ak, s, q0, q1)) continue;
          out[n++] = q0 === NONE && q1 === NONE ? -1 : this.index(0, ak, s, q0, q1);
        }
      }
      return n;
    }

    // Positions one move before position i, by the side that just moved, into `push`.
    unmoves(i, push) {
      const [stm, ak, dk, p0, p1] = this.decode(i);
      const full = s => s === ak || s === dk || s === p0 || s === p1;
      if (stm === 1) {
        // A just moved: its king or a piece goes back. A never captures.
        for (const s of KING_TO[ak]) if (!full(s) && !near(s, dk)) this.tryPush(push, 0, s, dk, p0, p1);
        for (let k = 0; k < this.n; k++) {
          const from = k === 0 ? p0 : p1;
          if (from === NONE) continue;
          const back = s => (k === 0 ? this.tryPush(push, 0, ak, dk, s, p1) : this.tryPush(push, 0, ak, dk, p0, s));
          if (this.types[k] === KNIGHT) {
            for (const s of KNIGHT_TO[from]) if (!full(s)) back(s);
          } else {
            for (const d of DIAGS) for (let s = d[from][0]; s !== undefined && !full(s); s = d[s][0]) back(s);
          }
        }
      } else {
        // The bare king just moved, maybe capturing a piece on the square it now stands on.
        for (const s of KING_TO[dk]) {
          if (full(s) || near(s, ak)) continue;
          this.tryPush(push, 1, ak, s, p0, p1);
          if (p0 === NONE) this.tryPush(push, 1, ak, s, dk, p1);
          if (this.n === 2 && p1 === NONE && !(this.same && p0 === NONE)) this.tryPush(push, 1, ak, s, p0, dk);
        }
      }
    }

    tryPush(push, stm, ak, dk, p0, p1) {
      if (this.same && p0 < p1) { const t = p0; p0 = p1; p1 = t; }
      if (this.valid(stm, ak, dk, p0, p1)) push(this.index(stm, ak, dk, p0, p1));
    }

    solve() {
      const val = this.val;
      val.fill(INVALID);
      let level = [];
      for (let i = 0; i < this.size; i++) {
        const [stm, ak, dk, p0, p1] = this.decode(i);
        if (!this.valid(stm, ak, dk, p0, p1)) continue;
        val[i] = 0;
        if (this.gen(stm, ak, dk, p0, p1) === 0) {
          if (this.goal === 'checkmate' && stm === 1 && !this.pieceAttacks(dk, ak, dk, p0, p1)) continue;
          val[i] = -1; // no legal move: lost now
          level.push(i);
        }
      }
      // Level d holds the positions decided at distance d. A win at d needs one move to a loss
      // at d - 1; a loss at d needs every move to reach a win, the longest at d - 1.
      for (let d = 1; level.length; d++) {
        const next = [];
        const seen = new Set();
        for (const i of level) {
          this.unmoves(i, j => {
            if (val[j] !== 0 || seen.has(j)) return;
            seen.add(j);
            if (d % 2 === 1) {
              val[j] = d + 1;
              next.push(j);
            } else if (this.allWin(j)) {
              next.push(j);
            }
          });
        }
        if (d % 2 === 0) for (const j of next) val[j] = -(d + 1);
        level = next;
      }
      this.longest = 0;
      for (let i = 0; i < this.size; i++) if (val[i] !== INVALID) this.longest = Math.max(this.longest, Math.abs(val[i]) - 1);
    }

    allWin(i) {
      const [stm, ak, dk, p0, p1] = this.decode(i);
      const n = this.gen(stm, ak, dk, p0, p1);
      for (let k = 0; k < n; k++) {
        const j = this.out[k];
        if (j < 0 || this.val[j] <= 0) return false;
      }
      return true;
    }
  }

  // --- reading a position --------------------------------------------------------------------

  const NAMES = { [KNIGHT]: 'N', [BISHOP]: 'B' };
  const tables = new Map();

  function table(types) {
    const key = types.map(t => NAMES[t]).join('');
    if (!tables.has(key)) tables.set(key, new Table(types));
    return tables.get(key);
  }

  // The ending in `pos`, or null: { strong, types, sig, ... } with squares seen from the strong
  // side (a Black strong side is mirrored rank for rank).
  function classify(pos) {
    for (let c = 0; c < 2; c++) for (let t = 1; t < 7; t++) if (pos.hand[c][t]) return null;
    const pieces = [[], []];
    for (let sq = 0; sq < 36; sq++) {
      const code = pos.board[sq];
      if (!code) continue;
      const color = code >= 8 ? BLACK : WHITE, type = code & 7;
      if (type === KING) continue;
      if (type !== KNIGHT && type !== BISHOP) return null;
      pieces[color].push({ type, sq });
    }
    let strong;
    if (pieces[WHITE].length && !pieces[BLACK].length) strong = WHITE;
    else if (pieces[BLACK].length && !pieces[WHITE].length) strong = BLACK;
    else return null;
    const list = pieces[strong];
    if (list.length > 2) return null;
    const view = sq => (strong === WHITE ? sq : (5 - rankOf(sq)) * 6 + fileOf(sq));
    // Knights before bishops, so each material has one table: N, B, NN, NB, BB.
    list.sort((a, b) => a.type - b.type);
    const types = list.map(p => p.type);
    const sig = `K${types.map(t => NAMES[t]).join('')}vK`;
    return {
      strong,
      types,
      sig,
      ak: view(pos.kingSq[strong]),
      dk: view(pos.kingSq[strong ^ 1]),
      p: list.map(p => view(p.sq)),
      stm: pos.side === strong ? 0 : 1,
    };
  }

  function supports(pos) {
    return classify(pos) !== null;
  }

  // Is this material's table already built (so a probe answers at once)?
  function ready(pos) {
    const c = classify(pos);
    return !!c && tables.has(c.types.map(t => NAMES[t]).join(''));
  }

  // { result: 'win'|'loss'|'draw', plies } for the side to move, or null.
  function lookup(c) {
    const t = table(c.types);
    const v = t.val[t.index(c.stm, c.ak, c.dk, c.p[0], c.p.length === 2 ? c.p[1] : NONE)];
    return decodeValue(v);
  }

  function decodeValue(v) {
    if (v === INVALID) return null;
    if (v === 0) return { result: 'draw', plies: null };
    return v > 0 ? { result: 'win', plies: v - 1 } : { result: 'loss', plies: -v - 1 };
  }

  // The exact result of `pos` and of each legal move in it, best first, or null when the
  // position is not a lone-piece ending.
  // { sig, strong, result, plies, moves: [{ uci, result, plies }] } — move results are for the
  // side that plays the move.
  function probe(pos) {
    const c = classify(pos);
    if (!c) return null;
    const here = lookup(c);
    if (!here) return null;
    const moves = [];
    for (const m of pos.legalMoves()) {
      const uci = pos.moveToUci(m);
      pos.makeMove(m);
      let r;
      if (pos.bareKings()) r = { result: 'draw', plies: null };
      else {
        const after = lookup(classify(pos));
        const flip = { win: 'loss', loss: 'win', draw: 'draw' }[after.result];
        r = { result: flip, plies: after.plies === null ? null : after.plies + 1 };
      }
      pos.unmakeMove();
      moves.push({ uci, ...r });
    }
    const rank = r => (r.result === 'win' ? 1e6 - r.plies : r.result === 'draw' ? 0 : -1e6 + r.plies);
    moves.sort((a, b) => rank(b) - rank(a));
    return { sig: c.sig, strong: c.strong, result: here.result, plies: here.plies, moves };
  }

  // Counts behind docs/ENDGAMES.md: for each material and goal, how positions with A to move
  // turn out, the longest win, and the positions where the bare king to move has no move.
  function report(types, goal = 'end') {
    const t = goal === 'end' ? table(types) : new Table(types, goal);
    const r = { sig: `K${types.map(x => NAMES[x]).join('')}vK`, goal, win: 0, draw: 0, longestWin: 0, checkmates: 0, stalemates: 0, defenderDraws: 0, defenderLosses: 0 };
    const all = types.length;
    for (let i = 0; i < t.size; i++) {
      const v = t.val[i];
      if (v === INVALID) continue;
      const [stm, ak, dk, p0, p1] = t.decode(i);
      if ((p0 !== NONE) + (p1 !== NONE) !== all) continue; // only positions with every piece on
      if (stm === 0) {
        if (v > 0) { r.win++; r.longestWin = Math.max(r.longestWin, v - 1); } else r.draw++;
      } else {
        if (v < 0) r.defenderLosses++; else r.defenderDraws++;
        if (t.gen(stm, ak, dk, p0, p1) === 0) {
          if (t.pieceAttacks(dk, ak, dk, p0, p1)) r.checkmates++;
          else r.stalemates++;
        }
      }
    }
    return r;
  }

  const api = { probe, supports, ready, report, Table, table, NONE, KNIGHT, BISHOP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Endgame = api;

  // node web/endgame.js: the counts for every lone-piece ending, both goals.
  if (typeof require === 'function' && typeof module !== 'undefined' && require.main === module) {
    for (const types of [[BISHOP], [KNIGHT], [KNIGHT, KNIGHT], [KNIGHT, BISHOP], [BISHOP, BISHOP]]) {
      for (const goal of ['end', 'checkmate']) console.log(JSON.stringify(report(types, goal)));
    }
  }
})(typeof self !== 'undefined' ? self : globalThis);
