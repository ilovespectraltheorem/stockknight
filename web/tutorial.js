'use strict';
// The Learn section: interactive lessons for complete beginners (lessons in web/lessons.js).
// The rules come from the reference engine, so a lesson plays exactly the game the site plays.
// In Node this file exports only the exercise logic, which web/test-tutorial.js checks.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const { Position, WHITE, BLACK, KING, moveFrom, moveTo, moveDrop, parseSq, sqName } = SK;
  const LETTERS = '.PNBRQK';

  // --- exercise logic ------------------------------------------------------------------------

  const ONE_MOVE = new Set(['check', 'mate', 'stalemate', 'escape', 'attack', 'moves']);

  // The squares still to visit in a stars or capture exercise.
  function initialStars(step, pos) {
    const t = step.task;
    if (!t) return null;
    if (t.type === 'stars') return new Set(t.targets.map(parseSq));
    if (t.type === 'capture') {
      const out = new Set();
      for (let sq = 0; sq < 36; sq++) {
        const code = pos.board[sq];
        if (code && code >> 3 !== pos.side && (code & 7) !== KING) out.add(sq);
      }
      return out;
    }
    return null;
  }

  // Whether `m`, just made on `pos`, solves a one-move exercise.
  function solves(task, pos, m, uci) {
    const mover = pos.side ^ 1;
    switch (task.type) {
      case 'check':
        return pos.inCheck();
      case 'mate': {
        const st = pos.status();
        return st.state === 'win' && st.reason === 'checkmate';
      }
      case 'stalemate': {
        const st = pos.status();
        return st.state === 'win' && st.reason === 'stalemate';
      }
      case 'escape': {
        const entry = pos.undo[pos.undo.length - 1];
        const king = !moveDrop(m) && (pos.board[moveTo(m)] & 7) === KING;
        if (task.how === 'move') return king;
        if (task.how === 'capture') return !!entry.captured;
        return !king && !entry.captured; // block
      }
      case 'attack': {
        if (task.drop && moveDrop(m) !== LETTERS.indexOf(task.drop)) return false;
        return [task.target, task.also].filter(Boolean).every(s => {
          const sq = parseSq(s);
          return pos.board[sq] && pos.isAttacked(sq, mover);
        });
      }
      case 'moves':
        return task.moves.includes(uci);
      default:
        return false;
    }
  }

  // Every legal move that solves a one-move exercise, in UCI.
  function solutions(step) {
    const pos = new Position(step.fen);
    const out = [];
    for (const m of pos.legalMoves()) {
      const uci = pos.moveToUci(m);
      pos.makeMove(m);
      if (solves(step.task, pos, m, uci)) out.push(uci);
      pos.unmakeMove();
    }
    return out;
  }

  // An exercise in progress: the position, the stars left and how many moves were made.
  class Exercise {
    constructor(step) {
      this.step = step;
      this.task = step.task || null;
      this.pos = new Position(step.fen);
      this.stars = initialStars(step, this.pos);
      this.moves = 0;
      this.solved = false;
      this.last = 0;
    }

    get oneMove() {
      return !!this.task && ONE_MOVE.has(this.task.type);
    }

    // Plays a move; returns 'illegal', 'star', 'moved', 'solved' or 'wrong'. After 'wrong',
    // call takeBack() to restore the position.
    play(uci) {
      const pos = this.pos;
      const m = pos.moveFromUci(uci);
      if (!m || this.solved) return 'illegal';
      pos.makeMove(m);
      this.moves++;
      this.last = m;
      if (!this.task) return 'moved';
      if (this.stars) {
        const hit = this.stars.delete(moveTo(m));
        if (!this.stars.size) {
          this.solved = true;
          return 'solved';
        }
        // The opponent passes: the learner keeps the move. (Black's king may be left
        // attacked; nothing here asks it to move.)
        pos.side ^= 1;
        return hit ? 'star' : 'moved';
      }
      if (solves(this.task, pos, m, uci)) {
        this.solved = true;
        return 'solved';
      }
      return 'wrong';
    }

    takeBack() {
      this.pos.unmakeMove();
      this.last = 0;
    }
  }

  const logic = { Exercise, solutions, solves, initialStars };
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = logic;
    return;
  }

  // --- the page ------------------------------------------------------------------------------

  const { CHAPTERS, LESSONS } = root.TutorialLessons;
  const $ = sel => document.querySelector(sel);
  const STORE_KEY = 'sk.learn';

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') return { done: v.done || {}, at: v.at || {} };
    } catch {
      /* fall through */
    }
    return { done: {}, at: {} };
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(progress));
    } catch {
      /* storage unavailable: progress is forgotten on reload */
    }
  }

  let deps = null; // from app.js: BoardView, pieceSvg, toast, openPve, playLocal
  let board = null;
  let progress = load();
  let lesson = null;
  let stepIndex = 0;
  let ex = null;
  let busy = 0; // timer while a wrong move is shown
  let hintArrows = [];

  const lessonById = id => LESSONS.find(l => l.id === id);
  const lessonIndex = l => LESSONS.indexOf(l);

  // The board, plus stars, tinted squares and move dots.
  function makeBoard(BoardView) {
    return class TutorialBoard extends BoardView {
      render() {
        super.render();
        if (!ex) return;
        const step = ex.step;
        const marks = step.marks || {};
        for (const [name, kind] of Object.entries(marks)) {
          const el = this.el.querySelector(`[data-sq="${parseSq(name)}"]`);
          if (el) el.classList.add(kind === 'x' ? 'tut-x' : 'tut-hl');
        }
        if (ex.stars && ex.task.type === 'stars') {
          for (const sq of ex.stars) {
            const el = this.el.querySelector(`[data-sq="${sq}"]`);
            if (el) el.insertAdjacentHTML('beforeend', '<span class="tut-star" aria-label="star"><svg viewBox="0 0 24 24"><path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z"/></svg></span>');
          }
        }
        if (ex.stars && ex.task.type === 'capture') {
          for (const sq of ex.stars) {
            const el = this.el.querySelector(`[data-sq="${sq}"]`);
            if (el) el.classList.add('tut-prey');
          }
        }
        if (step.show && ex.moves === 0) {
          const from = parseSq(step.show);
          for (const m of ex.pos.legalMoves()) {
            if (moveDrop(m) || moveFrom(m) !== from) continue;
            const el = this.el.querySelector(`[data-sq="${moveTo(m)}"]`);
            if (el && !el.querySelector('.dot')) el.insertAdjacentHTML('beforeend', '<span class="tut-dot"></span>');
          }
          const src = this.el.querySelector(`[data-sq="${from}"]`);
          if (src) src.classList.add('tut-src');
        }
      }
    };
  }

  function arrowsFor(list, color) {
    const out = [];
    for (const uci of list || []) {
      const drop = /^([PBR])@([a-f][1-6])$/.exec(uci);
      if (drop) out.push({ move: SK.encodeMove(0, parseSq(drop[2]), LETTERS.indexOf(drop[1])), color });
      else out.push({ move: SK.encodeMove(parseSq(uci.slice(0, 2)), parseSq(uci.slice(2, 4))), color });
    }
    return out;
  }

  // --- lesson list --------------------------------------------------------------------------

  function renderIndex() {
    $('#learnIndex').hidden = false;
    $('#learnLesson').hidden = true;
    const total = LESSONS.length;
    const done = LESSONS.filter(l => progress.done[l.id]).length;
    const next = LESSONS.find(l => !progress.done[l.id]);
    $('#learnProgress').innerHTML = `<div class="learn-meter"><div style="width:${(100 * done) / total}%"></div></div>
      <span>${done} of ${total} lessons done</span>
      ${next ? `<a class="btn primary" href="#/learn/${next.id}">${done ? 'Continue' : 'Start the first lesson'}: ${next.title}</a>` : '<span class="learn-all">All done. Time to play!</span>'}`;
    $('#learnChapters').innerHTML = CHAPTERS.map((ch, ci) => {
      const items = LESSONS.filter(l => l.chapter === ch.id).map(l => {
        const n = lessonIndex(l) + 1;
        const tasks = l.steps.filter(s => s.task).length;
        return `<a class="lesson-card${progress.done[l.id] ? ' done' : ''}" href="#/learn/${l.id}">
          <span class="lesson-icon">${deps.pieceSvg(l.piece, 'w')}</span>
          <span class="lesson-body"><span class="lesson-title">${n}. ${l.title}</span>
          <span class="lesson-sub">${l.blurb}</span>
          <span class="lesson-meta">${l.steps.length} steps${tasks ? ` · ${tasks} exercise${tasks > 1 ? 's' : ''}` : ''}</span></span>
          <span class="lesson-check" aria-label="${progress.done[l.id] ? 'done' : 'not done'}">${progress.done[l.id] ? '✓' : ''}</span>
        </a>`;
      }).join('');
      return `<section class="learn-chapter"><h2><span>Part ${ci + 1}</span> ${ch.title}</h2><p class="muted">${ch.blurb}</p><div class="lesson-grid">${items}</div></section>`;
    }).join('');
  }

  // --- a lesson -----------------------------------------------------------------------------

  function openLesson(id) {
    const l = lessonById(id);
    if (!l) {
      location.hash = '#/learn/lessons';
      return;
    }
    $('#learnIndex').hidden = true;
    $('#learnLesson').hidden = false;
    if (lesson !== l) {
      lesson = l;
      const at = progress.at[l.id] | 0;
      stepIndex = at < l.steps.length ? at : 0;
    }
    loadStep();
  }

  function loadStep() {
    clearTimeout(busy);
    busy = 0;
    hintArrows = [];
    const step = lesson.steps[stepIndex];
    ex = new Exercise(step);
    progress.at[lesson.id] = stepIndex;
    save();
    board.selected = null;
    syncBoard();
    renderPanel();
    feedback(step.task ? '' : null);
  }

  function syncBoard() {
    const step = ex.step;
    board.pos = ex.pos;
    board.flipped = false;
    board.lastMove = ex.last;
    board.movable = step.task && !ex.solved && !busy ? WHITE : null;
    board.arrows = [...arrowsFor(ex.moves ? [] : step.arrows, 'rgb(214 140 30)'), ...hintArrows];
    board.selected = null;
    board.render();
    renderBars();
  }

  function renderBars() {
    const pos = ex.pos;
    const drops = new Set(board.legal.map(moveDrop).filter(Boolean));
    const bar = color => {
      const mine = board.movable === color && pos.side === color;
      const res = [SK.PAWN, SK.BISHOP, SK.ROOK].map(t => {
        const n = pos.hand[color][t];
        const usable = mine && drops.has(t);
        const name = root.Pieces.NAMES[LETTERS[t]];
        const sel = board.selected && board.selected.drop === t;
        const cls = ['res', n ? '' : 'empty', usable ? 'usable' : '', usable && sel ? 'sel' : ''].join(' ');
        return `<button class="${cls}" data-type="${t}" title="${n} ${name}${n === 1 ? '' : 's'} in reserve"${usable ? '' : ' tabindex="-1"'}>
          ${deps.pieceSvg(LETTERS[t], color === WHITE ? 'w' : 'b')}${n > 1 ? `<span class="count">${n}</span>` : ''}</button>`;
      }).join('');
      const label = color === WHITE ? 'White (you)' : 'Black';
      return `<div class="avatar">${deps.pieceSvg('K', color === WHITE ? 'w' : 'b')}</div>
        <div><div class="pname">${label}</div><div class="psub">Reserve</div></div>
        <div class="reserve">${res}</div>`;
    };
    $('#lBarTop').innerHTML = bar(BLACK);
    $('#lBarBottom').innerHTML = bar(WHITE);
  }

  function renderPanel() {
    const step = ex.step;
    const n = lesson.steps.length;
    const li = lessonIndex(lesson);
    const ch = CHAPTERS.find(c => c.id === lesson.chapter);
    $('#lHead').innerHTML = `<a href="#/learn/lessons" class="learn-back">← All lessons</a>
      <div class="learn-kicker">Part ${CHAPTERS.indexOf(ch) + 1} · ${ch.title}</div>
      <h2>${li + 1}. ${lesson.title}</h2>`;
    $('#lDots').innerHTML = lesson.steps.map((s, i) =>
      `<button class="tut-pip${i === stepIndex ? ' cur' : ''}${i < stepIndex ? ' past' : ''}${s.task ? ' task' : ''}" data-step="${i}" aria-label="Step ${i + 1}${s.task ? ', exercise' : ''}"></button>`).join('') +
      `<span class="tut-count">${stepIndex + 1} / ${n}</span>`;
    $('#lText').innerHTML = step.text;
    const goal = $('#lGoal');
    goal.hidden = !step.task;
    if (step.task) goal.innerHTML = `<b>Your move.</b> ${step.goal || ''}${ex.stars && !ex.solved && step.task.type === 'stars' && step.task.targets.length > 1 ? ` <span class="tut-left">${ex.stars.size} left</span>` : ''}`;
    const end = step.end;
    $('#lEnd').hidden = !end;
    $('#lHint').hidden = !step.task;
    $('#lRetry').hidden = !step.task;
    $('#lPrev').disabled = stepIndex === 0 && li === 0;
    const last = stepIndex === n - 1;
    const nextLesson = LESSONS[li + 1];
    const btn = $('#lNext');
    btn.disabled = !!step.task && !ex.solved;
    btn.textContent = last ? (nextLesson ? `Next lesson: ${nextLesson.title} →` : 'Back to all lessons') : 'Next →';
    $('#lSkip').hidden = !(step.task && !ex.solved);
  }

  function feedback(text, kind = '') {
    const el = $('#lFeedback');
    if (text == null || text === '') {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.className = `tut-feedback ${kind}`;
    el.innerHTML = text;
  }

  function onMove(uci) {
    if (!ex || busy) return;
    const step = ex.step;
    const r = ex.play(uci);
    if (r === 'illegal') return;
    hintArrows = [];
    if (r === 'solved') {
      syncBoard();
      renderPanel();
      const moves = ex.stars && step.task.type !== 'capture' ? ` <span class="muted">(${ex.moves} move${ex.moves === 1 ? '' : 's'})</span>` : '';
      feedback(`${step.success || 'Well done!'}${moves}`, 'ok');
      if (stepIndex === lesson.steps.length - 1) finishLesson();
      return;
    }
    if (r === 'wrong') {
      busy = setTimeout(() => {
        busy = 0;
        ex.takeBack();
        syncBoard();
      }, 1100);
      syncBoard();
      feedback(step.wrong || 'Not quite. Try again.', 'bad');
      return;
    }
    if (r === 'star') feedback(`Got one. ${ex.stars.size} to go.`, 'ok');
    else if (step.task && step.task.type === 'capture' && ex.stars) feedback(`${ex.stars.size} to go.`, 'ok');
    else feedback('');
    syncBoard();
    renderPanel();
  }

  function finishLesson() {
    if (!progress.done[lesson.id]) {
      progress.done[lesson.id] = true;
      save();
      deps.toast(`Lesson done: ${lesson.title}`);
    }
  }

  function next() {
    const n = lesson.steps.length;
    if (stepIndex < n - 1) {
      stepIndex++;
      if (stepIndex === n - 1 && !lesson.steps[stepIndex].task) finishLesson();
      loadStep();
      return;
    }
    finishLesson();
    progress.at[lesson.id] = 0;
    save();
    const li = lessonIndex(lesson);
    const nl = LESSONS[li + 1];
    lesson = null;
    location.hash = nl ? `#/learn/${nl.id}` : '#/learn/lessons';
  }

  function prev() {
    if (stepIndex > 0) {
      stepIndex--;
      loadStep();
      return;
    }
    const li = lessonIndex(lesson);
    if (li > 0) {
      const pl = LESSONS[li - 1];
      progress.at[pl.id] = pl.steps.length - 1;
      save();
      location.hash = `#/learn/${pl.id}`;
    }
  }

  function hint() {
    const step = ex.step;
    if (!step.task || ex.solved) return;
    let text = step.hint || 'Look at every move your pieces can make.';
    if (ex.oneMove && !busy) {
      const sol = solutions({ fen: ex.pos.fen(), task: step.task });
      if (sol.length) hintArrows = arrowsFor([sol[0]], 'rgb(46 140 90)');
      text += sol.length ? ' <span class="muted">The arrow shows one answer.</span>' : '';
      syncBoard();
    }
    feedback(`<b>Hint:</b> ${text}`, 'hint');
  }

  function init(d) {
    deps = d;
    const TB = makeBoard(d.BoardView);
    board = new TB($('#lBoard'), { onMove });
    board.onSelect = () => renderBars();
    for (const id of ['#lBarTop', '#lBarBottom']) {
      $(id).addEventListener('click', e => {
        const b = e.target.closest('.res.usable');
        if (b) board.selectDrop(+b.dataset.type);
      });
    }
    $('#lNext').onclick = next;
    $('#lPrev').onclick = prev;
    $('#lRetry').onclick = loadStep;
    $('#lHint').onclick = hint;
    $('#lSkip').onclick = () => {
      if (stepIndex < lesson.steps.length - 1) {
        stepIndex++;
        loadStep();
      } else next();
    };
    $('#lDots').addEventListener('click', e => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      stepIndex = +b.dataset.step;
      loadStep();
    });
    $('#lPlayBot').onclick = () => d.openPve();
    $('#lPlayLocal').onclick = () => d.playLocal();
    document.addEventListener('keydown', e => {
      if ($('#view-learn').hidden || $('#learnLesson').hidden || e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowRight' && !$('#lNext').disabled) next();
      else if (e.key === 'ArrowLeft' && !$('#lPrev').disabled) prev();
    });
  }

  // `id`: a lesson id, or nothing for the list of lessons.
  function show(id) {
    if (!deps) return;
    if (id) openLesson(id);
    else {
      lesson = null;
      ex = null;
      renderIndex();
    }
  }

  root.Tutorial = { init, show, ...logic };
})(globalThis);
