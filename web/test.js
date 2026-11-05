'use strict';
// Tests for the website's engine tasks, game review and online server.
//   node web/test.js
const assert = require('node:assert/strict');
const SK = require('../reference/engine.js');
const T = require('./engine-tasks.js');
const R = require('./review.js');
const { MoveTree } = require('./tree.js');
const { createServer, createGameServer } = require('./server.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('play returns a legal move across the Elo range, and for old levels', () => {
  const pos = T.build(null, ['b2b3']);
  for (const elo of [T.STRENGTH.min, 800, 1200, 1600, 2000]) {
    const r = T.play({ moves: ['b2b3'], elo });
    assert.ok(pos.moveFromUci(r.best), `${elo} played ${r.best}`);
    assert.equal(r.elo, elo);
  }
  for (const level of ['page', 'squire', 'knight']) {
    const r = T.play({ moves: ['b2b3'], level });
    assert.ok(pos.moveFromUci(r.best), `${level} played ${r.best}`);
    assert.equal(r.elo, T.clampElo(T.STRENGTH.legacy[level]));
  }
});

test('strength settings change smoothly and monotonically with Elo', () => {
  const S = T.STRENGTH;
  assert.equal(S.ladder[S.ladder.length - 1].elo, 3000);
  for (let i = 1; i < S.ladder.length; i++) {
    const gap = S.ladder[i].elo - S.ladder[i - 1].elo;
    assert.ok(gap > 0 && gap <= 300, `measured gap L${i - 1}-L${i} is ${gap}`);
  }
  let prev = null;
  for (let elo = S.min; elo <= S.max; elo += S.step) {
    const s = T.settingFor(elo);
    if (prev) {
      assert.ok(s.nodes >= prev.nodes && s.temp <= prev.temp, `${elo} is at least as strong as ${elo - S.step}`);
    }
    prev = s;
  }
  assert.deepEqual(T.settingFor(3000), { nodes: S.ladder[S.ladder.length - 1].nodes, temp: 0 });
  assert.equal(T.clampElo(10), S.min);
  assert.equal(T.clampElo(9999), 3000);
  assert.equal(T.clampElo(1234), 1250);
});

test('a temperature spreads choices over good moves and avoids losing ones', () => {
  // From the start every move is playable: a warm setting varies, a cold one does not.
  const seen = new Set();
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const r = T.thinkAt(T.build(null, []), { nodes: 1, temp: 150 }, { random, searcher: new SK.Searcher() });
    seen.add(r.best);
  }
  assert.ok(seen.size >= 4, `warm setting picked ${seen.size} different moves`);
  const cold = new Set();
  for (let i = 0; i < 5; i++) cold.add(T.thinkAt(T.build(null, []), { nodes: 3000, temp: 0 }, { random, searcher: new SK.Searcher() }).best);
  assert.equal(cold.size, 1);
});

test('analyse scores every legal move and agrees with its best move', () => {
  const a = T.analyse({ moves: [], movetime: 200, depth: 4 });
  const pos = new SK.Position();
  assert.equal(Object.keys(a.scores).length, pos.legalMoves().length);
  assert.equal(a.legal, pos.legalMoves().length);
  const top = Math.max(...Object.values(a.scores));
  assert.equal(a.scores[a.best], top);
  assert.equal(a.score, top);
});

test('analyse finds a mate in one and reports no moves when mated', () => {
  // Find a position with a mate in one by random play from the start.
  let rng = 7;
  const rand = n => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) % n);
  let found = null;
  for (let game = 0; game < 400 && !found; game++) {
    const pos = new SK.Position();
    const moves = [];
    for (let ply = 0; ply < 60 && pos.status().state === 'ongoing'; ply++) {
      const legal = pos.legalMoves();
      const mate = legal.find(m => {
        pos.makeMove(m);
        const over = !pos.hasLegalMove();
        pos.unmakeMove();
        return over;
      });
      if (mate) {
        found = { moves: moves.slice() };
        break;
      }
      const m = legal[rand(legal.length)];
      moves.push(pos.moveToUci(m));
      pos.makeMove(m);
    }
  }
  assert.ok(found, 'random play reached a mate in one');
  const a = T.analyse({ moves: found.moves, movetime: 300, depth: 4 });
  assert.equal(SK.mateIn(a.score), 1);
  const pos = T.build(null, [...found.moves, a.best]);
  assert.equal(pos.status().state, 'win');
  const done = T.analyse({ moves: [...found.moves, a.best], movetime: 50 });
  assert.equal(done.legal, 0);
});

