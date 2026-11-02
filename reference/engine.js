'use strict';
// StockKnight reference engine: the KnightChess rules (docs/RULES.md), the hand-written
// evaluation G0 and the alpha-beta search. The Rust engine is a port of this file and must
// reproduce it exactly: same move generation order, same hash keys, same search tree.

const RULESET = 'knightchess-2';

// ---------------------------------------------------------------------------------------------
// Conventions (docs/RULES.md, "Notation")
// sq = rank * 6 + file; piece code = type | (color << 3); move = to | from << 6 | dropType << 12
// ---------------------------------------------------------------------------------------------

const WHITE = 0, BLACK = 1;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const DROP_TYPES = [PAWN, BISHOP, ROOK];
const PIECE_CHARS = '.PNBRQK..pnbrqk.';
const MATE = 30000;
const MATE_BOUND = MATE - 1000;
const RESERVE_MAX = [0, 2, 0, 1, 1, 0, 0]; // per type: 2 pawns, 1 bishop, 1 rook

const fileOf = sq => sq % 6;
const rankOf = sq => (sq / 6) | 0;
const colorOf = code => code >> 3;
const typeOf = code => code & 7;
const makeCode = (type, color) => type | (color << 3);
const sqName = sq => 'abcdef'[fileOf(sq)] + (rankOf(sq) + 1);
const parseSq = s => {
  if (!/^[a-f][1-6]$/.test(s)) return -1;
  return (s.charCodeAt(1) - 49) * 6 + (s.charCodeAt(0) - 97);
};

const encodeMove = (from, to, dropType = 0) => to | (from << 6) | (dropType << 12);
const moveTo = m => m & 63;
const moveFrom = m => (m >> 6) & 63;
const moveDrop = m => m >> 12;

// The rank a pawn of `color` may never enter, and whether a rank is in that pawn's enemy half.
const farRank = color => (color === WHITE ? 5 : 0);
const inEnemyHalf = (color, rank) => (color === WHITE ? rank >= 3 : rank <= 2);

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

function jumps(deltas) {
  const table = [];
  for (let sq = 0; sq < 36; sq++) {
    const list = [];
    for (const [df, dr] of deltas) {
      const f = fileOf(sq) + df, r = rankOf(sq) + dr;
      if (f >= 0 && f < 6 && r >= 0 && r < 6) list.push(r * 6 + f);
    }
    table.push(list);
  }
  return table;
}

