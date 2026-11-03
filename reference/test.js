'use strict';
// Rule tests for the reference engine: `node reference/test.js`.

const assert = require('node:assert/strict');
const E = require('./engine.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const uciMoves = pos => pos.legalMoves().map(m => pos.moveToUci(m)).sort();
const pieceMoves = (pos, from) => uciMoves(pos).filter(u => u.startsWith(from));
const play = (pos, ...ucis) => {
  for (const u of ucis) {
    const m = pos.moveFromUci(u);
    assert.ok(m, `illegal move ${u} in ${pos.fen()}`);
    pos.makeMove(m);
  }
};

// Perft from the start position, depths 1-5: the reference numbers for every other engine.
const PERFT = [10, 100, 1185, 13788, 181968];

test('start position', () => {
  const pos = new E.Position();
  assert.equal(pos.fen(), E.START_FEN);
  assert.equal(pos.legalMoves().length, 10);
  assert.equal(E.RULESET, 'knightchess-2');
});

test('perft counts', () => {
  const pos = new E.Position();
  PERFT.forEach((n, i) => assert.equal(pos.perft(i + 1), n, `perft(${i + 1})`));
  assert.equal(pos.fen(), E.START_FEN);
});

test('pawn in own half moves only forward', () => {
  const pos = new E.Position('2k3/6/6/2P3/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(pos, 'c3'), ['c3c4']);
});

test('pawn in enemy half moves forward, left and right', () => {
  const pos = new E.Position('2k3/6/2P3/6/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(pos, 'c4'), ['c4b4', 'c4c5', 'c4d4']);
});

test('pawn captures straight ahead and sideways, never diagonally', () => {
  const own = new E.Position('2k3/6/1nb3/2P3/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(own, 'c3'), ['c3c4']);
  const enemy = new E.Position('2k3/1nbn2/1pPp2/6/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(enemy, 'c4'), ['c4b4', 'c4c5', 'c4d4']);
});

test('pawn enters the far rank and checks there', () => {
  const pos = new E.Position('1k4/2P3/6/6/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(pos, 'c5'), ['c5b5', 'c5c6', 'c5d5']);
  assert.ok(new E.Position('2k3/2P3/6/6/6/3K2[-] b 0 1').inCheck(E.BLACK), 'a pawn on rank 5 attacks rank 6');
  const black = new E.Position('3k2/6/6/6/3p2/2K3[-] b 0 1');
  assert.deepEqual(pieceMoves(black, 'd2'), ['d2c2', 'd2d1', 'd2e2']);
  const far = new E.Position('2P3/6/6/k5/6/3K2[-] w 0 1');
  assert.deepEqual(pieceMoves(far, 'c6'), ['c6b6', 'c6d6']);
});

test('black pawns mirror white pawns', () => {
  const own = new E.Position('3k2/6/3p2/6/6/2K3[-] b 0 1');
  assert.deepEqual(pieceMoves(own, 'd4'), ['d4d3']);
  const enemy = new E.Position('3k2/6/6/3p2/6/2K3[-] b 0 1');
  assert.deepEqual(pieceMoves(enemy, 'd3'), ['d3c3', 'd3d2', 'd3e3']);
});

test('pawn attacks follow the half it stands in', () => {
  assert.ok(new E.Position('6/6/3Pk1/6/6/K5[-] b 0 1').inCheck(), 'sideways check in the enemy half');
  assert.ok(!new E.Position('6/6/6/3Pk1/6/K5[-] b 0 1').inCheck(), 'no sideways attack in the own half');
  assert.ok(new E.Position('6/6/3k2/3P2/6/K5[-] b 0 1').inCheck(), 'straight-ahead check');
  assert.ok(!new E.Position('6/6/6/2k3/3P2/K5[-] b 0 1').inCheck(), 'no diagonal attack');
});

test('pawns may be dropped on the far rank', () => {
  const pos = new E.Position('2k3/6/6/6/6/3K2[P] w 0 1');
  const drops = uciMoves(pos).filter(u => u.startsWith('P@'));
  assert.equal(drops.length, 34);
  assert.ok(drops.includes('P@a6'));
  const black = new E.Position('2k3/6/6/6/6/3K2[p] b 0 1');
  assert.ok(uciMoves(black).filter(u => u.startsWith('P@')).includes('P@a1'));
});

test('pawn drop file rule follows sideways moves', () => {
  const pos = new E.Position('2k3/6/2P3/6/6/3K2[P] w 0 1');
  let drops = uciMoves(pos).filter(u => u.startsWith('P@'));
  assert.ok(!drops.some(u => u[2] === 'c'));
  play(pos, 'c4d4', 'c6b6');
  drops = uciMoves(pos).filter(u => u.startsWith('P@'));
  assert.ok(drops.some(u => u[2] === 'c'), 'file c is free again');
  assert.ok(!drops.some(u => u[2] === 'd'), 'file d now holds a pawn');
});

test('sideways steps keep the quiet-ply counter, forward steps reset it', () => {
  const pos = new E.Position('2k3/6/2P3/6/6/3K2[-] w 5 1');
  play(pos, 'c4b4');
  assert.equal(pos.clock, 6);
  pos.unmakeMove();
  play(pos, 'c4c5');
  assert.equal(pos.clock, 0);
});

test('kings never stand next to each other', () => {
  assert.throws(() => new E.Position('6/6/2kK2/6/6/6[-] w 0 1'));
  const pos = new E.Position('6/6/1k1K2/6/6/6[-] w 0 1');
  const moves = uciMoves(pos);
  for (const u of ['d4c3', 'd4c4', 'd4c5']) assert.ok(!moves.includes(u), u);
  assert.ok(moves.includes('d4e4'));
  const guarded = new E.Position('6/6/1k1K2/2r3/6/6[-] w 0 1');
  assert.ok(!uciMoves(guarded).includes('d4c3'), 'a king may not take a piece the other king defends');
});

test('rook and bishop drop cap', () => {
  const capped = new E.Position('2k3/6/6/6/6/B2K1R[R] w 0 1');
  assert.ok(!uciMoves(capped).some(u => u.startsWith('R@')));
  const open = new E.Position('2k3/6/6/6/6/3K1R[RB] w 0 1');
  assert.ok(uciMoves(open).some(u => u.startsWith('R@')));
  assert.ok(uciMoves(open).some(u => u.startsWith('B@')));
});

test('no legal move loses, by checkmate or stalemate', () => {
  const stalemate = new E.Position('k5/2Q3/6/1N4/6/5K[-] b 0 1');
  assert.ok(!stalemate.inCheck());
  assert.deepEqual(stalemate.status(), { state: 'win', winner: E.WHITE, reason: 'stalemate' });
  const mate = new E.Position('k5/2Q3/6/1N4/6/R4K[-] b 0 1');
  assert.deepEqual(mate.status(), { state: 'win', winner: E.WHITE, reason: 'checkmate' });
});

test('threefold repetition and bare kings draw; no fifty-move rule', () => {
  const pos = new E.Position();
  for (let i = 0; i < 2; i++) play(pos, 'b1a3', 'b6a4', 'a3b1', 'a4b6');
  assert.deepEqual(pos.status(), { state: 'draw', reason: 'threefold' });
  assert.deepEqual(new E.Position('2k3/6/6/6/6/3K2[-] w 0 1').status(), { state: 'draw', reason: 'bare kings' });
  assert.deepEqual(new E.Position('2k3/6/6/6/6/3K1R[-] w 400 300').status(), { state: 'ongoing' });
});

test('bad FENs are rejected', () => {
  for (const fen of [
    '2P3/6/6/6/6/3K2[-] w 0 1', // no black king
    '2k3/6/6/6/6/3K2[PPP] w 0 1', // three pawns in reserve
    '2k3/6/6/6/6/3K2[-] x 0 1',
    '2k3/6/6/6/3K2[-] w 0 1',
    '2k3/6/6/6/6/3K2 w 0 1',
    '2k3/2R3/6/6/6/3K2[-] w 0 1', // side not to move is in check
  ]) {
    assert.throws(() => new E.Position(fen), Error, fen);
  }
});

test('make and unmake keep every invariant in random games', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  for (let game = 0; game < 200; game++) {
    const pos = new E.Position();
    const fens = [pos.fen()];
    for (let ply = 0; ply < 150; ply++) {
      const moves = pos.legalMoves();
      if (!moves.length || pos.status().state !== 'ongoing') break;
      pos.makeMove(moves[Math.floor(rnd() * moves.length)]);
      fens.push(pos.fen());
      const { hashLo, hashHi } = pos;
      pos.computeHash();
      assert.equal(pos.hashLo, hashLo);
      assert.equal(pos.hashHi, hashHi);
      const copy = new E.Position(pos.fen());
      assert.equal(copy.hashLo, hashLo, 'FEN round trip keeps the hash');
      assert.deepEqual([...copy.pawnFile[0], ...copy.pawnFile[1]], [...pos.pawnFile[0], ...pos.pawnFile[1]]);
      assert.deepEqual(copy.rbCount, pos.rbCount);
    }
    while (pos.undo.length) {
      assert.equal(pos.fen(), fens.pop());
      pos.unmakeMove();
    }
    assert.equal(pos.fen(), E.START_FEN);
  }
});

test('move text', () => {
  const pos = new E.Position();
  assert.equal(pos.moveToText(pos.moveFromUci('b1c3')), 'Nb1-c3');
  assert.equal(pos.moveToText(pos.moveFromUci('a2a3')), 'a2-a3');
  const enemy = new E.Position('2k3/6/1pP3/6/6/3K2[R] w 0 1');
  assert.equal(enemy.moveToText(enemy.moveFromUci('c4b4')), 'c4xb4');
  assert.equal(enemy.moveToText(enemy.moveFromUci('R@c5')), 'R@c5+');
  const mate = new E.Position('k5/2Q3/6/1N4/6/5K[R] w 0 1');
  assert.equal(mate.moveToText(mate.moveFromUci('R@a1')), 'R@a1#');
});

test('search finds a forced win and reports it as mate', () => {
  const pos = new E.Position('k5/2Q3/6/1N4/6/5K[R] w 0 1');
  const result = new E.Searcher().think(pos, { depth: 4 });
  assert.equal(result.score, E.MATE - 1);
  assert.equal(E.mateIn(result.score), 1);
  pos.makeMove(result.best);
  assert.equal(pos.status().state, 'win');
});

test('search is deterministic at fixed depth', () => {
  const a = new E.Searcher().think(new E.Position(), { depth: 6 });
  const b = new E.Searcher().think(new E.Position(), { depth: 6 });
  assert.deepEqual([a.best, a.score, a.nodes, a.pv], [b.best, b.score, b.nodes, b.pv]);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
