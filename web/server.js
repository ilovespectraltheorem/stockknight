'use strict';
// The Maki web server: serves the site and runs online games between two browsers.
// No dependencies. The server is the referee: it checks every move with the reference engine,
// keeps the clocks, and decides results, so a client cannot cheat.
//
//   node web/server.js [--port 8080] [--data rooms.json]     then open http://localhost:8080/
//
// --data keeps the rooms in a JSON file, so games survive a server restart (clocks pause while
// the server is down).
//
// API (JSON bodies; every player action carries the player's secret `token`):
//   GET  /api/health                                   -> { ok, ruleset }
//   GET  /api/lobby                                    -> { open: [...], live: [...], playing }
//   POST /api/rooms   { color, tc, name, public, client } -> { id, token, color }
//                     tc: { base: seconds, inc: seconds } or null for an untimed game
//   POST /api/quick   { tc, name, client }             -> { id, token, color }
//                     joins a waiting public game with the same time control, or makes one
//   POST /api/rooms/:id/join     { name, client }      -> { token, color } | 409 room is full
//   GET  /api/rooms/:id/events?token=...               -> server-sent events: `hello` { you },
//                                                         then one `state` per change
//   POST /api/rooms/:id/move     { token, uci, ply }   -> { ok } | 4xx { error }
//   POST /api/rooms/:id/resign   { token }
//   POST /api/rooms/:id/abort    { token }             before both sides have moved
//   POST /api/rooms/:id/draw     { token, answer }     answer: 'offer' | 'accept' | 'decline'
//   POST /api/rooms/:id/claim    { token }             win when the opponent has been gone a while
//   POST /api/rooms/:id/rematch  { token }             both ask -> state.next is the new room

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SK = require('../reference/engine.js');

const ROOT = path.resolve(__dirname, '..');
const SERVED = [path.join(ROOT, 'web'), path.join(ROOT, 'reference', 'engine.js')];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const DEFAULTS = {
  roomIdleMs: 6 * 60 * 60 * 1000, // an untouched, unwatched room is removed after this
  maxRooms: 2000,
  firstMoveMs: 30 * 1000, // timed games: each side must make its first move within this
  claimMs: 60 * 1000, // a player gone this long lets the opponent claim the win
  pingMs: 25 * 1000,
};

const TC_LIMITS = { base: [15, 3 * 60 * 60], inc: [0, 180] }; // seconds

const sideKey = c => (c === SK.WHITE ? 'w' : 'b');
const other = k => (k === 'w' ? 'b' : 'w');

function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || null;
}

function cleanTc(v) {
  if (!v || typeof v !== 'object') return null;
  const base = Math.round(Number(v.base));
  const inc = Math.round(Number(v.inc) || 0);
  if (!(base >= TC_LIMITS.base[0] && base <= TC_LIMITS.base[1])) return null;
  if (!(inc >= TC_LIMITS.inc[0] && inc <= TC_LIMITS.inc[1])) return null;
  return { base, inc };
}

const sameTc = (a, b) => (!a && !b) || (a && b && a.base === b.base && a.inc === b.inc);
const cleanClient = v => (typeof v === 'string' && /^[a-z0-9]{8,40}$/i.test(v) ? v : null);