const KNIGHT_JUMPS = jumps([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
const KING_STEPS = jumps([[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]]);

function rays(dirs) {
  const table = [];
  for (let sq = 0; sq < 36; sq++) {
    const out = [];
    for (const [df, dr] of dirs) {
      const ray = [];
      let f = fileOf(sq) + df, r = rankOf(sq) + dr;
      while (f >= 0 && f < 6 && r >= 0 && r < 6) {
        ray.push(r * 6 + f);
        f += df;
        r += dr;
      }
      if (ray.length) out.push(ray);
    }
    table.push(out);
  }
  return table;
}

const DIAG_RAYS = rays([[1, 1], [1, -1], [-1, -1], [-1, 1]]);
const ORTHO_RAYS = rays([[0, 1], [1, 0], [0, -1], [-1, 0]]);

// PAWN_STEPS[color][sq]: the squares a pawn of `color` on `sq` moves or captures to, in order:
// forward, then left, then right (left/right only in the enemy half). Never the far rank.
const PAWN_STEPS = [WHITE, BLACK].map(color => {
  const table = [];
  for (let sq = 0; sq < 36; sq++) {
    const list = [];
    const f = fileOf(sq), r = rankOf(sq);
    const fr = r + (color === WHITE ? 1 : -1);
    if (fr >= 0 && fr < 6) list.push(fr * 6 + f);
    if (inEnemyHalf(color, r)) {
      if (f > 0) list.push(r * 6 + f - 1);
      if (f < 5) list.push(r * 6 + f + 1);
    }
    table.push(list);
  }
  return table;
});

// PAWN_ATTACKERS[color][sq]: squares from which a pawn of `color` attacks `sq`.
const PAWN_ATTACKERS = [WHITE, BLACK].map(color => {
  const table = Array.from({ length: 36 }, () => []);
  for (let sq = 0; sq < 36; sq++) for (const to of PAWN_STEPS[color][sq]) table[to].push(sq);
  return table;
});

// ---------------------------------------------------------------------------------------------
// Zobrist keys: mulberry32 seeded with 0x6C6573, drawn in this order, each key as (lo, hi):
//   piece code 0..15 × square 0..35; color 0..1 × drop type (P, B, R) × count 0..2; side to move.
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const Z = (() => {
  const rng = mulberry32(0x6c6573);
  const pieceLo = new Uint32Array(16 * 36), pieceHi = new Uint32Array(16 * 36);
  for (let i = 0; i < 16 * 36; i++) {
    pieceLo[i] = rng();
    pieceHi[i] = rng();
  }
  const handLo = new Uint32Array(2 * 7 * 3), handHi = new Uint32Array(2 * 7 * 3);
  for (let c = 0; c < 2; c++) {
    for (const t of DROP_TYPES) {
      for (let n = 0; n < 3; n++) {
        const i = (c * 7 + t) * 3 + n;
        handLo[i] = rng();
        handHi[i] = rng();
      }
    }
  }
  return { pieceLo, pieceHi, handLo, handHi, sideLo: rng(), sideHi: rng() };
})();

// ---------------------------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------------------------

const START_FEN = 'rnkqnb/pppppp/6/6/PPPPPP/BNQKNR[PPRBpprb] w 0 1';

class Position {
  constructor(fen = START_FEN) {
    this.setFen(fen);
  }

  setFen(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length !== 4) throw new Error(`bad FEN: expected 4 fields: ${fen}`);
    const m = /^([^\[]+)\[([PBRpbr]*|-)\]$/.exec(parts[0]);
    if (!m) throw new Error(`bad FEN board or reserves: ${fen}`);
    const rows = m[1].split('/');
    if (rows.length !== 6) throw new Error(`bad FEN: expected 6 ranks: ${fen}`);

    this.board = new Int8Array(36);
    this.hand = [new Int8Array(7), new Int8Array(7)];
    this.pawnFile = [new Int8Array(6), new Int8Array(6)];
    this.rbCount = [0, 0];
    this.kingSq = [-1, -1];

    for (let i = 0; i < 6; i++) {
      const rank = 5 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '6') {
          file += ch.charCodeAt(0) - 48;
        } else {
          const code = PIECE_CHARS.indexOf(ch);
          if (code <= 0 || ch === '.') throw new Error(`bad FEN piece '${ch}': ${fen}`);
          if (file > 5) throw new Error(`bad FEN: rank too long: ${fen}`);
          const sq = rank * 6 + file;
          const color = colorOf(code), type = typeOf(code);
          if (type === KING) {
            if (this.kingSq[color] >= 0) throw new Error(`bad FEN: two kings: ${fen}`);
            this.kingSq[color] = sq;
          }
          this.board[sq] = code;
          file++;
        }
      }
      if (file !== 6) throw new Error(`bad FEN: rank ${rank + 1} has ${file} files: ${fen}`);
    }
    if (this.kingSq[WHITE] < 0 || this.kingSq[BLACK] < 0) {
      throw new Error(`bad FEN: missing king: ${fen}`);
    }

    if (m[2] !== '-') {
      for (const ch of m[2]) {
        const code = PIECE_CHARS.indexOf(ch);
        const color = colorOf(code), type = typeOf(code);
        this.hand[color][type]++;
        if (this.hand[color][type] > RESERVE_MAX[type]) {
          throw new Error(`bad FEN: too many '${ch}' in reserve: ${fen}`);
        }
      }
    }

    if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error(`bad FEN side: ${fen}`);
    this.side = parts[1] === 'w' ? WHITE : BLACK;
    if (!/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) {
      throw new Error(`bad FEN counters: ${fen}`);
    }
    this.clock = parseInt(parts[2], 10);
    this.moveNo = Math.max(1, parseInt(parts[3], 10));

    for (let sq = 0; sq < 36; sq++) {
      const code = this.board[sq];
      if (!code) continue;
      const type = typeOf(code), color = colorOf(code);
      if (type === PAWN) this.pawnFile[color][fileOf(sq)]++;
      if (type === BISHOP || type === ROOK) this.rbCount[color]++;
    }

    this.computeHash();
    this.undo = [];
    this.keysLo = [this.hashLo];
    this.keysHi = [this.hashHi];

    if (this.inCheck(this.side ^ 1)) {
      throw new Error(`bad FEN: the side not to move is in check: ${fen}`);
    }
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 36; sq++) {
      const code = this.board[sq];
      if (code) {
        lo ^= Z.pieceLo[code * 36 + sq];
        hi ^= Z.pieceHi[code * 36 + sq];
      }
    }
    for (let c = 0; c < 2; c++) {
      for (const t of DROP_TYPES) {
        const i = (c * 7 + t) * 3 + this.hand[c][t];
        lo ^= Z.handLo[i];
        hi ^= Z.handHi[i];
      }
    }
    if (this.side === BLACK) {
      lo ^= Z.sideLo;
      hi ^= Z.sideHi;
    }
    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
  }

  fen() {
    const rows = [];
    for (let rank = 5; rank >= 0; rank--) {
      let row = '', empty = 0;
      for (let file = 0; file < 6; file++) {
        const code = this.board[rank * 6 + file];
        if (!code) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        row += PIECE_CHARS[code];
      }
      if (empty) row += empty;
      rows.push(row);
    }
    let reserves = '';
    for (let c = 0; c < 2; c++) {
      for (const t of [PAWN, ROOK, BISHOP]) {
        reserves += PIECE_CHARS[makeCode(t, c)].repeat(this.hand[c][t]);
      }
    }
    return `${rows.join('/')}[${reserves || '-'}] ${this.side === WHITE ? 'w' : 'b'} ${this.clock} ${this.moveNo}`;
  }

  // --- attacks --------------------------------------------------------------------------------

  // Whether `sq` is attacked by a piece of color `by`. Kings never attack.
  isAttacked(sq, by) {
    const b = this.board;
    const pawn = makeCode(PAWN, by);
    for (const from of PAWN_ATTACKERS[by][sq]) if (b[from] === pawn) return true;
    const knight = makeCode(KNIGHT, by);
    for (const from of KNIGHT_JUMPS[sq]) if (b[from] === knight) return true;
    const queen = makeCode(QUEEN, by);
    for (const from of KING_STEPS[sq]) if (b[from] === queen) return true;
    const bishop = makeCode(BISHOP, by);
    for (const ray of DIAG_RAYS[sq]) {
      for (const s of ray) {
        if (b[s]) {
          if (b[s] === bishop) return true;
          break;
        }
      }
    }
    const rook = makeCode(ROOK, by);
    for (const ray of ORTHO_RAYS[sq]) {
      for (const s of ray) {
        if (b[s]) {
          if (b[s] === rook) return true;
          break;
        }
      }
    }
    return false;
  }

  inCheck(color = this.side) {
    return this.isAttacked(this.kingSq[color], color ^ 1);
  }

  // --- move generation ------------------------------------------------------------------------

  // Pseudo-legal moves (they may leave the own king attacked). Order: board moves by square
  // a1..f6, then drops by type (P, B, R) and square a1..f6. `capturesOnly` skips quiet moves
  // and drops. Kings are never captured.
  genMoves(list = [], capturesOnly = false) {
    const b = this.board, us = this.side, them = us ^ 1;
    const target = to => {
      const code = b[to];
      if (!code) return capturesOnly ? 0 : 1;
      return colorOf(code) === them && typeOf(code) !== KING ? 2 : 0;
    };
    for (let from = 0; from < 36; from++) {
      const code = b[from];
      if (!code || colorOf(code) !== us) continue;
      const type = typeOf(code);
      if (type === PAWN) {
        for (const to of PAWN_STEPS[us][from]) if (target(to)) list.push(encodeMove(from, to));
      } else if (type === KNIGHT) {
        for (const to of KNIGHT_JUMPS[from]) if (target(to)) list.push(encodeMove(from, to));
      } else if (type === QUEEN || type === KING) {
        for (const to of KING_STEPS[from]) if (target(to)) list.push(encodeMove(from, to));
      } else {
        const rayTable = type === BISHOP ? DIAG_RAYS : ORTHO_RAYS;
        for (const ray of rayTable[from]) {
          for (const to of ray) {
            const t = target(to);
            if (t) list.push(encodeMove(from, to));
            if (b[to]) break;
          }
        }
      }
    }
    if (capturesOnly) return list;

    const hand = this.hand[us];
    if (hand[PAWN] > 0) {
      for (let to = 0; to < 36; to++) {
        if (b[to] || rankOf(to) === farRank(us) || this.pawnFile[us][fileOf(to)]) continue;
        list.push(encodeMove(0, to, PAWN));
      }
    }
    if (this.rbCount[us] < 2) {
      for (const type of [BISHOP, ROOK]) {
        if (hand[type] <= 0) continue;
        for (let to = 0; to < 36; to++) if (!b[to]) list.push(encodeMove(0, to, type));
      }
    }
    return list;
  }

  legalMoves() {
    const out = [];
    for (const m of this.genMoves()) {
      this.makeMove(m);
      if (!this.inCheck(this.side ^ 1)) out.push(m);
      this.unmakeMove();
    }
    return out;
  }

  hasLegalMove() {
    for (const m of this.genMoves()) {
      this.makeMove(m);
      const ok = !this.inCheck(this.side ^ 1);
      this.unmakeMove();
      if (ok) return true;
    }
    return false;
  }

  // --- make / unmake --------------------------------------------------------------------------

  togglePiece(code, sq) {
    this.hashLo = (this.hashLo ^ Z.pieceLo[code * 36 + sq]) >>> 0;
    this.hashHi = (this.hashHi ^ Z.pieceHi[code * 36 + sq]) >>> 0;
  }

  toggleHand(color, type) {
    const i = (color * 7 + type) * 3 + this.hand[color][type];
    this.hashLo = (this.hashLo ^ Z.handLo[i]) >>> 0;
    this.hashHi = (this.hashHi ^ Z.handHi[i]) >>> 0;
  }

  removePiece(sq) {
    const code = this.board[sq];
    const color = colorOf(code), type = typeOf(code);
    this.togglePiece(code, sq);
    this.board[sq] = 0;
    if (type === PAWN) this.pawnFile[color][fileOf(sq)]--;
    else if (type === BISHOP || type === ROOK) this.rbCount[color]--;
  }

  putPiece(code, sq) {
    const color = colorOf(code), type = typeOf(code);
    this.togglePiece(code, sq);
    this.board[sq] = code;
    if (type === PAWN) this.pawnFile[color][fileOf(sq)]++;
    else if (type === BISHOP || type === ROOK) this.rbCount[color]++;
    else if (type === KING) this.kingSq[color] = sq;
  }

  makeMove(m) {
    const us = this.side;
    const from = moveFrom(m), to = moveTo(m), drop = moveDrop(m);
    const entry = { m, captured: 0, clock: this.clock, lo: this.hashLo, hi: this.hashHi };
    if (drop) {
      this.toggleHand(us, drop);
      this.hand[us][drop]--;
      this.toggleHand(us, drop);
      this.putPiece(makeCode(drop, us), to);
      this.clock = 0;
    } else {
      const code = this.board[from];
      const captured = this.board[to];
      entry.captured = captured;
      if (captured) this.removePiece(to);
      this.removePiece(from);
      this.putPiece(code, to);
      const forwardPawn = typeOf(code) === PAWN && fileOf(from) === fileOf(to);
      this.clock = captured || forwardPawn ? 0 : this.clock + 1;
    }
    this.side ^= 1;
    this.hashLo = (this.hashLo ^ Z.sideLo) >>> 0;
    this.hashHi = (this.hashHi ^ Z.sideHi) >>> 0;
    if (us === BLACK) this.moveNo++;
    this.undo.push(entry);
    this.keysLo.push(this.hashLo);
    this.keysHi.push(this.hashHi);
  }

  unmakeMove() {
    const entry = this.undo.pop();
    this.keysLo.pop();
    this.keysHi.pop();
    this.side ^= 1;
    const us = this.side;
    if (us === BLACK) this.moveNo--;
    const m = entry.m;
    const from = moveFrom(m), to = moveTo(m), drop = moveDrop(m);
    if (drop) {
      this.removePiece(to);
      this.hand[us][drop]++;
    } else {
      const code = this.board[to];
      this.removePiece(to);
      this.putPiece(code, from);
      if (entry.captured) this.putPiece(entry.captured, to);
    }
    this.clock = entry.clock;
    this.hashLo = entry.lo;
    this.hashHi = entry.hi;
  }

  // --- game status ----------------------------------------------------------------------------

  // How many times the current position has occurred, bounded by the quiet-ply counter.
  repetitionCount() {
    const n = this.keysLo.length - 1;
    const lo = this.keysLo[n], hi = this.keysHi[n];
    let count = 1;
    for (let i = n - 2; i >= 0 && n - i <= this.clock; i -= 2) {
      if (this.keysLo[i] === lo && this.keysHi[i] === hi) count++;
    }
    return count;
  }

  // Whether the current position occurred earlier within the last `plies` plies (search draw).
  repeatsWithin(plies) {
    const n = this.keysLo.length - 1;
    const lo = this.keysLo[n], hi = this.keysHi[n];
    const limit = Math.min(plies, this.clock);
    for (let i = n - 2; i >= 0 && n - i <= limit; i -= 2) {
      if (this.keysLo[i] === lo && this.keysHi[i] === hi) return true;
    }
    return false;
  }

  bareKings() {
    for (let sq = 0; sq < 36; sq++) {
      const code = this.board[sq];
      if (code && typeOf(code) !== KING) return false;
    }
    for (let c = 0; c < 2; c++) for (const t of DROP_TYPES) if (this.hand[c][t]) return false;
    return true;
  }

  // { state: 'ongoing' } | { state: 'win', winner, reason: 'checkmate'|'stalemate' }
  // | { state: 'draw', reason: 'threefold'|'bare kings' }
  status() {
    if (this.repetitionCount() >= 3) return { state: 'draw', reason: 'threefold' };
    if (this.bareKings()) return { state: 'draw', reason: 'bare kings' };
    if (!this.hasLegalMove()) {
      return {
        state: 'win',
        winner: this.side ^ 1,
        reason: this.inCheck() ? 'checkmate' : 'stalemate',
      };
    }
    return { state: 'ongoing' };
  }

  // --- notation -------------------------------------------------------------------------------

  moveToUci(m) {
    const drop = moveDrop(m);
    if (drop) return `${PIECE_CHARS[drop]}@${sqName(moveTo(m))}`;
    return sqName(moveFrom(m)) + sqName(moveTo(m));
  }

  // A legal move from its UCI text, or 0.
  moveFromUci(text) {
    for (const m of this.legalMoves()) if (this.moveToUci(m) === text) return m;
    return 0;
  }

  // Scoresheet text for a legal move in this position: `Nb1-c3`, `c4xc5`, `R@c4`, with `+`
  // when the move attacks the opposing king and `#` when the opponent then has no legal move.
  moveToText(m) {
    const drop = moveDrop(m), from = moveFrom(m), to = moveTo(m);
    let text;
    if (drop) {
      text = `${PIECE_CHARS[drop]}@${sqName(to)}`;
    } else {
      const type = typeOf(this.board[from]);
      const letter = type === PAWN ? '' : PIECE_CHARS[type];
      text = letter + sqName(from) + (this.board[to] ? 'x' : '-') + sqName(to);
    }
    this.makeMove(m);
    if (!this.hasLegalMove()) text += '#';
    else if (this.inCheck()) text += '+';
    this.unmakeMove();
    return text;
  }

  perft(depth) {
    if (depth === 0) return 1;
    let total = 0;
    for (const m of this.genMoves()) {
      this.makeMove(m);
      if (!this.inCheck(this.side ^ 1)) total += depth === 1 ? 1 : this.perft(depth - 1);
      this.unmakeMove();
    }
    return total;
  }

  toString() {
    let s = '';
    for (let rank = 5; rank >= 0; rank--) {
      s += `${rank + 1} `;
      for (let file = 0; file < 6; file++) s += `${PIECE_CHARS[this.board[rank * 6 + file]]} `;
      s += '\n';
    }
    return `${s}  a b c d e f\n${this.fen()}`;
  }
}

