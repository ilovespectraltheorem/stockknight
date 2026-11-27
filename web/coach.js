'use strict';
// Learn by playing: a real game against a gentle Stockhorse, with a coach that explains each rule
// the first time it matters (picking up a piece, a capture, a drop, a pawn crossing into the
// enemy half, check, the end of the game). The step-by-step lessons (web/lessons.js) are still
// there for anyone who wants drills.
// In Node this file exports only the logic, which web/test-coach.js checks.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const { WHITE, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, moveDrop, moveTo } = SK;
  const NAMES = { [PAWN]: 'pawn', [KNIGHT]: 'knight', [BISHOP]: 'bishop', [ROOK]: 'rook', [QUEEN]: 'queen', [KING]: 'king' };
  const LETTERS = '.PNBRQK';

  // Every tip: a short title, a piece to show, and the text (a string, or a function of the
  // context the event found). `rule` tips count towards "rules met" in the coach panel.
  const TIPS = {
    welcome: {
      title: 'Your first game',
      piece: 'N',
      text: '<p>You play White against a gentle Stockhorse. Click one of your pieces to see where it can go: the dots are its moves.</p><p>To win, leave Black with <b>no legal move</b>. I will explain each rule the moment it comes up.</p>',
    },
    pawn: {
      rule: true, title: 'The pawn', piece: 'P',
      text: '<p>A pawn steps <b>one square straight ahead</b>, and captures straight ahead too. It never captures diagonally, and there is no double step.</p>',
    },
    knight: {
      rule: true, title: 'The knight', piece: 'N',
      text: '<p>The knight jumps in an <b>L</b>: two squares one way, then one to the side. It hops over anything in between.</p>',
    },
    bishop: {
      rule: true, title: 'The bishop', piece: 'B',
      text: '<p>The bishop slides along <b>diagonals</b>, as far as it likes, until something is in the way.</p>',
    },
    rook: {
      rule: true, title: 'The rook', piece: 'R',
      text: '<p>The rook slides along <b>ranks and files</b>, as far as it likes. On this small board it is the strongest piece.</p>',
    },
    queen: {
      rule: true, title: 'The queen', piece: 'Q',
      text: '<p>Careful if you know chess: this queen steps just <b>one square</b> in any direction, like a king. Here the rook is the strongest piece.</p>',
    },
    king: {
      rule: true, title: 'The king', piece: 'K',
      text: '<p>The king steps one square in any direction. It may never step into check, so the two kings can <b>never stand side by side</b>.</p>',
    },
    drop: {
      rule: true, title: 'Drops', piece: 'P',
      text: '<p>Instead of moving, you may <b>drop</b> a piece from your reserve on any empty square. The dots show where.</p><p>Two limits: no pawn on a file that already has one of your pawns, and a rook or bishop only while you have fewer than two rooks and bishops on the board.</p>',
    },
    reserve: {
      title: 'Your reserve', piece: 'B',
      text: '<p>Your reserve can join the game now: a piece beside the board that lights up has a legal drop. Click it, then an empty square. At the start nothing could drop, because every file had your pawn and your rook and bishop were both on the board.</p>',
    },
    capture: {
      rule: true, title: 'Captures', piece: 'N',
      text: c => `<p>You took a ${c.name}. A captured piece <b>leaves the game for good</b>: it never joins anyone's reserve.</p>`,
    },
    lost: {
      title: 'Watch your pieces', piece: 'P',
      text: c => `<p>Stockhorse took your ${c.name}. Before each move, check which of your pieces nothing protects. While you learn, <b>Take back</b> is fine.</p>`,
    },
    theirDrop: {
      title: 'Black drops too', piece: 'R',
      text: c => `<p>Black dropped a ${c.name} from its reserve. Both sides start with the same reserve, so look out for drops that attack your pieces.</p>`,
    },
    pawnHalf: {
      rule: true, title: 'Pawns in enemy land', piece: 'P',
      text: '<p>Your pawn has crossed into Black\'s half. Over here it can also <b>step or capture one square sideways</b>, which makes it much stronger.</p>',
    },
    pawnFar: {
      rule: true, title: 'The last rank', piece: 'P',
      text: '<p>There is no promotion in Maki. A pawn on the last rank stays a pawn and can only step sideways.</p>',
    },
    check: {
      rule: true, title: 'Check', piece: 'K',
      text: '<p>Check! You attack Black\'s king, and Black must get out of it right away.</p>',
    },
    inCheck: {
      rule: true, title: 'You are in check', piece: 'K',
      text: '<p>Your king is attacked. Move it, capture the attacker, or put something in the way (a <b>drop</b> can block too). Only moves that end the check are allowed.</p>',
    },
    values: {
      title: 'What pieces are worth', piece: 'R',
      text: '<p>Counting a pawn as 1: <b>rook</b> about 6, <b>queen</b> 5, <b>knight</b> 4, <b>bishop</b> 3¾. A pawn in the enemy half or in your reserve is worth almost 2. Before each capture, compare what you take with what you might lose.</p>',
    },
    mateWin: {
      rule: true, title: 'Checkmate', piece: 'K',
      text: '<p>Black is in check with no way out. <b>You win!</b></p>',
    },
    mateLose: {
      rule: true, title: 'Checkmate', piece: 'K',
      text: '<p>Your king is in check with no way out, so Black wins this one. Take back a move or two to find the escape, or play again.</p>',
    },
    staleWin: {
      rule: true, title: 'Stalemate wins', piece: 'K',
      text: '<p>Black is not in check but has no legal move. In Maki that is a <b>win</b> for you, not a draw.</p>',
    },
    staleLose: {
      rule: true, title: 'Stalemate wins', piece: 'K',
      text: '<p>You are not in check, but you have no legal move. In Maki that <b>loses</b>, unlike chess. Keep a free move in hand.</p>',
    },
    threefold: {
      rule: true, title: 'Draw by repetition', piece: 'K',
      text: '<p>The same position came up three times, so the game is a draw.</p>',
    },
    bareKings: {
      rule: true, title: 'Bare kings', piece: 'K',
      text: '<p>Only the two kings are left and both reserves are empty, so the game is a draw.</p>',
    },
    resigned: {
      title: 'Game over', piece: 'K',
      text: '<p>Every game teaches something. Review it to see where it turned, or play again.</p>',
    },
  };
  const RULES = Object.keys(TIPS).filter(id => TIPS[id].rule && !/Lose$/.test(id));
  const sameRule = id => id.replace(/Lose$/, 'Win');

  // Tips for picking up a piece or a reserve piece (`sel` as the board reports it).
  function onSelect(pos, sel) {
    if (!sel) return [];
    if (sel.drop) return ['drop'];
    const code = pos.board[sel.sq];
    return code ? [NAMES[code & 7]] : [];
  }

  // Tips after a move: `pos` is the position after it, `human` the learner's colour and
  // `moves` every move of the game so far in UCI.
  function afterMove(pos, human, moves) {
    const entry = pos.undo[pos.undo.length - 1];
    if (!entry) return [];
    const mover = pos.side ^ 1;
    const out = [];
    const drop = moveDrop(entry.m);
    const to = moveTo(entry.m);
    const type = pos.board[to] & 7;
    const rank = (to / 6) | 0;
    const ctx = {};
    if (mover === human) {
      if (pos.inCheck()) out.push('check');
      if (entry.captured) {
        ctx.name = NAMES[entry.captured & 7];
        out.push('capture');
      }
      if (type === PAWN && !drop) {
        const far = human === WHITE ? rank === 5 : rank === 0;
        const enemy = human === WHITE ? rank >= 3 : rank <= 2;
        if (far) out.push('pawnFar');
        else if (enemy) out.push('pawnHalf');
      }
      // Moves made by the learner, counted back from the end (the last one is theirs).
      const mine = moves.filter((_, i) => (moves.length - 1 - i) % 2 === 0);
      if (mine.length >= 6) out.push('values');
    } else {
      if (pos.inCheck()) out.push('inCheck');
      if (entry.captured) {
        ctx.name = NAMES[entry.captured & 7];
        out.push('lost');
      }
      if (drop) {
        ctx.name = NAMES[drop];
        out.push('theirDrop');
      }
      // The first time the learner could drop something and has not yet.
      const mine = moves.filter((_, i) => (moves.length - 1 - i) % 2 === 1);
      if (!mine.some(u => u.includes('@')) && pos.legalMoves().some(m => moveDrop(m))) out.push('reserve');
    }
    return out.map(id => ({ id, ctx }));
  }

  // The tip for how a game ended. `result`: { winner: 'w' | 'b' | undefined, reason }.
  function endTip(result, human) {
    if (!result) return null;
    const won = result.winner && (result.winner === 'w') === (human === WHITE);
    switch (result.reason) {
      case 'checkmate': return won ? 'mateWin' : 'mateLose';
      case 'stalemate': return won ? 'staleWin' : 'staleLose';
      case 'threefold': return 'threefold';
      case 'bare kings': return 'bareKings';
      default: return 'resigned';
    }
  }

  function tipText(id, ctx = {}) {
    const t = TIPS[id];
    return typeof t.text === 'function' ? t.text(ctx) : t.text;
  }

  const logic = { TIPS, RULES, sameRule, onSelect, afterMove, endTip, tipText, LETTERS };

  // --- the coach panel (browser only) -------------------------------------------------------

  // `deps`: { $, pieceSvg }. One coach per coached game: `reset()` when a new one starts.
  class CoachPanel {
    constructor(deps) {
      this.d = deps;
      this.seen = new Set();
      this.current = null;
      this.el = deps.$('#coachBox');
      this.el.addEventListener('click', e => {
        const b = e.target.closest('[data-tip]');
        if (b) this.show(b.dataset.tip, JSON.parse(b.dataset.ctx || '{}'), { again: true });
      });
    }

    reset() {
      this.seen = new Set();
      this.ctx = {};
      this.current = null;
      this.show('welcome');
    }

    // Shows the first tip of `ids` (strings or { id, ctx }) not seen yet in this game.
    offer(ids) {
      for (const x of ids) {
        const id = typeof x === 'string' ? x : x.id;
        if (this.seen.has(sameRule(id))) continue;
        this.show(id, typeof x === 'string' ? {} : x.ctx);
        return true;
      }
      return false;
    }

    show(id, ctx = {}, { again = false } = {}) {
      if (!TIPS[id]) return;
      if (!again) {
        this.seen.add(sameRule(id));
        this.ctx[sameRule(id)] = { id, ctx };
      }
      this.current = { id, ctx };
      this.render(!again);
    }

    render(fresh) {
      const { $, pieceSvg } = this.d;
      const { id, ctx } = this.current;
      const t = TIPS[id];
      $('#coachIcon').innerHTML = pieceSvg(t.piece, 'w');
      $('#coachTitle').textContent = t.title;
      $('#coachText').innerHTML = tipText(id, ctx);
      const met = RULES.filter(r => this.seen.has(r));
      $('#coachCount').textContent = `${met.length} of ${RULES.length} rules`;
      $('#coachChips').innerHTML = met.map(r => {
        const hit = this.ctx[r];
        return `<button class="coach-chip${sameRule(id) === r ? ' cur' : ''}" type="button" data-tip="${hit.id}" data-ctx='${JSON.stringify(hit.ctx).replace(/'/g, '&#39;')}'>${TIPS[r].title}</button>`;
      }).join('');
      if (fresh) {
        this.el.classList.remove('pop');
        void this.el.offsetWidth;
        this.el.classList.add('pop');
      }
    }
  }

  root.Coach = { ...logic, CoachPanel };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
})(globalThis);
