'use strict';
// The Maki web server: serves the site and runs online games between two browsers.
// No dependencies. Moves are checked with the reference engine, so a client cannot cheat.
//
//   node web/server.js [--port 8080]        then open http://localhost:8080/
//
// API (JSON):
//   POST /api/rooms               { color: 'w'|'b'|'random' } -> { id, token, color }
//   POST /api/rooms/:id/join      {}                          -> { token, color }
//   GET  /api/rooms/:id/events?token=...                      -> server-sent events, one `state`
//                                                                per change
//   POST /api/rooms/:id/move      { token, uci }              -> { ok: true } | 4xx { error }
//   POST /api/rooms/:id/resign    { token }                   -> { ok: true }

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
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_ROOMS = 2000;

const rooms = new Map();

function newId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id;
  do {
    id = '';
    for (const b of crypto.randomBytes(6)) id += alphabet[b % alphabet.length];
  } while (rooms.has(id));
  return id;
}

function roomState(room) {
  return {
    id: room.id,
    startFen: SK.START_FEN,
    moves: room.moves,
    players: { w: !!room.tokens.w, b: !!room.tokens.b },
    result: room.result,
  };
}

function broadcast(room) {
  const data = `event: state\ndata: ${JSON.stringify(roomState(room))}\n\n`;
  for (const res of room.clients) res.write(data);
}

function colorOf(room, token) {
  if (!token) return null;
  if (room.tokens.w === token) return 'w';
  if (room.tokens.b === token) return 'b';
  return null;
}

function finish(room) {
  const st = room.pos.status();
  if (st.state === 'win') {
    room.result = { winner: st.winner === SK.WHITE ? 'w' : 'b', reason: st.reason };
  } else if (st.state === 'draw') {
    room.result = { winner: null, reason: st.reason };
  }
}

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
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function sweep() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS && room.clients.size === 0) rooms.delete(id);
  }
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', id?, action?]
  if (parts[1] === 'health') return send(res, 200, { ok: true, ruleset: SK.RULESET });
  if (parts[1] !== 'rooms') return send(res, 404, { error: 'not found' });

  if (parts.length === 2 && req.method === 'POST') {
    const body = (await readJson(req)) || {};
    sweep();
    if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'server full' });
    let color = body.color === 'w' || body.color === 'b' ? body.color : Math.random() < 0.5 ? 'w' : 'b';
    const room = {
      id: newId(),
      pos: new SK.Position(),
      moves: [],
      tokens: { w: null, b: null },
      result: null,
      clients: new Set(),
      touched: Date.now(),
    };
    const token = crypto.randomBytes(16).toString('hex');
    room.tokens[color] = token;
    rooms.set(room.id, room);
    return send(res, 200, { id: room.id, token, color });
  }

  const room = rooms.get(parts[2]);
  if (!room) return send(res, 404, { error: 'no such room' });
  room.touched = Date.now();
  const action = parts[3];

  if (action === 'events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const you = colorOf(room, url.searchParams.get('token'));
    res.write(`event: hello\ndata: ${JSON.stringify({ you })}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(roomState(room))}\n\n`);
    room.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(res);
    });
    return;
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'bad JSON' });

  if (action === 'join') {
    const free = !room.tokens.w ? 'w' : !room.tokens.b ? 'b' : null;
    if (!free) return send(res, 409, { error: 'room is full' });
    const token = crypto.randomBytes(16).toString('hex');
    room.tokens[free] = token;
    broadcast(room);
    return send(res, 200, { token, color: free });
  }

  const color = colorOf(room, body.token);
  if (!color) return send(res, 403, { error: 'not a player in this room' });
  if (room.result) return send(res, 409, { error: 'the game is over' });

  if (action === 'move') {
    if (!room.tokens.w || !room.tokens.b) return send(res, 409, { error: 'waiting for an opponent' });
    if ((room.pos.side === SK.WHITE ? 'w' : 'b') !== color) return send(res, 409, { error: 'not your turn' });
    const m = typeof body.uci === 'string' ? room.pos.moveFromUci(body.uci) : 0;
    if (!m) return send(res, 400, { error: 'illegal move' });
    room.pos.makeMove(m);
    room.moves.push(body.uci);
    finish(room);
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (action === 'resign') {
    room.result = { winner: color === 'w' ? 'b' : 'w', reason: 'resignation' };
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
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
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
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
}

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? parseInt(process.argv[i + 1], 10) : parseInt(process.env.PORT || '8080', 10);
  createServer().listen(port, () => console.log(`Maki: http://localhost:${port}/`));
}

module.exports = { createServer, rooms };