test('lines gives the best moves in order, each with a legal line', () => {
  const r = T.lines({ moves: ['b2b3'], movetime: 300, multipv: 3 });
  assert.equal(r.lines.length, 3);
  assert.equal(new Set(r.lines.map(l => l.move)).size, 3);
  for (let i = 1; i < r.lines.length; i++) assert.ok(r.lines[i - 1].score >= r.lines[i].score);
  for (const l of r.lines) {
    assert.equal(l.pv[0], l.move);
    assert.doesNotThrow(() => T.build(null, ['b2b3', ...l.pv]));
  }
  const one = T.lines({ moves: ['b2b3'], movetime: 300, depth: 4, multipv: 1 });
  assert.equal(one.depth, 4);
  assert.equal(one.lines.length, 1);
  const a = T.analyse({ moves: ['b2b3'], movetime: 300, depth: 4 });
  assert.ok(a.scores[one.lines[0].move] >= a.score - 40, 'the best line is among the best moves by analyse');
});

test('lines from a set-up position: a mate in one, a lone legal move, and no moves', () => {
  // White: Ke1, Rc1; Black: Ka6 hemmed in by its own pawns, Rc1-c6 mates.
  const mateFen = 'k5/pp4/6/6/6/2R1K1[-] w 0 1';
  const r = T.lines({ fen: mateFen, moves: [], movetime: 300, multipv: 2 });
  assert.equal(SK.mateIn(r.lines[0].score), 1);
  assert.equal(T.build(mateFen, [r.lines[0].move]).status().state, 'win');
  const pos = new SK.Position(mateFen);
  pos.makeMove(pos.moveFromUci(r.lines[0].move));
  const done = T.lines({ fen: pos.fen(), moves: [], movetime: 50 });
  assert.deepEqual(done.lines, []);
  assert.equal(done.legal, 0);
  // More lines asked for than there are legal moves.
  const few = new SK.Position(mateFen).legalMoves().length;
  assert.equal(T.lines({ fen: mateFen, moves: [], movetime: 100, depth: 2, multipv: 999 }).lines.length, Math.min(few, 999));
});

const E = require('./endgame.js');

test('endgame tables: a lone bishop or knight never mates, two knights cannot force mate', () => {
  const B = E.report([SK.BISHOP]), N = E.report([SK.KNIGHT]), NN = E.report([SK.KNIGHT, SK.KNIGHT]);
  // With the strong side to move: bishop always wins, knight wins unless it is trapped.
  assert.deepEqual([B.draw, B.longestWin, B.checkmates], [0, 39, 0]);
  assert.deepEqual([N.draw, N.longestWin, N.checkmates], [168, 65, 0]);
  assert.deepEqual([NN.draw, NN.longestWin], [0, 57]);
  assert.ok(B.stalemates > 0 && N.stalemates > 0 && NN.checkmates > 0);
  // Playing for checkmate only (a stalemated bare king counts as a draw), two knights win only
  // where a mate in one is already on the board, and the bare king loses only when mated.
  const NNm = E.report([SK.KNIGHT, SK.KNIGHT], 'checkmate');
  assert.equal(NNm.longestWin, 1);
  assert.equal(NNm.defenderLosses, NNm.checkmates);
});

