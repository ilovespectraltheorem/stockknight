'use strict';
// Online rooms behind one interface, so the page works in two places:
//   - served by web/server.js: rooms on that server (HTTP + server-sent events)
//   - published as a claude.ai Artifact: rooms in the artifact's shared database
//
// backend.create(color) -> id
// backend.subscribe(id, onUpdate) -> unsubscribe; onUpdate({ you: 'w'|'b'|null, moves, players, result })
// backend.move(id, uci), backend.resign(id) -> Promise, rejecting with an Error to show
// backend.listOpen(onList) -> unsubscribe (optional); onList([{ id, open: 'w'|'b', moves }])

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
    const tokens = id => store.get(`sk.room.${id}`, null);
    const post = async (path, body) => {
      const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || 'request failed'), { status: r.status });
      return data;
    };
    return {
      kind: 'server',
      async create(color) {
        const { id, token } = await post('/api/rooms', { color });
        store.set(`sk.room.${id}`, token);
        return id;
      },
      subscribe(id, onUpdate, onError) {
        let es = null, you = null, closed = false;
        (async () => {
          let token = tokens(id);
          if (!token) {
            try {
              token = (await post(`/api/rooms/${id}/join`, {})).token;
              store.set(`sk.room.${id}`, token);
            } catch (err) {
              if (err.status === 404) return onError(new Error('That room does not exist (rooms close after a few idle hours)'));
            }
          }
          if (closed) return;
          es = new EventSource(`/api/rooms/${id}/events?token=${encodeURIComponent(token || '')}`);
          es.addEventListener('hello', e => (you = JSON.parse(e.data).you));
          es.addEventListener('state', e => onUpdate({ you, ...JSON.parse(e.data) }));
        })();
        return () => {
          closed = true;
          if (es) es.close();
        };
      },
      move: (id, uci) => post(`/api/rooms/${id}/move`, { token: tokens(id), uci }),
      resign: id => post(`/api/rooms/${id}/resign`, { token: tokens(id) }),
      listOpen: null,
    };
  }

  // --- claude.ai Artifact shared database ---------------------------------------------------
  // rooms/<code>: { w, b (viewer ids or null), moves: [uci], result, created, updated }
  // Both browsers check every move with the reference engine before writing it.

  function dbBackend(db, me) {
    const ref = id => db.doc(`rooms/${id}`);
    const seat = (d, who) => (d.w === who ? 'w' : d.b === who ? 'b' : null);
    const toUpdate = (d, you) => ({
      you,
      moves: Array.isArray(d.moves) ? d.moves.filter(m => typeof m === 'string') : [],
      players: { w: !!d.w, b: !!d.b },
      result: d.result || null,
    });

    async function load(id) {
      const snap = await ref(id).get();
      if (!snap.exists) throw new Error('That game no longer exists');
      return snap.data();
    }

    return {
      kind: 'db',
      async create(color) {
        const id = newCode();
        const c = pickColor(color);
        const now = Date.now();
        await ref(id).set({ w: c === 'w' ? me : null, b: c === 'b' ? me : null, moves: [], result: null, created: now, updated: now });
        return id;
      },
      subscribe(id, onUpdate, onError) {
        let claimed = false;
        return ref(id).onSnapshot(
          async snap => {
            if (!snap.exists) return onError(new Error('That game does not exist'));
            const d = snap.data();
            let you = seat(d, me);
            if (!you && !claimed && !d.result && (!d.w || !d.b)) {
              claimed = true; // take the free seat once
              const free = !d.w ? 'w' : 'b';
              try {
                await ref(id).update({ [free]: me, updated: Date.now() });
                return; // the next snapshot carries the seat
              } catch {
                /* read-only viewer: watch instead */
              }
            }
            onUpdate(toUpdate(d, you));
          },
          err => onError(new Error(err.message || 'Lost the connection to the game')),
        );
      },
      async move(id, uci) {
        const d = await load(id);
        const you = seat(d, me);
        if (!you) throw new Error('You are watching this game');
        if (!d.w || !d.b) throw new Error('Waiting for an opponent');
        if (d.result) throw new Error('The game is over');
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
        await ref(id).update({ moves: [...d.moves, uci], result, updated: Date.now() });
      },
      async resign(id) {
        const d = await load(id);
        const you = seat(d, me);
        if (!you || d.result) return;
        await ref(id).update({ result: { winner: you === 'w' ? 'b' : 'w', reason: 'resignation' }, updated: Date.now() });
      },
      listOpen(onList) {
        return db.collection('rooms').orderBy('updated', 'desc').limit(30).onSnapshot(
          snap => {
            const day = Date.now() - 24 * 3600 * 1000;
            onList(
              snap.docs
                .map(s => ({ id: s.id, d: s.data() }))
                .filter(({ d }) => !d.result && (d.updated || 0) > day)
                .map(({ id, d }) => ({
                  id,
                  mine: d.w === me || d.b === me,
                  open: !d.w ? 'w' : !d.b ? 'b' : null,
                  moves: (d.moves || []).length,
                }))
                .filter(r => r.open || r.mine),
            );
          },
          () => onList([]),
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
        if (me) return dbBackend(db, me);
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
