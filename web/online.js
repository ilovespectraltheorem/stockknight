'use strict';
// Online games behind one interface, so the page works in two places:
//   - served by web/server.js: games on that server (HTTP + server-sent events). The server is
//     the referee: it checks moves, runs the clocks and decides results.
//   - published as a claude.ai Artifact: games in the artifact's shared database. There is no
//     referee there, so both browsers check every move, and games are untimed.
//
// backend.features: { clocks, quick, lobby, claim } (draw offers, abort and rematch work on both)
// backend.create({ color, tc, name }) -> id          (tc: { base, inc } in seconds, or null)
// backend.quick({ tc, name }) -> id                   (features.quick)
// backend.subscribe(id, onUpdate, onError, onConn) -> unsubscribe
//   onUpdate(state): { you: 'w'|'b'|null, moves, players, names, online, gone, tc, clock,
//                      firstMove, drawOffer, rematch, next, result, watchers }
//   onConn(true|false): the live connection is up / lost and retrying
// backend.move(id, uci, ply), .resign(id), .abort(id), .draw(id, 'offer'|'accept'|'decline'),
//   .claim(id), .rematch(id) -> Promise, rejecting with an Error to show
// backend.lobby(onList) -> unsubscribe; onList({ open: [{ id, open, tc, name, mine }], live: [...] })

