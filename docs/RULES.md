# KnightChess rules (ruleset `knightchess-2`)

These are the frozen rules that every StockKnight component implements: the JavaScript
reference engine (`reference/engine.js`), the Rust core, the WebAssembly build and the game
server. A change to any rule here changes the ruleset id, and data or networks made under a
different ruleset id are refused.

## Board and setup

- 6×6 board, files a–f, ranks 1–6.
- **White's half** is ranks 1–3, **Black's half** ranks 4–6.
- White, rank 1 from a to f: bishop, knight, queen, king, knight, rook. White pawns fill rank 2.
- Black's setup is the 180° rotation of White's: rank 6 from a to f is rook, knight, king,
  queen, knight, bishop; Black pawns fill rank 5.
- Each side starts with a reserve of 2 pawns, 1 rook and 1 bishop.
- White moves first.

Start position: `rnkqnb/pppppp/6/6/PPPPPP/BNQKNR[PPRBpprb] w 0 1`

## Pieces

| Piece | Movement |
|---|---|
| King | One square in any direction, as in chess. No castling |
| Queen | One square in any direction (moves like a king) |
| Rook | Any distance along a rank or file, as in chess |
| Bishop | Any distance diagonally, as in chess |
| Knight | As in chess |
| Pawn | See below |

### Pawns

A pawn's options depend on which half of the board it stands on.

**In its own half** (ranks 1–3 for White, ranks 4–6 for Black):

- It moves one square straight forward to an empty square, or captures the enemy piece on the
  square straight in front of it.
- It never moves or captures sideways, diagonally or backwards.

**In the opponent's half** (ranks 4–6 for White, ranks 1–3 for Black):

- It moves or captures one square straight forward, one square left, or one square right.
- It never moves or captures diagonally or backwards.

**Everywhere:**

- A pawn can always move or capture one square straight forward, including onto the
  opponent's back rank (rank 6 for White, rank 1 for Black). So a White pawn on rank 5 gives
  check to a king on the square in front of it. A pawn on the opponent's back rank can only
  move or capture sideways.
- No double step, no en passant, no promotion.

## Kings and check

- A king attacks the squares around it, as in chess. So two kings can never stand next to
  each other, and a king cannot capture a piece the other king defends. A king never captures
  the other king.
- A king is in check when an enemy piece other than the king attacks its square.
- You may not make a move that leaves your own king in check.

## Drops

Instead of moving a piece, a player may place a piece from their reserve on any empty square.

- Captured pieces are removed from the game. They never go to anyone's reserve.
- A pawn may not be dropped on a file that already holds one of your own pawns.
- A pawn may be dropped on any rank, including the opponent's back rank, where it can only
  move sideways.
- A rook or bishop may be dropped only while you have fewer than 2 rooks and bishops in total
  on the board.
- A drop may give check or checkmate.

## End of the game

- **Win:** the player to move who has no legal move loses. Checkmate and stalemate both lose.
- **Draw by repetition:** the same position (board, reserves and side to move) occurs for the
  third time.
- **Draw by bare kings:** only the two kings remain and both reserves are empty.
- There is no 50-move rule.

## Notation

- Squares: `sq = rank × 6 + file` with files a–f = 0–5 and ranks 1–6 = 0–5.
- Moves (UCI style): `b1c3` for a board move or capture, `R@c4` for a drop.
- FEN: the six ranks from rank 6 down to rank 1, then the reserves in brackets (White's in
  capitals, `[-]` when both are empty), the side to move, the quiet-ply counter and the move
  number.
- The quiet-ply counter counts plies since the last capture, drop or forward pawn step. A
  sideways pawn step is reversible, so it does not reset the counter. The counter is not a draw
  rule; it only bounds how far back a repetition can be.
