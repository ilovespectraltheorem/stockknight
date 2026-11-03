'use strict';
// The Maki site (the game was called KnightChess; its engine, Stockhorse, was StockKnight): the board, play against the engine, pass-and-play, online games and
// game review. Rules come from the reference engine (reference/engine.js), so the site plays
// exactly the game the engines play.

(function () {
  const SK = window.StockKnight;
  const { Position, START_FEN, WHITE, BLACK, moveFrom, moveTo, moveDrop } = SK;
  const { pieceSvg } = window.Pieces;
  const R = window.Review;
  const LETTERS = '.PNBRQK';
  const DROP_ORDER = [SK.PAWN, SK.BISHOP, SK.ROOK];
  const colorName = c => (c === WHITE ? 'White' : 'Black');
  const colorKey = c => (c === WHITE ? 'w' : 'b');

  // --- small helpers ----------------------------------------------------------------------

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable: the site still works, it just forgets */
      }
    },
  };

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function buildPosition(fen, moves) {
    const pos = new Position(fen || START_FEN);
    for (const u of moves) {
      const m = pos.moveFromUci(u);
      if (!m) throw new Error(`illegal move ${u}`);
      pos.makeMove(m);
    }
    return pos;
  }

  function badgeHtml(cls, extra = '') {
    const c = R.CLASSES[cls];
    return `<span class="badge ${cls} ${extra}" title="${c.label}">${c.symbol}</span>`;
  }

  function resultText(result) {
    if (!result) return '';
    if (!result.winner) return result.reason === 'bare kings' ? 'Draw: bare kings' : 'Draw by repetition';
    const who = result.winner === 'w' ? 'White' : 'Black';
    const how = {
      checkmate: 'by checkmate',
      stalemate: 'by stalemate (no legal move loses)',
      resignation: 'by resignation',
    }[result.reason] || '';
    return `${who} wins ${how}`.trim();
  }

  function statusToResult(st) {
    if (st.state === 'win') return { winner: colorKey(st.winner), reason: st.reason };
    if (st.state === 'draw') return { winner: null, reason: st.reason };
    return null;
  }

  // --- engine client (Web Worker, or the page itself when workers are unavailable) --------

  class EngineClient {
    constructor() {
      this.pending = new Map();
      this.nextId = 1;
      this.start();
    }

    start() {
      this.worker = null;
      try {
        // A bundled single-file page (build-artifact.js) carries the worker's source inline.
        this.worker = window.SK_WORKER_SRC
          ? new Worker(URL.createObjectURL(new Blob([window.SK_WORKER_SRC], { type: 'text/javascript' })))
          : new Worker('engine-worker.js');
        this.worker.onmessage = e => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error));
          else p.resolve(e.data.result);
        };
        this.worker.onerror = () => {
          // Most often a file:// page; fall back to running on the page.
          this.worker = null;
          for (const [, p] of this.pending) p.retry();
          this.pending.clear();
        };
      } catch {
        this.worker = null;
      }
    }

    call(cmd, args) {
      return new Promise((resolve, reject) => {
        const local = async () => {
          await sleep(30); // let the page paint first
          try {
            resolve(window.EngineTasks[cmd](args));
          } catch (err) {
            reject(err);
          }
        };
        if (!this.worker) return void local();
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject, retry: local });
        this.worker.postMessage({ id, cmd, args });
      });
    }

    // Abandon whatever is running (a new game while the engine thinks).
    reset() {
      if (this.worker) {
        this.worker.terminate();
        for (const [, p] of this.pending) p.reject(new Error('cancelled'));
        this.pending.clear();
        this.start();
      }
    }
  }

  let backend = null; // online rooms: see online.js
  const engine = new EngineClient(); // play
  const reviewEngine = new EngineClient(); // game review, so it never waits behind a game

  // --- board view -------------------------------------------------------------------------

  class BoardView {
    constructor(el, opts = {}) {
      this.el = el;
      this.onMove = opts.onMove || (() => {});
      this.pos = new Position();
      this.flipped = false;
      this.lastMove = 0;
      this.movable = null; // color the user may move, or null
      this.selected = null; // { sq } or { drop: type }
      this.badge = null; // { sq, cls }
      this.arrows = [];
      this.legal = [];
      el.addEventListener('pointerdown', e => this.pointerDown(e));
    }

    set(state) {
      Object.assign(this, state);
      this.selected = null;
      this.render();
    }

    squareAt(row, col) {
      return this.flipped ? row * 6 + (5 - col) : (5 - row) * 6 + col;
    }

    targets() {
      const sel = this.selected;
      if (!sel) return [];
      return this.legal.filter(m => (sel.drop ? moveDrop(m) === sel.drop : !moveDrop(m) && moveFrom(m) === sel.sq));
    }

    render() {
      const pos = this.pos;
      this.legal = this.movable !== null && pos.side === this.movable ? pos.legalMoves() : [];
      const targets = new Set(this.targets().map(moveTo));
      const checkSq = pos.inCheck() ? pos.kingSq[pos.side] : -1;
      const lastFrom = this.lastMove && !moveDrop(this.lastMove) ? moveFrom(this.lastMove) : -1;
      const lastTo = this.lastMove ? moveTo(this.lastMove) : -1;
      const html = [];
      for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 6; col++) {
          const sq = this.squareAt(row, col);
          const file = sq % 6, rank = (sq / 6) | 0;
          const code = pos.board[sq];
          const cls = ['sq', (file + rank) % 2 ? 'light' : 'dark'];
          if (sq === lastFrom || sq === lastTo) cls.push('last');
          if (this.selected && this.selected.sq === sq) cls.push('sel');
          if (sq === checkSq) cls.push('check');
          if (code) cls.push('has-piece');
          if (targets.has(sq)) cls.push('target');
          if (code && this.legal.some(m => !moveDrop(m) && moveFrom(m) === sq)) cls.push('can-move');
          let inner = '';
          if (code) inner += pieceSvg(LETTERS[code & 7], code >> 3 ? 'b' : 'w');
          if (targets.has(sq) && !code) inner += '<span class="dot"></span>';
          if (col === 0) inner += `<span class="coord rank">${rank + 1}</span>`;
          if (row === 5) inner += `<span class="coord file">${'abcdef'[file]}</span>`;
          if (this.badge && this.badge.sq === sq) inner += badgeHtml(this.badge.cls);
          html.push(`<div class="${cls.join(' ')}" data-sq="${sq}">${inner}</div>`);
        }
      }
      html.push(this.arrowSvg());
      this.el.innerHTML = html.join('');
    }

    center(sq) {
      const file = sq % 6, rank = (sq / 6) | 0;
      const col = this.flipped ? 5 - file : file;
      const row = this.flipped ? rank : 5 - rank;
      return [col + 0.5, row + 0.5];
    }

    arrowSvg() {
      if (!this.arrows.length) return '';
      const parts = this.arrows.map(({ move, color }) => {
        const [x2, y2] = this.center(moveTo(move));
        if (moveDrop(move)) {
          return `<circle cx="${x2}" cy="${y2}" r="0.42" fill="none" stroke="${color}" stroke-width="0.09" opacity="0.85"/>`;
        }
        const [x1, y1] = this.center(moveFrom(move));
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
        const ux = dx / len, uy = dy / len;
        const ex = x2 - ux * 0.3, ey = y2 - uy * 0.3;
        const head = `${x2 - ux * 0.08},${y2 - uy * 0.08} ${ex - uy * 0.2},${ey + ux * 0.2} ${ex + uy * 0.2},${ey - ux * 0.2}`;
        return `<g opacity="0.82"><line x1="${x1 + ux * 0.2}" y1="${y1 + uy * 0.2}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="0.15" stroke-linecap="round"/><polygon points="${head}" fill="${color}"/></g>`;
      });
      return `<svg class="arrow-layer" viewBox="0 0 6 6">${parts.join('')}</svg>`;
    }

    selectDrop(type) {
      if (this.movable === null || this.pos.side !== this.movable) return;
      this.selected = this.selected && this.selected.drop === type ? null : { drop: type };
      this.render();
      if (this.onSelect) this.onSelect(this.selected);
    }

    tryMove(sq) {
      const m = this.targets().find(x => moveTo(x) === sq);
      if (!m) return false;
      this.selected = null;
      if (this.onSelect) this.onSelect(null);
      this.onMove(this.pos.moveToUci(m));
      return true;
    }

    pointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      const sqEl = e.target.closest('.sq');
      if (!sqEl) return;
      const sq = +sqEl.dataset.sq;
      if (this.selected && this.tryMove(sq)) return;

      const code = this.pos.board[sq];
      const own = code && this.movable !== null && code >> 3 === this.movable && this.pos.side === this.movable;
      if (!own) {
        if (this.selected) {
          this.selected = null;
          this.render();
          if (this.onSelect) this.onSelect(null);
        }
        return;
      }
      const already = this.selected && this.selected.sq === sq;
      this.selected = { sq };
      this.render();
      if (this.onSelect) this.onSelect(this.selected);
      this.startDrag(e, sq, already);
    }

    startDrag(e, sq, wasSelected) {
      const rect = this.el.getBoundingClientRect();
      const size = rect.width / 6;
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.style.width = ghost.style.height = `${size * 0.95}px`;
      const code = this.pos.board[sq];
      ghost.innerHTML = pieceSvg(LETTERS[code & 7], code >> 3 ? 'b' : 'w');
      let moved = false;
      const x0 = e.clientX, y0 = e.clientY;
      const srcEl = this.el.querySelector(`[data-sq="${sq}"]`);
      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        if (!moved) {
          moved = true;
          document.body.appendChild(ghost);
          srcEl.classList.add('dragging');
        }
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      };
      const up = ev => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        ghost.remove();
        srcEl.classList.remove('dragging');
        if (!moved) {
          if (wasSelected) {
            this.selected = null;
            this.render();
            if (this.onSelect) this.onSelect(null);
          }
          return;
        }
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const target = under && under.closest && under.closest('.sq');
        if (target && this.el.contains(target) && this.tryMove(+target.dataset.sq)) return;
        this.render();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
  }

  // --- eval bar ---------------------------------------------------------------------------

  function setEvalBar(el, scoreWhite, flipped) {
    const wp = R.winProb(scoreWhite);
    el.querySelector('.evalbar-fill').style.height = `${Math.max(0.03, Math.min(0.97, wp)) * 100}%`;
    el.classList.toggle('flipped', !!flipped);
    el.classList.toggle('black-ahead', scoreWhite < 0);
    el.querySelector('.evalbar-text').textContent = R.scoreText(Math.abs(scoreWhite)).replace('+', '');
  }

  // --- saved games ------------------------------------------------------------------------

  function savedGames() {
    // Games saved under an earlier ruleset may not replay under the current rules.
    return store.get('sk.games', []).filter(g => g.ruleset === SK.RULESET);
  }

  function saveGame(game) {
    const games = savedGames().filter(g => g.id !== game.id);
    games.unshift({ ...game, ruleset: SK.RULESET });
    store.set('sk.games', games.slice(0, 40));
    renderRecent();
  }

  function timeAgo(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString();
  }

  function recentItems(limit) {
    return savedGames()
      .slice(0, limit)
      .map(
        g => `<li><button data-game="${esc(g.id)}"><span><b>${esc(g.white)}</b> vs <b>${esc(g.black)}</b>
          <span class="muted"> · ${esc(resultText(g.result) || 'unfinished')} · ${Math.ceil(g.moves.length / 2)} moves</span></span>
          <span class="when">${timeAgo(g.date)}</span></button></li>`,
      )
      .join('');
  }

  function renderRecent() {
    const items = recentItems(6);
    $('#recentWrap').hidden = !items;
    $('#recentList').innerHTML = items;
    $('#reviewRecent').innerHTML = recentItems(12);
  }

  function openSaved(id) {
    const g = savedGames().find(x => x.id === id);
    if (g) {
      review.load(g);
      location.hash = '#/review';
    }
  }

  // --- opponents --------------------------------------------------------------------------

  const OPPONENTS = [
    { id: 'page', name: 'Page', piece: 'P', blurb: 'Still learning the L. Takes whatever looks shiny.' },
    { id: 'squire', name: 'Squire', piece: 'B', blurb: 'Looks two moves ahead, with a little randomness.' },
    { id: 'knight', name: 'Knight', piece: 'N', blurb: 'Seven plies deep, about a second a move.' },
    { id: 'champion', name: 'Champion', piece: 'K', blurb: 'Three seconds a move at full strength.' },
  ];

  // --- play controller --------------------------------------------------------------------

  const play = {
    board: null,
    game: null, // { id, mode, startFen, moves, white, black, result, level, humanColor }
    pos: null,
    thinking: false,
    showEval: store.get('sk.showEval', false),
    flipped: false,
    online: null, // { id, token, color, es, players }
    dropSel: null,
    token: 0,

    init() {
      this.board = new BoardView($('#playBoard'), { onMove: uci => this.userMove(uci) });
      this.board.onSelect = sel => {
        this.dropSel = sel && sel.drop ? sel.drop : null;
        this.renderBars();
      };
      $('#btnFlip').onclick = () => {
        this.flipped = !this.flipped;
        this.render();
      };
      $('#btnEval').onclick = () => {
        this.showEval = !this.showEval;
        store.set('sk.showEval', this.showEval);
        this.render();
        if (this.showEval) this.updateEval();
      };
      $('#btnUndo').onclick = () => this.undo();
      $('#btnResign').onclick = () => this.resign();
      $('#btnNew').onclick = () => this.again();
      $('#btnReviewThis').onclick = () => this.reviewThis();
      $('#btnCopy').onclick = () => {
        $('#shareLink').select();
        navigator.clipboard?.writeText($('#shareLink').value).then(
          () => toast('Link copied'),
          () => toast('Select the link and copy it'),
        );
      };
      for (const id of ['#barTop', '#barBottom']) {
        $(id).addEventListener('click', e => {
          const b = e.target.closest('.res.usable');
          if (b) this.board.selectDrop(+b.dataset.type);
        });
      }
    },

    start(opts) {
      this.leaveOnline();
      engine.reset();
      this.token++;
      this.thinking = false;
      this.dropSel = null;
      const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      let humanColor = null;
      let white = 'White', black = 'Black';
      if (opts.mode === 'pve') {
        humanColor = opts.color === 'random' ? (Math.random() < 0.5 ? WHITE : BLACK) : opts.color === 'b' ? BLACK : WHITE;
        const opp = OPPONENTS.find(o => o.id === opts.level) || OPPONENTS[1];
        const engineName = `${opp.name} (Stockhorse)`;
        white = humanColor === WHITE ? 'You' : engineName;
        black = humanColor === BLACK ? 'You' : engineName;
      }
      this.game = { id, mode: opts.mode, startFen: START_FEN, moves: [], white, black, result: null, level: opts.level, humanColor, date: Date.now() };
      this.pos = new Position(START_FEN);
      this.flipped = opts.mode === 'pve' ? humanColor === BLACK : false;
      $('#sharePanel').hidden = true;
      this.render();
      this.maybeEngine();
    },

    again() {
      if (!this.game || this.game.mode === 'pve') return openPveDialog();
      if (this.game.mode === 'online') return openOnlineDialog();
      this.start({ mode: 'local' });
    },

    isHuman(color) {
      const g = this.game;
      if (g.mode === 'local') return true;
      if (g.mode === 'pve') return color === g.humanColor;
      if (g.mode === 'online') return this.online && this.online.color === color;
      return false;
    },

    movableColor() {
      if (!this.game || this.game.result || this.thinking) return null;
      if (this.game.mode === 'online' && (!this.online || !this.online.players.w || !this.online.players.b)) return null;
      return this.isHuman(this.pos.side) ? this.pos.side : null;
    },

    userMove(uci) {
      if (this.game.mode === 'online') return this.onlineMove(uci);
      this.applyMove(uci);
      this.maybeEngine();
    },

    applyMove(uci) {
      const m = this.pos.moveFromUci(uci);
      if (!m) return false;
      this.pos.makeMove(m);
      this.game.moves.push(uci);
      this.dropSel = null;
      if (this.game.mode === 'local') this.flipped = this.pos.side === BLACK;
      const res = statusToResult(this.pos.status());
      if (res && !this.game.result) this.finish(res);
      this.render();
      if (this.showEval) this.updateEval();
      return true;
    },

    async maybeEngine() {
      const g = this.game;
      if (g.mode !== 'pve' || g.result || this.isHuman(this.pos.side)) return;
      const token = ++this.token;
      this.thinking = true;
      this.render();
      const started = Date.now();
      try {
        const r = await engine.call('play', { fen: g.startFen, moves: g.moves.slice(), level: g.level });
        const wait = 450 - (Date.now() - started);
        if (wait > 0) await sleep(wait);
        if (token !== this.token) return;
        this.thinking = false;
        if (r.best) this.applyMove(r.best);
        else this.render();
      } catch (err) {
        if (token !== this.token) return;
        this.thinking = false;
        this.render();
        if (err.message !== 'cancelled') toast(`Engine error: ${err.message}`);
      }
    },

    async updateEval() {
      const g = this.game;
      if (!g || g.mode === 'pve' && !g.result && this.thinking) return;
      const n = g.moves.length;
      if (this.pos.status().state !== 'ongoing') return;
      if (g.mode === 'pve' && !g.result && !this.isHuman(this.pos.side)) return; // engine is about to think
      try {
        const a = await engine.call('analyse', { fen: g.startFen, moves: g.moves.slice(), movetime: 250, depth: 8 });
        if (this.game !== g || g.moves.length !== n) return;
        const white = this.pos.side === WHITE ? a.score : -a.score;
        setEvalBar($('#playEval'), white, this.flipped);
      } catch {
        /* superseded */
      }
    },

    undo() {
      const g = this.game;
      if (!g || g.mode === 'online' || !g.moves.length) return;
      engine.reset();
      this.token++;
      this.thinking = false;
      let n = 1;
      if (g.mode === 'pve') {
        // Back to the human's turn: one ply if the engine has not replied yet, otherwise two.
        n = this.pos.side === g.humanColor ? 2 : 1;
        if (n > g.moves.length) n = g.moves.length;
      }
      g.moves.splice(g.moves.length - n, n);
      g.result = null;
      this.pos = buildPosition(g.startFen, g.moves);
      if (g.mode === 'local') this.flipped = this.pos.side === BLACK;
      this.render();
      if (this.showEval) this.updateEval();
      this.maybeEngine();
    },

    resign() {
      const g = this.game;
      if (!g || g.result) return;
      if (g.mode === 'online') {
        if (!this.online || this.online.color === null) return;
        if (!this.confirmResign()) return;
        backend.resign(this.online.id).catch(err => toast(err.message));
        return;
      }
      const loser = g.mode === 'pve' ? g.humanColor : this.pos.side;
      if (!this.confirmResign()) return;
      engine.reset();
      this.token++;
      this.thinking = false;
      this.finish({ winner: loser === WHITE ? 'b' : 'w', reason: 'resignation' });
      this.render();
    },

    // Resigning takes a second click within a few seconds (no browser confirm dialog, which
    // embedded pages may not be allowed to show).
    confirmResign() {
      const b = $('#btnResign');
      if (this.resignArmed) {
        clearTimeout(this.resignArmed);
        this.resignArmed = 0;
        b.textContent = 'Resign';
        return true;
      }
      b.textContent = 'Click again to resign';
      this.resignArmed = setTimeout(() => {
        this.resignArmed = 0;
        b.textContent = 'Resign';
      }, 3000);
      return false;
    },

    finish(result) {
      const g = this.game;
      g.result = result;
      if (g.moves.length) saveGame({ ...g, moves: g.moves.slice() });
      setTimeout(() => showResult(g), 350);
    },

    reviewThis() {
      const g = this.game;
      if (!g || !g.moves.length) return toast('Play a move or two first');
      saveGame({ ...g, moves: g.moves.slice() });
      review.load({ ...g, moves: g.moves.slice() });
      location.hash = '#/review';
    },

    // --- rendering ---

    render() {
      if (!this.game) return;
      const g = this.game;
      const lastMove = g.moves.length ? this.lastMoveCode() : 0;
      this.board.set({ pos: this.pos, flipped: this.flipped, lastMove, movable: this.movableColor(), badge: null, arrows: [] });
      this.renderBars();
      this.renderMoves();
      this.renderStatus();
      $('#playEval').hidden = !this.showEval;
      $('#btnEval').classList.toggle('primary', this.showEval);
      $('#btnUndo').disabled = g.mode === 'online' || !g.moves.length;
      $('#btnResign').disabled = !!g.result || (g.mode === 'online' && !(this.online && this.online.color !== null));
    },

    lastMoveCode() {
      const g = this.game;
      const prev = buildPosition(g.startFen, g.moves.slice(0, -1));
      return prev.moveFromUci(g.moves[g.moves.length - 1]);
    },

    renderBars() {
      const g = this.game;
      const bottomColor = this.flipped ? BLACK : WHITE;
      $('#barBottom').innerHTML = this.barHtml(bottomColor);
      $('#barTop').innerHTML = this.barHtml(bottomColor ^ 1);
      $('#barBottom').classList.toggle('to-move', !g.result && this.pos.side === bottomColor);
      $('#barTop').classList.toggle('to-move', !g.result && this.pos.side !== bottomColor);
    },

    barHtml(color) {
      const g = this.game;
      const name = color === WHITE ? g.white : g.black;
      let sub = name === colorName(color) ? '' : colorName(color);
      if (g.mode === 'local') sub = 'Pass and play';
      if (g.mode === 'online' && this.online) {
        const here = this.online.players[colorKey(color)];
        if (this.online.color !== color && !here) sub += ' · waiting to join';
      }
      const thinking = this.thinking && this.pos.side === color ? '<span class="thinking"><i></i><i></i><i></i></span>' : '';
      const mine = this.movableColor() === color;
      const droppable = new Set(mine ? this.board.legal.map(moveDrop).filter(Boolean) : []);
      const res = DROP_ORDER.map(t => {
        const n = this.pos.hand[color][t];
        const usable = droppable.has(t);
        const name = window.Pieces.NAMES[LETTERS[t]];
        const title = `${n} ${name}${n === 1 ? '' : 's'} in reserve${n && mine && !usable ? ' (no legal drop right now)' : ''}`;
        const cls = ['res', n ? '' : 'empty', usable ? 'usable' : '', this.dropSel === t && usable ? 'sel' : ''].join(' ');
        return `<button class="${cls}" data-type="${t}" title="${title}"${usable ? '' : ' tabindex="-1"'}>
          ${pieceSvg(LETTERS[t], colorKey(color))}${n > 1 ? `<span class="count">${n}</span>` : ''}</button>`;
      }).join('');
      const avatarPiece = name.includes('Stockhorse') ? OPPONENTS.find(o => name.startsWith(o.name))?.piece || 'N' : 'N';
      return `<div class="avatar">${pieceSvg(avatarPiece, colorKey(color))}</div>
        <div><div class="pname">${esc(name)}${thinking}</div><div class="psub">${sub}</div></div>
        <div class="reserve">${res}</div>`;
    },

    renderMoves() {
      const g = this.game;
      const pos = new Position(g.startFen);
      const items = [];
      g.moves.forEach((u, i) => {
        const m = pos.moveFromUci(u);
        const text = pos.moveToText(m);
        pos.makeMove(m);
        if (i % 2 === 0) items.push(`<li><span class="no">${i / 2 + 1}.</span>`);
        items.push(`<span class="mv${i === g.moves.length - 1 ? ' cur' : ''}">${esc(text)}</span>`);
        if (i % 2 === 1) items.push('</li>');
      });
      const ol = $('#playMoves');
      ol.innerHTML = items.join('');
      ol.scrollTop = ol.scrollHeight;
    },

    renderStatus() {
      const g = this.game;
      let main, sub = '';
      if (g.result) {
        main = resultText(g.result);
        sub = 'Review the game to see where it was won and lost.';
      } else if (g.mode === 'online' && this.online && (!this.online.players.w || !this.online.players.b)) {
        main = 'Waiting for your opponent';
        sub = 'Share the details below with your friend.';
      } else {
        const side = colorName(this.pos.side);
        main = this.thinking ? `${side === 'White' ? g.white : g.black} is thinking` : `${side} to move`;
        if (this.pos.inCheck()) sub = `${side} is in check.`;
        else if (this.dropSel) sub = 'Pick an empty square to drop on.';
        if (g.mode === 'online' && this.online && this.online.color === null) sub = 'You are watching.';
      }
      $('#playStatus').innerHTML = `${esc(main)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
    },

    // --- online ---

    async createRoom(color) {
      try {
        const id = await backend.create(color);
        location.hash = `#/online/${id}`;
      } catch (err) {
        toast(`Could not make a game: ${err.message}`);
      }
    },

    joinRoom(id) {
      if (this.online && this.online.id === id) return;
      this.leaveOnline();
      if (!backend) {
        toast('Online play is not available here');
        location.hash = '#/';
        return;
      }
      engine.reset();
      this.token++;
      this.thinking = false;
      this.online = { id, color: null, players: { w: false, b: false }, unsubscribe: null };
      this.game = { id: `room-${id}`, mode: 'online', startFen: START_FEN, moves: [], white: 'White', black: 'Black', result: null, date: Date.now() };
      this.pos = new Position(START_FEN);
      if (backend.kind === 'server') {
        $('#shareText').textContent = 'Send this link to your opponent:';
        $('#shareLink').value = `${location.origin}${location.pathname}#/online/${id}`;
      } else {
        $('#shareText').textContent = 'Your friend opens this page, chooses Play a friend online and joins this game from the list, or types its code:';
        $('#shareLink').value = id;
      }
      const o = this.online;
      o.unsubscribe = backend.subscribe(
        id,
        st => {
          if (this.online !== o) return;
          const you = st.you === 'w' ? WHITE : st.you === 'b' ? BLACK : null;
          if (you !== o.color || this.game.white === 'White') {
            o.color = you;
            this.flipped = you === BLACK;
            this.game.white = you === WHITE ? 'You' : you === null ? 'Player' : 'Opponent';
            this.game.black = you === BLACK ? 'You' : you === null ? 'Player' : 'Opponent';
          }
          this.syncRoom(st);
        },
        err => {
          toast(err.message);
          if (this.online === o) location.hash = '#/';
        },
      );
      this.render();
    },

    syncRoom(st) {
      const g = this.game;
      if (!this.online || g.mode !== 'online') return;
      this.online.players = st.players;
      const same = st.moves.length >= g.moves.length && g.moves.every((u, i) => st.moves[i] === u);
      if (same) {
        for (const u of st.moves.slice(g.moves.length)) {
          this.pos.makeMove(this.pos.moveFromUci(u));
          g.moves.push(u);
        }
      } else {
        g.moves = st.moves.slice();
        this.pos = buildPosition(g.startFen, g.moves);
      }
      $('#sharePanel').hidden = !!(st.players.w && st.players.b);
      if (st.result && !g.result) this.finish(st.result);
      this.render();
      if (this.showEval) this.updateEval();
    },

    async onlineMove(uci) {
      const o = this.online;
      // Show the move at once; the next room update confirms or corrects it.
      const before = this.game.moves.slice();
      this.applyMove(uci);
      try {
        await backend.move(o.id, uci);
      } catch (err) {
        if (this.online !== o) return;
        toast(err.message || 'Move refused');
        this.game.moves = before;
        this.game.result = null;
        this.pos = buildPosition(this.game.startFen, before);
        this.render();
      }
    },

    leaveOnline() {
      if (this.online && this.online.unsubscribe) this.online.unsubscribe();
      this.online = null;
    },
  };

  // --- result dialog ----------------------------------------------------------------------

  function showResult(g) {
    if (location.hash.indexOf('#/play') !== 0 && location.hash.indexOf('#/online') !== 0) return;
    const r = g.result;
    let title;
    let me = null;
    if (g.mode === 'pve') me = g.humanColor;
    if (g.mode === 'online' && play.online) me = play.online.color;
    if (!r.winner) title = 'Draw';
    else if (me === null) title = `${r.winner === 'w' ? 'White' : 'Black'} wins`;
    else title = colorKey(me) === r.winner ? 'You win' : 'You lose';
    $('#resultTitle').textContent = title;
    $('#resultText').textContent = `${resultText(r)} after ${Math.ceil(g.moves.length / 2)} move${g.moves.length > 2 ? 's' : ''}.`;
    const mark = r.winner ? (r.winner === 'w' ? pieceSvg('N', 'w') : pieceSvg('N', 'b')) : pieceSvg('K', 'w');
    $('#resultMark').innerHTML = mark;
    const dlg = $('#dlgResult');
    dlg.returnValue = '';
    dlg.showModal();
  }

  $('#dlgResult').addEventListener('close', () => {
    const v = $('#dlgResult').returnValue;
    if (v === 'review') play.reviewThis();
    if (v === 'again') play.again();
  });

  // --- review controller ------------------------------------------------------------------

  const review = {
    board: null,
    game: null,
    data: null, // classifyGame output
    analyses: null,
    cursor: 0,
    flipped: false,
    runId: 0,
    positions: [],

    init() {
      this.board = new BoardView($('#reviewBoard'));
      $$('[data-step]').forEach(b => (b.onclick = () => this.step(b.dataset.step)));
      $('#rFlip').onclick = () => {
        this.flipped = !this.flipped;
        this.render();
      };
      $('#btnReanalyse').onclick = () => this.analyse();
      $('#reviewDepth').value = String(store.get('sk.reviewTime', 700));
      $('#reviewDepth').onchange = () => store.set('sk.reviewTime', +$('#reviewDepth').value);
      $('#btnCopyMoves').onclick = () => {
        const text = this.game ? this.game.moves.join(' ') : '';
        navigator.clipboard?.writeText(text).then(() => toast('Moves copied'), () => toast(text));
      };
      $('#reviewMoves').addEventListener('click', e => {
        const b = e.target.closest('[data-ply]');
        if (b) this.go(+b.dataset.ply + 1);
      });
      $('#evalGraph').addEventListener('click', e => {
        if (!this.game) return;
        const r = e.currentTarget.getBoundingClientRect();
        const n = this.game.moves.length;
        this.go(Math.round(((e.clientX - r.left) / r.width) * n));
      });
      $('#btnImport').onclick = () => this.importMoves();
      $('#btnOther').onclick = () => {
        this.runId++;
        reviewEngine.reset();
        this.game = null;
        this.show();
      };
      document.addEventListener('keydown', e => {
        if (location.hash !== '#/review' || !this.game || e.target.matches('input, textarea, select')) return;
        const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end' }[e.key];
        if (k) {
          e.preventDefault();
          this.step(k);
        }
      });
    },

    importMoves() {
      const words = $('#importMoves').value.trim().split(/[\s,]+/).filter(Boolean)
        .filter(w => !/^\d+\.+$/.test(w)); // tolerate move numbers like "1."
      const err = $('#importError');
      try {
        if (!words.length) throw new Error('Paste some moves first.');
        const pos = buildPosition(START_FEN, words);
        const g = {
          id: `imp${Date.now().toString(36)}`,
          mode: 'import',
          startFen: START_FEN,
          moves: words,
          white: 'White',
          black: 'Black',
          result: statusToResult(pos.status()),
          date: Date.now(),
        };
        err.hidden = true;
        saveGame(g);
        this.load(g);
      } catch (e) {
        err.textContent = e.message.startsWith('illegal move') ? `That move list has an ${e.message} for this position.` : e.message;
        err.hidden = false;
      }
    },

    load(game) {
      this.game = game;
      this.data = null;
      this.analyses = null;
      this.cursor = game.moves.length;
      this.flipped = game.mode === 'pve' && game.humanColor === BLACK;
      this.positions = [];
      const pos = new Position(game.startFen);
      const codes = [];
      for (const u of game.moves) {
        const m = pos.moveFromUci(u);
        codes.push({ m, text: pos.moveToText(m) });
        pos.makeMove(m);
      }
      this.moveInfo = codes;
      this.show();
      this.analyse();
    },

    show() {
      $('#reviewEmpty').hidden = !!this.game;
      $('#reviewArena').hidden = !this.game;
      if (this.game) this.render();
    },

    async analyse() {
      const g = this.game;
      if (!g) return;
      const run = ++this.runId;
      reviewEngine.reset();
      const movetime = +$('#reviewDepth').value || 700;
      const n = g.moves.length;
      const analyses = [];
      $('#reviewProgress').hidden = false;
      $('#reviewSummary').hidden = true;
      this.data = null;
      this.render();
      const finalPos = buildPosition(g.startFen, g.moves);
      const finalStatus = finalPos.status();
      const total = finalStatus.state === 'ongoing' ? n + 1 : n;
      for (let i = 0; i < total; i++) {
        $('#progressText').textContent = `${i} of ${total} positions`;
        $('#progressFill').style.width = `${(i / total) * 100}%`;
        let a;
        try {
          a = await reviewEngine.call('analyse', { fen: g.startFen, moves: g.moves.slice(0, i), movetime, depth: 14 });
        } catch {
          return; // cancelled by a newer run
        }
        if (run !== this.runId) return;
        analyses.push(a);
      }
      this.analyses = analyses;
      this.data = R.classifyGame(g, analyses, finalStatus);
      $('#reviewProgress').hidden = true;
      this.renderSummary();
      this.render();
    },

    step(k) {
      if (!this.game) return;
      const n = this.game.moves.length;
      if (k === 'start') this.go(0);
      else if (k === 'end') this.go(n);
      else if (k === 'prev') this.go(this.cursor - 1);
      else if (k === 'next') this.go(this.cursor + 1);
    },

    go(i) {
      const n = this.game.moves.length;
      this.cursor = Math.max(0, Math.min(n, i));
      this.render();
    },

    render() {
      const g = this.game;
      if (!g) return;
      const k = this.cursor;
      const pos = buildPosition(g.startFen, g.moves.slice(0, k));
      const ply = this.data && k > 0 ? this.data.plies[k - 1] : null;
      const last = k > 0 ? this.moveInfo[k - 1].m : 0;
      const arrows = [];
      if (ply && ply.best && ply.best !== ply.uci && !['best', 'brilliant', 'great', 'forced'].includes(ply.cls)) {
        const before = buildPosition(g.startFen, g.moves.slice(0, k - 1));
        arrows.push({ move: before.moveFromUci(ply.best), color: '#5f9e3a' });
      }
      this.board.set({
        pos,
        flipped: this.flipped,
        lastMove: last,
        movable: null,
        badge: ply ? { sq: moveTo(last), cls: ply.cls } : null,
        arrows,
      });

      const bottom = this.flipped ? BLACK : WHITE;
      $('#rBarBottom').innerHTML = this.barHtml(pos, bottom);
      $('#rBarTop').innerHTML = this.barHtml(pos, bottom ^ 1);

      // Eval bar
      const evalEl = $('#reviewEval');
      if (this.data) {
        const wp = this.data.curve[k];
        const a = this.analyses[k];
        let white;
        if (a) white = pos.side === WHITE ? a.score : -a.score;
        else white = wp > 0.99 ? SK.MATE - 1 : wp < 0.01 ? -(SK.MATE - 1) : 0;
        if (k === g.moves.length && pos.status().state === 'draw') white = 0;
        setEvalBar(evalEl, white, this.flipped);
      } else {
        setEvalBar(evalEl, 0, this.flipped);
      }

      this.renderMoves();
      this.renderCoach(pos, ply);
      this.renderGraph();
    },

    barHtml(pos, color) {
      const g = this.game;
      const name = color === WHITE ? g.white : g.black;
      const acc = this.data ? this.data.players[color].accuracy : null;
      const res = DROP_ORDER.map(t => {
        const n = pos.hand[color][t];
        return `<span class="res ${n ? '' : 'empty'}">${pieceSvg(LETTERS[t], colorKey(color))}${n > 1 ? `<span class="count">${n}</span>` : ''}</span>`;
      }).join('');
      return `<div class="avatar">${pieceSvg('N', colorKey(color))}</div>
        <div><div class="pname">${esc(name)}</div><div class="psub">${colorName(color)}${acc !== null ? ` · accuracy ${acc.toFixed(1)}` : ''}</div></div>
        <div class="reserve">${res}</div>`;
    },

    renderMoves() {
      const g = this.game;
      const items = [];
      this.moveInfo.forEach((mi, i) => {
        const p = this.data ? this.data.plies[i] : null;
        if (i % 2 === 0) items.push(`<li><span class="no">${i / 2 + 1}.</span>`);
        const badge = p ? badgeHtml(p.cls) : '';
        items.push(`<button class="mv${i === this.cursor - 1 ? ' cur' : ''}" data-ply="${i}">${badge}<span>${esc(mi.text)}</span></button>`);
        if (i % 2 === 1) items.push('</li>');
      });
      if (g.moves.length % 2 === 1) items.push('</li>');
      const ol = $('#reviewMoves');
      ol.innerHTML = items.join('');
      const cur = ol.querySelector('.cur');
      if (cur) {
        const top = cur.offsetTop - ol.offsetTop;
        if (top < ol.scrollTop || top > ol.scrollTop + ol.clientHeight - 30) ol.scrollTop = top - ol.clientHeight / 2;
      }
    },

    renderCoach(pos, ply) {
      const el = $('#coach');
      const g = this.game;
      const k = this.cursor;
      if (!this.data) {
        el.innerHTML = '<div>Stockhorse is going through the game. You can step through the moves while it works.</div>';
        return;
      }
      if (!ply) {
        el.innerHTML = `<div><b>Start position.</b> ${esc(g.white)} has White, ${esc(g.black)} has Black. Use ← and → to step through the game.</div>`;
        return;
      }
      const c = R.CLASSES[ply.cls];
      const who = ply.mover === WHITE ? 'White' : 'Black';
      const scoreFor = s => R.scoreText(ply.mover === WHITE ? s : -s); // White's view
      const mv = `<b>${esc(this.moveInfo[k - 1].text)}</b>`;
      const phrase = {
        brilliant: 'is <b>brilliant</b>',
        great: 'is a <b>great</b> move',
        best: 'is the <b>best</b> move',
        excellent: 'is an <b>excellent</b> move',
        good: 'is a <b>good</b> move',
        inaccuracy: 'is an <b>inaccuracy</b>',
        mistake: 'is a <b>mistake</b>',
        miss: 'is a <b>miss</b>',
        blunder: 'is a <b>blunder</b>',
        forced: 'was <b>forced</b>',
      }[ply.cls];
      const text = `${mv} ${phrase}: ${c.blurb}.`;
      let detail = `Evaluation ${scoreFor(ply.playedScore)}`;
      if (ply.best && ply.best !== ply.uci && !['best', 'forced'].includes(ply.cls)) {
        detail += ` · best was <b>${esc(ply.bestText)}</b> (${scoreFor(ply.bestScore)})`;
      }
      const line = ply.bestPv && ply.bestPv.length > 1 && ply.best !== ply.uci && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(ply.cls)
        ? `<div class="line">Best line: ${esc(this.pvText(k - 1, ply.bestPv))}</div>` : '';
      el.innerHTML = `${badgeHtml(ply.cls)}<div><div>${text}</div><div class="muted" style="font-size:13px">${who} · ${detail}</div>${line}</div>`;
    },

    pvText(plyIndex, pv) {
      const pos = buildPosition(this.game.startFen, this.game.moves.slice(0, plyIndex));
      const out = [];
      for (const u of pv.slice(0, 6)) {
        const m = pos.moveFromUci(u);
        if (!m) break;
        out.push(pos.moveToText(m));
        pos.makeMove(m);
      }
      return out.join(' ');
    },

    renderGraph() {
      const svg = $('#evalGraph');
      if (!this.data) {
        svg.innerHTML = '<line x1="0" y1="40" x2="300" y2="40" stroke="#5a616c" stroke-width="1"/>';
        return;
      }
      const curve = this.data.curve;
      const n = Math.max(1, curve.length - 1);
      const x = i => (i / n) * 300;
      const y = wp => 80 - wp * 80;
      let d = `M0 80 L${curve.map((wp, i) => `${x(i).toFixed(1)} ${y(wp).toFixed(1)}`).join(' L')} L300 80 Z`;
      const dots = this.data.plies
        .filter(p => ['brilliant', 'great', 'blunder', 'mistake', 'miss'].includes(p.cls))
        .map(p => `<circle cx="${x(p.ply + 1).toFixed(1)}" cy="${y(curve[p.ply + 1]).toFixed(1)}" r="2.6" fill="var(--c-${p.cls})" stroke="#2a2f37" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`)
        .join('');
      const cx = x(this.cursor).toFixed(1);
      svg.innerHTML = `<path d="${d}" fill="#f3efe5"/>
        <line x1="0" y1="40" x2="300" y2="40" stroke="#8a8f96" stroke-width="0.6" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
        <line x1="${cx}" y1="0" x2="${cx}" y2="80" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>${dots}`;
    },

    renderSummary() {
      const d = this.data;
      const el = $('#reviewSummary');
      const [w, b] = d.players;
      const acc = p => (p.accuracy === null ? '–' : p.accuracy.toFixed(1));
      const rows = R.ORDER.map(k => {
        const c = R.CLASSES[k];
        return `<span class="rowlabel">${badgeHtml(k)}${c.label}</span>
          <span class="n ${w.counts[k] ? '' : 'zero'}">${w.counts[k]}</span><span class="n ${b.counts[k] ? '' : 'zero'}">${b.counts[k]}</span>`;
      }).join('');
      el.innerHTML = `<span></span><span class="head">${esc(this.game.white)}</span><span class="head">${esc(this.game.black)}</span>
        <span class="rowlabel"><b>Accuracy</b></span><span class="acc w">${acc(w)}</span><span class="acc b">${acc(b)}</span>${rows}`;
      el.hidden = false;
    },
  };

  // --- dialogs ----------------------------------------------------------------------------

  function openPveDialog() {
    const dlg = $('#dlgPve');
    const last = store.get('sk.level', 'squire');
    $('#opponents').innerHTML = OPPONENTS.map(
      o => `<label class="opp"><input type="radio" name="level" value="${o.id}"${o.id === last ? ' checked' : ''}>
        <span>${pieceSvg(o.piece, 'b')}<span><b>${o.name}</b><small>${o.blurb}</small></span></span></label>`,
    ).join('');
    dlg.returnValue = '';
    dlg.showModal();
  }

  $('#dlgPve').addEventListener('close', () => {
    const dlg = $('#dlgPve');
    if (dlg.returnValue !== 'ok') return;
    const level = dlg.querySelector('input[name=level]:checked').value;
    const color = dlg.querySelector('input[name=color]:checked').value;
    store.set('sk.level', level);
    location.hash = '#/play';
    play.start({ mode: 'pve', level, color });
  });

  let openGamesUnsub = null;
  function openOnlineDialog() {
    const dlg = $('#dlgOnline');
    dlg.returnValue = '';
    $('#joinCode').value = '';
    $('#openGamesWrap').hidden = !(backend && backend.listOpen);
    if (backend && backend.listOpen && !openGamesUnsub) {
      openGamesUnsub = backend.listOpen(rows => {
        $('#openGames').innerHTML = rows.length
          ? rows.map(r => `<li><button type="button" class="btn" data-join="${esc(r.id)}">${r.mine ? 'Back to your game' : `Play as ${r.open === 'w' ? 'White' : 'Black'}`}
              <span class="muted">· ${esc(r.id)} · ${r.moves} move${r.moves === 1 ? '' : 's'}</span></button></li>`).join('')
          : '<li class="muted">No open games yet. Make one and your friend will see it here.</li>';
      });
    }
    dlg.showModal();
  }

  $('#dlgOnline').addEventListener('click', e => {
    const b = e.target.closest('[data-join]');
    if (b) {
      $('#dlgOnline').close('join');
      location.hash = `#/online/${b.dataset.join}`;
    }
  });

  $('#dlgOnline').addEventListener('close', () => {
    const dlg = $('#dlgOnline');
    if (openGamesUnsub) openGamesUnsub();
    openGamesUnsub = null;
    if (dlg.returnValue === 'code') {
      const code = $('#joinCode').value.trim().toLowerCase();
      if (/^[a-z0-9]{4,12}$/.test(code)) location.hash = `#/online/${code}`;
      else if (code) toast('That code does not look right');
      return;
    }
    if (dlg.returnValue !== 'ok') return;
    play.createRoom(dlg.querySelector('input[name=ocolor]:checked').value);
  });

  // --- routing ----------------------------------------------------------------------------

  function showView(name) {
    for (const v of ['home', 'play', 'review', 'rules']) $(`#view-${v}`).hidden = v !== name;
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name || (name === 'play' && a.dataset.nav === 'home')));
  }

  function route() {
    const h = location.hash || '#/';
    const online = /^#\/online\/([a-z0-9]+)$/.exec(h);
    if (online) {
      showView('play');
      play.joinRoom(online[1]);
      return;
    }
    if (h !== '#/play' && play.online) play.leaveOnline();
    if (h === '#/play') {
      if (!play.game) play.start({ mode: 'local' });
      showView('play');
    } else if (h === '#/review') {
      showView('review');
      review.show();
    } else if (h === '#/rules') {
      showView('rules');
    } else {
      showView('home');
      renderRecent();
    }
    window.scrollTo(0, 0);
  }

  // --- decoration -------------------------------------------------------------------------

  // The hero: a knight on c3 of a 6×6 board, its jumps marked and one L traced.
  function heroArt() {
    const cells = [];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const light = (r + c) % 2 === 0;
        cells.push(`<rect x="${c * 10}" y="${r * 10}" width="10" height="10" fill="var(--${light ? 'sq-light' : 'sq-dark'})"/>`);
      }
    }
    const kx = 2, ky = 3; // c3 (row 3 from the top)
    const jumps = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
      .map(([dx, dy]) => [kx + dx, ky + dy])
      .filter(([x, y]) => x >= 0 && x < 6 && y >= 0 && y < 6);
    const dots = jumps.map(([x, y]) => `<circle cx="${x * 10 + 5}" cy="${y * 10 + 5}" r="1.9" fill="var(--accent)" opacity="0.9"/>`).join('');
    const path = `<path d="M${kx * 10 + 5} ${ky * 10 + 5} V${(ky - 2) * 10 + 5} H${(kx + 1) * 10 + 5}" fill="none" stroke="var(--accent)" stroke-width="1.1" stroke-dasharray="2 1.6" stroke-linecap="round"/>`;
    const knight = `<g transform="translate(${kx * 10 - 1} ${ky * 10 - 1.5}) scale(0.12)">${window.Pieces.shapes.N.replace(/class="b"/g, 'class="b" fill="#f8f4ea" stroke="#1d2127" stroke-width="3"').replace(/class="d"/g, 'class="d" fill="#1d2127" stroke="#1d2127"')}</g>`;
    return `<svg viewBox="-1 -1 62 62"><rect x="-1" y="-1" width="62" height="62" rx="3" fill="var(--surface)" stroke="var(--line)" stroke-width="0.5"/>
      <g>${cells.join('')}</g>${path}${dots}${knight}</svg>`;
  }

  const BOARDS = ['steel', 'oak', 'heraldry', 'midnight'];
  function applyBoard(name) {
    if (name === 'steel') delete document.documentElement.dataset.board;
    else document.documentElement.dataset.board = name;
  }

  // --- boot -------------------------------------------------------------------------------

  function boot() {
    applyBoard(store.get('sk.board', 'steel'));
    $('#themeBtn').onclick = () => {
      const cur = store.get('sk.board', 'steel');
      const next = BOARDS[(BOARDS.indexOf(cur) + 1) % BOARDS.length];
      store.set('sk.board', next);
      applyBoard(next);
      toast(`Board: ${next[0].toUpperCase()}${next.slice(1)}`);
    };
    $('#brandMark').innerHTML = pieceSvg('N', 'w');
    $('#heroArt').innerHTML = heroArt();
    $$('.mode-icon').forEach(el => (el.innerHTML = pieceSvg(el.dataset.piece, 'w')));

    play.init();
    review.init();

    $$('.mode-card').forEach(card => {
      card.onclick = () => {
        const m = card.dataset.mode;
        if (m === 'pve') openPveDialog();
        else if (m === 'local') {
          location.hash = '#/play';
          play.start({ mode: 'local' });
        } else if (m === 'online') openOnlineDialog();
        else if (m === 'review') location.hash = '#/review';
      };
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-game]');
      if (b) openSaved(b.dataset.game);
    });

    // Online play needs web/server.js, or the shared database of a claude.ai Artifact.
    window.addEventListener('hashchange', route);
    renderRecent();
    const pendingOnline = /^#\/online\//.test(location.hash);
    if (!pendingOnline) route();
    window.Online.detect(store).then(b => {
      backend = b;
      if (!b) {
        $('#onlineCard').disabled = true;
        $('#onlineSub').textContent = window.claude
          ? 'Sign in to claude.ai, and ask the owner for access that lets you interact with this page.'
          : 'Needs the Maki server: run node web/server.js and open the page it prints.';
      } else if (b.kind === 'db') {
        $('#onlineSub').textContent = 'Make a game, and your friend joins it from this same page.';
      }
      if (pendingOnline) route();
    });
  }

  boot();
})();
