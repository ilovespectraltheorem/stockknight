'use strict';
// Tests for the website's engine tasks, game review and online server.
//   node web/test.js
const assert = require('node:assert/strict');
const SK = require('../reference/engine.js');
const T = require('./engine-tasks.js');
const R = require('./review.js');
const { createServer } = require('./server.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('play returns a legal move at every level', () => {
  for (const level of Object.keys(T.LEVELS)) {
    if (level === 'champion') continue; // 3 s a move; covered by the same code path as knight
    const r = T.play({ moves: ['b2b3'], level });
    const pos = T.build(null, ['b2b3']);
    assert.ok(pos.moveFromUci(r.best), `${level} played ${r.best}`);
  }
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
  // Page (random-ish) against Knight, a few moves, then analysed and classified.
  const moves = [];
  for (let i = 0; i < 12; i++) {
    const pos = T.build(null, moves);
    if (pos.status().state !== 'ongoing') break;
    moves.push(T.play({ moves, level: i % 2 ? 'page' : 'squire' }).best);
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
  const id = await alice.create('w');
  let open = null;
  bob.listOpen(rows => (open = rows));
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