function createGameServer(options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const now = opt.now || (() => Date.now());
  const rooms = new Map();
  let saveTimer = null;

  // --- rooms ------------------------------------------------------------------------------

  function newId() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let id;
    do {
      id = '';
      for (const b of crypto.randomBytes(6)) id += alphabet[b % alphabet.length];
    } while (rooms.has(id));
    return id;
  }

  const newToken = () => crypto.randomBytes(16).toString('hex');

  function makeRoom({ tc = null, isPublic = false } = {}) {
    const t = now();
    const room = {
      id: newId(),
      pos: new SK.Position(),
      moves: [],
      tokens: { w: null, b: null },
      names: { w: null, b: null },
      hosts: { w: null, b: null }, // client ids, so quick pairing never pairs you with yourself
      tc,
      clock: tc ? { w: tc.base * 1000, b: tc.base * 1000 } : null,
      turnSince: null, // when the clock of the side to move started running
      phaseSince: null, // when the current side's first-move window opened
      result: null,
      drawOffer: null,
      rematch: { w: false, b: false },
      next: null,
      isPublic,
      created: t,
      touched: t,
      clients: new Set(), // { res, color }
      goneSince: { w: null, b: null },
      timer: null,
    };
    rooms.set(room.id, room);
    return room;
  }

  const seated = room => !!(room.tokens.w && room.tokens.b);
  const toMove = room => sideKey(room.pos.side);
  const clockRunning = room => !!(room.tc && !room.result && seated(room) && room.moves.length >= 2);
  const firstMovePending = room => !!(room.tc && !room.result && seated(room) && room.moves.length < 2);

  function connected(room, color) {
    for (const c of room.clients) if (c.color === color) return true;
    return false;
  }

  // Time left for a side right now (ms).
  function timeLeft(room, color, t = now()) {
    if (!room.clock) return null;
    let ms = room.clock[color];
    if (clockRunning(room) && toMove(room) === color && room.turnSince !== null) ms -= t - room.turnSince;
    return Math.max(0, ms);
  }

  // A side with only its king and an empty reserve cannot win, so its opponent's flag is a draw.
  function canWin(room, color) {
    const c = color === 'w' ? SK.WHITE : SK.BLACK;
    const pos = room.pos;
    for (let sq = 0; sq < 36; sq++) {
      const code = pos.board[sq];
      if (code && code >> 3 === c && (code & 7) !== SK.KING) return true;
    }
    return [SK.PAWN, SK.BISHOP, SK.ROOK].some(t => pos.hand[c][t] > 0);
  }

  function end(room, result) {
    if (room.result) return;
    const t = now();
    if (room.clock) for (const k of ['w', 'b']) room.clock[k] = timeLeft(room, k, t);
    room.turnSince = null;
    room.result = result;
    room.drawOffer = null;
    changed(room);
  }

  // Checks the clocks and the first-move window, and sets the timer for the next deadline.
  function tick(room) {
    clearTimeout(room.timer);
    room.timer = null;
    if (room.result) return;
    const t = now();
    let wait = Infinity;
    if (clockRunning(room)) {
      const side = toMove(room);
      const left = timeLeft(room, side, t);
      if (left <= 0) {
        const winner = other(side);
        return end(room, canWin(room, winner) ? { winner, reason: 'timeout' } : { winner: null, reason: 'timeout vs insufficient material' });
      }
      wait = left;
    } else if (firstMovePending(room) && room.phaseSince !== null) {
      const left = opt.firstMoveMs - (t - room.phaseSince);
      if (left <= 0) return end(room, { winner: null, reason: 'aborted', detail: 'first move not played' });
      wait = left;
    }
    if (wait < Infinity) {
      room.timer = setTimeout(() => tick(room), Math.min(wait + 5, 2 ** 31 - 1));
      if (room.timer.unref) room.timer.unref();
    }
  }

  function state(room, t = now()) {
    const claimable = {};
    for (const k of ['w', 'b']) {
      const since = room.goneSince[k];
      claimable[k] = since === null || room.result ? null : Math.max(0, opt.claimMs - (t - since));
    }
    return {
      id: room.id,
      startFen: SK.START_FEN,
      moves: room.moves,
      players: { w: !!room.tokens.w, b: !!room.tokens.b },
      names: room.names,
      online: { w: connected(room, 'w'), b: connected(room, 'b') },
      // ms until a gone player's opponent may claim the win (null while they are here)
      gone: claimable,
      tc: room.tc,
      clock: room.clock
        ? { w: timeLeft(room, 'w', t), b: timeLeft(room, 'b', t), running: clockRunning(room) ? toMove(room) : null }
        : null,
      firstMove: firstMovePending(room) && room.phaseSince !== null
        ? { side: toMove(room), left: Math.max(0, opt.firstMoveMs - (t - room.phaseSince)) }
        : null,
      drawOffer: room.drawOffer,
      rematch: room.rematch,
      next: room.next,
      result: room.result,
      watchers: [...room.clients].filter(c => !c.color).length,
      public: room.isPublic,
    };
  }

  function broadcast(room) {
    const t = now();
    const data = `event: state\ndata: ${JSON.stringify(state(room, t))}\n\n`;
    for (const c of room.clients) c.res.write(data);
  }

  function changed(room) {
    room.touched = now();
    tick(room);
    broadcast(room);
    scheduleSave();
  }

  function colorOf(room, token) {
    if (typeof token !== 'string' || !token) return null;
    if (room.tokens.w === token) return 'w';
    if (room.tokens.b === token) return 'b';
    return null;
  }

  function seat(room, color, body) {
    const token = newToken();
    room.tokens[color] = token;
    room.names[color] = cleanName(body.name);
    room.hosts[color] = cleanClient(body.client);
    room.goneSince[color] = now(); // cleared when their event stream connects
    if (seated(room)) room.phaseSince = now();
    return token;
  }

  function sweep() {
    const t = now();
    for (const [id, room] of rooms) {
      if (t - room.touched > opt.roomIdleMs && room.clients.size === 0) {
        clearTimeout(room.timer);
        rooms.delete(id);
      }
    }
  }

  // --- persistence --------------------------------------------------------------------------

  function scheduleSave() {
    if (!opt.dataFile || saveTimer) return;
    saveTimer = setTimeout(save, 500);
    if (saveTimer.unref) saveTimer.unref();
  }

  function save() {
    saveTimer = null;
    if (!opt.dataFile) return;
    const t = now();
    const list = [...rooms.values()].map(r => ({
      id: r.id, moves: r.moves, tokens: r.tokens, names: r.names, hosts: r.hosts, tc: r.tc,
      clock: r.clock ? { w: timeLeft(r, 'w', t), b: timeLeft(r, 'b', t) } : null,
      firstMoveUsed: r.phaseSince === null ? null : t - r.phaseSince,
      result: r.result, drawOffer: r.drawOffer, rematch: r.rematch, next: r.next,
      isPublic: r.isPublic, created: r.created, touched: r.touched,
    }));
    const tmp = `${opt.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ruleset: SK.RULESET, rooms: list }));
    fs.renameSync(tmp, opt.dataFile);
  }

  function load() {
    if (!opt.dataFile || !fs.existsSync(opt.dataFile)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(opt.dataFile, 'utf8'));
    } catch (err) {
      console.error(`ignoring ${opt.dataFile}: ${err.message}`);
      return;
    }
    if (data.ruleset !== SK.RULESET) return console.error(`ignoring ${opt.dataFile}: ruleset ${data.ruleset}`);
    const t = now();
    for (const d of data.rooms || []) {
      const pos = new SK.Position();
      let ok = true;
      for (const u of d.moves) {
        const m = pos.moveFromUci(u);
        if (!m) { ok = false; break; }
        pos.makeMove(m);
      }
      if (!ok) continue;
      const room = {
        ...makeRoom(),
        pos, moves: d.moves, tokens: d.tokens, names: d.names, hosts: d.hosts || { w: null, b: null }, tc: d.tc,
        clock: d.clock, result: d.result, drawOffer: d.drawOffer, rematch: d.rematch || { w: false, b: false },
        next: d.next, isPublic: d.isPublic, created: d.created, touched: d.touched,
      };
      rooms.delete(room.id);
      room.id = d.id;
      room.turnSince = clockRunning(room) ? t : null;
      room.phaseSince = d.firstMoveUsed === null ? null : t - Math.min(d.firstMoveUsed, opt.firstMoveMs / 2);
      // Everyone is disconnected after a restart; start counting from now.
      if (!room.result && seated(room)) room.goneSince = { w: t, b: t };
      rooms.set(room.id, room);
      tick(room);
    }
  }

  // --- HTTP -------------------------------------------------------------------------------

  function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise(resolve => {
      let text = '';
      req.on('data', chunk => {
        text += chunk;
        if (text.length > 4096) req.destroy();
      });
      req.on('end', () => {
        try {
          const v = text ? JSON.parse(text) : {};
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  function lobby() {
    const open = [], live = [];
    let playing = 0;
    for (const r of rooms.values()) {
      if (r.result) continue;
      if (seated(r)) {
        playing++;
        if (r.moves.length && (connected(r, 'w') || connected(r, 'b'))) {
          live.push({ id: r.id, tc: r.tc, names: r.names, moves: r.moves.length, watchers: [...r.clients].filter(c => !c.color).length });
        }
      } else if (r.isPublic) {
        const host = r.tokens.w ? 'w' : 'b';
        if (connected(r, host)) open.push({ id: r.id, tc: r.tc, open: other(host), name: r.names[host], created: r.created });
      }
    }
    open.sort((a, b) => b.created - a.created);
    live.sort((a, b) => b.moves - a.moves);
    return { open: open.slice(0, 30), live: live.slice(0, 20), playing };
  }

  function create(body) {
    sweep();
    if (rooms.size >= opt.maxRooms) return null;
    const tc = cleanTc(body.tc);
    const room = makeRoom({ tc, isPublic: !!body.public });
    const color = body.color === 'w' || body.color === 'b' ? body.color : Math.random() < 0.5 ? 'w' : 'b';
    const token = seat(room, color, body);
    scheduleSave();
    return { id: room.id, token, color };
  }

  function events(req, res, room, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const color = colorOf(room, url.searchParams.get('token'));
    const client = { res, color };
    res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ you: color })}\n\n`);
    room.clients.add(client);
    if (color && room.goneSince[color] !== null) room.goneSince[color] = null;
    changed(room);
    const ping = setInterval(() => res.write(': ping\n\n'), opt.pingMs);
    if (ping.unref) ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(client);
      if (color && !connected(room, color) && !room.result) room.goneSince[color] = now();
      if (rooms.get(room.id) === room) changed(room);
    });
  }

  // Player actions. Each returns [status, body].
  const actions = {
    move(room, color, body) {
      if (!seated(room)) return [409, { error: 'Waiting for an opponent' }];
      if (toMove(room) !== color) return [409, { error: 'Not your turn' }];
      if (body.ply !== undefined && body.ply !== room.moves.length) return [409, { error: 'Out of sync: reloading the game' }];
      const m = typeof body.uci === 'string' ? room.pos.moveFromUci(body.uci) : 0;
      if (!m) return [400, { error: 'Illegal move' }];
      const t = now();
      if (clockRunning(room)) {
        const left = timeLeft(room, color, t);
        if (left <= 0) {
          tick(room);
          return [409, { error: 'Out of time' }];
        }
        room.clock[color] = left + room.tc.inc * 1000;
      }
      room.pos.makeMove(m);
      room.moves.push(body.uci);
      room.turnSince = t;
      room.phaseSince = room.moves.length < 2 ? t : null;
      if (room.drawOffer && room.drawOffer !== color) room.drawOffer = null; // moving declines it
      const st = room.pos.status();
      if (st.state === 'win') end(room, { winner: sideKey(st.winner), reason: st.reason });
      else if (st.state === 'draw') end(room, { winner: null, reason: st.reason });
      else changed(room);
      return [200, { ok: true }];
    },

    resign(room, color) {
      if (room.moves.length < 2) return actions.abort(room, color);
      end(room, { winner: other(color), reason: 'resignation' });
      return [200, { ok: true }];
    },

    abort(room, color) {
      if (room.moves.length >= 2) return [409, { error: 'Too late to abort: resign or offer a draw' }];
      end(room, { winner: null, reason: 'aborted', by: color });
      return [200, { ok: true }];
    },

    draw(room, color, body) {
      if (!seated(room)) return [409, { error: 'Waiting for an opponent' }];
      const answer = body.answer || 'offer';
      if (answer === 'offer' || answer === 'accept') {
        if (room.drawOffer === other(color)) {
          end(room, { winner: null, reason: 'agreement' });
        } else if (answer === 'offer') {
          if (room.moves.length < 2) return [409, { error: 'Make a move first' }];
          room.drawOffer = color;
          changed(room);
        } else {
          return [409, { error: 'There is no draw offer to accept' }];
        }
      } else if (answer === 'decline') {
        if (room.drawOffer) room.drawOffer = null, changed(room);
      } else {
        return [400, { error: 'answer must be offer, accept or decline' }];
      }
      return [200, { ok: true }];
    },

    claim(room, color) {
      const opp = other(color);
      const since = room.goneSince[opp];
      if (!seated(room) || since === null || connected(room, opp)) return [409, { error: 'Your opponent is still here' }];
      if (now() - since < opt.claimMs) return [409, { error: 'Give your opponent a little longer to come back' }];
      if (room.moves.length < 2) end(room, { winner: null, reason: 'aborted', detail: 'opponent left' });
      else end(room, canWin(room, color) ? { winner: color, reason: 'abandonment' } : { winner: null, reason: 'abandonment vs insufficient material' });
      return [200, { ok: true }];
    },

    rematch(room, color) {
      if (!seated(room)) return [409, { error: 'There is no opponent to play' }];
      if (room.next) return [200, { ok: true, next: room.next }];
      room.rematch[color] = true;
      if (room.rematch.w && room.rematch.b) {
        // Colours swap; each player keeps their token.
        const next = makeRoom({ tc: room.tc });
        next.tokens = { w: room.tokens.b, b: room.tokens.w };
        next.names = { w: room.names.b, b: room.names.w };
        next.hosts = { w: room.hosts.b, b: room.hosts.w };
        next.phaseSince = now();
        next.goneSince = { w: now(), b: now() };
        room.next = next.id;
        tick(next);
      }
      changed(room);
      return [200, { ok: true, next: room.next }];
    },
  };
  const AFTER_RESULT = new Set(['rematch']);

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', id?, action?]
    const route = parts[1];
    if (route === 'health') return send(res, 200, { ok: true, ruleset: SK.RULESET });
    if (route === 'lobby' && req.method === 'GET') return send(res, 200, lobby());

    if (route === 'quick' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body) return send(res, 400, { error: 'bad JSON' });
      const tc = cleanTc(body.tc);
      const client = cleanClient(body.client);
      for (const r of rooms.values()) {
        if (!r.isPublic || r.result || seated(r) || !sameTc(r.tc, tc)) continue;
        const host = r.tokens.w ? 'w' : 'b';
        if (!connected(r, host) || (client && r.hosts[host] === client)) continue;
        const color = other(host);
        const token = seat(r, color, body);
        changed(r);
        return send(res, 200, { id: r.id, token, color });
      }
      const made = create({ ...body, public: true, color: 'random' });
      return made ? send(res, 200, made) : send(res, 503, { error: 'server full' });
    }

    if (route !== 'rooms') return send(res, 404, { error: 'not found' });

    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      if (!body) return send(res, 400, { error: 'bad JSON' });
      const made = create(body);
      return made ? send(res, 200, made) : send(res, 503, { error: 'server full' });
    }

    const room = rooms.get(parts[2]);
    if (!room) return send(res, 404, { error: 'That game does not exist (games close after a few idle hours)' });
    room.touched = now();
    const action = parts[3];

    if (action === 'events' && req.method === 'GET') return events(req, res, room, url);
    if (!action && req.method === 'GET') return send(res, 200, state(room));
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'bad JSON' });

    if (action === 'join') {
      if (room.result) return send(res, 409, { error: 'The game is over' });
      const free = !room.tokens.w ? 'w' : !room.tokens.b ? 'b' : null;
      if (!free) return send(res, 409, { error: 'The game is full' });
      const token = seat(room, free, body);
      changed(room);
      return send(res, 200, { token, color: free });
    }

    const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
    if (!fn) return send(res, 404, { error: 'not found' });
    const color = colorOf(room, body.token);
    if (!color) return send(res, 403, { error: 'You are not a player in this game' });
    if (room.result && !AFTER_RESULT.has(action)) return send(res, 409, { error: 'The game is over' });
    if (!room.result && AFTER_RESULT.has(action)) return send(res, 409, { error: 'The game is still going' });
    tick(room); // a flag that fell since the last timer decides the game first
    if (room.result && !AFTER_RESULT.has(action)) return send(res, 409, { error: 'The game is over' });
    const [code, out] = fn(room, color, body);
    return send(res, code, out);
  }

  function serveStatic(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (rel === '/' || rel === '/web') {
      res.writeHead(302, { Location: '/web/' });
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    const allowed = SERVED.some(p => file === p || file.startsWith(p + path.sep));
    if (!allowed) {
      res.writeHead(404);
      return res.end('not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  load();
  const sweeper = setInterval(sweep, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch(err => send(res, 500, { error: String(err.message || err) }));
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  server.on('close', () => {
    clearInterval(sweeper);
    for (const r of rooms.values()) clearTimeout(r.timer);
    if (saveTimer) clearTimeout(saveTimer), save();
  });
  return { server, rooms, save };
}

const createServer = options => createGameServer(options).server;

if (require.main === module) {
  const arg = name => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const port = parseInt(arg('--port') || process.env.PORT || '8080', 10);
  const dataFile = arg('--data') || process.env.MAKI_DATA;
  const { server, save } = createGameServer({ dataFile });
  server.listen(port, () => console.log(`Maki: http://localhost:${port}/${dataFile ? ` (games kept in ${dataFile})` : ''}`));
  const stop = () => {
    if (dataFile) save();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, createGameServer };