test('endgame probe matches sk-tb and the engine', () => {
  // Results from `sk-tb probe` (crates/tb), for both colours as the strong side.
  const known = [
    ['6/6/2k3/B5/4K1/6[-] b 0 1', 'loss', 36], ['6/4B1/6/4K1/2k3/6[-] b 0 1', 'loss', 26],
    ['2k3/6/6/4K1/6/4N1[-] b 0 1', 'loss', 50], ['6/6/2k3/K5/6/N5[-] b 0 1', 'loss', 56],
    ['6/k5/2N3/4K1/6/4N1[-] b 0 1', 'loss', 16], ['6/4N1/2k3/K5/6/N5[-] b 0 1', 'loss', 24],
    ['2K3/4N1/6/Bk4/6/6[-] b 0 1', 'loss', 50], ['2B3/6/2K3/6/2B3/k5[-] b 0 1', 'loss', 8],
    ['6/6/6/6/5B/K1k3[-] w 0 1', 'win', 39], ['5N/6/6/2k3/6/K5[-] w 0 1', 'win', 65],
    ['6/6/6/2NN2/2k3/K5[-] w 0 1', 'win', 57], ['k5/2B3/1K4/6/6/6[-] b 0 1', 'loss', 0],
  ];
  for (const [fen, result, plies] of known) {
    const r = E.probe(new SK.Position(fen));
    assert.deepEqual([r.result, r.plies], [result, plies], fen);
    // The same position with colours swapped and the board turned over.
    const swapped = new SK.Position(fen.replace(/^[^\[]+/, b => b.split('/').reverse().join('/').replace(/[a-z]/gi, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))).replace(/ ([wb]) /, (_, s) => ` ${s === 'w' ? 'b' : 'w'} `));
    const q = E.probe(swapped);
    assert.deepEqual([q.result, q.plies], [result, plies], `swapped ${fen}`);
  }
  // Each position's value follows from its moves, which come from the reference engine.
  let seed = 7;
  const rnd = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let checked = 0;
  while (checked < 300) {
    const sqs = [];
    while (sqs.length < 4) { const s = rnd(36); if (!sqs.includes(s)) sqs.push(s); }
    const fenBoard = [];
    const at = new Map([[sqs[0], 'K'], [sqs[1], 'k'], [sqs[2], 'NB'[rnd(2)]], [sqs[3], rnd(2) ? 'NB'[rnd(2)] : null]]);
    for (let r = 5; r >= 0; r--) {
      let row = '', e = 0;
      for (let f = 0; f < 6; f++) {
        const c = at.get(r * 6 + f);
        if (c) { if (e) row += e; e = 0; row += c; } else e++;
      }
      fenBoard.push(row + (e || ''));
    }
    let p;
    try { p = new SK.Position(`${fenBoard.join('/')}[-] ${rnd(2) ? 'w' : 'b'} 0 1`); } catch { continue; }
    if (Math.abs((sqs[0] % 6) - (sqs[1] % 6)) <= 1 && Math.abs(Math.floor(sqs[0] / 6) - Math.floor(sqs[1] / 6)) <= 1) continue;
    const r = E.probe(p);
    assert.ok(r, p.fen());
    assert.equal(r.moves.length, p.legalMoves().length);
    const wins = r.moves.filter(m => m.result === 'win'), draws = r.moves.filter(m => m.result === 'draw');
    if (r.result === 'win') assert.equal(r.plies, Math.min(...wins.map(m => m.plies)), p.fen());
    else if (r.result === 'draw') assert.ok(!wins.length && draws.length, p.fen());
    else if (r.moves.length) assert.equal(r.plies, Math.max(...r.moves.map(m => m.plies)), p.fen());
    else assert.equal(r.plies, 0);
    checked++;
  }
  // Anything else is not a lone-piece ending.
  assert.equal(E.probe(new SK.Position(SK.START_FEN)), null);
  assert.equal(E.probe(new SK.Position('6/6/6/6/2R3/K1k3[-] b 0 1')), null);
  assert.equal(E.probe(new SK.Position('6/6/6/6/2N3/K1k3[B] b 0 1')), null);
  assert.equal(T.tablebase({ fen: '6/6/6/6/5B/K1k3[-] w 0 1', moves: ['f2d4'] }).result, 'loss');
});

test('move tree: lines, variations, promotion, deletion and storage', () => {
  const t = new MoveTree();
  const a = t.addLine(0, ['b2b3', 'c5c4', 'a2a3']);
  assert.deepEqual(t.path(a.id), ['b2b3', 'c5c4', 'a2a3']);
  assert.equal(a.text, 'a2-a3');
  assert.equal(t.add(0, 'b2b3').id, t.root.children[0].id, 'an existing move is reused');
  assert.equal(t.add(0, 'b2b4'), null, 'an illegal move is refused');
  const v = t.add(t.root.children[0].id, 'a5a4');
  assert.ok(!t.isMainline(v.id) && t.isMainline(a.id));
  assert.deepEqual(t.mainline().map(n => n.uci), ['b2b3', 'c5c4', 'a2a3']);
  t.promote(v.id);
  assert.ok(t.isMainline(v.id));
  assert.deepEqual(t.mainline().map(n => n.uci), ['b2b3', 'a5a4']);
  const back = MoveTree.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
  assert.deepEqual(back.toJSON(), t.toJSON());
  assert.ok(back.find(['b2b3', 'c5c4', 'a2a3']));
  assert.equal(t.remove(v.id), t.root.children[0].id);
  assert.equal(t.get(v.id), null);
  assert.deepEqual(t.mainline().map(n => n.uci), ['b2b3', 'c5c4', 'a2a3']);
  assert.equal(t.position(a.id).fen(), T.build(null, ['b2b3', 'c5c4', 'a2a3']).fen());
  // From a set-up position, and no moves once the game is over.
  const mateFen = 'k5/pp4/6/6/6/2R1K1[-] w 0 1';
  const m = new MoveTree(mateFen);
  const mate = m.add(0, 'c1c6');
  assert.ok(mate && mate.text.endsWith('#'));
  assert.equal(m.add(mate.id, 'a5a4'), null);
  assert.throws(() => new MoveTree('6/6/6/6/6/6[-] w 0 1'));
});

