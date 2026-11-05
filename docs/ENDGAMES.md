# Lone pieces against a bare king

Which single pieces can checkmate in Maki (ruleset `knightchess-2`)? This note answers it for
the minor pieces: a king and a bishop, a king and a knight, and a king and two knights, each
against a bare king, all on the board with both reserves empty.

Two rules decide everything here:

- A king attacks the 8 squares around it, so the two kings never stand side by side and the
  bare king cannot take a piece that the other king guards.
- **The side to move with no legal move loses.** Checkmate and stalemate both lose.

## The answers

| Material | Can it checkmate? | Can it force a win? | Longest win, stronger side to move |
|---|---|---|---|
| King and bishop | Never: no checkmate position exists | Yes, from every position with the stronger side to move | 39 plies (20 moves) |
| King and knight | Never: no checkmate position exists | Yes, unless the knight is already trapped (168 positions) | 65 plies (33 moves) |
| King and two knights | Yes, but it cannot be forced | Yes, from every position with the stronger side to move | 57 plies (29 moves) |

So in Maki all three are wins, and the win is (almost always) a **stalemate**: the bare king is
left on the move with nowhere to go. The bare king's only real hope is to win material: with king
and bishop it draws exactly when it is to move and can take the bishop at once (bare kings); with
king and knight it also draws when the knight is trapped; and with two knights, taking one
usually still leaves a lost king-and-knight ending.

In ordinary chess the checkmate answers are the same (no mate with a lone bishop or knight, and
two knights cannot force one), but there a stalemate is a draw, so all three endings are draws.

## Why a lone bishop or knight can never checkmate

Call the bare king's square *s*. Its four **side neighbours** (the squares one step up, down,
left and right; two in a corner, three on an edge) all have the opposite colour to *s*.

1. **The checking piece guards none of them.** A bishop that gives check stands on a square of
   the same colour as *s*, and a bishop only ever reaches squares of its own colour. A knight that
   gives check stands on the opposite colour to *s*, and a knight always jumps to the colour it is
   not on, so it reaches only squares of *s*'s colour. Either way, the side neighbours are not
   attacked by the piece. The piece does not stand on one either (a bishop is on the wrong colour,
   and a knight checks from two squares away).
2. **The other king cannot guard them all.** It may not stand next to *s*. In a corner (say *s* =
   a1, neighbours a2 and b1) the only squares next to both a2 and b1 are a1 and b2, and both touch
   a1. On an edge (*s* = a3) the squares next to both a2 and a4 are a3 and b3, again touching the
   king. In the middle, the same holds for two opposite side neighbours. So at least one side
   neighbour is free.
3. That free square is empty and unguarded, so the bare king can step there: it is not mated.

Hence no checkmate position exists with king and bishop, or king and knight, against a king. The
exhaustive solve agrees: it finds 96 stalemates and no checkmate for the bishop, and 40 stalemates
and no checkmate for the knight.

## Why two knights cannot force checkmate

Mates with two knights exist: 88 positions, for example White Kc2, Nb3, Nc3 against Black Ka1,
or, on the edge, White Ka1, Nb3, Ne3 against Black Kc1. But they cannot be forced. This is a
computer proof: `web/endgame.js` solves the ending a second time with checkmate as the only goal
(a stalemated bare king counts as a draw there). In that table:

- the stronger side wins only in the positions where it already has a mate in one, and
- the bare king loses only in the 88 positions where it is already mated.

That is, from any position with the bare king to move that is not already mate, it has a move
after which no mate in one exists, and so no mate ever comes. In Maki this does not save it:
stepping out of the mate leads, sooner or later, into a stalemate, which loses.

## How to win

The tables in the analysis board give the exact best move in every position (pick **Lone-piece
endings** under the board, or set one up). The plans behind those moves:

### King and bishop (at most 20 moves)

1. **Keep the bishop safe.** The bare king's only hope is to take it. Keep it far away on a long
   diagonal, or next to your own king.
