# Training data

## The record (24 bytes)

| Bytes | Field |
|---|---|
| 0–17 | Board: 36 squares × 4 bits (piece codes), square `2i` in the low nibble of byte `i` |
| 18 | Reserves: White pawns (2 bits), White rook (1), White bishop (1), then Black's the same |
| 19 | Bit 0: side to move. Bits 1–2: game result from White's view (0 Black won, 1 draw, 2 White won) |
| 20–21 | Search score, int16 little-endian, centipawns, side to move's view |
| 22–23 | Best move, engine encoding, little-endian |

Files are plain concatenations of records (`.bin`). Defined in `crates/data/src/lib.rs`.
`Record::key()` hashes the position only (labels ignored) and is what `dedup` uses.

## Self-play (`sk-datagen run`)

One game per thread with G0: random opening plies (not recorded; the game is discarded if the
first search scores beyond `--opening-limit`), then a search of `--nodes` per move. Games end by
the rules, by adjudication (one side beyond `--adjudicate` cp for `--adjudicate-plies` plies),
after `--quiet-draw` quiet plies (a draw) or at `--max-plies` (a draw).

A position is recorded unless the side to move is in check, the best move is a capture, the
score is a forced result, or the position is more than `--record-quiet-limit` quiet plies into a
shuffle. Whole games (`--val-fraction`, 1% by default) go to the validation file. Each game is
fully determined by `--seed` and its index.

Outputs: `<prefix>.train.bin`, `<prefix>.val.bin` and `<prefix>.info.txt`, written last, so its
presence means the run finished.

| Option | Default |
|---|---|
| `--nodes` | 5,000 |
| `--random-plies` | 8 |
| `--opening-limit` | 600 cp |
| `--max-plies` | 400 |
| `--adjudicate`, `--adjudicate-plies` | 1,500 cp, 8 |
| `--quiet-draw` | 120 plies |
| `--record-quiet-limit` | 40 plies |
| `--val-fraction` | 0.01 |

## Tools

```sh
sk-datagen stats <file>                     # results, side balance, scores, distinct positions
sk-datagen dump <file> --n 20               # FEN, score, result, best move
sk-datagen dedup <in>... <out> --exclude <val file>
```