test('win probability and accuracy are monotonic and bounded', () => {
  assert.equal(R.winProb(0), 0.5);
  assert.ok(R.winProb(300) > R.winProb(100));
  assert.equal(R.winProb(SK.MATE - 3), 1);
  assert.equal(R.winProb(-(SK.MATE - 3)), 0);
  assert.ok(R.moveAccuracy(0) > 99.9);
  assert.ok(R.moveAccuracy(0.3) < R.moveAccuracy(0.05));
  assert.equal(R.moveAccuracy(1), 0);
});

// A synthetic analysis lets each rule be checked without depending on search details.
function fake(scores, pv = []) {
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  return { legal: Object.keys(scores).length, best, score: scores[best], depth: 5, scores, pv };
}

test('classification thresholds', () => {
  const game = { moves: ['b2b3'] };
  const cases = [
    [{ b2b3: 50, c2c3: 40 }, 'best'],
    [{ b2b3: 40, c2c3: 50, d2d3: 45 }, 'excellent'], // ~0.9% expected points
    [{ b2b3: 0, c2c3: 50, d2d3: 45 }, 'good'], // ~4.6%
    [{ b2b3: -40, c2c3: 50, d2d3: 45 }, 'inaccuracy'],
    [{ b2b3: -150, c2c3: 50, d2d3: 45 }, 'mistake'],
    [{ b2b3: -400, c2c3: 50, d2d3: 45 }, 'blunder'],
    [{ b2b3: 30, c2c3: -400 }, 'great'], // the only move that holds
  ];
  for (const [scores, want] of cases) {
    const out = R.classifyGame(game, [fake(scores), fake({ x: 0 })], { state: 'ongoing' });
    assert.equal(out.plies[0].cls, want, JSON.stringify(scores));
  }
});

test('forced and miss', () => {
  const game = { moves: ['b2b3', 'c5c4', 'c2c3'] };
  const out = R.classifyGame(
    game,
    [fake({ b2b3: 0, c2c3: 0 }), fake({ c5c4: 0, d5d4: 0 }), fake({ c2c3: -50, d2d3: 200, e2e3: 190 }), fake({ x: 0 })],
    { state: 'ongoing' },
  );
  // Black's c5c4 is fine, but give it a blunder-sized loss to set up White's miss.
  const out2 = R.classifyGame(
    game,
    [fake({ b2b3: 0, c2c3: 0 }), fake({ c5c4: -400, d5d4: 0 }), fake({ c2c3: 200, d2d3: 400, e2e3: 390 }), fake({ x: 0 })],
    { state: 'ongoing' },
  );
  assert.equal(out2.plies[1].cls, 'blunder');
  assert.equal(out2.plies[2].cls, 'miss');
  assert.notEqual(out.plies[2].cls, 'miss');
  const forced = R.classifyGame({ moves: ['b2b3'] }, [fake({ b2b3: -100 }), fake({ x: 0 })], { state: 'ongoing' });
  assert.equal(forced.plies[0].cls, 'forced');
  assert.equal(forced.plies[0].accuracy, null);
});

test('a winning sacrifice is brilliant, the same move without the sacrifice is best', () => {
  // A knight move to a square where Black can capture it, with the reply line showing the
  // capture: that is a sacrifice, and at no loss of evaluation it is brilliant.
  const fen = 'rnkqnb/pp1ppp/6/2p3/PP1PPP/BNQKNR[PPRBpprb] w 0 1';
  const pos = new SK.Position(fen);
  let sac = null;
  for (const m of pos.legalMoves()) {
    const u = pos.moveToUci(m);
    pos.makeMove(m);
    for (const r of pos.legalMoves()) {
      if (SK.moveTo(r) === SK.moveTo(m) && !SK.moveDrop(m) && (pos.board[SK.moveTo(m)] & 7) === SK.KNIGHT) {
        sac = sac || { u, reply: pos.moveToUci(r) };
      }
    }
    pos.unmakeMove();
  }
  assert.ok(sac, 'found a knight move that can be captured');
  const game = { startFen: fen, moves: [sac.u] };
  const scores = { [sac.u]: 120, other: 100 };
  const brilliant = R.classifyGame(game, [fake(scores), fake({ x: -120 }, [sac.reply])], { state: 'ongoing' });
  assert.equal(brilliant.plies[0].sacrifice, true);
  assert.equal(brilliant.plies[0].cls, 'brilliant');
  const declined = R.classifyGame(game, [fake(scores), fake({ x: -120 }, [])], { state: 'ongoing' });
  assert.equal(declined.plies[0].cls, 'best');
});