2. **Pick the corner the bishop cannot reach.** On a 6×6 board a1 and f6 are dark, a6 and f1
   light. A light-squared bishop finishes in a1 or f6, a dark-squared one in a6 or f1. (In the
   corner of the bishop's own colour the two squares beside the corner would both have to be held
   by the king, which cannot be done without standing next to the bare king.)
3. **Herd the king there.** Your king walks toward the bare king, staying a knight's move or two
   squares away, while the bishop sits on a diagonal that the bare king may not cross. Each time
   the bare king retreats, step forward or move the bishop to a shorter diagonal.
4. **Use the bishop to pass.** The bare king must move every turn. When the position is right
   but it is your move, slide the bishop along its diagonal without changing what it guards: now
   the bare king has to give ground.
5. **The finish** (light-squared bishop, bare king on a1, Black to move): your king on **c1 or
   c2** guards b1 and b2, and the bishop guards a2 from **b1, b3, c4, d5 or e6** without giving
   check. Or the mirror: king on **a3 or b3**, bishop on **a2, c2, d3, e4 or f5** guarding b1.
   Two edge finishes also exist: Kc2 and Bb2 against Ka2, and Kc3 and Bc2 against Kc1.

Example, the longest case, White to move: White Ka1, Bf2, Black Kc1. White wins in 20 moves, for
instance 1. Ka2 Kc2 2. Ka3 Kc3 3. Ka4 Kd3 4. Kb4 Ke2 5. Bd4 Kd3 6. Ba1 Ke3 7. Kc4 Ke2 8. Kd4 Kd2
9. Bc3+ Kc2 10. Kc4 Kb1 11. Kb3 Kc1 12. Bb4 Kd1 13. Kc3 Ke2 14. Kd4 Kf3 15. Kd3 Kf4 16. Bd6+ Kf3
17. Be5 Kf2 18. Bd4+ Ke1 19. Be3 Kf1 20. Kd2, and Black, on f1, has no move.

### King and knight (at most 33 moves)

1. **Never let the knight be trapped.** A knight on the edge or in a corner, attacked by the bare
   king, with every square it could jump to guarded by that king, is lost (for example Na6 against
   Kc4 or Kb5): that is how all 168 drawn positions arise. Keep the knight near your own king.
2. **Any corner will do.** A knight has no colour to care about.
3. **Herd the king with your king** a knight's move or two squares away, and use the knight to
   take away the squares your king cannot.
4. **Time the last knight move.** A knight cannot pass, so your king makes the waiting moves; the
   knight lands on its final square at the moment the bare king is in the corner and has to move.
5. **The finish** (bare king on a1, Black to move): your king on **c1 or c2** guards b1 and b2, and
   the knight guards a2 from **c3 or b4** (or from **c1** when your king is on c2), without
   giving check. Or the mirror: king on a3 or b3, knight guarding b1.

Example, the end of a longest line: White Kb3, Nd3, Black Ka1, White to move: 1. Nc1 Kb1 2. Na2
Ka1 3. Nc3. On a1 Black has no move: b1 is covered by the knight, a2 and b2 by the king.

### King and two knights (at most 29 moves)

The same plan as with one knight, made easier: one knight guards while the other one moves, so
the timing problem mostly goes away. Drive the bare king to an edge or a corner and close the last
squares; there are 260 different final pictures (up to the symmetries of the board), 11 of them
checkmates and 249 stalemates. Do not hunt for a checkmate: the bare king can always dodge
it, but not the stalemate. If the bare king takes a knight, the king-and-knight ending that is
left is usually still won.

## Reproducing the numbers

```sh
node web/endgame.js        # counts for KBvK, KNvK, KNNvK (also KNBvK and KBBvK), both goals
node web/test.js           # includes the checks behind this page
```

`web/endgame.js` solves each ending by retrograde analysis, in the same level-by-level way as
`sk-tb` (see [TABLEBASES.md](TABLEBASES.md)). Its results match `sk-tb probe` on every position
compared (300 random positions across the five materials, both colours as the stronger side,
plus the fixed cases in `web/test.js`), and an independent C solver written for this check agreed
with it on all 1.2 million positions of the three endings above.
