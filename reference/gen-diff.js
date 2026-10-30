'use strict';
// Writes testdata/diff-positions.txt: random positions with what the Rust port must reproduce.
// Usage: node reference/gen-diff.js [count]
// Line format (tab-separated): FEN, legal moves (UCI, generation order, space-separated),
// status, in check (0/1), perft(2), G0 value, Zobrist key (16 hex digits, hi then lo).

const fs = require('node:fs');
const path = require('node:path');
const E = require('./engine.js');

const count = parseInt(process.argv[2] || '10000', 10);
let seed = 0x5eed;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};

const hex = n => n.toString(16).padStart(8, '0');
const lines = [];
while (lines.length < count) {
  const pos = new E.Position();
  const plies = 1 + Math.floor(rnd() * 80);
  for (let i = 0; i < plies; i++) {
    const moves = pos.legalMoves();
    if (!moves.length || pos.status().state !== 'ongoing') break;
    pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
  }
  // Repetition needs history, so positions are written from their FEN alone (no history).
  const fresh = new E.Position(pos.fen());
  const st = fresh.status();
  const status = st.state === 'ongoing' ? 'ongoing' : st.state === 'draw' ? `draw:${st.reason}` : `win:${st.winner ? 'b' : 'w'}:${st.reason}`;
  const legal = fresh.legalMoves().map(m => fresh.moveToUci(m)).join(' ');
  lines.push([fresh.fen(), legal, status, fresh.inCheck() ? 1 : 0, fresh.perft(2), E.evaluate(fresh), hex(fresh.hashHi) + hex(fresh.hashLo)].join('\t'));
}

const out = path.join(__dirname, '..', 'testdata', 'diff-positions.txt');
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`wrote ${lines.length} positions to ${out}`);