(function (root) {
  const SK = root.StockKnight;

  function newCode() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let id = '';
    for (const b of crypto.getRandomValues(new Uint8Array(6))) id += alphabet[b % alphabet.length];
    return id;
  }

  function pickColor(color) {
    return color === 'w' || color === 'b' ? color : Math.random() < 0.5 ? 'w' : 'b';
  }

  // --- web/server.js ------------------------------------------------------------------------

  function serverBackend(store) {
    const key = id => `sk.room.${id}`;
    const tokenOf = id => store.get(key(id), null);
    let client = store.get('sk.client', null);
    if (!client) {
      client = newCode() + newCode();
      store.set('sk.client', client);
    }
    const post = async (path, body) => {
      let r;
      try {
        r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
      } catch {
        throw new Error('No connection to the server');
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: r.status });
      return data;
    };
    const act = (id, action, extra = {}) => post(`/api/rooms/${id}/${action}`, { token: tokenOf(id), ...extra });

    return {
      kind: 'server',
      features: { clocks: true, quick: true, lobby: true, claim: true },
      async create({ color, tc, name }) {
        const { id, token } = await post('/api/rooms', { color, tc, name, client });
        store.set(key(id), token);
        return id;
      },
      async quick({ tc, name }) {
        const { id, token } = await post('/api/quick', { tc, name, client });
        store.set(key(id), token);
        return id;
      },
      subscribe(id, onUpdate, onError, onConn = () => {}) {
        let es = null, you = null, closed = false, retry = 0;
        const open = () => {
          if (closed) return;
          es = new EventSource(`/api/rooms/${id}/events?token=${encodeURIComponent(tokenOf(id) || '')}`);
          es.onopen = () => onConn(true);
          es.addEventListener('hello', e => (you = JSON.parse(e.data).you));
          es.addEventListener('state', e => {
            const st = JSON.parse(e.data);
            // A rematch keeps each player's token, with colours swapped.
            if (st.next && you && tokenOf(id) && !tokenOf(st.next)) store.set(key(st.next), tokenOf(id));
            onUpdate({ you, ...st });
          });
          es.onerror = async () => {
            onConn(false);
            if (es.readyState !== EventSource.CLOSED) return; // the browser retries by itself
            // The server answered with an error (a restart, or the game is gone): check, then retry.
            es = null;
            try {
              const r = await fetch(`/api/rooms/${id}`);
              if (r.status === 404) return closed || onError(new Error('That game does not exist (games close after a few idle hours)'));
            } catch {
              /* still offline */
            }
            setTimeout(open, Math.min(1000 * 2 ** retry++, 10000));
          };
        };
        (async () => {
          if (!tokenOf(id)) {
            try {
              const { token } = await post(`/api/rooms/${id}/join`, { name: store.get('sk.name', ''), client });
              store.set(key(id), token);
            } catch (err) {
              if (err.status === 404) return onError(err);
              // full or finished: watch instead
            }
          }
          open();
        })();
        return () => {
          closed = true;
          if (es) es.close();
        };
      },
      move: (id, uci, ply) => act(id, 'move', { uci, ply }),
      resign: id => act(id, 'resign'),
      abort: id => act(id, 'abort'),
      draw: (id, answer) => act(id, 'draw', { answer }),
      claim: id => act(id, 'claim'),
      rematch: id => act(id, 'rematch'),
      lobby(onList) {
        let stop = false, timer = 0;
        const poll = async () => {
          try {
            const r = await fetch('/api/lobby', { cache: 'no-store' });
            const d = await r.json();
            if (stop) return;
            onList({
              open: d.open.map(g => ({ ...g, mine: !!tokenOf(g.id) })),
              live: d.live.map(g => ({ ...g, mine: !!tokenOf(g.id) })),
              playing: d.playing,
            });
          } catch {
            /* keep the last list */
          }
          if (!stop) timer = setTimeout(poll, 3000);
        };
        poll();
        return () => {
          stop = true;
          clearTimeout(timer);
        };
      },
    };
  }

  // --- claude.ai Artifact shared database ---------------------------------------------------
  // rooms/<code>: { w, b (viewer ids or null), names, moves: [uci], result, drawOffer,
  //                 rematch: { w, b }, next, created, updated }
  // Both browsers check every move with the reference engine before writing it.

  function dbBackend(db, me, store = { get: (k, d) => d }) {
    const ref = id => db.doc(`rooms/${id}`);
    const seat = (d, who) => (d.w === who ? 'w' : d.b === who ? 'b' : null);
    const toUpdate = (id, d, you) => ({
      id,
      you,
      moves: Array.isArray(d.moves) ? d.moves.filter(m => typeof m === 'string') : [],
      players: { w: !!d.w, b: !!d.b },
      names: d.names || { w: null, b: null },
      online: null,
      gone: null,
      tc: null,
      clock: null,
      firstMove: null,
      drawOffer: d.drawOffer === 'w' || d.drawOffer === 'b' ? d.drawOffer : null,
      rematch: d.rematch || { w: false, b: false },
      next: typeof d.next === 'string' ? d.next : null,
      result: d.result || null,
      watchers: null,
    });
    const name = () => String(store.get('sk.name', '') || '').slice(0, 24) || null;

    async function load(id) {
      const snap = await ref(id).get();
      if (!snap.exists) throw new Error('That game no longer exists');
      return snap.data();
    }

    async function mine(id, { live = true } = {}) {
      const d = await load(id);
      const you = seat(d, me);
      if (!you) throw new Error('You are watching this game');
      if (live && d.result) throw new Error('The game is over');
      if (live && (!d.w || !d.b)) throw new Error('Waiting for an opponent');
      return { d, you };
    }

    return {
      kind: 'db',
      features: { clocks: false, quick: false, lobby: true, claim: false },
      async create({ color } = {}) {
        const id = newCode();
        const c = pickColor(color);
        const now = Date.now();
        await ref(id).set({
          w: c === 'w' ? me : null, b: c === 'b' ? me : null,
          names: { w: c === 'w' ? name() : null, b: c === 'b' ? name() : null },
          moves: [], result: null, drawOffer: null, rematch: { w: false, b: false }, next: null, created: now, updated: now,
        });
        return id;
      },
      subscribe(id, onUpdate, onError, onConn = () => {}) {
        let claimed = false;
        return ref(id).onSnapshot(
          async snap => {
            onConn(true);
            if (!snap.exists) return onError(new Error('That game does not exist'));
            const d = snap.data();
            let you = seat(d, me);
            if (!you && !claimed && !d.result && (!d.w || !d.b)) {
              claimed = true; // take the free seat once
              const free = !d.w ? 'w' : 'b';
              try {
                await ref(id).update({ [free]: me, names: { w: null, b: null, ...(d.names || {}), [free]: name() }, updated: Date.now() });
                return; // the next snapshot carries the seat
              } catch {
                /* read-only viewer: watch instead */
              }
            }
            onUpdate(toUpdate(id, d, you));
          },
          err => onError(new Error(err.message || 'Lost the connection to the game')),
        );
      },
      async move(id, uci) {
        const { d, you } = await mine(id);
        const pos = new SK.Position();
        for (const u of d.moves) pos.makeMove(pos.moveFromUci(u));
        if ((pos.side === SK.WHITE ? 'w' : 'b') !== you) throw new Error('Not your turn');
        const m = pos.moveFromUci(uci);
        if (!m) throw new Error('Illegal move');
        pos.makeMove(m);
        const st = pos.status();
        const result = st.state === 'win'
          ? { winner: st.winner === SK.WHITE ? 'w' : 'b', reason: st.reason }
          : st.state === 'draw' ? { winner: null, reason: st.reason } : null;
        const drawOffer = d.drawOffer && d.drawOffer !== you ? null : d.drawOffer || null;
        await ref(id).update({ moves: [...d.moves, uci], result, drawOffer, updated: Date.now() });
      },
      async resign(id) {
        const { d, you } = await mine(id, { live: false });
        if (d.result) return;
        const result = (d.moves || []).length < 2 || !d.w || !d.b
          ? { winner: null, reason: 'aborted', by: you }
          : { winner: you === 'w' ? 'b' : 'w', reason: 'resignation' };
        await ref(id).update({ result, drawOffer: null, updated: Date.now() });
      },
      async abort(id) {
        const { d, you } = await mine(id, { live: false });
        if (d.result) return;
        if ((d.moves || []).length >= 2) throw new Error('Too late to abort: resign or offer a draw');
        await ref(id).update({ result: { winner: null, reason: 'aborted', by: you }, updated: Date.now() });
      },
      async draw(id, answer) {
        const { d, you } = await mine(id);
        const theirs = d.drawOffer && d.drawOffer !== you;
        if ((answer === 'offer' || answer === 'accept') && theirs) {
          await ref(id).update({ result: { winner: null, reason: 'agreement' }, drawOffer: null, updated: Date.now() });
        } else if (answer === 'offer') {
          if ((d.moves || []).length < 2) throw new Error('Make a move first');
          await ref(id).update({ drawOffer: you, updated: Date.now() });
        } else if (answer === 'decline') {
          await ref(id).update({ drawOffer: null, updated: Date.now() });
        } else {
          throw new Error('There is no draw offer to accept');
        }
      },
      claim: async () => {
        throw new Error('Not available here');
      },
      async rematch(id) {
        const { d, you } = await mine(id, { live: false });
        if (!d.result) throw new Error('The game is still going');
        if (d.next) return { next: d.next };
        const rematch = { ...(d.rematch || {}), [you]: true };
        if (rematch.w && rematch.b) {
          const next = newCode();
          const now = Date.now();
          const names = d.names || {};
          await ref(next).set({
            w: d.b, b: d.w, names: { w: names.b || null, b: names.w || null },
            moves: [], result: null, drawOffer: null, rematch: { w: false, b: false }, next: null, created: now, updated: now,
          });
          await ref(id).update({ rematch, next, updated: now });
          return { next };
        }
        await ref(id).update({ rematch, updated: Date.now() });
        return { next: null };
      },
      lobby(onList) {
        return db.collection('rooms').orderBy('updated', 'desc').limit(30).onSnapshot(
          snap => {
            const day = Date.now() - 24 * 3600 * 1000;
            const rows = snap.docs
              .map(s => ({ id: s.id, d: s.data() }))
              .filter(({ d }) => !d.result && (d.updated || 0) > day);
            const names = d => d.names || { w: null, b: null };
            onList({
              open: rows
                .filter(({ d }) => !d.w || !d.b || d.w === me || d.b === me)
                .map(({ id, d }) => ({
                  id,
                  mine: d.w === me || d.b === me,
                  open: !d.w ? 'w' : !d.b ? 'b' : null,
                  name: names(d)[d.w ? 'w' : 'b'],
                  moves: (d.moves || []).length,
                  tc: null,
                })),
              live: rows
                .filter(({ d }) => d.w && d.b && d.w !== me && d.b !== me && (d.moves || []).length)
                .map(({ id, d }) => ({ id, names: names(d), moves: d.moves.length, tc: null })),
            });
          },
          () => onList({ open: [], live: [] }),
        );
      },
    };
  }

  // Resolves the backend this page can use, or null.
  async function detect(store) {
    if (root.claude && typeof root.claude.use === 'function') {
      const [db, user] = await Promise.all([root.claude.use('db'), root.claude.use('user')]);
      if (db && user) {
        const me = await user.id();
        if (me) return dbBackend(db, me, store);
      }
      return null;
    }
    try {
      const r = await fetch('/api/health');
      if (r.ok) return serverBackend(store);
    } catch {
      /* no server */
    }
    return null;
  }

  root.Online = { detect, dbBackend, serverBackend };
})(globalThis);