test('a real game reviews end to end', () => {
  // A weak setting against a stronger one, a few moves, then analysed and classified.
  const moves = [];
  for (let i = 0; i < 12; i++) {
    const pos = T.build(null, moves);
    if (pos.status().state !== 'ongoing') break;
    moves.push(T.play({ moves, elo: i % 2 ? 600 : 1200 }).best);
  }
  const analyses = [];
  for (let i = 0; i <= moves.length; i++) analyses.push(T.analyse({ moves: moves.slice(0, i), movetime: 60, depth: 5 }));
  const status = T.build(null, moves).status();
  const out = R.classifyGame({ moves }, analyses, status);
  assert.equal(out.plies.length, moves.length);
  assert.equal(out.curve.length, moves.length + 1);
  for (const p of out.plies) assert.ok(R.CLASSES[p.cls]);
  for (const pl of out.players) assert.ok(pl.accuracy === null || (pl.accuracy >= 0 && pl.accuracy <= 100));
});

// A tiny in-memory stand-in for the claude.ai Artifact database (doc get/set/update/onSnapshot).
function fakeDb() {
  const docs = new Map(), subs = new Map(), colSubs = [];
  const snap = (path) => ({ id: path.split('/').pop(), exists: docs.has(path), data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined) });
  const notify = path => {
    for (const fn of subs.get(path) || []) setTimeout(() => fn(snap(path)));
    for (const fn of colSubs) setTimeout(() => fn({ docs: [...docs.keys()].map(snap) }));
  };
  return {
    doc: path => ({
      get: async () => snap(path),
      set: async d => (docs.set(path, structuredClone(d)), notify(path)),
      update: async d => {
        if (!docs.has(path)) throw new Error('missing');
        docs.set(path, { ...docs.get(path), ...structuredClone(d) });
        notify(path);
      },
      onSnapshot(fn) {
        subs.set(path, [...(subs.get(path) || []), fn]);
        setTimeout(() => fn(snap(path)));
        return () => subs.set(path, subs.get(path).filter(f => f !== fn));
      },
    }),
    collection: () => {
      const q = { orderBy: () => q, limit: () => q, onSnapshot: fn => (colSubs.push(fn), setTimeout(() => fn({ docs: [...docs.keys()].map(snap) })), () => {}) };
      return q;
    },
  };
}

test('artifact rooms: seats, turn order, legality, resignation, open list', async () => {
  globalThis.StockKnight = SK;
  require('./online.js');
  const db = fakeDb();
  const alice = globalThis.Online.dbBackend(db, 'alice');
  const bob = globalThis.Online.dbBackend(db, 'bob');
  const carol = globalThis.Online.dbBackend(db, 'carol');
  const tick = () => new Promise(r => setTimeout(r, 5));
  const id = await alice.create({ color: 'w' });
  let open = null;
  bob.lobby(rows => (open = rows.open));
  await tick();
  assert.deepEqual(open.map(r => [r.id, r.open]), [[id, 'b']]);
  await assert.rejects(alice.move(id, 'b2b3'), /opponent/);
  const seen = {};
  for (const [name, be] of [['alice', alice], ['bob', bob], ['carol', carol]]) be.subscribe(id, u => (seen[name] = u), err => assert.fail(err));
  await tick(); await tick();
  assert.equal(seen.alice.you, 'w');
  assert.equal(seen.bob.you, 'b');
  assert.equal(seen.carol.you, null, 'a third visitor watches');
  await assert.rejects(bob.move(id, 'c5c4'), /turn/);
  await assert.rejects(alice.move(id, 'b2b5'), /Illegal/);
  await assert.rejects(carol.move(id, 'b2b3'), /watching/);
  await alice.move(id, 'b2b3');
  await bob.move(id, 'c5c4');
  await tick();
  assert.deepEqual(seen.carol.moves, ['b2b3', 'c5c4']);
  await bob.resign(id);
  await tick();
  assert.deepEqual(seen.alice.result, { winner: 'w', reason: 'resignation' });
  await assert.rejects(alice.move(id, 'c2c3'), /over/);
});

