# StockKnight

A Stockfish-style engine for **KnightChess** (a 6×6 drop-chess variant) and an online platform
to play and evaluate games.

- Rules: [docs/RULES.md](docs/RULES.md) (ruleset `knightchess-1`)
- Plan: the StockKnight engine, training and platform plan (shared separately)

## Status

Workstream A (rules freeze) is in place:

| Path | Contents |
|---|---|
| `docs/RULES.md` | The frozen rules every component implements |
| `reference/engine.js` | Reference implementation: rules, G0 evaluation, alpha-beta search (no dependencies; Node and browsers) |
| `reference/test.js` | Rule tests, perft, make/unmake invariants, search checks |
| `reference/gen-diff.js` | Writes `testdata/diff-positions.txt` for the Rust port's differential tests |
| `reference/bench.js` | Fixed-depth search over `testdata/bench-positions.txt` |

```sh
node reference/test.js          # rule tests
node reference/bench.js 6       # benchmark
node reference/gen-diff.js      # regenerate differential data after a rule change
```

### Perft from the start position

| Depth | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Nodes | 10 | 100 | 1,185 | 13,770 | 181,548 |

Depths 1–3 equal the original 6×6 Drop Chess; from depth 4 the back-rank pawn-drop ban and the
new pawn moves change the counts. With the old pawn rules restored, this engine reproduces the
original project's numbers (13,788 and 180,967), which checks the shared move generator.