// ---------------------------------------------------------------------------------------------
// G0: the hand-written evaluation. Centipawns from the side to move's view.
// Tables are from White's view, a1 first; Black reads them at 35 - sq.
// ---------------------------------------------------------------------------------------------

const VALUE = [0, 100, 290, 300, 450, 320, 0];

const PST = [
  null,
  // pawn: worth more once across the middle line; rank 6 is never reached
  [
    0, 0, 0, 0, 0, 0,
    0, 2, 4, 4, 2, 0,
    4, 8, 12, 12, 8, 4,
    18, 24, 28, 28, 24, 18,
    26, 32, 36, 36, 32, 26,
    0, 0, 0, 0, 0, 0,
  ],
  // knight
  [
    -30, -16, -10, -10, -16, -30,
    -16, 0, 8, 8, 0, -16,
    -10, 8, 18, 18, 8, -10,
    -10, 8, 18, 18, 8, -10,
    -16, 0, 8, 8, 0, -16,
    -30, -16, -10, -10, -16, -30,
  ],
  // bishop (mobility does most of the work)
  [
    -8, -4, -4, -4, -4, -8,
    -4, 4, 2, 2, 4, -4,
    -4, 2, 6, 6, 2, -4,
    -4, 2, 6, 6, 2, -4,
    -4, 4, 2, 2, 4, -4,
    -8, -4, -4, -4, -4, -8,
  ],
  // rook
  [
    0, 0, 2, 2, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    8, 10, 10, 10, 10, 8,
    4, 4, 4, 4, 4, 4,
  ],
  // queen (moves like a king)
  [
    -12, -6, -4, -4, -6, -12,
    -6, 0, 4, 4, 0, -6,
    -4, 4, 10, 10, 4, -4,
    -4, 4, 10, 10, 4, -4,
    -6, 0, 4, 4, 0, -6,
    -12, -6, -4, -4, -6, -12,
  ],
];

