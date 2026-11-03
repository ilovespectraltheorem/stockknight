# Endgame tablebases (sk-tb)

`sk-tb` solves KnightChess endgames exactly. For every position of a material signature it stores
the result with best play and the distance to the end of the game in plies. This is the endgame
track of the plan (phases E0 to E5). E0 and E1 are done: indexing, the solver, and its
verification up to 4 pieces. E2, the 5-piece tables, is being generated.

## What a table holds

- **Pieces** are counted on the board and in reserve, both kings included. `KR[P]vK` is White king
  and rook on the board with a pawn in reserve against a bare Black king: 4 pieces.
- **Values** are for the side to move. A stored distance d means the game ends after d plies with
  best play: d odd is a win, d even a loss, and d = 0 means there is no legal move now. With
  KnightChess rules that covers checkmate and stalemate alike. The winner plays for the shortest
  win and the loser for the longest loss.
- **Draws** are the positions neither side can force to an end. Play can only end there by
  repetition. Bare kings with empty reserves is a draw by rule. There is no 50-move rule, so
  every win in a table is a real win.

## How it is solved

Captured pieces leave the game and a drop moves a piece from reserve to the board. So a move
either stays inside its table (a quiet board move) or leads to a table with fewer pieces, or as
many pieces but fewer in reserve. `all_sigs` lists tables in that order, and each table is
solved once all the tables it leads to are done.

Inside a table, `solve` decides positions level by level: level n holds exactly the positions
whose distance is n.

1. A first pass marks invalid indices, decides positions with no legal move (level 0), and looks
   up every capture and drop in the finished tables. A position is registered for the levels at
   which those moves could decide it.
2. Each position decided at level n − 1 is un-moved: every quiet move by the side that just moved
   is taken back. That gives the in-table positions that might now be decided.
3. Each candidate for level n is re-examined by playing every legal move forward. It is decided
   if one move reaches a loss at n − 1 (a win at n), or if every move reaches a win, the longest
   at n − 1 (a loss at n). There is no move counting, so symmetric or repeated predecessors
   cannot corrupt a count.

## Indexing

The rules are symmetric under a left-right mirror, so the white king is kept on files a–c (18
squares). An index is made of the side to move, the white king (18 squares), the black king (36),
then, for each group of identical pieces, the rank of its set of squares in the combinatorial
number system. Indices that do not decode to a legal position are stored as invalid: two pieces
on one square, a pawn on its far rank, or the side not to move in check. Colour swap is a symmetry too:
turning the board upside down and swapping colours and the side to move gives a position the rules
treat identically. So only one table of each pair is stored (`Sig::canonical`), for example `KPvKR`
for both `KPvKR` and `KRvKP`. A probe into the other one flips the board (`index::flip`).

## Files

`<signature>.sktb` holds `SKTB`, the format number (2), the ruleset id, the signature name, the
entry count, a value width, and then the values. Width 1 is one byte per entry (0 for a draw,
distance + 1, 255 for an invalid index) and is used whenever the longest distance is at most 253.
Width 2 stores u16 values (65535 invalid). Loading checks the ruleset id, the name and the size,
and also reads format 1 files. In memory a table is always u16. Commands load only the tables a
signature leads to, so memory stays near the largest table plus its successors.

## Commands

```
cargo build --release -p sk-tb
sk-tb census --max 6                        # signatures and index sizes per piece count
sk-tb gen --dir tb --max 4 --threads 1      # solve and save missing tables, in order
sk-tb check --dir tb --max 4                # every value against its successors
sk-tb brute --dir tb --max 3                # compare with the brute-force solver
sk-tb brute --dir tb 'KRvKP' 'KvK[RP]'      # ... or with chosen tables
sk-tb stats --dir tb --max 4
sk-tb probe --dir tb '6/6/6/q5/6/KkB3[-] b 0 1'
```

Generation resumes: tables already in the folder are loaded, not solved again.

## Verification

- **Index:** every index of every signature up to 4 pieces decodes and encodes back to itself,
  both for the board and for its mirror image (`index_round_trip`).
- **Successor check** (`sk-tb check`): every stored value is recomputed from its successors.
  A win at d needs a move to a loss at d − 1 and none to a shorter loss. A loss at d needs only
  moves to wins, the longest at d − 1. A draw needs no move to a loss and some move to a draw.
- **Brute force** (`sk-tb brute`, `brute.rs`) is a second solver that shares nothing with the
  first except the rules. It has no index, no symmetry and no un-moves: it lists positions by
  placing pieces, reads them through the FEN parser, links them by FEN keys with full legal move
  generation, and assigns values by plain sweeps. The successor check cannot detect a group of
  won positions wrongly marked as draws that point at each other. The brute-force solver can.
- `cargo test -p sk-tb` solves every table up to 3 pieces and runs both checks on it.

## Census

| Pieces | Signatures | Stored tables | Index entries stored | Largest table |
|---|---|---|---|---|
| 2 | 1 | 1 | 1,296 | KvK |
| 3 | 16 | 8 | 237,168 | KRvK and others (46,656) |
| 4 | 130 | 69 | 46,668,960 | KRPvK and others (1.7M) |
| 5 | 708 | 354 | 4.9 × 10^9 | 60M |
| 6 | 2,891 | 1,462 | 4.3 × 10^11 | 2.2 × 10^9 |

At one byte per entry the 4-piece set takes 45 MB, the 5-piece set about 5 GB and the 6-piece set
about 430 GB (about 108 GB as 2-bit win/draw/loss before compression). One worker solving the
largest 6-piece table needs about 4.4 GB of memory for it, plus its successors.
