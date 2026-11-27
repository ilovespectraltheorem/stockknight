'use strict';
// The Maki site (the game was called KnightChess; its engine, Stockhorse, was StockKnight): the board, play against the engine, pass-and-play, online games and
// game review. Rules come from the reference engine (reference/engine.js), so the site plays
// exactly the game the engines play.

(function () {
  const SK = window.StockKnight;
  const { Position, START_FEN, WHITE, BLACK, moveFrom, moveTo, moveDrop } = SK;
  const { pieceSvg } = window.Pieces;
  const R = window.Review;
  const MoveTree = window.MoveTree;
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
    if (!result.winner) {
      return {
        'bare kings': 'Draw: bare kings',
        threefold: 'Draw by repetition',
        agreement: 'Draw by agreement',
        aborted: 'Game aborted',
        'timeout vs insufficient material': 'Draw: out of time, but the opponent had only a king left',
        'abandonment vs insufficient material': 'Draw: a player left, but the other had only a king left',
      }[result.reason] || 'Draw';
    }
    const who = result.winner === 'w' ? 'White' : 'Black';
    const how = {
      checkmate: 'by checkmate',
      stalemate: 'by stalemate (no legal move loses)',
      resignation: 'by resignation',
      timeout: 'on time',
      abandonment: 'as the opponent left the game',
    }[result.reason] || '';
    return `${who} wins ${how}`.trim();
  }

  function statusToResult(st) {
    if (st.state === 'win') return { winner: colorKey(st.winner), reason: st.reason };
    if (st.state === 'draw') return { winner: null, reason: st.reason };
    return null;
  }

  // Online time controls: { base, inc } in seconds, or null for untimed.
  function parseTc(v) {
    const m = /^(\d+)\+(\d+)$/.exec(v || '');
    return m ? { base: +m[1], inc: +m[2] } : null;
  }

  function tcLabel(tc) {
    if (!tc) return 'Untimed';
    const base = tc.base % 60 ? `${tc.base} s` : `${tc.base / 60} min`;
    return tc.inc ? `${tc.base % 60 ? tc.base + ' s' : tc.base / 60} | ${tc.inc}` : base;
  }

  function fmtClock(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 10000) return `0:0${(Math.floor(ms / 100) / 10).toFixed(1)}`;
    const s = Math.ceil(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  function chosenTc() {
    if (!backend || !backend.features.clocks) return null;
    const el = document.querySelector('#tcSeg input[name=tc]:checked');
    return parseTc(el ? el.value : '');
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
      // An idle worker has nothing to cancel; keeping it saves reloading the network.
      if (this.worker && this.pending.size) {
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
      // A drop that was just played lands with a bounce and a ripple. The board redraws often
      // (selections, engine lines), so a redraw mid-landing picks the animation up where it was.
      const key = this.lastMove && moveDrop(this.lastMove) ? `${this.lastMove}:${pos.undo.length}:${pos.hashLo}` : '';
      if (key !== this.droppedKey) {
        this.droppedKey = key;
        this.droppedAt = performance.now();
      }
      const since = performance.now() - this.droppedAt;
      if (key && since < 900) {
        const el = this.el.querySelector(`[data-sq="${moveTo(this.lastMove)}"]`);
        if (el) {
          el.classList.add('dropped');
          el.style.setProperty('--drop-t', `${-Math.round(since)}ms`);
        }
      }
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
          <span class="muted"> · ${esc(resultText(g.result) || 'unfinished')} · ${movesPlayed(g.startFen, g.moves.length)} moves</span></span>
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

  // Strength bands for the Elo picker: a piece to show and a line about how it plays.
  const STRENGTH = window.EngineTasks.STRENGTH;
  const BANDS = [
    { below: 800, piece: 'P', name: 'Beginner', blurb: 'Knows how the pieces move. Often leaves them hanging.' },
    { below: 1200, piece: 'B', name: 'Casual', blurb: 'Takes what you leave loose, and leaves things loose too.' },
    { below: 1600, piece: 'N', name: 'Club', blurb: 'Sees simple threats. Still misses plenty a few moves out.' },
    { below: 2000, piece: 'R', name: 'Strong club', blurb: 'Rarely blunders outright. Punishes loose pieces.' },
    { below: 2400, piece: 'Q', name: 'Expert', blurb: 'Calculates several moves deep and keeps up the pressure.' },
    { below: 2950, piece: 'Q', name: 'Master', blurb: 'Few mistakes, and small ones.' },
    { below: Infinity, piece: 'K', name: 'Full strength', blurb: 'Stockhorse at full strength, about two seconds a move.' },
  ];
  const bandFor = elo => BANDS.find(b => elo < b.below);
  const COACH_ELO = 400; // Stockhorse's strength in Learn by playing
  const Coach = window.Coach;

  // The Resign button's words change online (Abort, Cancel) and while it asks to confirm.
  function setResignLabel(text) {
    const el = $('#btnResign .tool-label');
    if (el.textContent !== text) el.textContent = text;
    $('#btnResign').title = text === 'Sure?' ? 'Click again to resign' : text === 'Cancel' ? 'Cancel this game' : text;
  }

  // --- play controller --------------------------------------------------------------------

  const play = {
    board: null,
    game: null, // { id, mode, startFen, moves, white, black, result, elo, humanColor } (older games: level)
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
        if (this.coach && sel) this.coach.offer(Coach.onSelect(this.pos, sel));
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
      $('#btnNew').onclick = $('#btnNewMenu').onclick = () => this.again();
      $('#btnReviewThis').onclick = $('#btnReviewMenu').onclick = () => this.reviewThis();
      $('#btnSharePlay').onclick = () => this.share();
      $('#btnHint').onclick = () => this.hint();
      // The More menu closes after a pick, or on a click anywhere else.
      $('#playMore').addEventListener('click', e => {
        if (e.target.closest('.tool-menu button')) $('#playMore').open = false;
      });
      document.addEventListener('click', e => {
        if ($('#playMore').open && !e.target.closest('#playMore')) $('#playMore').open = false;
      });
      $('#btnAnalysePlay').onclick = () => {
        const g = this.game;
        if (!g) return;
        analysis.load(g.startFen, g.moves.slice());
        location.hash = '#/analysis';
      };
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
        const engineName = `Stockhorse ${opts.elo}`;
        white = humanColor === WHITE ? 'You' : engineName;
        black = humanColor === BLACK ? 'You' : engineName;
      }
      const startFen = opts.fen || START_FEN;
      this.game = { id, mode: opts.mode, startFen, moves: [], white, black, result: null, elo: opts.elo, humanColor, date: Date.now() };
      if (opts.coach) this.game.coach = true;
      this.pos = new Position(startFen);
      this.hintArrows = [];
      $('#coachBox').hidden = !opts.coach;
      if (opts.coach) {
        if (!this.coach) this.coach = new Coach.CoachPanel({ $, pieceSvg });
        this.coach.reset();
      }
      this.flipped = opts.mode === 'pve' ? humanColor === BLACK : this.pos.side === BLACK;
      $('#sharePanel').hidden = true;
      this.render();
      this.maybeEngine();
    },

    // Learn by playing: White against a gentle Stockhorse, with the coach beside the board.
    startCoached() {
      this.start({ mode: 'pve', elo: window.EngineTasks.clampElo(COACH_ELO), color: 'w', coach: true });
    },

    // A hint for the learner: Stockhorse's best move as an arrow.
    async hint() {
      const g = this.game;
      if (!g || g.result || this.thinking || !this.isHuman(this.pos.side)) return;
      const n = g.moves.length;
      $('#btnHint').disabled = true;
      try {
        const a = await engine.call('analyse', { fen: g.startFen, moves: g.moves.slice(), movetime: 400, depth: 8 });
        if (this.game !== g || g.moves.length !== n || !a.best) return;
        const m = this.pos.moveFromUci(a.best);
        if (!m) return;
        this.hintArrows = [{ move: m, color: 'rgb(46 140 90)' }];
        this.render();
      } catch {
        /* superseded */
      } finally {
        $('#btnHint').disabled = false;
      }
    },

    again() {
      if (this.game && this.game.coach) return this.startCoached();
      if (!this.game || this.game.mode === 'pve') return openPveDialog(this.game && this.game.startFen !== START_FEN ? this.game.startFen : null);
      if (this.game.mode === 'online') return openOnlineDialog(this.game.startFen);
      this.start({ mode: 'local' });
    },

    // "Play again" after a result: a rematch online, otherwise a new game.
    playAgain() {
      const o = this.online;
      if (this.game && this.game.mode === 'online' && o && o.color !== null && o.st && o.st.players.w && o.st.players.b && o.st.result && o.st.result.reason !== 'aborted') {
        return this.onlineAction('rematch');
      }
      this.again();
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
      this.hintArrows = [];
      if (this.coach && this.game.coach) this.coach.offer(Coach.afterMove(this.pos, this.game.humanColor, this.game.moves));
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
        const r = await engine.call('play', { fen: g.startFen, moves: g.moves.slice(), elo: g.elo, level: g.level });
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

    // Whether Undo has something to take back. Against Stockhorse that needs a move of yours:
    // from a position where it moved first, taking back only its move would just replay it.
    canUndo() {
      const g = this.game;
      if (!g || g.mode === 'online' || !g.moves.length) return false;
      if (g.mode !== 'pve') return true;
      const first = new Position(g.startFen).side;
      return g.moves.length > (first === g.humanColor ? 0 : 1);
    },

    undo() {
      const g = this.game;
      if (!this.canUndo()) return;
      engine.reset();
      this.token++;
      this.thinking = false;
      let n = 1;
      if (g.mode === 'pve') {
        // Back to the human's turn: one ply if the engine has not replied yet, otherwise two.
        n = this.pos.side === g.humanColor ? 2 : 1;
      }
      g.moves.splice(g.moves.length - n, n);
      g.result = null;
      this.hintArrows = [];
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
        if (this.resignLabel() === 'Resign' && !this.confirmResign()) return;
        this.onlineAction('resign');
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
      if (this.resignArmed) {
        clearTimeout(this.resignArmed);
        this.resignArmed = 0;
        setResignLabel(this.resignLabel());
        return true;
      }
      setResignLabel('Sure?');
      this.resignArmed = setTimeout(() => {
        this.resignArmed = 0;
        setResignLabel(this.resignLabel());
      }, 3000);
      return false;
    },

    finish(result) {
      const g = this.game;
      g.result = result;
      this.hintArrows = [];
      if (g.coach && this.coach) this.coach.show(Coach.endTip(result, g.humanColor));
      if (g.moves.length && result.reason !== 'aborted') saveGame({ ...g, moves: g.moves.slice() });
      setTimeout(() => showResult(g), 350);
    },

    share() {
      const g = this.game;
      if (!g) return;
      const d = { kind: 'review', fen: g.startFen, moves: g.moves.slice(), white: g.white, black: g.black, result: g.result, date: g.date };
      if (g.mode === 'online' && this.online) {
        // A live game shares its room, so the link follows the game as it goes on.
        d.kind = 'online';
        d.url = `${Share.baseUrl(location.href)}#/online/${this.online.id}`;
        d.summary = `${g.white} vs ${g.black} · ${g.result ? resultText(g.result) : 'live'}${g.moves.length ? ` · ${movesPlayed(g.startFen, g.moves.length)} moves` : ''}`;
      } else if (!g.moves.length) {
        d.kind = 'analysis';
        d.title = 'Share this position';
      }
      openShare(d);
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
      this.board.set({ pos: this.pos, flipped: this.flipped, lastMove, movable: this.movableColor(), badge: null, arrows: this.hintArrows || [] });
      this.renderBars();
      this.renderMoves();
      this.renderStatus();
      $('#playEval').hidden = !this.showEval;
      $('#btnEval').classList.toggle('on', this.showEval);
      $('#btnEval').setAttribute('aria-pressed', String(this.showEval));
      $('#btnUndo').disabled = !this.canUndo();
      $('#btnResign').disabled = !!g.result || (g.mode === 'online' && !(this.online && this.online.color !== null));
      // After the game, its next steps come first; during it, they wait in the More menu.
      $('#playOver').hidden = !g.result || g.mode === 'online';
      $('#btnReviewMenu').disabled = !g.moves.length;
      $('#btnHint').hidden = !!g.result;
      $('#btnHint').disabled = this.thinking || !this.isHuman(this.pos.side);
      // No engine help in a live game against a person.
      $('#btnAnalysePlay').disabled = g.mode === 'online' && !g.result && !!(this.online && this.online.color !== null);
      this.renderOnline();
      if (g.mode === 'online') this.tickOnline();
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
      let clock = '';
      if (g.mode === 'online' && this.online && this.online.st) {
        const st = this.online.st;
        const k = colorKey(color);
        sub = colorName(color);
        if (st.players[k] && st.online) sub = `<span class="presence${st.online[k] ? '' : ' off'}" title="${st.online[k] ? 'Connected' : 'Not connected'}"></span>${sub}${st.online[k] ? '' : ' · away'}`;
        if (!st.players[k]) sub += ' · waiting to join';
        if (st.clock) {
          const run = st.clock.running === k && !g.result;
          clock = `<div class="clock${run ? ' run' : ''}" data-clock="${k}">${fmtClock(this.clockLeft(k))}</div>`;
        }
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
      const eloMatch = /^Stockhorse (\d+)$/.exec(name);
      const avatarPiece = eloMatch ? bandFor(+eloMatch[1]).piece : 'N';
      return `<div class="avatar">${pieceSvg(avatarPiece, colorKey(color))}</div>
        <div><div class="pname">${esc(name)}${thinking}</div><div class="psub">${sub}</div></div>
        <div class="reserve">${res}</div>${clock}`;
    },

    renderMoves() {
      const g = this.game;
      const pos = new Position(g.startFen);
      const off = pos.side === BLACK ? 1 : 0, no0 = pos.moveNo;
      const items = off && g.moves.length ? [`<li><span class="no">${no0}.</span><span class="mv muted">…</span>`] : [];
      g.moves.forEach((u, i) => {
        const m = pos.moveFromUci(u);
        const text = pos.moveToText(m);
        pos.makeMove(m);
        const j = i + off;
        if (j % 2 === 0) items.push(`<li><span class="no">${no0 + j / 2}.</span>`);
        items.push(`<span class="mv${i === g.moves.length - 1 ? ' cur' : ''}">${esc(text)}</span>`);
        if (j % 2 === 1) items.push('</li>');
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
      } else if (g.mode === 'online' && this.online && !this.online.st) {
        main = 'Connecting to the game…';
      } else if (g.mode === 'online' && this.online && (!this.online.players.w || !this.online.players.b)) {
        const st = this.online.st;
        main = st && st.public ? 'Looking for an opponent…' : 'Waiting for your opponent';
        sub = st && st.public
          ? `The next player to pick Quick pairing at ${tcLabel(st.tc)} joins you. A friend can also use the link below.`
          : `${tcLabel(st && st.tc)}. Share the details below with your friend.`;
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

    async createRoom(color, fen = null) {
      try {
        const id = await backend.create({ color, tc: chosenTc(), name: store.get('sk.name', ''), fen });
        this.madeFrom = { id, fen }; // shown at once, before the room's first update arrives
        location.hash = `#/online/${id}`;
      } catch (err) {
        toast(`Could not make a game: ${err.message}`);
      }
    },

    async quickPair() {
      try {
        const id = await backend.quick({ tc: chosenTc(), name: store.get('sk.name', '') });
        location.hash = `#/online/${id}`;
      } catch (err) {
        toast(`Could not find a game: ${err.message}`);
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
      this.dropSel = null;
      this.online = { id, color: null, players: { w: false, b: false }, st: null, recvAt: 0, conn: true, sawNext: null, unsubscribe: null };
      const known = this.madeFrom && this.madeFrom.id === id && this.madeFrom.fen ? this.madeFrom.fen : START_FEN;
      this.game = { id: `room-${id}`, mode: 'online', startFen: known, moves: [], white: 'White', black: 'Black', result: null, date: Date.now() };
      this.pos = new Position(known);
      if (backend.kind === 'server') {
        $('#shareText').textContent = 'Send this link to your opponent:';
        $('#shareLink').value = `${location.origin}${location.pathname}#/online/${id}`;
      } else {
        $('#shareText').textContent = 'Your friend opens this page, chooses Play online and joins this game from the list, or types its code:';
        $('#shareLink').value = id;
      }
      const o = this.online;
      o.unsubscribe = backend.subscribe(
        id,
        st => {
          if (this.online !== o) return;
          const you = st.you === 'w' ? WHITE : st.you === 'b' ? BLACK : null;
          if (you !== o.color || !o.st) {
            o.color = you;
            this.flipped = you === BLACK;
          }
          this.syncRoom(st);
        },
        err => {
          toast(err.message);
          if (this.online === o) location.hash = '#/';
        },
        up => {
          if (this.online !== o || o.conn === up) return;
          o.conn = up;
          this.renderOnline();
        },
      );
      clearInterval(this.clockTimer);
      this.clockTimer = setInterval(() => this.tickOnline(), 100);
      this.render();
    },

    // The name shown for a seat: the player's chosen name, or a stand-in.
    seatName(k, st) {
      const mine = this.online && this.online.color !== null && colorKey(this.online.color) === k;
      const n = st.names && st.names[k];
      if (n) return mine ? `${n} (you)` : n;
      if (mine) return 'You';
      return st.players[k] ? (this.online.color === null ? colorName(k === 'w' ? WHITE : BLACK) : 'Opponent') : 'Waiting…';
    },

    syncRoom(st) {
      const g = this.game;
      const o = this.online;
      if (!o || g.mode !== 'online') return;
      if (o.sawNext === null) o.sawNext = !!st.next; // a game opened after its rematch began does not jump ahead
      o.st = st;
      o.recvAt = Date.now();
      o.players = st.players;
      o.conn = true;
      g.white = this.seatName('w', st);
      g.black = this.seatName('b', st);
      g.tc = st.tc || null;
      const startFen = st.startFen || START_FEN;
      if (startFen !== g.startFen) {
        // A game from a set-up position: start over from it.
        g.startFen = startFen;
        g.moves = [];
        this.pos = new Position(startFen);
      }
      const same = st.moves.length >= g.moves.length && g.moves.every((u, i) => st.moves[i] === u);
      const before = g.moves.length;
      if (same) {
        for (const u of st.moves.slice(g.moves.length)) {
          this.pos.makeMove(this.pos.moveFromUci(u));
          g.moves.push(u);
        }
      } else {
        g.moves = st.moves.slice();
        this.pos = buildPosition(g.startFen, g.moves);
        this.dropSel = null;
      }
      if (g.moves.length !== before) this.dropSel = null;
      $('#sharePanel').hidden = !!(st.players.w && st.players.b) || !!st.result;
      if (st.result && !g.result) this.finish(st.result);
      this.render();
      if (this.showEval) this.updateEval();
      if (st.next && !o.sawNext && o.color !== null) {
        o.sawNext = true;
        toast('Rematch! Colours swap.');
        $('#dlgResult').open && $('#dlgResult').close();
        location.hash = `#/online/${st.next}`;
      }
    },

    // Time left on a side's clock right now, in ms, counting down from the last update.
    clockLeft(k) {
      const st = this.online && this.online.st;
      if (!st || !st.clock) return null;
      let ms = st.clock[k];
      if (st.clock.running === k && !this.game.result) ms -= Date.now() - this.online.recvAt;
      return Math.max(0, ms);
    },

    tickOnline() {
      const o = this.online;
      if (!o || !o.st) return;
      for (const el of $$('.clock[data-clock]')) {
        const k = el.dataset.clock;
        const ms = this.clockLeft(k);
        el.textContent = fmtClock(ms);
        el.classList.toggle('low', ms < 20000 && !!o.st.clock);
      }
      // Countdowns in words change once a second.
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== this.lastSec) {
        this.lastSec = sec;
        this.renderOnline();
      }
    },

    async onlineMove(uci) {
      const o = this.online;
      // Show the move at once; the next room update confirms or corrects it.
      const before = this.game.moves.slice();
      const ply = before.length;
      this.applyMove(uci);
      try {
        await backend.move(o.id, uci, ply);
      } catch (err) {
        if (this.online !== o) return;
        toast(err.message || 'Move refused');
        this.game.moves = before;
        this.game.result = null;
        this.pos = buildPosition(this.game.startFen, before);
        if (o.st) this.syncRoom(o.st);
        else this.render();
      }
    },

    async onlineAction(name, ...args) {
      const o = this.online;
      if (!o) return;
      try {
        await backend[name](o.id, ...args);
      } catch (err) {
        if (this.online === o) toast(err.message);
      }
    },

    // The online panel: what is going on beyond the board, and the buttons for it.
    renderOnline() {
      const o = this.online;
      const box = $('#onlineBox');
      if (!o || !this.game || this.game.mode !== 'online' || !o.st) {
        box.hidden = true;
        return;
      }
      const st = o.st;
      const me = o.color === null ? null : colorKey(o.color);
      const opp = me && (me === 'w' ? 'b' : 'w');
      const seatedBoth = st.players.w && st.players.b;
      const info = [];
      let warn = false;
      const buttons = [];
      if (!o.conn) {
        info.push('Connection lost. Reconnecting…');
        warn = true;
      }
      if (!st.result && seatedBoth) {
        if (st.firstMove) {
          const who = me === st.firstMove.side ? 'You have' : `${st.firstMove.side === 'w' ? 'White' : 'Black'} has`;
          const left = Math.max(0, Math.ceil((st.firstMove.left - (Date.now() - o.recvAt)) / 1000));
          info.push(`${who} ${left} s to make the first move, or the game is aborted.`);
        }
        if (opp && st.gone && st.gone[opp] !== null) {
          const left = Math.max(0, Math.ceil((st.gone[opp] - (Date.now() - o.recvAt)) / 1000));
          if (left > 0) info.push(`Your opponent left the game. You can claim the win in ${left} s if they do not come back.`);
          else {
            info.push('Your opponent left the game.');
            buttons.push('<button class="btn primary" data-oa="claim">Claim the win</button>');
          }
          warn = true;
        }
        if (me && st.drawOffer === opp) {
          info.push('Your opponent offers a draw.');
          buttons.push('<button class="btn primary" data-oa="accept">Accept draw</button>', '<button class="btn" data-oa="decline">Decline</button>');
        } else if (me && st.drawOffer === me) {
          info.push('You offered a draw.');
        } else if (me && this.game.moves.length >= 2) {
          buttons.push('<button class="btn" data-oa="offer">½ Offer draw</button>');
        }
      }
      if (st.result && me && seatedBoth && !st.next) {
        if (st.rematch && st.rematch[opp]) {
          info.push('Your opponent wants a rematch.');
          buttons.push('<button class="btn primary" data-oa="rematch">Accept rematch</button>');
        } else if (st.rematch && st.rematch[me]) {
          info.push('Rematch offered. Waiting for your opponent…');
        } else {
          buttons.push('<button class="btn primary" data-oa="rematch">Rematch</button>');
        }
      }
      if (st.result && st.next && (me === null || o.sawNext)) {
        buttons.push(`<button class="btn" data-oa="next">${me ? 'Go to the rematch' : 'Watch the rematch'}</button>`);
      }
      if (st.watchers) info.push(`${st.watchers} watching.`);
      const infoEl = $('#onlineInfo');
      infoEl.hidden = !info.length;
      infoEl.classList.toggle('warn', warn);
      infoEl.textContent = info.join(' ');
      const html = buttons.join('');
      if ($('#onlineActions').innerHTML !== html) $('#onlineActions').innerHTML = html;
      $('#onlineActions').hidden = !buttons.length;
      box.hidden = !info.length && !buttons.length;
      if (!st.result) {
        const label = this.resignLabel();
        if (!this.resignArmed) setResignLabel(label);
      }
    },

    resignLabel() {
      const g = this.game;
      if (g && g.mode === 'online' && this.online && this.online.st && !g.result) {
        const st = this.online.st;
        if (!(st.players.w && st.players.b)) return 'Cancel';
        if (g.moves.length < 2) return 'Abort';
      }
      return 'Resign';
    },

    leaveOnline() {
      if (this.online && this.online.unsubscribe) this.online.unsubscribe();
      this.online = null;
      clearInterval(this.clockTimer);
      $('#onlineBox').hidden = true;
      setResignLabel('Resign');
    },
  };

  // --- result dialog ----------------------------------------------------------------------

  // Moves played, counted as the move list numbers them: from Black to move, "1… a 2. b" is two.
  function movesPlayed(startFen, plies) {
    const off = new Position(startFen || START_FEN).side === BLACK ? 1 : 0;
    return Math.ceil((plies + off) / 2);
  }

  function showResult(g) {
    if (!/^#\/(play|online|learn)$|^#\/online\//.test(location.hash)) return;
    const r = g.result;
    let title;
    let me = null;
    if (g.mode === 'pve') me = g.humanColor;
    if (g.mode === 'online' && play.online) me = play.online.color;
    if (r.reason === 'aborted') title = 'Game aborted';
    else if (!r.winner) title = 'Draw';
    else if (me === null) title = `${r.winner === 'w' ? 'White' : 'Black'} wins`;
    else title = colorKey(me) === r.winner ? 'You win' : 'You lose';
    $('#resultTitle').textContent = title;
    const n = movesPlayed(g.startFen, g.moves.length);
    $('#resultText').textContent = `${resultText(r)} after ${n} move${n === 1 ? '' : 's'}.`;
    const mark = r.winner ? (r.winner === 'w' ? pieceSvg('N', 'w') : pieceSvg('N', 'b')) : pieceSvg('K', 'w');
    $('#resultMark').innerHTML = mark;
    const rematch = g.mode === 'online' && play.online && play.online.color !== null && r.reason !== 'aborted';
    $('#resultAgain').textContent = rematch ? 'Rematch' : 'Play again';
    const dlg = $('#dlgResult');
    dlg.returnValue = '';
    dlg.showModal();
  }

  $('#dlgResult').addEventListener('close', () => {
    const v = $('#dlgResult').returnValue;
    if (v === 'review') play.reviewThis();
    if (v === 'share') play.share();
    if (v === 'again') play.playAgain();
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
    // Exploring: the game as the main line of a move tree, plus any line tried from it.
    tree: null,
    cur: 0, // the tree node on the board; `cursor` is the game ply it branches from
    eng: null, // live engine lines for the position on the board
    live: null, // the latest live result: { node, depth, lines, ... }
    liveRun: 0,
    thinking: false,
    active: false,
    dropSel: null,
    engineOn: store.get('sk.rvEngine', true),
    multipv: store.get('sk.rvLines', 3),

    init() {
      this.board = new BoardView($('#reviewBoard'), { onMove: uci => this.play(uci) });
      this.board.onSelect = sel => {
        this.dropSel = sel && sel.drop ? sel.drop : null;
        this.renderBars(this.tree.position(this.cur));
      };
      for (const id of ['#rBarTop', '#rBarBottom']) {
        $(id).addEventListener('click', e => {
          const b = e.target.closest('.res.usable');
          if (b) this.board.selectDrop(+b.dataset.type);
        });
      }
      $('#rEngineOn').checked = this.engineOn;
      $('#rEngineOn').onchange = () => {
        this.engineOn = $('#rEngineOn').checked;
        store.set('sk.rvEngine', this.engineOn);
        this.render();
        this.runLive();
      };
      $('#rMultipv').value = String(this.multipv);
      $('#rMultipv').onchange = () => {
        this.multipv = +$('#rMultipv').value || 3;
        store.set('sk.rvLines', this.multipv);
        this.runLive();
      };
      $('#rLines').addEventListener('click', e => {
        const b = e.target.closest('[data-line]');
        const r = this.live;
        if (!b || !r || r.node !== this.cur) return;
        const line = r.lines[+b.dataset.line];
        if (line) this.goNode(this.tree.addLine(this.cur, line.pv.slice(0, +b.dataset.idx + 1)).id);
      });
      $('#rVariation').addEventListener('click', e => {
        if (e.target.closest('#rBackToGame')) return this.go(this.cursor);
        const b = e.target.closest('[data-node]');
        if (b) this.goNode(+b.dataset.node);
      });
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
      $('#btnImportFile').onclick = () => $('#importFile').click();
      $('#btnShareReview').onclick = () => {
        const g = this.game;
        if (!g) return;
        openShare({ kind: 'review', fen: g.startFen, moves: g.moves, at: this.cursor, white: g.white, black: g.black, result: g.result, date: g.date });
      };
      $('#btnAnalyseHere').onclick = () => {
        if (!this.game) return;
        analysis.load(this.game.startFen, this.game.moves.slice(), this.cursor);
        const extra = this.tree.path(this.cur).slice(this.cursor);
        if (extra.length) {
          // Bring the line being explored along, as a variation off the game.
          analysis.cur = analysis.tree.addLine(analysis.cur, extra).id;
          analysis.save();
        }
        location.hash = '#/analysis';
      };
      $('#btnOther').onclick = () => {
        this.runId++;
        reviewEngine.reset();
        this.stopLive();
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

    // The box on the empty review page takes a move list, a shared link, a game file or a
    // position with moves; whatever it holds opens in review.
    importMoves() {
      const err = $('#importError');
      const text = $('#importMoves').value;
      const r = Share.read(text);
      if (!text.trim() || !r || r.error) {
        err.textContent = !text.trim() ? 'Paste some moves first.' : r ? r.error : 'That is not a move list, a Maki link or a game file.';
        err.hidden = false;
        return;
      }
      err.hidden = true;
      openImported(asReview(r));
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
      this.tree = new MoveTree(game.startFen);
      this.cur = this.tree.addLine(0, game.moves).id;
      this.live = null;
      this.show();
      this.analyse();
    },

    show() {
      this.active = true;
      $('#reviewEmpty').hidden = !!this.game;
      $('#reviewArena').hidden = !this.game;
      if (this.game) {
        this.render();
        this.runLive();
      } else {
        this.stopLive();
      }
    },

    hide() {
      this.active = false;
      this.stopLive();
    },

    // Whether the board shows a position from the game itself, not a line tried from it.
    onGame() {
      return this.tree.isMainline(this.cur);
    },

    // The game ply a node branches from: its own ply on the game line, otherwise the ply of
    // the last game position before the line left it.
    branchPly(id) {
      let n = this.tree.get(id);
      while (n.parent && !this.tree.isMainline(n.id)) n = n.parent;
      return n.ply;
    },

    // A move made on the board: the game's own next move stays on the game line, anything
    // else starts (or follows) a line to explore.
    play(uci) {
      const n = this.tree.add(this.cur, uci);
      if (n) this.goNode(n.id);
    },

    goNode(id) {
      if (!this.tree.get(id)) return;
      this.cur = id;
      this.cursor = this.branchPly(id);
      this.dropSel = null;
      this.render();
      this.runLive();
    },

    stopLive() {
      this.liveRun++;
      this.thinking = false;
      if (this.eng && this.eng.pending.size) this.eng.reset();
    },

    // Stockhorse's best lines for the position on the board, deepening like the analysis board.
    async runLive() {
      this.stopLive();
      const run = this.liveRun;
      if (!this.game || !this.active) return;
      const node = this.cur;
      const pos = this.tree.position(node);
      if (this.live && this.live.node !== node) this.live = null;
      if (!this.engineOn || pos.status().state !== 'ongoing') return this.renderEngine(pos);
      if (!this.eng) this.eng = new EngineClient();
      const eng = this.eng;
      const fen = this.tree.fen, moves = this.tree.path(node);
      const steps = eng.worker ? ENGINE_STEPS : ENGINE_STEPS.slice(0, 2);
      this.live = null;
      this.thinking = true;
      this.renderEngine(pos);
      for (const movetime of steps) {
        let r;
        try {
          r = await eng.call('lines', { fen, moves, movetime, depth: 40, multipv: this.multipv });
        } catch {
          return; // a newer position took over
        }
        if (run !== this.liveRun) return;
        const done = this.live && r.depth <= this.live.depth && movetime > ENGINE_STEPS[1];
        if (!this.live || r.depth >= this.live.depth) this.live = { ...r, node };
        const top = r.lines[0];
        if (done || (top && Math.abs(top.score) >= SK.MATE - 1000 && r.depth >= SK.MATE - Math.abs(top.score))) break;
        this.renderEngine(pos);
        this.renderArrows(pos);
      }
      this.thinking = false;
      this.renderEngine(pos);
      this.renderArrows(pos);
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
      if (!this.onGame() && (k === 'prev' || k === 'next')) {
        const node = this.tree.get(this.cur);
        if (k === 'prev') this.goNode(node.parent.id);
        else if (node.children.length) this.goNode(node.children[0].id);
        return;
      }
      if (k === 'start') this.go(0);
      else if (k === 'end') this.go(n);
      else if (k === 'prev') this.go(this.cursor - 1);
      else if (k === 'next') this.go(this.cursor + 1);
    },

    go(i) {
      const n = this.game.moves.length;
      const k = Math.max(0, Math.min(n, i));
      const node = k ? this.tree.mainline(0)[k - 1] : this.tree.root;
      this.goNode(node.id);
    },

    // The game move on the board with its classification, when the board is on the game line.
    gamePly() {
      const k = this.cursor;
      return this.data && k > 0 && this.onGame() ? this.data.plies[k - 1] : null;
    },

    arrows(pos) {
      const ply = this.gamePly();
      const k = this.cursor;
      // After a slip, the move that should have been played.
      if (ply && ply.best && ply.best !== ply.uci && !['best', 'brilliant', 'great', 'forced'].includes(ply.cls)) {
        const before = buildPosition(this.game.startFen, this.game.moves.slice(0, k - 1));
        return [{ move: before.moveFromUci(ply.best), color: '#5f9e3a' }];
      }
      const r = this.live;
      if (!this.engineOn || !r || r.node !== this.cur) return [];
      return r.lines.slice(0, 3).map((l, i) => ({ move: pos.moveFromUci(l.move), color: LINE_COLORS[i] })).filter(a => a.move).reverse();
    },

    renderArrows(pos) {
      this.board.arrows = this.arrows(pos);
      this.board.render(); // keeps a picked piece picked
    },

    renderBars(pos) {
      const bottom = this.flipped ? BLACK : WHITE;
      $('#rBarBottom').innerHTML = this.barHtml(pos, bottom);
      $('#rBarTop').innerHTML = this.barHtml(pos, bottom ^ 1);
    },

    render() {
      const g = this.game;
      if (!g) return;
      const k = this.cursor;
      const onGame = this.onGame();
      const node = this.tree.get(this.cur);
      const pos = this.tree.position(this.cur);
      const ply = this.gamePly();
      const last = node.parent ? this.tree.position(node.parent.id).moveFromUci(node.uci) : 0;
      const st = pos.status();
      this.board.set({
        pos,
        flipped: this.flipped,
        lastMove: last,
        movable: st.state === 'ongoing' ? pos.side : null,
        badge: ply ? { sq: moveTo(last), cls: ply.cls } : null,
        arrows: this.arrows(pos),
      });
      this.renderBars(pos);

      // Eval bar
      const evalEl = $('#reviewEval');
      const live = this.live && this.live.node === this.cur && this.live.lines[0] ? this.live : null;
      if (!onGame || (live && this.engineOn)) {
        let white = 0;
        if (st.state !== 'ongoing') white = st.state === 'draw' ? 0 : st.winner === WHITE ? SK.MATE - 1 : -(SK.MATE - 1);
        else if (live) white = pos.side === WHITE ? live.lines[0].score : -live.lines[0].score;
        setEvalBar(evalEl, white, this.flipped);
      } else if (this.data) {
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
      this.renderVariation();
      this.renderEngine(pos);
      this.renderGraph();
    },

    barHtml(pos, color) {
      const g = this.game;
      const name = color === WHITE ? g.white : g.black;
      const acc = this.data ? this.data.players[color].accuracy : null;
      const st = pos.status();
      const mine = pos.side === color && st.state === 'ongoing';
      const droppable = new Set(mine ? this.board.legal.map(moveDrop).filter(Boolean) : []);
      const res = DROP_ORDER.map(t => {
        const n = pos.hand[color][t];
        const usable = droppable.has(t);
        const cls = ['res', n ? '' : 'empty', usable ? 'usable' : '', usable && this.dropSel === t ? 'sel' : ''].join(' ');
        return `<button class="${cls}" data-type="${t}" title="${n} ${window.Pieces.NAMES[LETTERS[t]]}${n === 1 ? '' : 's'} in reserve"${usable ? '' : ' tabindex="-1"'}>
          ${pieceSvg(LETTERS[t], colorKey(color))}${n > 1 ? `<span class="count">${n}</span>` : ''}</button>`;
      }).join('');
      return `<div class="avatar">${pieceSvg('N', colorKey(color))}</div>
        <div><div class="pname">${esc(name)}</div><div class="psub">${colorName(color)}${acc !== null ? ` · accuracy ${acc.toFixed(1)}` : ''}</div></div>
        <div class="reserve">${res}</div>`;
    },

    renderMoves() {
      const g = this.game;
      const start = new Position(g.startFen);
      const off = start.side === BLACK ? 1 : 0, no0 = start.moveNo;
      const items = off && g.moves.length ? [`<li><span class="no">${no0}.</span><span class="mv muted">…</span>`] : [];
      this.moveInfo.forEach((mi, i) => {
        const p = this.data ? this.data.plies[i] : null;
        const j = i + off;
        if (j % 2 === 0) items.push(`<li><span class="no">${no0 + j / 2}.</span>`);
        const badge = p ? badgeHtml(p.cls) : '';
        const at = i === this.cursor - 1 ? (this.onGame() ? ' cur' : ' branch') : '';
        items.push(`<button class="mv${at}" data-ply="${i}">${badge}<span>${esc(mi.text)}</span></button>`);
        if (j % 2 === 1) items.push('</li>');
      });
      if ((g.moves.length + off) % 2 === 1) items.push('</li>');
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
      el.hidden = !this.onGame();
      if (el.hidden) return;
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

    // The line being explored, from where it leaves the game, with a way back.
    renderVariation() {
      const box = $('#rVariation');
      if (this.onGame()) {
        box.hidden = true;
        return;
      }
      const k = this.cursor;
      const num = numberer(this.tree.fen);
      const path = [];
      for (let n = this.tree.get(this.cur); n.ply > k; n = n.parent) path.unshift(n);
      const line = path.concat(this.tree.mainline(this.cur));
      const btns = line.map((n, i) => {
        const no = num(n.ply, i === 0);
        return `<button class="tmv${n.id === this.cur ? ' cur' : ''}" data-node="${n.id}">${no ? `<span class="no">${no}</span>` : ''}${esc(n.text)}</button>`;
      }).join('');
      const gameMove = k < this.moveInfo.length ? `instead of ${num(k + 1, true)}${this.moveInfo[k].text}` : 'after the game ended';
      box.hidden = false;
      box.innerHTML = `<div class="variation-head"><span><b>Exploring</b> <span class="muted">${esc(gameMove)}</span></span>
        <button class="btn" id="rBackToGame" title="Back to the game position this line starts from">Back to game</button></div>
        <div class="variation-line">${btns}</div>`;
    },

    renderEngine(pos) {
      const on = this.engineOn;
      const st = pos.status();
      const r = this.live && this.live.node === this.cur ? this.live : null;
      const white = s => (pos.side === WHITE ? s : -s);
      $('#rEngine').classList.toggle('off', !on);
      let score = '', info = '', lines = '';
      if (!on) {
        info = 'Turn Stockhorse on to see its best lines for each position. Move any piece to try your own ideas.';
      } else if (st.state !== 'ongoing') {
        score = st.state === 'draw' ? '½–½' : st.winner === WHITE ? '1–0' : '0–1';
        info = 'Game over.';
      } else if (!r) {
        info = 'Stockhorse is thinking <span class="thinking"><i></i><i></i><i></i></span>';
        score = '…';
      } else {
        const top = r.lines[0];
        score = R.scoreText(white(top.score));
        const nodes = r.nodes >= 1e6 ? `${(r.nodes / 1e6).toFixed(1)}M` : r.nodes >= 1e3 ? `${Math.round(r.nodes / 1e3)}k` : r.nodes;
        info = `Depth ${r.depth} · ${nodes} nodes${this.thinking ? ' <span class="thinking"><i></i><i></i><i></i></span>' : ''} · click a move to play it out`;
        const num = numberer(this.tree.fen);
        const ply0 = this.tree.get(this.cur).ply;
        lines = r.lines.map((l, i) => {
          const p = new Position(pos.fen());
          const out = [];
          for (let j = 0; j < Math.min(l.pv.length, 12); j++) {
            const m = p.moveFromUci(l.pv[j]);
            if (!m) break;
            const no = num(ply0 + j + 1, j === 0);
            out.push(`<button class="pmv" data-line="${i}" data-idx="${j}">${no ? `<span class="no">${no}</span>` : ''}${esc(p.moveToText(m))}</button>`);
            p.makeMove(m);
          }
          return `<li><span class="pv-score" style="--lc:${LINE_COLORS[i] || 'var(--line)'}">${R.scoreText(white(l.score))}</span><span class="pv-moves">${out.join('')}</span></li>`;
        }).join('');
      }
      $('#rScore').textContent = score;
      $('#rInfo').innerHTML = info;
      $('#rLines').innerHTML = lines;
      // On the game line the eval bar follows the review until live lines arrive.
      if (r && on) {
        const evalEl = $('#reviewEval');
        if (st.state === 'ongoing') setEvalBar(evalEl, white(r.lines[0].score), this.flipped);
      }
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

  // --- analysis board ---------------------------------------------------------------------

  // Move numbers for a ply in a game that starts from `fen`: "3." before a White move, "3…"
  // before a Black one. ply counts from 1 for the first move.
  function numberer(fen) {
    const p = new Position(fen);
    const off = p.side === BLACK ? 1 : 0;
    return (ply, force) => {
      const j = ply - 1 + off;
      const no = p.moveNo + Math.floor(j / 2);
      if (j % 2 === 0) return `${no}.`;
      return force ? `${no}…` : '';
    };
  }

  const LINE_COLORS = ['#5f9e3a', '#3d7fd1', '#8a8f96'];
  const PALETTE = [SK.KING, SK.QUEEN, SK.ROOK, SK.BISHOP, SK.KNIGHT, SK.PAWN];
  const RESERVE_MAX = { [SK.PAWN]: 2, [SK.ROOK]: 1, [SK.BISHOP]: 1 };
  const ENGINE_STEPS = [250, 700, 1800, 4500, 12000]; // ms per search, each one deeper

  const analysis = {
    board: null,
    tree: null,
    cur: 0,
    flipped: store.get('sk.anFlip', false),
    engineOn: store.get('sk.anEngine', true),
    multipv: store.get('sk.anLines', 3),
    runId: 0,
    result: null, // the latest engine result for the current node
    thinking: false,
    dropSel: null,
    editing: null, // { board, hand, side, tool } while setting up a position
    eng: null,
    active: false,
    tb: null, // the endgame table's answer for a lone-piece ending: { node, r } or { node, pending }
    tbEng: null,
    tbRun: 0,

    engine() {
      return this.eng || (this.eng = new EngineClient());
    },

    // A worker of its own, so solved endgame tables stay in memory while the search restarts.
    tbEngine() {
      return this.tbEng || (this.tbEng = new EngineClient());
    },

    init() {
      this.board = new BoardView($('#aBoard'), { onMove: uci => this.play(uci) });
      this.board.onSelect = sel => {
        this.dropSel = sel && sel.drop ? sel.drop : null;
        this.renderBars(this.tree.position(this.cur));
        this.renderStatus(this.tree.position(this.cur));
      };
      for (const id of ['#aBarTop', '#aBarBottom']) {
        $(id).addEventListener('click', e => {
          const b = e.target.closest('.res.usable');
          if (b && !this.editing) this.board.selectDrop(+b.dataset.type);
        });
      }
      $('#aNav').addEventListener('click', e => {
        const b = e.target.closest('[data-astep]');
        if (b) this.step(b.dataset.astep);
      });
      $('#aFlip').onclick = () => this.flip();
      $('#eFlip').onclick = () => this.flip();
      $('#aEngineOn').checked = this.engineOn;
      $('#aEngineOn').onchange = () => {
        this.engineOn = $('#aEngineOn').checked;
        store.set('sk.anEngine', this.engineOn);
        this.run();
      };
      $('#aMultipv').value = String(this.multipv);
      $('#aMultipv').onchange = () => {
        this.multipv = +$('#aMultipv').value || 3;
        store.set('sk.anLines', this.multipv);
        this.run();
      };
      $('#aTree').addEventListener('click', e => {
        const b = e.target.closest('[data-node]');
        if (b) this.go(+b.dataset.node);
      });
      $('#aLines').addEventListener('click', e => {
        const b = e.target.closest('[data-line]');
        if (!b || !this.result) return;
        const line = this.result.lines[+b.dataset.line];
        if (line) this.go(this.tree.addLine(this.cur, line.pv.slice(0, +b.dataset.idx + 1)).id);
      });
      $('#aPromote').onclick = () => {
        this.tree.promote(this.cur);
        this.save();
        this.render();
      };
      $('#aDelete').onclick = () => this.go(this.tree.remove(this.cur));
      $('#aFenCopy').onclick = () => copyText($('#aFen').value, 'Position copied');
      $('#aFenLoad').onclick = () => this.loadFenInput();
      $('#aFen').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.loadFenInput();
        }
      });
      $('#aSetup').onclick = () => this.openEditor();
      $('#aReset').onclick = () => this.load(START_FEN);
      $('#aCopyLine').onclick = () => {
        const moves = this.tree.path(this.cur).join(' ');
        if (!moves) return toast('No moves yet');
        const text = this.tree.fen === START_FEN ? moves : `${this.tree.fen} moves ${moves}`;
        copyText(text, 'Moves copied');
      };
      $('#aShare').onclick = () => {
        // The whole line through this move, opening on it.
        const at = this.tree.path(this.cur);
        const moves = at.concat(this.tree.mainline(this.cur).map(n => n.uci));
        openShare({ kind: 'analysis', fen: this.tree.fen, moves, at: at.length });
      };
      $('#aImport').onclick = () => openImport();
      $('#aPlayHere').onclick = () => openPveDialog(this.tree.position(this.cur).fen());
      $('#aPlayOnline').onclick = () => {
        if (!backend) return toast('Online play is not available here');
        openOnlineDialog(this.tree.position(this.cur).fen());
      };
      $('#aLesson').onchange = () => {
        const fen = $('#aLesson').value;
        $('#aLesson').value = '';
        if (fen) this.load(fen);
      };
      $('#aTb').addEventListener('click', e => {
        const b = e.target.closest('[data-tbmove]');
        if (b) this.play(b.dataset.tbmove);
      });

      // The position editor.
      $('#ePalette').addEventListener('click', e => {
        const b = e.target.closest('[data-tool]');
        if (!b) return;
        this.editing.tool = +b.dataset.tool;
        this.renderEditor();
      });
      $('#eReserves').addEventListener('click', e => {
        const b = e.target.closest('[data-res]');
        if (!b) return;
        const [c, t, d] = b.dataset.res.split(':').map(Number);
        const h = this.editing.hand[c];
        h[t] = Math.max(0, Math.min(RESERVE_MAX[t], h[t] + d));
        this.renderEditor();
      });
      $('#eSide').addEventListener('change', () => {
        this.editing.side = $('#eSide input:checked').value === 'b' ? BLACK : WHITE;
        this.renderEditor();
      });
      $('#eStart').onclick = () => this.editFrom(new Position(START_FEN));
      $('#eClear').onclick = () => {
        this.editing.board.fill(0);
        this.renderEditor();
      };
      $('#eCancel').onclick = () => {
        const back = this.afterEdit;
        this.closeEditor();
        if (back) back(null);
      };
      $('#eDone').onclick = () => {
        const v = this.validate();
        if (v.error) return;
        const back = this.afterEdit;
        this.closeEditor(false);
        this.load(v.fen);
        if (back) back(v.fen);
      };
      $('#aBoard').addEventListener('pointerdown', e => {
        if (!this.editing) return;
        const sqEl = e.target.closest('.sq');
        if (!sqEl) return;
        e.preventDefault();
        this.editSquare(+sqEl.dataset.sq, e.button === 2);
      });
      $('#aBoard').addEventListener('contextmenu', e => {
        if (this.editing) e.preventDefault();
      });

      document.addEventListener('keydown', e => {
        if (!this.active || this.editing || e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
        const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end' }[e.key];
        if (k) {
          e.preventDefault();
          this.step(k);
        } else if (e.key === 'f') {
          this.flip();
        }
      });

      const saved = store.get('sk.analysis', null);
      try {
        if (saved && saved.ruleset === SK.RULESET) {
          this.tree = MoveTree.fromJSON(saved);
          const n = this.tree.find(saved.at || []);
          this.cur = n ? n.id : 0;
        }
      } catch {
        this.tree = null;
      }
      if (!this.tree) {
        this.tree = new MoveTree(START_FEN);
        this.cur = 0;
      }
    },

    // A new board from `fen`, with `moves` as its main line and the cursor after `at` of them.
    load(fen, moves = [], at = moves.length) {
      this.tree = new MoveTree(fen || START_FEN);
      this.tree.addLine(0, moves);
      const n = this.tree.find(moves.slice(0, at));
      this.cur = n ? n.id : 0;
      this.result = null;
      this.save();
      if (this.active) {
        this.render();
        this.run();
      }
    },

    loadFenInput() {
      const text = $('#aFen').value.trim();
      const err = $('#aFenError');
      // Accept a bare position, or "<position> moves <uci …>" as Copy moves writes it.
      const m = /^(.*?)(?:\s+moves\s+(.*))?$/.exec(text);
      try {
        if (!text) throw new Error('Paste a position first.');
        const fen = m[1].trim();
        new Position(fen);
        const moves = (m[2] || '').split(/\s+/).filter(Boolean);
        this.load(fen, moves);
        const got = this.tree.path(this.cur).length;
        err.hidden = true;
        if (got < moves.length) toast(`Loaded the position and ${got} of ${moves.length} moves`);
        else toast('Position loaded');
      } catch (e) {
        err.textContent = `That position does not read right: ${String(e.message).replace(/^bad FEN:?\s*/, '').replace(/: [^:]*$/, '')}.`;
        err.hidden = false;
      }
    },

    save() {
      store.set('sk.analysis', { ...this.tree.toJSON(), at: this.tree.path(this.cur), ruleset: SK.RULESET });
    },

    show() {
      this.active = true;
      if (this.editing) return this.renderEditor();
      this.render();
      this.run();
    },

    hide() {
      this.active = false;
      this.stop();
    },

    stop() {
      this.runId++;
      this.thinking = false;
      if (this.eng && this.eng.pending.size) this.eng.reset();
    },

    flip() {
      this.flipped = !this.flipped;
      store.set('sk.anFlip', this.flipped);
      if (this.editing) this.renderEditor();
      else this.render();
    },

    play(uci) {
      const n = this.tree.add(this.cur, uci);
      if (n) this.go(n.id);
    },

    go(id) {
      if (!this.tree.get(id)) return;
      this.cur = id;
      this.dropSel = null;
      this.result = null;
      this.save();
      this.render();
      this.run();
    },

    step(k) {
      const n = this.tree.get(this.cur);
      if (k === 'start') this.go(0);
      else if (k === 'prev' && n.parent) this.go(n.parent.id);
      else if (k === 'next' && n.children.length) this.go(n.children[0].id);
      else if (k === 'end') {
        const line = this.tree.mainline(this.cur);
        if (line.length) this.go(line[line.length - 1].id);
      }
    },

    // --- engine ---

    async run() {
      this.stop();
      const run = this.runId;
      this.result = null;
      const pos = this.tree.position(this.cur);
      this.runTb(pos);
      if (!this.engineOn || this.editing || !this.active || pos.status().state !== 'ongoing') return this.renderEngine(pos);
      const eng = this.engine();
      const node = this.cur, fen = this.tree.fen, moves = this.tree.path(node);
      const steps = eng.worker ? ENGINE_STEPS : ENGINE_STEPS.slice(0, 2); // on the page, keep it short
      this.thinking = true;
      this.renderEngine(pos);
      for (const movetime of steps) {
        let r;
        try {
          r = await eng.call('lines', { fen, moves, movetime, depth: 40, multipv: this.multipv });
        } catch {
          return; // a newer position took over
        }
        if (run !== this.runId) return;
        const done = this.result && r.depth <= this.result.depth && movetime > ENGINE_STEPS[1];
        if (!this.result || r.depth >= this.result.depth) this.result = { ...r, node };
        const top = r.lines[0];
        if (done || (top && Math.abs(top.score) >= SK.MATE - 1000 && r.depth >= SK.MATE - Math.abs(top.score))) break;
        this.renderEngine(pos);
        this.renderArrows(pos);
      }
      this.thinking = false;
      this.renderEngine(pos);
      this.renderArrows(pos);
    },

    // --- endgame table (web/endgame.js): exact results for king and minor pieces v bare king ---

    async runTb(pos) {
      const id = ++this.tbRun;
      const E = window.Endgame;
      if (this.editing || !this.active || !E || !E.supports(pos) || pos.status().state !== 'ongoing') {
        this.tb = null;
        return this.renderTb();
      }
      const node = this.cur;
      this.tb = { node, pending: true };
      this.renderTb();
      let r;
      try {
        r = await this.tbEngine().call('tablebase', { fen: this.tree.fen, moves: this.tree.path(node) });
      } catch {
        return;
      }
      if (id !== this.tbRun) return;
      this.tb = r ? { node, r } : null;
      this.renderTb();
      this.renderArrows(pos);
    },

    renderTb() {
      const box = $('#aTb');
      const t = this.tb;
      if (!t || t.node !== this.cur || this.editing) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      const head = sig => `<div class="tb-head"><b>Endgame table</b><span class="muted">${sig ? esc(sig.replace('v', ' v ')) : ''}</span></div>`;
      if (t.pending) {
        box.innerHTML = `${head('')}<div class="tb-sum muted">Solving this ending exactly <span class="thinking"><i></i><i></i><i></i></span></div>`;
        return;
      }
      const r = t.r;
      const pos = this.tree.position(this.cur);
      const strong = colorName(r.strong);
      const moves = n => `${n} move${n === 1 ? '' : 's'}`;
      let sum;
      if (r.result === 'draw') sum = `Draw with best play: ${colorName(r.strong ^ 1)} wins material and is left with bare kings.`;
      else {
        const winner = r.result === 'win' ? pos.side : pos.side ^ 1;
        sum = `${colorName(winner)} wins: ${colorName(winner ^ 1)} has no legal move after ${moves(Math.ceil(r.plies / 2))} by ${colorName(winner)}, with best play.`;
      }
      const notes = {
        KBvK: `A lone bishop can never checkmate. ${strong} wins by leaving the bare king without a move (stalemate loses), usually in a corner of the colour the bishop does not move on.`,
        KNvK: `A lone knight can never checkmate. ${strong} wins by stalemating the bare king in a corner, as long as the knight is not trapped.`,
        KNNvK: `Two knights can checkmate, but cannot force it: the bare king can always step away from a mate. ${strong} wins by stalemate instead.`,
      };
      const note = notes[r.sig] || 'The game ends when a side has no legal move: checkmate or stalemate.';
      const label = m => (m.result === 'draw' ? 'Draw' : `${m.result === 'win' ? 'Wins' : 'Loses'} in ${m.plies}`);
      const list = r.moves.map(m => {
        const mv = pos.moveFromUci(m.uci);
        return `<button class="tb-move ${m.result}" data-tbmove="${esc(m.uci)}"><span>${esc(mv ? pos.moveToText(mv) : m.uci)}</span><span class="tb-val">${esc(label(m))}</span></button>`;
      }).join('');
      box.innerHTML = `${head(r.sig)}<div class="tb-sum">${esc(sum)}</div><p class="tb-note muted">${esc(note)} <a href="#/rules">Why?</a></p>
        <div class="tb-moves">${list}</div><p class="tb-note muted">Each move's value counts plies (single moves by either side) to the end of the game, for the side playing it.</p>`;
    },

    // --- rendering ---

    render() {
      const pos = this.tree.position(this.cur);
      const node = this.tree.get(this.cur);
      const st = pos.status();
      let lastMove = 0;
      if (node.parent) lastMove = this.tree.position(node.parent.id).moveFromUci(node.uci);
      this.board.set({ pos, flipped: this.flipped, lastMove, movable: st.state === 'ongoing' ? pos.side : null, badge: null, arrows: this.arrows(pos) });
      this.renderBars(pos);
      this.renderStatus(pos);
      this.renderTree();
      this.renderEngine(pos);
      this.renderTb();
      const fenEl = $('#aFen');
      if (document.activeElement !== fenEl) fenEl.value = pos.fen();
      $('#aFenError').hidden = true;
      $('#aPromote').disabled = this.tree.isMainline(this.cur);
      $('#aDelete').disabled = !node.parent;
      $('#aPlayHere').disabled = st.state !== 'ongoing';
      $('#aPlayOnline').disabled = st.state !== 'ongoing';
      $('#aCopyLine').disabled = !node.parent;
      for (const b of $$('#aNav [data-astep]')) {
        const s = b.dataset.astep;
        b.disabled = s === 'start' || s === 'prev' ? !node.parent : !node.children.length;
      }
    },

    arrows(pos) {
      // In a lone-piece ending the table's best moves are exact, so they get the arrows.
      const t = this.tb && this.tb.r && this.tb.node === this.cur ? this.tb.r : null;
      if (t && t.moves.length) {
        const best = t.moves.filter(m => m.result === t.moves[0].result && m.plies === t.moves[0].plies).slice(0, 3);
        return best.map((m, i) => ({ move: pos.moveFromUci(m.uci), color: LINE_COLORS[i] })).filter(a => a.move).reverse();
      }
      const r = this.result;
      if (!this.engineOn || !r || r.node !== this.cur) return [];
      return r.lines.slice(0, 3).map((l, i) => ({ move: pos.moveFromUci(l.move), color: LINE_COLORS[i] })).filter(a => a.move).reverse();
    },

    renderArrows(pos) {
      if (this.editing) return;
      this.board.arrows = this.arrows(pos);
      this.board.render(); // keeps a picked piece picked
    },

    renderBars(pos) {
      const bottom = this.flipped ? BLACK : WHITE;
      const st = pos.status();
      const droppable = new Set(st.state === 'ongoing' ? this.board.legal.map(moveDrop).filter(Boolean) : []);
      const bar = color => {
        const mine = !this.editing && pos.side === color && st.state === 'ongoing';
        const res = DROP_ORDER.map(t => {
          const n = pos.hand[color][t];
          const usable = mine && droppable.has(t);
          const name = window.Pieces.NAMES[LETTERS[t]];
          const cls = ['res', n ? '' : 'empty', usable ? 'usable' : '', usable && this.dropSel === t ? 'sel' : ''].join(' ');
          return `<button class="${cls}" data-type="${t}" title="${n} ${name}${n === 1 ? '' : 's'} in reserve"${usable ? '' : ' tabindex="-1"'}>
            ${pieceSvg(LETTERS[t], colorKey(color))}${n > 1 ? `<span class="count">${n}</span>` : ''}</button>`;
        }).join('');
        return `<div class="avatar">${pieceSvg('K', colorKey(color))}</div>
          <div><div class="pname">${colorName(color)}</div><div class="psub">${mine ? 'To move' : ''}</div></div>
          <div class="reserve">${res}</div>`;
      };
      $('#aBarBottom').innerHTML = bar(bottom);
      $('#aBarTop').innerHTML = bar(bottom ^ 1);
      $('#aBarBottom').classList.toggle('to-move', !this.editing && pos.side === bottom && st.state === 'ongoing');
      $('#aBarTop').classList.toggle('to-move', !this.editing && pos.side !== bottom && st.state === 'ongoing');
    },

    renderStatus(pos) {
      const st = pos.status();
      let main, sub = '';
      if (st.state !== 'ongoing') {
        main = resultText(statusToResult(st));
        sub = 'Step back, or click an earlier move, to try something else.';
      } else {
        main = `${colorName(pos.side)} to move`;
        if (pos.inCheck()) sub = `${colorName(pos.side)} is in check.`;
        else if (this.dropSel) sub = 'Pick an empty square to drop on.';
        else sub = 'Move either side. A new move starts a variation.';
      }
      $('#aStatus').innerHTML = `${esc(main)}<span class="sub">${esc(sub)}</span>`;
    },

    renderTree() {
      const t = this.tree;
      const num = numberer(t.fen);
      const parts = [];
      const btn = (n, force) => {
        const no = num(n.ply, force);
        return `<button class="tmv${n.id === this.cur ? ' cur' : ''}" data-node="${n.id}">${no ? `<span class="no">${no}</span>` : ''}${esc(n.text)}</button>`;
      };
      // A line: `first` and its main continuation, each variation shown after the move it replaces.
      const line = (first, depth) => {
        let force = true;
        for (let n = first; n; n = n.children[0]) {
          parts.push(btn(n, force));
          force = false;
          const p = n.parent;
          if (p.children[0] === n && p.children.length > 1) {
            for (const v of p.children.slice(1)) {
              parts.push(depth === 0 ? '<div class="var">' : '<span class="var inline">(');
              line(v, depth + 1);
              parts.push(depth === 0 ? '</div>' : ')</span>');
            }
            force = true;
          }
        }
      };
      if (t.root.children.length) line(t.root.children[0], 0);
      const el = $('#aTree');
      el.innerHTML = parts.length
        ? `<div class="tree-start${this.cur === 0 ? ' cur' : ''}"><button class="tmv${this.cur === 0 ? ' cur' : ''}" data-node="0">Start</button></div><div class="mainline">${parts.join('')}</div>`
        : '<p class="muted tree-empty">Make a move on the board, for either side. Every move you try is kept here, with side lines as variations.</p>';
      const cur = el.querySelector('.tmv.cur');
      if (cur) {
        const top = cur.offsetTop - el.offsetTop;
        if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 30) el.scrollTop = top - el.clientHeight / 2;
      }
    },

    renderEngine(pos) {
      const on = this.engineOn;
      const st = pos.status();
      const r = this.result && this.result.node === this.cur ? this.result : null;
      const white = s => (pos.side === WHITE ? s : -s);
      $('#aEval').hidden = !on;
      $('#aEngine').classList.toggle('off', !on);
      let score = '', info = '', lines = '';
      if (!on) {
        info = 'Turn Stockhorse on to see its evaluation and best lines.';
      } else if (st.state !== 'ongoing') {
        const v = st.state === 'draw' ? 0 : st.winner === WHITE ? SK.MATE : -SK.MATE;
        score = st.state === 'draw' ? '½–½' : st.winner === WHITE ? '1–0' : '0–1';
        info = 'Game over.';
        setEvalBar($('#aEval'), v, this.flipped);
      } else if (!r) {
        info = 'Stockhorse is thinking <span class="thinking"><i></i><i></i><i></i></span>';
        score = '…';
      } else {
        const top = r.lines[0];
        score = R.scoreText(white(top.score));
        const nodes = r.nodes >= 1e6 ? `${(r.nodes / 1e6).toFixed(1)}M` : r.nodes >= 1e3 ? `${Math.round(r.nodes / 1e3)}k` : r.nodes;
        info = `Depth ${r.depth} · ${nodes} nodes${this.thinking ? ' <span class="thinking"><i></i><i></i><i></i></span>' : ''}`;
        setEvalBar($('#aEval'), white(top.score), this.flipped);
        const num = numberer(this.tree.fen);
        const ply0 = this.tree.get(this.cur).ply;
        lines = r.lines.map((l, i) => {
          const p = new Position(pos.fen());
          const out = [];
          for (let j = 0; j < Math.min(l.pv.length, 8); j++) {
            const m = p.moveFromUci(l.pv[j]);
            if (!m) break;
            const no = num(ply0 + j + 1, j === 0);
            out.push(`<button class="pmv" data-line="${i}" data-idx="${j}">${no ? `<span class="no">${no}</span>` : ''}${esc(p.moveToText(m))}</button>`);
            p.makeMove(m);
          }
          return `<li><span class="pv-score" style="--lc:${LINE_COLORS[i] || 'var(--line)'}">${R.scoreText(white(l.score))}</span><span class="pv-moves">${out.join('')}</span></li>`;
        }).join('');
      }
      if (!on || (!r && st.state === 'ongoing')) setEvalBar($('#aEval'), 0, this.flipped);
      $('#aScore').textContent = score;
      $('#aInfo').innerHTML = info;
      $('#aLines').innerHTML = lines;
    },

    // --- position editor ---

    // `afterEdit(fen | null)`, when given, runs once the editor closes (Done gives the FEN,
    // Cancel gives null): the online dialog uses it to come back with the position set up.
    openEditor(afterEdit = null) {
      this.afterEdit = afterEdit;
      $('#eDone').textContent = afterEdit ? 'Use this position' : 'Analyse this position';
      this.stop();
      this.board.set({ movable: null });
      this.editFrom(this.tree.position(this.cur), true);
      $('#aPanel').hidden = true;
      $('#aEditor').hidden = false;
      $('#aEngine').classList.add('off');
    },

    editFrom(pos, fresh = false) {
      this.editing = {
        board: Int8Array.from(pos.board),
        hand: [Array.from(pos.hand[WHITE]), Array.from(pos.hand[BLACK])],
        side: pos.side,
        tool: fresh || !this.editing ? SK.PAWN : this.editing.tool,
      };
      this.renderEditor();
    },

    closeEditor(rerender = true) {
      this.editing = null;
      this.afterEdit = null;
      $('#aBoard').classList.remove('editing');
      $('#aPanel').hidden = false;
      $('#aEditor').hidden = true;
      if (rerender) {
        this.render();
        this.run();
      }
    },

    editSquare(sq, erase) {
      const e = this.editing;
      const tool = e.tool;
      if (erase || !tool || e.board[sq] === tool) {
        e.board[sq] = 0;
      } else {
        if ((tool & 7) === SK.KING) {
          for (let i = 0; i < 36; i++) if (e.board[i] === tool) e.board[i] = 0; // one king a side
        }
        e.board[sq] = tool;
      }
      this.renderEditor();
    },

    editorFen() {
      const e = this.editing;
      const chars = '.PNBRQK..pnbrqk.';
      const rows = [];
      for (let rank = 5; rank >= 0; rank--) {
        let row = '', empty = 0;
        for (let file = 0; file < 6; file++) {
          const code = e.board[rank * 6 + file];
          if (!code) {
            empty++;
            continue;
          }
          if (empty) row += empty;
          empty = 0;
          row += chars[code];
        }
        if (empty) row += empty;
        rows.push(row);
      }
      let res = '';
      for (const c of [WHITE, BLACK]) for (const t of [SK.PAWN, SK.ROOK, SK.BISHOP]) res += chars[t | (c << 3)].repeat(e.hand[c][t]);
      return `${rows.join('/')}[${res || '-'}] ${e.side === WHITE ? 'w' : 'b'} 0 1`;
    },

    // { fen } for a legal setup, or { error } saying what to fix.
    validate() {
      const e = this.editing;
      const fen = this.editorFen();
      const kings = [WHITE, BLACK].map(c => e.board.findIndex(code => code === (SK.KING | (c << 3))));
      if (kings[WHITE] < 0 || kings[BLACK] < 0) {
        const missing = kings[WHITE] < 0 && kings[BLACK] < 0 ? 'Both sides need' : `${kings[WHITE] < 0 ? 'White' : 'Black'} needs`;
        return { fen, error: `${missing} a king.` };
      }
      const [a, b] = kings;
      if (Math.abs((a % 6) - (b % 6)) <= 1 && Math.abs(((a / 6) | 0) - ((b / 6) | 0)) <= 1) {
        return { fen, error: 'The kings cannot stand next to each other.' };
      }
      try {
        new Position(fen);
      } catch (err) {
        if (/not to move is in check/.test(err.message)) {
          const other = colorName(e.side ^ 1);
          return { fen, error: `${other} is in check, but it is ${colorName(e.side)}'s move. Switch the side to move, or move a piece.` };
        }
        return { fen, error: err.message.replace(/: [^:]*$/, '') };
      }
      return { fen };
    },

    renderEditor() {
      const e = this.editing;
      if (!e) return;
      // The board.
      const html = [];
      for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 6; col++) {
          const sq = this.flipped ? row * 6 + (5 - col) : (5 - row) * 6 + col;
          const file = sq % 6, rank = (sq / 6) | 0;
          const code = e.board[sq];
          let inner = code ? pieceSvg(LETTERS[code & 7], code >> 3 ? 'b' : 'w') : '';
          if (col === 0) inner += `<span class="coord rank">${rank + 1}</span>`;
          if (row === 5) inner += `<span class="coord file">${'abcdef'[file]}</span>`;
          html.push(`<div class="sq ${(file + rank) % 2 ? 'light' : 'dark'} edit${code ? ' has-piece' : ''}" data-sq="${sq}">${inner}</div>`);
        }
      }
      $('#aBoard').innerHTML = html.join('');
      $('#aBoard').classList.add('editing');

      // The palette: White's pieces, Black's pieces, and the eraser.
      const tool = (code, label, inner) =>
        `<button class="tool${e.tool === code ? ' sel' : ''}" data-tool="${code}" title="${label}" aria-label="${label}" aria-pressed="${e.tool === code}">${inner}</button>`;
      $('#ePalette').innerHTML = [WHITE, BLACK].map(c =>
        `<div class="palette-row">${PALETTE.map(t => tool(t | (c << 3), `${colorName(c)} ${window.Pieces.NAMES[LETTERS[t]]}`, pieceSvg(LETTERS[t], colorKey(c)))).join('')}</div>`,
      ).join('') + `<div class="palette-row">${tool(0, 'Eraser', '<svg viewBox="0 0 24 24" class="eraser"><path d="M15.5 4.5l4 4-9 9H6l-2.5-2.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 9l5 5M4 20h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Erase</span>')}</div>`;

      // Reserves.
      const stepper = (c, t) => {
        const n = e.hand[c][t];
        const name = window.Pieces.NAMES[LETTERS[t]];
        return `<span class="stepper"><span class="res${n ? '' : ' empty'}" title="${colorName(c)} ${name}s in reserve">${pieceSvg(LETTERS[t], colorKey(c))}</span>
          <button class="icon-btn" data-res="${c}:${t}:-1" aria-label="One ${colorName(c)} ${name} fewer" ${n ? '' : 'disabled'}>&minus;</button><b>${n}</b>
          <button class="icon-btn" data-res="${c}:${t}:1" aria-label="One ${colorName(c)} ${name} more" ${n < RESERVE_MAX[t] ? '' : 'disabled'}>+</button></span>`;
      };
      const plural = t => { const n = window.Pieces.NAMES[LETTERS[t]]; return `${n[0].toUpperCase()}${n.slice(1)}s`; };
      $('#eReserves').innerHTML = '<span></span><span class="ehead">White</span><span class="ehead">Black</span>' +
        DROP_ORDER.map(t => `<span class="ehead">${plural(t)}</span>${stepper(WHITE, t)}${stepper(BLACK, t)}`).join('');

      $$('#eSide input').forEach(i => (i.checked = i.value === colorKey(e.side)));
      const v = this.validate();
      $('#eError').hidden = !v.error;
      $('#eError').textContent = v.error || '';
      $('#eDone').disabled = !!v.error;

      // Bars show only names while editing.
      const bottom = this.flipped ? BLACK : WHITE;
      for (const [id, c] of [['#aBarBottom', bottom], ['#aBarTop', bottom ^ 1]]) {
        $(id).innerHTML = `<div class="avatar">${pieceSvg('K', colorKey(c))}</div><div><div class="pname">${colorName(c)}</div><div class="psub">${e.side === c ? 'To move' : ''}</div></div>`;
        $(id).classList.toggle('to-move', e.side === c);
      }
      $('#aEval').hidden = true;
      for (const b of $$('#aNav [data-astep]')) b.disabled = true;
    },
  };

  function copyText(text, done) {
    navigator.clipboard?.writeText(text).then(() => toast(done), () => toast(text));
  }

  // --- sharing and importing --------------------------------------------------------------

  const Share = window.Share;
  let shareData = null; // what the share sheet is showing

  // A short line about a game or position for the share sheet and the native share text.
  function shareSummary(d) {
    const n = d.moves.length;
    if (d.kind === 'online') return d.summary;
    const who = d.white || d.black ? `${d.white || 'White'} vs ${d.black || 'Black'}` : '';
    const res = d.result ? resultText(d.result) : '';
    if (d.kind === 'review') return [who, res || (n ? 'unfinished' : ''), n ? `${Math.ceil(n / 2)} move${n > 2 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    const pos = buildPosition(d.fen, d.moves.slice(0, d.at ?? n));
    return `${colorName(pos.side)} to move${n ? ` · ${n} move${n > 1 ? 's' : ''} in the line` : ''}`;
  }

  // Opens the share sheet. `d`: { kind: 'analysis' | 'review' | 'online', fen, moves, at,
  // white, black, result, date, url (online only), title }.
  function openShare(d) {
    d.fen = d.fen || START_FEN;
    d.moves = d.moves || [];
    const at = d.at ?? d.moves.length;
    shareData = d;
    d.url = d.url || Share.shareUrl(location.href, d.kind, d);
    const pos = buildPosition(d.fen, d.moves.slice(0, at));
    $('#shareTitle').textContent = d.title || (d.kind === 'analysis' ? 'Share this position' : 'Share this game');
    $('#shareBoard').innerHTML = miniBoard(pos);
    $('#shareSummary').textContent = shareSummary(d);
    $('#shareNote').textContent = d.kind === 'online'
      ? 'The link opens the live game. Anyone who opens it can watch, or take an empty seat.'
      : d.kind === 'review'
        ? 'The link opens the game in Review, on this move. Nothing is uploaded: the moves are in the link itself.'
        : `The link opens this position${d.moves.length ? ' and line' : ''} on the analysis board. Nothing is uploaded: it is all in the link.`;
    $('#shareUrl').value = d.url;
    $('#shareNative').hidden = !navigator.share;
    $('#shareCopyMoves').hidden = !d.moves.length;
    $('#shareDownload').hidden = d.kind === 'online' && !d.moves.length;
    const dlg = $('#dlgShare');
    if (!dlg.open) dlg.showModal();
  }

  function shareGameFile(d) {
    const game = { fen: d.fen, moves: d.moves, white: d.white, black: d.black, result: d.result, date: d.date, link: d.kind === 'online' ? d.url : Share.shareUrl(location.href, 'review', { ...d, at: undefined }) };
    return { name: Share.fileName(game), text: Share.gameText(game) };
  }

  // A toast would sit under the open dialog, so the sheet's buttons say "Copied" themselves.
  function flash(btn, text) {
    clearTimeout(btn.flashTimer);
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = text;
    btn.flashTimer = setTimeout(() => (btn.textContent = btn.dataset.label), 1600);
  }
  function copyFromSheet(btn, text) {
    if (!navigator.clipboard) return flash(btn, 'Select and copy');
    navigator.clipboard.writeText(text).then(() => flash(btn, 'Copied'), () => flash(btn, 'Could not copy'));
  }
  $('#shareCopyLink').onclick = e => {
    $('#shareUrl').select();
    copyFromSheet(e.currentTarget, $('#shareUrl').value);
  };
  $('#shareCopyFen').onclick = e => {
    const d = shareData;
    copyFromSheet(e.currentTarget, buildPosition(d.fen, d.moves.slice(0, d.at ?? d.moves.length)).fen());
  };
  $('#shareCopyMoves').onclick = e => {
    const d = shareData;
    copyFromSheet(e.currentTarget, d.fen === START_FEN ? d.moves.join(' ') : `${d.fen} moves ${d.moves.join(' ')}`);
  };
  $('#shareDownload').onclick = e => {
    const f = shareGameFile(shareData);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([f.text], { type: 'text/plain' }));
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash(e.currentTarget, 'Downloaded');
  };
  $('#shareNative').onclick = async () => {
    const d = shareData;
    try {
      await navigator.share({ title: 'Maki', text: `${$('#shareTitle').textContent.replace(/^Share /, 'Look at ')}: ${shareSummary(d)}`, url: d.url });
      $('#dlgShare').close();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // Some browsers refuse a share from an embedded page: fall back to copying the link.
      copyFromSheet($('#shareNative'), d.url);
    }
  };

  // Opens what Share.read found: the analysis board, a review, an online game or a page.
  // Returns true when there was something to open.
  function openImported(r, { quiet = false } = {}) {
    if (!r) return false;
    if (r.error) {
      toast(r.error);
      return false;
    }
    if (r.kind === 'online') {
      location.hash = `#/online/${r.id}`;
      return true;
    }
    if (r.kind === 'route') {
      location.hash = r.hash;
      return true;
    }
    if (r.kind === 'review' && r.moves.length) {
      // The same game opened twice is one saved game, not two.
      let h = 0;
      for (const ch of `${r.fen}|${r.moves.join(' ')}|${r.white || ''}|${r.black || ''}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
      const g = {
        id: `imp${(h >>> 0).toString(36)}`,
        mode: 'import',
        startFen: r.fen,
        moves: r.moves.slice(),
        white: r.white || 'White',
        black: r.black || 'Black',
        result: r.result || statusToResult(buildPosition(r.fen, r.moves).status()),
        date: r.date || Date.now(),
      };
      saveGame(g);
      review.load(g);
      if (r.at !== undefined) review.go(r.at);
      location.hash = '#/review';
      if (!quiet) toast('Game imported');
      return true;
    }
    analysis.load(r.fen, r.moves, r.at ?? r.moves.length);
    if (location.hash !== '#/analysis') location.hash = '#/analysis';
    if (!quiet) toast(r.moves.length ? 'Position and moves imported' : 'Position imported');
    return true;
  }

  // A move list or position with moves, opened in review rather than on the analysis board.
  function asReview(r) {
    return r && !r.error && r.kind === 'analysis' && r.moves.length ? { ...r, kind: 'review', at: r.at } : r;
  }

  function importText(text, opts) {
    const r = Share.read(text);
    if (!r) {
      toast('Nothing to import there: paste a Maki link, a game file, a position or a move list.');
      return false;
    }
    return openImported(r, opts);
  }

  async function readFile(file) {
    if (file.size > 1e6) throw new Error('That file is too big to be a Maki game.');
    return file.text();
  }

  // The import dialog: paste, pick a file, or read the clipboard.
  function openImport() {
    $('#importText').value = '';
    $('#importDlgError').hidden = true;
    $('#importPasteBtn').hidden = !(navigator.clipboard && navigator.clipboard.readText);
    $('#dlgImport').showModal();
    $('#importText').focus();
  }
  function importDialogText(text) {
    const r = Share.read(text);
    const err = $('#importDlgError');
    if (!r || r.error) {
      err.textContent = r ? r.error : 'That is not a Maki link, game file, position or move list.';
      err.hidden = false;
      return;
    }
    $('#dlgImport').close();
    openImported(r);
  }
  $('#importGo').onclick = () => importDialogText($('#importText').value);
  $('#importPasteBtn').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('#importText').value = text;
      importDialogText(text);
    } catch {
      $('#importDlgError').textContent = 'The browser would not read the clipboard: paste into the box instead.';
      $('#importDlgError').hidden = false;
    }
  };
  $('#importFileBtn').onclick = () => $('#importFile').click();
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await readFile(f);
      if ($('#dlgImport').open) {
        $('#importText').value = text;
        importDialogText(text);
      } else {
        const r = Share.read(text);
        if (!r) toast('That file holds no Maki game or position.');
        else openImported(location.hash === '#/review' ? asReview(r) : r);
      }
    } catch (err) {
      toast(err.message);
    }
  });

  // Paste anywhere that is not a text box imports straight away.
  document.addEventListener('paste', e => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('dialog[open]')) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    const r = text && Share.read(text);
    if (!r) return;
    e.preventDefault();
    openImported(r);
  });

  // Drop a game file, a link or a position anywhere on the page.
  let dragDepth = 0;
  const draggable = e => {
    const t = e.dataTransfer && Array.from(e.dataTransfer.types || []);
    return t && (t.includes('Files') || t.includes('text/plain') || t.includes('text/uri-list'));
  };
  document.addEventListener('dragenter', e => {
    if (!draggable(e) || document.querySelector('dialog[open]')) return;
    dragDepth++;
    document.body.classList.add('dropping');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dropping');
  });
  document.addEventListener('dragover', e => {
    if (draggable(e) && !document.querySelector('dialog[open]')) e.preventDefault();
  });
  document.addEventListener('drop', async e => {
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (!draggable(e) || document.querySelector('dialog[open]')) return;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) {
      // Dropped text imports only when it reads as a game or position, so text dragged about
      // the page by accident does nothing.
      const r = Share.read(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
      if (!r) return;
      e.preventDefault();
      openImported(r);
      return;
    }
    e.preventDefault();
    try {
      importText(await readFile(f));
    } catch (err) {
      toast(err.message);
    }
  });

  // --- dialogs ----------------------------------------------------------------------------

  let pveFen = null; // a start position other than the usual one, from the analysis board
  function openPveDialog(fen = null) {
    const dlg = $('#dlgPve');
    pveFen = fen && fen !== START_FEN ? fen : null;
    $('#pveFenWrap').hidden = !pveFen;
    if (pveFen) {
      // Show the position, and offer the side to move: from a set-up position that is usually
      // the side you want to play.
      const pos = new Position(pveFen);
      $('#pveFenBoard').innerHTML = miniBoard(pos);
      $('#pveFenInfo').innerHTML = `<b>${colorName(pos.side)} to move.</b><br>White's reserve: ${esc(reserveText(pos, WHITE))}.<br>Black's reserve: ${esc(reserveText(pos, BLACK))}.`;
      $$('#pveFenSeg input').forEach(i => (i.checked = i.value === 'custom'));
      $$('#colorSeg input').forEach(i => (i.checked = i.value === colorKey(pos.side)));
    }
    renderPveFen();
    const range = $('#strengthRange');
    range.min = STRENGTH.min;
    range.max = STRENGTH.max;
    range.step = STRENGTH.step;
    let last = store.get('sk.elo', null);
    if (last === null) last = STRENGTH.legacy[store.get('sk.level', '')] ?? 1200;
    range.value = window.EngineTasks.clampElo(last);
    renderStrength();
    dlg.returnValue = '';
    dlg.showModal();
  }

  function renderPveFen() {
    const custom = !!pveFen && $('#pveFenSeg input:checked').value === 'custom';
    $('#pveFenPreview').hidden = !custom;
    $('#dlgPve h2').textContent = custom ? 'Play Stockhorse from this position' : 'Play Stockhorse';
  }
  $('#pveFenSeg').addEventListener('change', renderPveFen);

  function renderStrength() {
    const range = $('#strengthRange');
    const elo = +range.value;
    const band = bandFor(elo);
    $('#strengthElo').textContent = elo;
    $('#strengthName').textContent = band.name;
    $('#strengthBlurb').textContent = band.blurb;
    $('#strengthPiece').innerHTML = pieceSvg(band.piece, 'b');
    range.style.setProperty('--fill', `${(100 * (elo - range.min)) / (range.max - range.min)}%`);
    $('#strengthDown').disabled = elo <= +range.min;
    $('#strengthUp').disabled = elo >= +range.max;
  }

  $('#strengthRange').addEventListener('input', renderStrength);
  for (const [id, dir] of [['#strengthDown', -1], ['#strengthUp', 1]]) {
    $(id).addEventListener('click', e => {
      e.preventDefault();
      const range = $('#strengthRange');
      range.value = window.EngineTasks.clampElo(+range.value + dir * STRENGTH.step);
      renderStrength();
    });
  }

  $('#dlgPve').addEventListener('close', () => {
    const dlg = $('#dlgPve');
    if (dlg.returnValue !== 'ok') return;
    const elo = window.EngineTasks.clampElo(+$('#strengthRange').value);
    const color = dlg.querySelector('input[name=color]:checked').value;
    store.set('sk.elo', elo);
    location.hash = '#/play';
    const custom = !!pveFen && $('#pveFenSeg input:checked').value === 'custom';
    play.start({ mode: 'pve', elo, color, fen: custom ? pveFen : null });
  });

  // The online dialog's start position: null for the usual one, or a FEN.
  let onlineFen = null;

  function miniBoard(pos) {
    const cells = [];
    for (let rank = 5; rank >= 0; rank--) {
      for (let file = 0; file < 6; file++) {
        const code = pos.board[rank * 6 + file];
        cells.push(`<div class="${(file + rank) % 2 ? 'light' : 'dark'}">${code ? pieceSvg(LETTERS[code & 7], code >> 3 ? 'b' : 'w') : ''}</div>`);
      }
    }
    return cells.join('');
  }

  function reserveText(pos, c) {
    const parts = DROP_ORDER.filter(t => pos.hand[c][t]).map(t => {
      const n = pos.hand[c][t], name = window.Pieces.NAMES[LETTERS[t]];
      return `${n} ${name}${n > 1 ? 's' : ''}`;
    });
    return parts.length ? parts.join(', ') : 'nothing';
  }

  // Shows the start-position part of the online dialog. A custom FEN is checked the way the
  // server checks it; an unusable one keeps the invite button off.
  function renderOnlineFen() {
    const custom = $('#ofenSeg input:checked').value === 'custom';
    $('#ofenWrap').hidden = !custom;
    const f = (backend && backend.features) || {};
    $('#quickWrap').hidden = !f.quick || custom;
    const invite = $('#dlgOnline button[value=ok]');
    if (!custom) {
      invite.disabled = false;
      invite.textContent = 'Make an invite link';
      return;
    }
    invite.textContent = 'Make an invite link from this position';
    const text = $('#ofenInput').value.trim();
    const fen = text ? window.Online.cleanFen(text) : null;
    let error = '';
    if (!text) error = 'Paste a position, or set one up on the board.';
    else if (!fen) {
      try {
        const st = new Position(text).status();
        error = st.state === 'ongoing' ? 'That position cannot start a game.' : `That game is already over (${st.reason}).`;
      } catch (err) {
        error = `Not a valid position: ${err.message.replace(/: [^:]*$/, '').replace(/^bad FEN:? ?/, '')}.`;
      }
    }
    $('#ofenError').hidden = !error;
    $('#ofenError').textContent = error;
    invite.disabled = !!error;
    if (fen) {
      const pos = new Position(fen);
      onlineFen = fen === START_FEN ? null : fen;
      $('#ofenBoard').innerHTML = miniBoard(pos);
      $('#ofenInfo').innerHTML = `<b>${colorName(pos.side)} to move.</b><br>White's reserve: ${esc(reserveText(pos, WHITE))}.<br>Black's reserve: ${esc(reserveText(pos, BLACK))}.`;
    } else {
      onlineFen = null;
      $('#ofenBoard').innerHTML = '';
      $('#ofenInfo').textContent = '';
    }
  }

  $('#ofenSeg').addEventListener('change', renderOnlineFen);
  $('#ofenInput').addEventListener('input', renderOnlineFen);
  // Set up the position on the analysis board's editor; its Done button brings the dialog back
  // with that position, and Cancel brings it back as it was.
  $('#ofenSetup').addEventListener('click', () => {
    $('#dlgOnline').close('setup');
    const typed = $('#ofenInput').value.trim();
    location.hash = '#/analysis';
    route();
    if (typed && window.Online.cleanFen(typed)) analysis.load(typed);
    analysis.openEditor(fen => openOnlineDialog(fen || typed || null, { custom: true }));
    toast('Set up the position, then press Use this position');
  });

  // Enter in a text box of the online dialog would press its first button, Quick pairing, and
  // start a game from the usual position. Enter does what the box is for instead.
  $('#dlgOnline').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'radio') return;
    e.preventDefault();
    const dlg = $('#dlgOnline');
    if (e.target.id === 'joinCode') {
      if ($('#joinCode').value.trim()) dlg.close('code');
    } else if (e.target.id === 'ofenInput') {
      if (!$('#dlgOnline button[value=ok]').disabled) dlg.close('ok');
    }
  });

  let openGamesUnsub = null;
  // `fen`: the position to offer, or null for the usual start. With `custom` the dialog opens on
  // "From a position" even without one (the FEN box is then left as it was).
  function openOnlineDialog(fen = null, { custom = false } = {}) {
    const dlg = $('#dlgOnline');
    dlg.returnValue = '';
    const fromPos = !!(fen && fen !== START_FEN);
    if (fromPos) $('#ofenInput').value = fen;
    $$('#ofenSeg input').forEach(i => (i.checked = i.value === (fromPos || custom ? 'custom' : 'std')));
    dlg.querySelector('h2').textContent = fromPos ? 'Play online from this position' : 'Play online';
    $('#joinCode').value = '';
    $('#onlineName').value = store.get('sk.name', '');
    const f = (backend && backend.features) || {};
    $('#tcWrap').hidden = !f.clocks;
    renderOnlineFen();
    const lastTc = store.get('sk.tc', '300+0');
    const tcInput = $$('#tcSeg input').find(i => i.value === lastTc);
    if (tcInput) tcInput.checked = true;
    $('#openGamesWrap').hidden = !f.lobby;
    $('#liveGamesWrap').hidden = true;
    if (f.lobby && !openGamesUnsub) {
      openGamesUnsub = backend.lobby(({ open, live }) => {
        const by = r => (r.name ? ` · ${esc(r.name)}` : '');
        const tc = r => (backend.features.clocks ? ` · ${esc(tcLabel(r.tc))}` : '') + (r.custom ? ' · set-up position' : '');
        $('#openGames').innerHTML = open.length
          ? open.map(r => `<li><button type="button" class="btn" data-join="${esc(r.id)}">${r.mine ? 'Back to your game' : `Play as ${r.open === 'w' ? 'White' : 'Black'}`}
              <span class="muted">${tc(r)}${by(r)} · ${esc(r.id)}</span></button></li>`).join('')
          : '<li class="muted">No open challenges right now. Use Quick pairing and others will see yours here.</li>';
        $('#liveGamesWrap').hidden = !live.length;
        $('#liveGames').innerHTML = live.map(r => {
          const names = `${esc((r.names && r.names.w) || 'White')} vs ${esc((r.names && r.names.b) || 'Black')}`;
          return `<li><button type="button" class="btn" data-join="${esc(r.id)}">${r.mine ? 'Back to your game: ' : ''}${names}
            <span class="muted">${tc(r)} · move ${Math.ceil((r.moves + 1) / 2)}${r.watchers ? ` · ${r.watchers} watching` : ''}</span></button></li>`;
        }).join('');
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
    store.set('sk.name', $('#onlineName').value.trim().slice(0, 24));
    const tcEl = $('#tcSeg input[name=tc]:checked');
    if (tcEl) store.set('sk.tc', tcEl.value);
    if (dlg.returnValue === 'code') {
      const code = $('#joinCode').value.trim().toLowerCase();
      if (/^[a-z0-9]{4,12}$/.test(code)) location.hash = `#/online/${code}`;
      else if (code) toast('That code does not look right');
      return;
    }
    if (dlg.returnValue === 'quick') return play.quickPair();
    if (dlg.returnValue !== 'ok') return;
    const custom = $('#ofenSeg input:checked').value === 'custom';
    play.createRoom(dlg.querySelector('input[name=ocolor]:checked').value, custom ? onlineFen : null);
  });

  $('#onlineActions').addEventListener('click', e => {
    const b = e.target.closest('[data-oa]');
    if (!b) return;
    const a = b.dataset.oa;
    if (a === 'offer' || a === 'accept' || a === 'decline') play.onlineAction('draw', a);
    else if (a === 'claim') play.onlineAction('claim');
    else if (a === 'rematch') play.onlineAction('rematch');
    else if (a === 'next' && play.online && play.online.st.next) location.hash = `#/online/${play.online.st.next}`;
  });

  // --- routing ----------------------------------------------------------------------------

  function showView(name) {
    for (const v of ['home', 'play', 'review', 'analysis', 'rules', 'learn', 'train']) $(`#view-${v}`).hidden = v !== name;
    if (name !== 'analysis' && analysis.active) analysis.hide();
    if (name !== 'review' && review.active) review.hide();
    if (name !== 'train' && window.Train) window.Train.hide();
    const coached = name === 'play' && play.game && play.game.coach;
    const nav = coached ? 'learn' : name === 'play' ? 'home' : name;
    $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
  }

  function route() {
    const h = location.hash || '#/';
    // A shared link: open what it holds, then drop it from the address bar so a reload or
    // the back button does not import it again over later work.
    const shared = /^#\/(analysis|review)\?/.exec(h);
    if (shared) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/${shared[1]}`);
      const r = Share.read(h);
      if (!r || r.error) toast(r ? r.error : 'That link does not read right.');
      else openImported(r, { quiet: true });
      return route();
    }
    const online = /^#\/online\/([a-z0-9]+)$/.exec(h);
    if (online) {
      showView('play');
      play.joinRoom(online[1]);
      return;
    }
    if (h !== '#/play' && play.online) play.leaveOnline();
    if (h === '#/play') {
      if (!play.game) play.start({ mode: 'local' });
      else if (play.game.coach) {
        // Learn by playing lives at #/learn; a plain #/play starts nothing new.
        history.replaceState(null, '', `${location.pathname}${location.search}#/learn`);
      }
      showView('play');
    } else if (h === '#/review') {
      showView('review');
      review.show();
    } else if (h === '#/analysis') {
      showView('analysis');
      analysis.show();
    } else if (h === '#/rules') {
      showView('rules');
    } else if (h === '#/learn') {
      // Learn by playing: carry on with an unfinished coached game, or start one.
      store.set('sk.learnTip', 'seen');
      if (!(play.game && play.game.coach && !play.game.result)) play.startCoached();
      showView('play');
    } else if (/^#\/learn\/[a-z0-9-]+$/.test(h)) {
      showView('learn');
      store.set('sk.learnTip', 'seen');
      const id = h.split('/')[2];
      window.Tutorial.show(id === 'lessons' ? undefined : id);
    } else if (/^#\/train(\/|$)/.test(h)) {
      showView('train');
      window.Train.show(h);
    } else {
      showView('home');
      renderRecent();
      renderLearnTip();
    }
    window.scrollTo(0, 0);
  }

  // A first-time visitor sees "New? Start here" on the Learn card. It goes away for good once
  // they open Learn or have a saved game.
  function renderLearnTip() {
    let learnt = false;
    try {
      const v = JSON.parse(localStorage.getItem('sk.learn') || 'null');
      learnt = !!(v && v.done && Object.keys(v.done).length);
    } catch {
      /* no storage: treat it as a first visit */
    }
    const fresh = !store.get('sk.learnTip', null) && !learnt && savedGames().length === 0;
    $('#learnNew').hidden = !fresh;
    $('#learnCard').classList.toggle('fresh', fresh);
  }

  // --- decoration -------------------------------------------------------------------------

  // The hero: a real Maki combination, played on a loop. White, with a bishop in reserve:
  //   rkp3/pp1PR1/r5/4KP/1q2P1/P5[B] w 0 25
  // 1. B@c5+!!  The hand drops the bishop with check. The only reply is
  // 1… c6xc5    the pawn takes it, which opens the sixth rank and plugs c5 with Black's own pawn.
  // 2. Re6#     Checkmate. (Stockhorse finds it as mate in 2; web/test-coach.js checks the line.)
  // The motion is driven from JavaScript (heroPlay below) by setting SVG transform and opacity
  // attributes on plain <g> groups, so it looks the same in every browser (CSS transforms on
  // nested <svg> elements do nothing in Safari). With reduced motion the final position shows.
  const HERO = { fen: 'rkp3/pp1PR1/r5/4KP/1q2P1/P5[B] w 0 25', line: ['B@c5', 'c6c5', 'e5e6'] };
  function heroArt() {
    const piece = (letter, color, col, row) =>
      `<svg class="piece ${color === 'w' ? 'pw' : 'pb'}" x="${col * 10 + 0.6}" y="${row * 10 + 0.6}" width="8.8" height="8.8" viewBox="0 0 100 100">${window.Pieces.shapes[letter]}</svg>`;
    const pos = new Position(HERO.fen);
    const cells = [], men = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 6; col++) {
        const sq = (5 - row) * 6 + col;
        cells.push(`<rect x="${col * 10}" y="${row * 10}" width="10" height="10" fill="var(--${(col + row) % 2 ? 'sq-dark' : 'sq-light'})"/>`);
        const code = pos.board[sq];
        if (!code) continue;
        const name = SK.sqName(sq);
        // The two pieces that move sit in their own group, so the animation can slide them.
        const svg = piece(LETTERS[code & 7], code >> 3 ? 'b' : 'w', col, row);
        const track = name === 'c6' ? 'pawn' : name === 'e5' ? 'rook' : '';
        men.push(track ? `<g data-ha="${track}">${svg}</g>` : svg);
      }
    }
    // A white glove that pinches at (0, 0), its wrist up and to the right.
    const hand = `<g data-ha="hand"><g transform="rotate(-24) scale(0.85)">
        <path class="ha-glove" d="M-3.2 -11.5 C-5.8 -9.6 -6.4 -6 -5 -3.2 C-4.4 -1.9 -3 -1.6 -2.6 -3 L-3 -6.2 Z"/>
        <rect class="ha-cuff" x="-4.6" y="-27" width="10.5" height="6" rx="1.6"/>
        <path class="ha-glove" d="M-4 -21.5 C-6.5 -17 -6.8 -13 -5.6 -10.2 L-4.6 -6.4 C-4.3 -4.6 -2.6 -4.4 -2.1 -6 L-2.3 -8.6 L-1.6 -1.2 C-1.4 0.6 1.4 0.6 1.6 -1.2 L1.8 -9.4 C3.6 -9.2 5.2 -10.6 5.8 -12.6 C6.8 -15.8 6.4 -19 5.4 -21.5 Z"/>
        <path class="ha-crease" d="M1.8 -9.4 C2.6 -11 3.8 -12 5.6 -12.4 M2.4 -13.6 C3.6 -14.6 4.8 -15 6.1 -15.2"/>
      </g></g>`;
    return `<svg viewBox="-2 -9 64 88" role="img" aria-label="A Maki checkmate: White drops a bishop on c5 with check, the pawn takes it, and the rook mates on e6.">
      <rect x="-1" y="-1" width="62" height="62" rx="3" fill="var(--surface)" stroke="var(--line)" stroke-width="0.5"/>
      <g>${cells.join('')}</g>
      <g data-ha="land"><rect class="ha-land" x="20" y="10" width="10" height="10"/></g>
      <g data-ha="ripple"><circle class="ha-ripple" cx="25" cy="15" r="4"/></g>
      <g data-ha="check"><circle class="ha-check" cx="15" cy="5" r="5.4"/></g>
      ${men.join('')}
      <g data-ha="line"><path class="ha-line" d="M41 5 H21"/></g>
      <rect class="ha-tray" x="12" y="63.5" width="31.5" height="13" rx="3"/>
      <text class="ha-tray-label" x="14.5" y="71">Reserve</text>
      <g data-ha="slot"><rect class="ha-slot" x="32.5" y="65" width="10" height="10" rx="2"/></g>
      <g data-ha="bishop">${piece('B', 'w', 3.25, 6.5)}</g>
      <g data-ha="brill" class="ha-brill"><circle cx="29.4" cy="10.4" r="3.8"/><text x="29.4" y="12">!!</text></g>
      ${hand}
      <g data-ha="cap1" class="ha-cap ha-cap1"><rect x="7" y="-8.6" width="46" height="6.6" rx="3.3"/><text x="30" y="-4.1">!!  Brilliant drop: B@c5+</text></g>
      <g data-ha="cap2" class="ha-cap ha-cap2"><rect x="13" y="-8.6" width="34" height="6.6" rx="3.3"/><text x="30" y="-4.1">1… c6×c5, forced</text></g>
      <g data-ha="cap3" class="ha-cap ha-cap3"><rect x="1" y="-8.6" width="58" height="6.6" rx="3.3"/><text x="30" y="-4.1"><tspan class="ha-bang">B@c5!!</tspan> c6×c5 Re6#  Checkmate</text></g>
    </svg>`;
  }

  // The hero's timeline: for each group, keyframes [time 0..1 of a 12 s loop, { x, y, s, o }]
  // (translate, scale about the group's centre `c`, opacity). Values a keyframe leaves out
  // carry over from the one before it.
  const HERO_LOOP = 12000;
  const HERO_TRACKS = {
    hand: { k: [[0, { x: 78, y: 30, o: 0 }], [0.06, { o: 1 }], [0.14, { x: 37.5, y: 65.6 }], [0.18, { y: 66.6 }], [0.3, { x: 27, y: -1 }], [0.36, { x: 25, y: 10.6 }], [0.39, {}], [0.48, { x: 72, y: -14, o: 0 }]] },
    bishop: { c: [37.5, 74.4], k: [[0, { x: 0, y: 0, s: 1, o: 1 }], [0.18, {}], [0.3, { x: -10.5, y: -66.6, s: 1.12 }], [0.36, { x: -12.5, y: -55, s: 1 }], [0.38, { s: 0.9 }], [0.41, { s: 1 }], [0.53, {}], [0.57, { s: 0.6, o: 0 }], [0.95, {}], [0.96, { x: 0, y: 0, s: 1 }], [1, { o: 1 }]] },
    slot: { k: [[0, { o: 1 }], [0.16, {}], [0.22, { o: 0.3 }], [0.94, {}], [1, { o: 1 }]] },
    land: { k: [[0, { o: 0 }], [0.37, {}], [0.41, { o: 1 }], [0.52, {}], [0.57, { o: 0 }]] },
    ripple: { c: [25, 15], k: [[0, { s: 0.6, o: 0 }], [0.37, {}], [0.38, { s: 0.8, o: 0.9 }], [0.46, { s: 2.4, o: 0 }]] },
    brill: { c: [29.4, 10.4], k: [[0, { s: 0, o: 0 }], [0.38, {}], [0.41, { s: 1.35, o: 1 }], [0.44, { s: 1 }], [0.54, {}], [0.57, { o: 0 }]] },
    check: { k: [[0, { o: 0 }], [0.38, {}], [0.41, { o: 1 }], [0.52, {}], [0.56, { o: 0 }], [0.66, {}], [0.71, { o: 1 }], [0.92, {}], [0.97, { o: 0 }]] },
    pawn: { k: [[0, { y: 0 }], [0.52, {}], [0.57, { y: 10 }], [0.94, {}], [0.99, { y: 0 }]] },
    rook: { k: [[0, { y: 0 }], [0.64, {}], [0.7, { y: -10 }], [0.94, {}], [0.99, { y: 0 }]] },
    line: { k: [[0, { o: 0 }], [0.69, {}], [0.73, { o: 1 }], [0.92, {}], [0.97, { o: 0 }]] },
    cap1: { k: [[0, { o: 0 }], [0.38, {}], [0.41, { o: 1 }], [0.54, {}], [0.56, { o: 0 }]] },
    cap2: { k: [[0, { o: 0 }], [0.55, {}], [0.57, { o: 1 }], [0.65, {}], [0.67, { o: 0 }]] },
    cap3: { k: [[0, { o: 0 }], [0.67, {}], [0.71, { o: 1 }], [0.94, {}], [0.97, { o: 0 }]] },
  };
  // Fill in every value at every keyframe, carrying the last one forward.
  for (const t of Object.values(HERO_TRACKS)) {
    let last = { x: 0, y: 0, s: 1, o: 1 };
    t.k = t.k.map(([at, v]) => [at, (last = { ...last, ...v })]);
  }
  const smooth = u => u * u * (3 - 2 * u);
  function heroState(track, f) {
    const k = track.k;
    if (f <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (f <= k[i][0]) {
        const [a, va] = k[i - 1], [b, vb] = k[i];
        const u = smooth((f - a) / (b - a || 1));
        const out = {};
        for (const p in vb) out[p] = va[p] + (vb[p] - va[p]) * u;
        return out;
      }
    }
    return k[k.length - 1][1];
  }
  // Draws the hero at `f` (0..1 through the loop).
  function heroFrame(svg, f) {
    for (const el of svg.querySelectorAll('[data-ha]')) {
      const track = HERO_TRACKS[el.dataset.ha];
      const v = heroState(track, f);
      let tr = `translate(${v.x.toFixed(2)} ${v.y.toFixed(2)})`;
      if (track.c && v.s !== 1) {
        const [cx, cy] = track.c;
        tr += ` translate(${cx} ${cy}) scale(${v.s.toFixed(3)}) translate(${-cx} ${-cy})`;
      }
      el.setAttribute('transform', tr);
      el.setAttribute('opacity', v.o.toFixed(3));
    }
  }
  // Plays the hero while the home page shows; with reduced motion it shows the mate.
  function heroPlay() {
    const svg = $('#heroArt svg');
    const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) return heroFrame(svg, 0.85);
    const start = performance.now();
    window.MakiHero = { frame: f => heroFrame(svg, f), paused: false }; // for screenshots and tests
    const tick = now => {
      if (!window.MakiHero.paused && !$('#view-home').hidden && !document.hidden) heroFrame(svg, ((now - start) % HERO_LOOP) / HERO_LOOP);
      requestAnimationFrame(tick);
    };
    heroFrame(svg, 0);
    requestAnimationFrame(tick);
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
    heroPlay();
    $$('.mode-icon').forEach(el => (el.innerHTML = pieceSvg(el.dataset.piece, 'w')));
    $$('#colorSeg i[data-piece]').forEach(el => (el.innerHTML = pieceSvg(el.dataset.piece, el.dataset.color)));

    play.init();
    review.init();
    analysis.init();
    window.Tutorial.init({
      BoardView,
      pieceSvg,
      toast,
      openPve: () => openPveDialog(),
      playLocal: () => {
        location.hash = '#/play';
        play.start({ mode: 'local' });
      },
    });
    window.Train.init({
      $, $$, esc, pieceSvg, store, toast, BoardView,
      openAnalysis(fen, moves, at) {
        analysis.load(fen, moves, at);
        location.hash = '#/analysis';
      },
      openPve: fen => openPveDialog(fen),
    });

    $$('.mode-card').forEach(card => {
      card.onclick = () => {
        const m = card.dataset.mode;
        if (m === 'pve') openPveDialog();
        else if (m === 'local') {
          location.hash = '#/play';
          play.start({ mode: 'local' });
        } else if (m === 'online') openOnlineDialog();
        else if (m === 'review') location.hash = '#/review';
        else if (m === 'analysis') location.hash = '#/analysis';
        else if (m === 'train') location.hash = '#/train';
        else if (m === 'learn') location.hash = '#/learn';
      };
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-game]');
      if (b) openSaved(b.dataset.game);
    });

    // Online play needs web/server.js, or the shared database of a claude.ai Artifact.
    window.addEventListener('hashchange', route);
    renderRecent();

    // Shared to the installed app from another app (the manifest's share_target): the text,
    // link and title arrive as query parameters. Import what they hold and tidy the address.
    const q = new URLSearchParams(location.search);
    if (q.has('text') || q.has('url') || q.has('title')) {
      const incoming = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean);
      history.replaceState(null, '', `${location.pathname}${location.hash || '#/'}`);
      const r = incoming.map(t => Share.read(t)).find(x => x) || null;
      if (r) setTimeout(() => openImported(r), 0);
      else toast('Nothing to import in what was shared.');
    }
    // A game file opened with the installed app (the manifest's file_handlers).
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async params => {
        for (const h of params.files || []) {
          try {
            importText(await readFile(await h.getFile()));
          } catch (err) {
            toast(err.message);
          }
          break;
        }
      });
    }
    const pendingOnline = /^#\/online\//.test(location.hash);
    if (!pendingOnline) route();
    window.Online.detect(store).then(b => {
      backend = b;
      if (!b) {
        $('#onlineCard').disabled = true;
        setTimeout(() => ($('#onlineCard').title = $('#onlineSub').textContent), 0);
        $('#onlineSub').textContent = window.claude
          ? 'Sign in to claude.ai, and ask the owner for access that lets you interact with this page.'
          : (window.MAKI_CONFIG && window.MAKI_CONFIG.server)
            ? 'The game server is not answering. It may be waking up: try again in a minute.'
            : 'Needs the Maki server: run node web/server.js and open the page it prints.';
      } else if (b.kind === 'db') {
        $('#onlineSub').textContent = 'Make a game, and your friend joins it from this same page. Draw offers and rematches; no clocks here.';
      }
      if (pendingOnline) route();
    });
  }

  boot();
})();