const KING_MIDDLE = [
  8, 12, 4, 4, 12, 8,
  0, 0, -8, -8, 0, 0,
  -16, -20, -24, -24, -20, -16,
  -28, -32, -36, -36, -32, -28,
  -36, -40, -44, -44, -40, -36,
  -40, -44, -48, -48, -44, -40,
];

const KING_END = [
  -20, -10, -6, -6, -10, -20,
  -10, 0, 6, 6, 0, -10,
  -6, 6, 14, 14, 6, -6,
  -6, 6, 14, 14, 6, -6,
  -10, 0, 6, 6, 0, -10,
  -20, -10, -6, -6, -10, -20,
];

const PHASE_WEIGHT = [0, 0, 1, 1, 2, 1, 0];
const PHASE_MAX = 2 * (2 + 1 + 2 + 1) + 2 * (1 + 2); // start material on board and in reserve

function evaluate(pos) {
  const b = pos.board;
  const score = [0, 0];
  let phase = 0;

  for (let sq = 0; sq < 36; sq++) {
    const code = b[sq];
    if (!code) continue;
    const color = colorOf(code), type = typeOf(code);
    const rel = color === WHITE ? sq : 35 - sq;
    phase += PHASE_WEIGHT[type];
    if (type === KING) continue;
    score[color] += VALUE[type] + PST[type][rel];
    if (type === BISHOP || type === ROOK) {
      const rayTable = type === BISHOP ? DIAG_RAYS : ORTHO_RAYS;
      let mobility = 0;
      for (const ray of rayTable[sq]) {
        for (const s of ray) {
          if (b[s] && colorOf(b[s]) === color) break;
          mobility++;
          if (b[s]) break;
        }
      }
      score[color] += 4 * mobility;
    }
  }

  for (let c = 0; c < 2; c++) {
    const hand = pos.hand[c];
    phase += PHASE_WEIGHT[BISHOP] * hand[BISHOP] + PHASE_WEIGHT[ROOK] * hand[ROOK];
    if (hand[PAWN]) {
      let freeFiles = 0;
      for (let f = 0; f < 6; f++) if (!pos.pawnFile[c][f]) freeFiles++;
      score[c] += hand[PAWN] * (freeFiles >= hand[PAWN] ? 90 : 50);
    }
    const open = pos.rbCount[c] < 2;
    score[c] += hand[BISHOP] * (open ? 270 : 210) + hand[ROOK] * (open ? 410 : 320);
  }

  phase = Math.min(phase, PHASE_MAX);
  for (let c = 0; c < 2; c++) {
    const ksq = pos.kingSq[c];
    const rel = c === WHITE ? ksq : 35 - ksq;
    score[c] += Math.round((KING_MIDDLE[rel] * phase + KING_END[rel] * (PHASE_MAX - phase)) / PHASE_MAX);
    let shelter = 0;
    for (const s of KING_STEPS[ksq]) if (b[s] && colorOf(b[s]) === c) shelter++;
    score[c] += Math.round((6 * shelter * phase) / PHASE_MAX);
  }

  const us = pos.side;
  return score[us] - score[us ^ 1] + 8;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
const MAX_PLY = 96;

const LEVELS = {
  casual: { depth: 2, movetime: 600, randomMargin: 90 },
  club: { depth: 7, movetime: 1000 },
  strong: { movetime: 3000 },
};

function mateIn(score) {
  if (Math.abs(score) < MATE_BOUND) return 0;
  const plies = MATE - Math.abs(score);
  const moves = Math.ceil(plies / 2);
  return score > 0 ? moves : -moves;
}

// History index: from-square for board moves, 36 + drop type for drops (2 × 41 × 36 table).
const historyIndex = (side, m) => (side * 41 + (moveDrop(m) ? 36 + moveDrop(m) : moveFrom(m))) * 36 + moveTo(m);

class Searcher {
  constructor() {
    this.ttKey = new Uint32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttScore = new Int32Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE);
    this.ttFlag = new Int8Array(TT_SIZE);
    this.history = new Int32Array(2 * 41 * 36);
    this.killers = new Int32Array(MAX_PLY * 2);
  }

  clear() {
    this.ttKey.fill(0);
    this.ttMove.fill(0);
    this.ttScore.fill(0);
    this.ttDepth.fill(0);
    this.ttFlag.fill(0);
    this.history.fill(0);
    this.killers.fill(0);
  }

  // limits: { depth, nodes, movetime, randomMargin, random } (random: a () => [0, 1) source)
  // onInfo({ depth, score, nodes, elapsed, pv }) after every completed iteration.
  think(pos, limits = {}, onInfo = null) {
    this.pos = pos;
    this.nodes = 0;
    this.stopped = false;
    this.start = Date.now();
    this.maxNodes = limits.nodes || Infinity;
    this.deadline = limits.movetime ? this.start + limits.movetime : Infinity;
    const maxDepth = Math.min(limits.depth || 64, MAX_PLY - 8);
    const margin = limits.randomMargin || 0;
    const random = limits.random || Math.random;
    this.killers.fill(0);
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 2;

    const rootMoves = pos.legalMoves();
    const result = { best: 0, score: 0, depth: 0, nodes: 0, elapsed: 0, pv: [] };
    if (!rootMoves.length) {
      result.score = -MATE;
      return result;
    }
    let order = rootMoves.slice();
    let scores = new Map();

    for (let depth = 1; depth <= maxDepth; depth++) {
      const { best, score, moveScores, complete } = this.searchRoot(order, depth, margin > 0);
      if (!complete && depth > 1) break;
      result.best = best;
      result.score = score;
      result.depth = depth;
      scores = moveScores;
      order = [best, ...order.filter(m => m !== best)];
      result.pv = this.principalVariation(best, depth);
      result.nodes = this.nodes;
      result.elapsed = Date.now() - this.start;
      if (onInfo) onInfo({ ...result });
      if (!complete || this.stopped) break;
      if (Math.abs(score) >= MATE_BOUND && depth >= MATE - Math.abs(score)) break;
    }

    if (margin > 0 && scores.size) {
      const near = order.filter(m => scores.get(m) >= result.score - margin);
      const pick = near[Math.floor(random() * near.length)];
      if (pick !== result.best) {
        result.best = pick;
        result.score = scores.get(pick);
        result.pv = [pick];
      }
    }
    result.nodes = this.nodes;
    result.elapsed = Date.now() - this.start;
    return result;
  }

  searchRoot(order, depth, exactAll) {
    const pos = this.pos;
    let alpha = -MATE - 1;
    const beta = MATE + 1;
    let best = order[0], bestScore = -MATE - 1;
    const moveScores = new Map();
    for (let i = 0; i < order.length; i++) {
      const m = order[i];
      pos.makeMove(m);
      let score;
      if (i === 0 || exactAll) {
        score = -this.negamax(depth - 1, -beta, -alpha, 1);
      } else {
        score = -this.negamax(depth - 1, -alpha - 1, -alpha, 1);
        if (score > alpha && !this.stopped) score = -this.negamax(depth - 1, -beta, -alpha, 1);
      }
      pos.unmakeMove();
      if (this.stopped) return { best, score: bestScore, moveScores, complete: false };
      moveScores.set(m, score);
      if (score > bestScore) {
        bestScore = score;
        best = m;
        if (!exactAll && score > alpha) alpha = score;
      }
    }
    this.storeTT(depth, bestScore, TT_EXACT, best, 0);
    return { best, score: bestScore, moveScores, complete: true };
  }

  checkLimits() {
    if (this.nodes >= this.maxNodes) this.stopped = true;
    else if ((this.nodes & 1023) === 0 && Date.now() >= this.deadline) this.stopped = true;
  }

  ttIndex() {
    return this.pos.hashLo & (TT_SIZE - 1);
  }

  storeTT(depth, score, flag, move, ply) {
    const i = this.ttIndex();
    if (score >= MATE_BOUND) score += ply;
    else if (score <= -MATE_BOUND) score -= ply;
    this.ttKey[i] = this.pos.hashHi;
    this.ttMove[i] = move;
    this.ttScore[i] = score;
    this.ttDepth[i] = depth;
    this.ttFlag[i] = flag;
  }

  negamax(depth, alpha, beta, ply) {
    const pos = this.pos;
    this.nodes++;
    this.checkLimits();
    if (this.stopped) return 0;

    if (pos.repeatsWithin(Infinity) || pos.bareKings()) return 0;
    alpha = Math.max(alpha, -MATE + ply);
    beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;

    const inCheck = pos.inCheck();
    if (inCheck && ply < MAX_PLY - 8) depth++;
    if (depth <= 0 || ply >= MAX_PLY - 2) return this.quiesce(alpha, beta, ply);

    const pvNode = beta - alpha > 1;
    const i = this.ttIndex();
    let ttMove = 0;
    if (this.ttKey[i] === pos.hashHi && this.ttFlag[i]) {
      ttMove = this.ttMove[i];
      if (!pvNode && this.ttDepth[i] >= depth) {
        let s = this.ttScore[i];
        if (s >= MATE_BOUND) s -= ply;
        else if (s <= -MATE_BOUND) s += ply;
        const flag = this.ttFlag[i];
        if (flag === TT_EXACT || (flag === TT_LOWER && s >= beta) || (flag === TT_UPPER && s <= alpha)) {
          return s;
        }
      }
    }

    const moves = this.orderMoves(pos.genMoves(), ttMove, ply);
    const alphaStart = alpha;
    let best = 0, bestScore = -MATE - 1, legal = 0;
    for (const m of moves) {
      const capture = !moveDrop(m) && pos.board[moveTo(m)] !== 0;
      pos.makeMove(m);
      if (pos.inCheck(pos.side ^ 1)) {
        pos.unmakeMove();
        continue;
      }
      legal++;
      let score;
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      } else {
        let reduction = 0;
        if (depth >= 3 && legal > 3 && !capture && !inCheck && !pos.inCheck()) {
          reduction = legal > 8 ? 2 : 1;
        }
        score = -this.negamax(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && reduction) score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      }
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!capture) {
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2];
            this.killers[ply * 2] = m;
          }
          this.history[historyIndex(pos.side, m)] += depth * depth;
        }
        break;
      }
    }

    if (!legal) return -MATE + ply; // checkmate and stalemate both lose
    const flag = bestScore >= beta ? TT_LOWER : bestScore > alphaStart ? TT_EXACT : TT_UPPER;
    this.storeTT(depth, bestScore, flag, best, ply);
    return bestScore;
  }

  quiesce(alpha, beta, ply) {
    const pos = this.pos;
    this.nodes++;
    this.checkLimits();
    if (this.stopped) return 0;

    const inCheck = pos.inCheck();
    let bestScore = -MATE + ply;
    if (!inCheck) {
      const stand = evaluate(pos);
      if (stand >= beta || ply >= MAX_PLY - 1) return stand;
      if (stand > alpha) alpha = stand;
      bestScore = stand;
    }

    const moves = this.orderMoves(pos.genMoves([], !inCheck), 0, ply);
    for (const m of moves) {
      pos.makeMove(m);
      if (pos.inCheck(pos.side ^ 1)) {
        pos.unmakeMove();
        continue;
      }
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > bestScore) bestScore = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return bestScore;
  }

  // Order: TT move, captures (most valuable victim, then least valuable attacker), killers,
  // then quiet moves and drops by history. Stable for equal keys, so the order is deterministic.
  orderMoves(moves, ttMove, ply) {
    const pos = this.pos, b = pos.board;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const keyed = moves.map((m, i) => {
      let key;
      if (m === ttMove) key = 1e9;
      else if (!moveDrop(m) && b[moveTo(m)]) {
        key = 1e8 + VALUE[typeOf(b[moveTo(m)])] * 10 - VALUE[typeOf(b[moveFrom(m)])] / 10;
      } else if (m === k1) key = 9e7;
      else if (m === k2) key = 8e7;
      else key = this.history[historyIndex(pos.side, m)];
      return { m, key, i };
    });
    keyed.sort((x, y) => y.key - x.key || x.i - y.i);
    return keyed.map(x => x.m);
  }

  principalVariation(first, depth) {
    const pos = this.pos;
    const pv = [first];
    pos.makeMove(first);
    let made = 1;
    while (pv.length < depth) {
      const i = this.ttIndex();
      if (this.ttKey[i] !== pos.hashHi || !this.ttMove[i]) break;
      const m = this.ttMove[i];
      if (!pos.legalMoves().includes(m)) break;
      pv.push(m);
      pos.makeMove(m);
      made++;
      if (pos.repetitionCount() >= 2) break;
    }
    while (made--) pos.unmakeMove();
    return pv;
  }
}

const api = {
  RULESET, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, MATE, START_FEN, LEVELS,
  Position, Searcher, evaluate, mateIn, encodeMove, moveFrom, moveTo, moveDrop, sqName, parseSq,
  PAWN_STEPS, Z,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.StockKnight = api;
