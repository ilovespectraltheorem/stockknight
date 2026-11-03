'use strict';
// Game review: turns per-position engine analysis into move classifications (brilliant, great,
// best, excellent, good, inaccuracy, mistake, miss, blunder, forced) and accuracy scores.
//
// Everything is measured in expected points (win probability) from the mover's view, so a
// 300-centipawn slip in a dead-won position costs far less than the same slip in a level one.

(function (root) {
  const SK = root.StockKnight || (typeof require === 'function' ? require('../reference/engine.js') : null);
  const MATE_BOUND = SK.MATE - 1000;
  const VALUE = [0, 100, 290, 300, 450, 320, 0]; // G0 material values, by piece type

  const CLASSES = {
    brilliant: { label: 'Brilliant', symbol: '!!', blurb: 'a sacrifice that works' },
    great: { label: 'Great', symbol: '!', blurb: 'the only good move' },
    best: { label: 'Best', symbol: '★', blurb: "the engine's choice" },
    excellent: { label: 'Excellent', symbol: '✓', blurb: 'nearly as good as the best move' },
    good: { label: 'Good', symbol: '·', blurb: 'a solid move' },
    inaccuracy: { label: 'Inaccuracy', symbol: '?!', blurb: 'a better move was available' },
    mistake: { label: 'Mistake', symbol: '?', blurb: 'this gives away a real part of the advantage' },
    miss: { label: 'Miss', symbol: '✕', blurb: "the opponent's error went unpunished" },
    blunder: { label: 'Blunder', symbol: '??', blurb: 'this throws the game away' },
    forced: { label: 'Forced', symbol: '□', blurb: 'the only legal move' },
  };
  const ORDER = Object.keys(CLASSES);

  // Expected points for a centipawn score; mates count as certain.
  function winProb(score) {
    if (score >= MATE_BOUND) return 1;
    if (score <= -MATE_BOUND) return 0;
    return 1 / (1 + Math.exp(-0.00368208 * score));
  }

  // Per-move accuracy from the expected points lost (the widely used exponential fit).
  function moveAccuracy(loss) {
    const a = 103.1668 * Math.exp(-0.04354 * loss * 100) - 3.1669;
    return Math.max(0, Math.min(100, a));
  }

  // Material on the board and in reserve, `color` minus its opponent.
  function balance(pos, color) {
    let s = 0;
    for (let sq = 0; sq < 36; sq++) {
      const code = pos.board[sq];
      if (code) s += (code >> 3 === color ? 1 : -1) * VALUE[code & 7];
    }
    for (const t of [SK.PAWN, SK.BISHOP, SK.ROOK]) s += (pos.hand[color][t] - pos.hand[color ^ 1][t]) * VALUE[t];
    return s;
  }

  // Whether the move gives up material for good: after it and the opponent's best reply line
  // (up to four plies), the mover is down by more than a pawn compared with before the move.
  function isSacrifice(pos, uci, replyPv) {
    const mover = pos.side;
    const before = balance(pos, mover);
    const m = pos.moveFromUci(uci);
    if (!m) return false;
    pos.makeMove(m);
    let made = 1, worst = Infinity;
    for (const text of replyPv.slice(0, 4)) {
      const r = pos.moveFromUci(text);
      if (!r) break;
      pos.makeMove(r);
      made++;
      if (pos.side === mover) worst = Math.min(worst, balance(pos, mover));
    }
    const end = balance(pos, mover);
    while (made--) pos.unmakeMove();
    return worst !== Infinity && Math.max(worst, end) <= before - 150;
  }

  function scoreText(score) {
    if (Math.abs(score) >= MATE_BOUND) {
      const n = SK.mateIn(score);
      return n > 0 ? `M${n}` : `-M${-n}`;
    }
    const v = score / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  // game: { startFen, moves: [uci] }
  // analyses: one per position, analyses[i] for the position before moves[i] (from the
  // engine's analyse task); analyses[n] may describe the final position.
  // finalStatus: the game's final status from Position.status().
  function classifyGame(game, analyses, finalStatus) {
    const pos = new SK.Position(game.startFen || SK.START_FEN);
    const plies = [];
    const n = game.moves.length;

    for (let i = 0; i < n; i++) {
      const a = analyses[i];
      const uci = game.moves[i];
      const mover = pos.side;
      const m = pos.moveFromUci(uci);
      const text = pos.moveToText(m);
      const played = a.scores[uci] !== undefined ? a.scores[uci] : -analyses[i + 1].score;
      const wpBest = winProb(a.score);
      const wpPlayed = winProb(played);
      const loss = Math.max(0, wpBest - wpPlayed);

      // The best score among the other moves, for "only move" detection.
      let second = -Infinity;
      for (const [k, v] of Object.entries(a.scores)) if (k !== a.best && v > second) second = v;
      const onlyMoveGap = second === -Infinity ? 0 : wpBest - winProb(second);

      const prev = plies[i - 1];
      const next = analyses[i + 1];
      const replyPv = next && next.pv ? next.pv : [];

      let cls;
      if (a.legal === 1) cls = 'forced';
      else if (uci === a.best || loss <= 0.002) cls = 'best';
      else if (loss < 0.02) cls = 'excellent';
      else if (loss < 0.05) cls = 'good';
      else if (loss < 0.1) cls = 'inaccuracy';
      else if (loss < 0.2) cls = 'mistake';
      else cls = 'blunder';

      const sacrifice = cls !== 'forced' && loss < 0.02 && isSacrifice(pos, uci, replyPv);
      // How the mover stood before the opponent's last move (or before this one at ply 0).
      const wasWinning = prev ? 1 - prev.wpBefore : wpBest;
      if (sacrifice && wpPlayed >= 0.5 && wasWinning < 0.95) cls = 'brilliant';
      else if ((cls === 'best' || cls === 'excellent') && a.legal > 1 && onlyMoveGap >= 0.15 && wpPlayed >= 0.35) {
        cls = 'great';
      } else if (
        (cls === 'inaccuracy' || cls === 'mistake' || cls === 'blunder') &&
        prev && (prev.cls === 'mistake' || prev.cls === 'blunder') &&
        loss >= 0.1 && wpPlayed >= 0.3
      ) {
        cls = 'miss';
      }

      plies.push({
        ply: i,
        mover,
        uci,
        text,
        cls,
        loss,
        accuracy: cls === 'forced' ? null : moveAccuracy(loss),
        best: a.best,
        bestText: a.best ? pos.moveToText(pos.moveFromUci(a.best)) : '',
        bestScore: a.score,
        playedScore: played,
        wpBefore: wpBest,
        wpAfter: wpPlayed,
        bestPv: a.pv,
        sacrifice,
      });
      pos.makeMove(m);
    }

    // White's expected points at every position, for the evaluation graph.
    const curve = [];
    const tmp = new SK.Position(game.startFen || SK.START_FEN);
    for (let i = 0; i <= n; i++) {
      let wp;
      if (i < n || (analyses[i] && analyses[i].legal)) {
        const a = analyses[i];
        wp = winProb(a.score);
      } else if (finalStatus && finalStatus.state === 'win') {
        wp = finalStatus.winner === tmp.side ? 1 : 0;
      } else {
        wp = 0.5;
      }
      if (i === n && finalStatus && finalStatus.state === 'draw') wp = 0.5;
      curve.push(tmp.side === SK.WHITE ? wp : 1 - wp);
      if (i < n) tmp.makeMove(tmp.moveFromUci(game.moves[i]));
    }

    const players = [SK.WHITE, SK.BLACK].map(color => {
      const mine = plies.filter(p => p.mover === color);
      const counts = Object.fromEntries(ORDER.map(k => [k, 0]));
      for (const p of mine) counts[p.cls]++;
      const scored = mine.filter(p => p.accuracy !== null);
      const accuracy = scored.length ? scored.reduce((s, p) => s + p.accuracy, 0) / scored.length : null;
      return { color, counts, accuracy };
    });

    return { plies, curve, players };
  }

  const api = { CLASSES, ORDER, winProb, moveAccuracy, balance, isSacrifice, scoreText, classifyGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Review = api;
})(typeof self !== 'undefined' ? self : globalThis);