async function serverTest() {
  const server = createServer().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
  try {
    const a = await (await post('/api/rooms', { color: 'w' })).json();
    assert.equal(a.color, 'w');
    let r = await post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'b2b3' });
    assert.equal(r.status, 409, 'cannot move before the opponent joins');
    const b = await (await post(`/api/rooms/${a.id}/join`, {})).json();
    assert.equal(b.color, 'b');
    assert.equal((await post(`/api/rooms/${a.id}/join`, {})).status, 409);
    assert.equal((await post(`/api/rooms/${a.id}/move`, { token: b.token, uci: 'c5c4' })).status, 409);
    assert.equal((await post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'b2b5' })).status, 400);
    assert.equal((await post(`/api/rooms/${a.id}/move`, { token: 'nope', uci: 'b2b3' })).status, 403);
    assert.equal((await post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'b2b3' })).status, 200);

    // The event stream carries the state.
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/rooms/${a.id}/events?token=${b.token}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('event: state')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"you":"b"/);
    assert.match(text, /"moves":\["b2b3"\]/);
    ctrl.abort();

    assert.equal((await post(`/api/rooms/${a.id}/resign`, { token: b.token })).status, 200);
    assert.equal((await post(`/api/rooms/${a.id}/move`, { token: b.token, uci: 'c5c4' })).status, 409);

    // Only the site and the engine are served.
    assert.equal((await fetch(`${base}/web/`)).status, 200);
    assert.equal((await fetch(`${base}/reference/engine.js`)).status, 200);
    assert.equal((await fetch(`${base}/README.md`)).status, 404);
    assert.equal((await fetch(`${base}/web/%2e%2e/Cargo.toml`)).status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
test('online rooms: joining, turn order, legality, resignation, static files', serverTest);

test('artifact rooms: draw offers, abort and rematch', async () => {
  const db = fakeDb();
  const alice = globalThis.Online.dbBackend(db, 'alice');
  const bob = globalThis.Online.dbBackend(db, 'bob');
  const tick = () => new Promise(r => setTimeout(r, 5));
  const id = await alice.create({ color: 'w' });
  let seen = null;
  bob.subscribe(id, u => (seen = u), err => assert.fail(err));
  await tick(); await tick();
  await assert.rejects(alice.draw(id, 'offer'), /move first/);
  await alice.move(id, 'b2b3');
  await bob.move(id, 'c5c4');
  await alice.draw(id, 'offer');
  await alice.move(id, 'a2a3');
  await tick();
  assert.equal(seen.drawOffer, 'w', 'your own move keeps your offer');
  await bob.move(id, 'a5a4'); // the opponent moving declines it
  await tick();
  assert.equal(seen.drawOffer, null);
  await bob.draw(id, 'offer');
  await alice.draw(id, 'accept');
  await tick();
  assert.deepEqual(seen.result, { winner: null, reason: 'agreement' });
  assert.deepEqual(await alice.rematch(id), { next: null });
  const { next } = await bob.rematch(id);
  assert.ok(next);
  let again = null;
  bob.subscribe(next, u => (again = u), err => assert.fail(err));
  await tick();
  assert.equal(again.you, 'w', 'colours swap in the rematch');
  await bob.abort(next);
  await tick();
  assert.equal(again.result.reason, 'aborted');
});

// --- the game server --------------------------------------------------------------------------

async function withServer(options, fn) {
  const { server, rooms } = createGameServer(options);
  server.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  const api = {
    base,
    rooms,
    post: async (path, body = {}) => {
      const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
    get: async path => (await fetch(base + path)).json(),
    // Opens a room's event stream; .last() is the latest state, .next(pred) waits for one.
    watch: async (id, token = '') => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/rooms/${id}/events?token=${token}`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const s = { states: [], you: undefined, waiters: [], close: () => ctrl.abort() };
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /event: (\w+)/.exec(block), data = /data: (.*)/.exec(block);
              if (!ev || !data) continue;
              const d = JSON.parse(data[1]);
              if (ev[1] === 'hello') s.you = d.you;
              else s.states.push(d);
              s.waiters = s.waiters.filter(w => !(w.pred(d) && (w.resolve(d), true)));
            }
          }
        } catch {
          /* aborted */
        }
      })();
      s.last = () => s.states[s.states.length - 1];
      // Each call looks only at states after the one the previous call returned.
      s.cursor = 0;
      s.next = pred => {
        const i = s.states.findIndex((st, j) => j >= s.cursor && pred(st));
        if (i >= 0) {
          s.cursor = i + 1;
          return Promise.resolve(s.states[i]);
        }
        return new Promise((resolve, reject) => {
          s.waiters.push({ pred, resolve: d => ((s.cursor = s.states.length), resolve(d)) });
          setTimeout(() => reject(new Error('timed out waiting for a state')), 3000);
        });
      };
      streams.push(s);
      await s.next(() => true);
      return s;
    },
  };
  try {
    await fn(api);
  } finally {
    for (const s of streams) s.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

test('online server: quick pairing matches two players, never you with yourself', () => withServer({}, async api => {
  const tc = { base: 180, inc: 2 };
  const a = (await api.post('/api/quick', { tc, name: 'Ann', client: 'clientaaaa' })).body;
  // An open seek counts only while its player is connected.
  assert.equal((await api.get('/api/lobby')).open.length, 0);
  const sa = await api.watch(a.id, a.token);
  const lob = await api.get('/api/lobby');
  assert.deepEqual(lob.open.map(g => [g.id, g.name, g.tc.base]), [[a.id, 'Ann', 180]]);
  const self = (await api.post('/api/quick', { tc, client: 'clientaaaa' })).body;
  assert.notEqual(self.id, a.id, 'a second tab of the same browser waits instead of pairing with itself');
  const other = (await api.post('/api/quick', { tc: { base: 60, inc: 0 }, client: 'clientcccc' })).body;
  assert.notEqual(other.id, a.id, 'a different time control waits too');
  const b = (await api.post('/api/quick', { tc, name: '<Bo>', client: 'clientbbbb' })).body;
  assert.equal(b.id, a.id);
  assert.notEqual(b.color, a.color);
  const st = await sa.next(s => s.players.w && s.players.b);
  assert.equal(st.names[b.color], 'Bo', 'names are cleaned');
  assert.deepEqual(st.tc, tc);
}));

test('online server: clocks, increments, first-move abort and flagging', async () => {
  let t = 1_000_000;
  await withServer({ now: () => t, firstMoveMs: 30000 }, async api => {
    const a = (await api.post('/api/rooms', { color: 'w', tc: { base: 60, inc: 2 } })).body;
    const b = (await api.post(`/api/rooms/${a.id}/join`, {})).body;
    const mv = (tok, uci, ply) => api.post(`/api/rooms/${a.id}/move`, { token: tok, uci, ply });
    let st = await api.get(`/api/rooms/${a.id}`);
    assert.equal(st.clock.running, null, 'clocks wait for both first moves');
    assert.equal(st.firstMove.side, 'w');
    t += 20000;
    assert.equal((await mv(a.token, 'b2b3', 0)).status, 200);
    assert.equal((await mv(b.token, 'c5c4', 0)).status, 409, 'a stale ply is refused');
    t += 5000;
    assert.equal((await mv(b.token, 'c5c4', 1)).status, 200);
    st = await api.get(`/api/rooms/${a.id}`);
    assert.equal(st.clock.running, 'w');
    assert.equal(st.clock.w, 60000, 'first moves cost no time');
    assert.equal(st.clock.b, 60000);
    t += 10000;
    assert.equal((await mv(a.token, 'a2a3', 2)).status, 200);
    st = await api.get(`/api/rooms/${a.id}`);
    assert.equal(st.clock.w, 52000, '10 s used, 2 s increment');
    t += 61000; // Black's minute runs out
    const r = await mv(b.token, 'a5a4', 3);
    assert.equal(r.status, 409);
    st = await api.get(`/api/rooms/${a.id}`);
    assert.deepEqual(st.result, { winner: 'w', reason: 'timeout' });
    assert.equal(st.clock.b, 0);

    // A side that never makes its first move aborts the game.
    const c = (await api.post('/api/rooms', { color: 'w', tc: { base: 60, inc: 0 } })).body;
    const d = (await api.post(`/api/rooms/${c.id}/join`, {})).body;
    t += 31000;
    assert.equal((await api.post(`/api/rooms/${c.id}/move`, { token: c.token, uci: 'b2b3' })).status, 409);
    st = await api.get(`/api/rooms/${c.id}`);
    assert.equal(st.result.reason, 'aborted');
    assert.ok(d.token);
  });
});

test('online server: draw offers, abort, resign and rematch', () => withServer({}, async api => {
  const a = (await api.post('/api/rooms', { color: 'w' })).body;
  const b = (await api.post(`/api/rooms/${a.id}/join`, {})).body;
  const act = (tok, action, extra = {}) => api.post(`/api/rooms/${a.id}/${action}`, { token: tok, ...extra });
  assert.equal((await act(a.token, 'draw', { answer: 'offer' })).status, 409, 'no draw offer before moving');
  await act(a.token, 'move', { uci: 'b2b3' });
  await act(b.token, 'move', { uci: 'c5c4' });
  assert.equal((await act(a.token, 'abort')).status, 409, 'too late to abort');
  assert.equal((await act(a.token, 'draw', { answer: 'offer' })).status, 200);
  let st = await api.get(`/api/rooms/${a.id}`);
  assert.equal(st.drawOffer, 'w');
  assert.equal((await act(b.token, 'draw', { answer: 'decline' })).status, 200);
  assert.equal((await api.get(`/api/rooms/${a.id}`)).drawOffer, null);
  assert.equal((await act(a.token, 'draw', { answer: 'accept' })).status, 409, 'nothing to accept');
  await act(a.token, 'draw', { answer: 'offer' });
  await act(a.token, 'move', { uci: 'a2a3' });
  assert.equal((await api.get(`/api/rooms/${a.id}`)).drawOffer, 'w', 'moving does not withdraw your own offer');
  await act(b.token, 'move', { uci: 'a5a4' });
  assert.equal((await api.get(`/api/rooms/${a.id}`)).drawOffer, null, 'the opponent moving declines it');
  await act(b.token, 'draw', { answer: 'offer' });
  await act(a.token, 'draw', { answer: 'accept' });
  st = await api.get(`/api/rooms/${a.id}`);
  assert.deepEqual(st.result, { winner: null, reason: 'agreement' });

  assert.equal((await act(a.token, 'rematch')).body.next, null);
  const next = (await act(b.token, 'rematch')).body.next;
  assert.ok(next);
  assert.equal((await api.get(`/api/rooms/${a.id}`)).next, next);
  // Same tokens, colours swapped: the old Black moves first.
  assert.equal((await api.post(`/api/rooms/${next}/move`, { token: b.token, uci: 'b2b3' })).status, 200);
  assert.equal((await api.post(`/api/rooms/${next}/resign`, { token: a.token })).status, 200, 'resigning before your first move aborts');
  assert.equal((await api.get(`/api/rooms/${next}`)).result.reason, 'aborted');

  // Resigning a real game.
  const c = (await api.post('/api/rooms', { color: 'b' })).body;
  const d = (await api.post(`/api/rooms/${c.id}/join`, {})).body;
  await api.post(`/api/rooms/${c.id}/move`, { token: d.token, uci: 'b2b3' });
  await api.post(`/api/rooms/${c.id}/move`, { token: c.token, uci: 'c5c4' });
  await api.post(`/api/rooms/${c.id}/resign`, { token: d.token });
  assert.deepEqual((await api.get(`/api/rooms/${c.id}`)).result, { winner: 'b', reason: 'resignation' });
}));

test('online server: presence, reconnecting, claiming an abandoned game', async () => {
  let t = 5_000_000;
  await withServer({ now: () => t, claimMs: 60000 }, async api => {
    const a = (await api.post('/api/rooms', { color: 'w' })).body;
    const b = (await api.post(`/api/rooms/${a.id}/join`, {})).body;
    const sa = await api.watch(a.id, a.token);
    let sb = await api.watch(a.id, b.token);
    assert.equal(sa.you, 'w');
    assert.equal(sb.you, 'b');
    const viewer = await api.watch(a.id);
    assert.equal(viewer.you, null);
    await sa.next(s => s.watchers === 1);
    await api.post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'b2b3' });
    await api.post(`/api/rooms/${a.id}/move`, { token: b.token, uci: 'c5c4' });
    assert.equal((await api.post(`/api/rooms/${a.id}/claim`, { token: a.token })).status, 409, 'the opponent is here');
    sb.close();
    let st = await sa.next(s => !s.online.b);
    assert.equal(st.gone.b, 60000);
    // Back within the minute: the stream starts with the full game.
    sb = await api.watch(a.id, b.token);
    assert.deepEqual(sb.last().moves, ['b2b3', 'c5c4']);
    await sa.next(s => s.online.b && s.gone.b === null);
    sb.close();
    await sa.next(s => !s.online.b);
    t += 30000;
    assert.equal((await api.post(`/api/rooms/${a.id}/claim`, { token: a.token })).status, 409, 'too soon');
    t += 31000;
    const claim = await api.post(`/api/rooms/${a.id}/claim`, { token: a.token });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    st = await api.get(`/api/rooms/${a.id}`);
    assert.deepEqual(st.result, { winner: 'w', reason: 'abandonment' });
  });
});

test('online server: games survive a restart with --data', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maki-'));
  const dataFile = path.join(dir, 'rooms.json');
  let a, b;
  await withServer({ dataFile }, async api => {
    a = (await api.post('/api/rooms', { color: 'w', tc: { base: 300, inc: 0 }, name: 'Ann' })).body;
    b = (await api.post(`/api/rooms/${a.id}/join`, {})).body;
    await api.post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'b2b3' });
    await api.post(`/api/rooms/${a.id}/move`, { token: b.token, uci: 'c5c4' });
  });
  assert.ok(fs.existsSync(dataFile));
  await withServer({ dataFile }, async api => {
    const st = await api.get(`/api/rooms/${a.id}`);
    assert.deepEqual(st.moves, ['b2b3', 'c5c4']);
    assert.equal(st.names.w, 'Ann');
    assert.ok(st.clock.w > 299000 && st.clock.w <= 300000);
    assert.equal((await api.post(`/api/rooms/${a.id}/move`, { token: a.token, uci: 'a2a3' })).status, 200, 'tokens still work');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${err.stack.split('\n').slice(0, 3).join('\n     ')}`);
    }
  }
  console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
