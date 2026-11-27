'use strict';
// Checks the coach in Learn by playing (web/coach.js): each rule tip fires at the moment it
// should, every tip has text, and whole random games never trip it up.
//   node web/test-coach.js
const assert = require('node:assert');
const SK = require('../reference/engine.js');
const Coach = require('./coach.js');
const { Position, WHITE, BLACK } = SK;

let failures = 0, passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

// Plays `moves` (UCI) from `fen` and returns the tip ids for the last one, with the learner as `human`.
function tipsAfter(fen, moves, human = WHITE) {
  const pos = new Position(fen);
  for (const u of moves) {
    const m = pos.moveFromUci(u);
    assert.ok(m, `illegal move ${u} in ${pos.fen()}`);
    pos.makeMove(m);
  }
  return Coach.afterMove(pos, human, moves).map(t => t.id);
}

check('every tip has a title, a piece and text', () => {
  for (const [id, t] of Object.entries(Coach.TIPS)) {
    assert.ok(t.title && t.piece, id);
    assert.ok(Coach.tipText(id, { name: 'rook' }).includes('<p>'), id);
  }
  assert.ok(Coach.RULES.length >= 10);
});

check('picking up a piece explains it', () => {
  const pos = new Position();
  const at = s => ({ sq: SK.parseSq(s) });
  assert.deepStrictEqual(Coach.onSelect(pos, at('b2')), ['pawn']);
  assert.deepStrictEqual(Coach.onSelect(pos, at('b1')), ['knight']);
  assert.deepStrictEqual(Coach.onSelect(pos, at('a1')), ['bishop']);
  assert.deepStrictEqual(Coach.onSelect(pos, at('f1')), ['rook']);
  assert.deepStrictEqual(Coach.onSelect(pos, at('c1')), ['queen']);
  assert.deepStrictEqual(Coach.onSelect(pos, at('d1')), ['king']);
  assert.deepStrictEqual(Coach.onSelect(pos, { drop: SK.PAWN }), ['drop']);
  assert.deepStrictEqual(Coach.onSelect(pos, null), []);
});

check('a capture by the learner, and one against them', () => {
  const fen = '3k2/6/6/2p3/2R3/3K2[-] w 0 1';
  assert.ok(tipsAfter(fen, ['c2c3']).includes('capture'));
  const fen2 = '3k2/6/6/2r3/2P3/3K2[-] b 0 1';
  assert.ok(tipsAfter(fen2, ['c3c2']).includes('lost'));
});

check('a pawn in enemy land and on the last rank', () => {
  assert.ok(tipsAfter('k5/6/6/2P3/6/5K[-] w 0 1', ['c3c4']).includes('pawnHalf'));
  assert.ok(tipsAfter('k5/2P3/6/6/6/5K[-] w 0 1', ['c5c6']).includes('pawnFar'));
  assert.ok(!tipsAfter('k5/6/6/6/2P3/5K[-] w 0 1', ['c2c3']).includes('pawnHalf'));
});

check('check given and check received', () => {
  assert.ok(tipsAfter('3k2/6/6/6/R5/5K[-] w 0 1', ['a2a6']).includes('check'));
  assert.ok(tipsAfter('3k2/6/6/6/r5/5K[-] b 0 1', ['a2a1']).includes('inCheck'));
});

check('a drop by the opponent, and the reserve once a drop is legal', () => {
  assert.ok(tipsAfter('3k2/6/6/6/6/K5[r] b 0 1', ['R@f6']).includes('theirDrop'));
  // At the start nothing can drop: no reserve tip.
  assert.ok(!tipsAfter(SK.START_FEN, ['b2b3', 'e5e4']).includes('reserve'));
  // Once a drop becomes legal for White (a file free of White pawns, say), the tip comes up.
  let found = false;
  for (let seed = 1; seed < 200 && !found; seed++) {
    const p = new Position();
    const played = [];
    let r = seed;
    for (let ply = 0; ply < 40; ply++) {
      const legal = p.legalMoves().filter(m => !SK.moveDrop(m));
      if (!legal.length || p.status().state !== 'ongoing') break;
      r = (r * 1103515245 + 12345) % 2147483648;
      const m = legal[r % legal.length];
      played.push(p.moveToUci(m));
      p.makeMove(m);
      if (p.side === WHITE && p.legalMoves().some(x => SK.moveDrop(x))) {
        assert.ok(Coach.afterMove(p, WHITE, played).some(t => t.id === 'reserve'), played.join(' '));
        found = true;
        break;
      }
    }
  }
  assert.ok(found, 'no game reached a legal white drop');
});

check('how a game ended', () => {
  assert.strictEqual(Coach.endTip({ winner: 'w', reason: 'checkmate' }, WHITE), 'mateWin');
  assert.strictEqual(Coach.endTip({ winner: 'b', reason: 'checkmate' }, WHITE), 'mateLose');
  assert.strictEqual(Coach.endTip({ winner: 'w', reason: 'stalemate' }, WHITE), 'staleWin');
  assert.strictEqual(Coach.endTip({ winner: 'w', reason: 'stalemate' }, BLACK), 'staleLose');
  assert.strictEqual(Coach.endTip({ reason: 'threefold' }, WHITE), 'threefold');
  assert.strictEqual(Coach.endTip({ reason: 'bare kings' }, WHITE), 'bareKings');
  assert.strictEqual(Coach.endTip({ winner: 'b', reason: 'resignation' }, WHITE), 'resigned');
  assert.strictEqual(Coach.sameRule('mateLose'), 'mateWin');
});

check('random games never trip the coach', () => {
  let r = 7;
  for (let g = 0; g < 60; g++) {
    const p = new Position();
    const played = [];
    for (let ply = 0; ply < 120 && p.status().state === 'ongoing'; ply++) {
      const legal = p.legalMoves();
      r = (r * 1103515245 + 12345) % 2147483648;
      const m = legal[r % legal.length];
      played.push(p.moveToUci(m));
      p.makeMove(m);
      for (const t of Coach.afterMove(p, WHITE, played)) assert.ok(Coach.TIPS[t.id], t.id);
    }
  }
});

// The home page's hero plays this combination (heroArt in web/app.js): it must stay a real one.
check('the hero combination is a forced mate in 2 with a drop', () => {
  const pos = new Position('rkp3/pp1PR1/r5/4KP/1q2P1/P5[B] w 0 25');
  const drop = pos.moveFromUci('B@c5');
  assert.ok(drop, 'B@c5 is legal');
  pos.makeMove(drop);
  assert.ok(pos.inCheck(), 'the drop gives check');
  assert.deepStrictEqual(pos.legalMoves().map(m => pos.moveToUci(m)), ['c6c5'], 'the only reply takes the bishop');
  pos.makeMove(pos.moveFromUci('c6c5'));
  pos.makeMove(pos.moveFromUci('e5e6'));
  assert.deepStrictEqual(pos.status(), { state: 'win', winner: WHITE, reason: 'checkmate' });
});

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
