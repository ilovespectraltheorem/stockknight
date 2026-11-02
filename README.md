# StockKnight

A Stockfish-style engine for **KnightChess** (a 6×6 drop-chess variant) and an online platform
to play and evaluate games.

- Rules: [docs/RULES.md](docs/RULES.md) (ruleset `knightchess-2`)
- Plan: the StockKnight engine, training and platform plan (shared separately)

## Status

Workstreams A (rules freeze) and B (Rust engine) are in place, and the Phase 1 gate passes:
the Rust engine equals the JS reference move for move. Self-play data (Phase 2), the first
trained network G1 (Phase 3) and fast quantized network inference (Phase 4) follow; see
`docs/RESULTS.md`.

| Path | Contents |
|---|---|
| `docs/RULES.md` | The frozen rules every component implements |
| `reference/engine.js` | Reference implementation: rules, G0 evaluation, alpha-beta search (no dependencies) |
| `reference/test.js` | Rule tests, perft, make/unmake invariants, search checks |
| `reference/js-engine.js` | The reference engine behind the engine protocol, for matches |
| `reference/gen-diff.js`, `bench.js` | Differential data and the benchmark the Rust port must reproduce |
| `crates/core` (`sk-core`) | Rules: position, moves, legality, outcome, FEN, Zobrist keys, perft |
| `crates/eval` (`sk-eval`) | The `Evaluator` trait and G0 |
| `crates/search` (`sk-search`) | Alpha-beta search, generic over the evaluator; strength levels |
| `crates/engine` (`stockknight`) | The engine binary (UCI-like protocol) |
| `crates/match` (`sk-match`) | Engine-vs-engine matches: openings, parallel games, adjudication, Elo, SPRT, JSON |
| `crates/data` (`sk-data`), `crates/datagen` (`sk-datagen`) | Training records (`docs/DATA.md`) and self-play data generation |
| `crates/nnue` (`sk-nnue`) | Network inputs, `.nnue` files, float reference, quantized incremental inference (`docs/NNUE.md`) |
| `crates/tb` (`sk-tb`) | Endgame tablebases: exact results and distance to the end by retrograde analysis (`docs/TABLEBASES.md`) |
| `python/skpy` | Record loading, the PyTorch trainer, league maths and the generation loop (`docs/LEAGUE.md`) |
| `python/skpy/harness`, `./sk`, `configs/` | The training harness: resumable runs, configs, status, reports, dashboard, doctor, smoke (`docs/HARNESS.md`) |
| `web/` | The play website: PvE against four engine levels, pass-and-play, online rooms, game review (`docs/WEB.md`) |

```sh
cargo build --release --offline && cargo test --release --offline
node reference/test.js
target/release/stockknight bench            # 12 positions, depth 7
target/release/stockknight "position startpos" "go depth 8"
target/release/sk-match --e1 target/release/stockknight --e2 "node reference/js-engine.js" \
  --games 200 --nodes 3000 --concurrency 4
```

### Verification (Phase 1 gate)

| Check | Result |
|---|---|
| Rule tests | 20 JS tests, 18 Rust tests, all passing |
| 10,000 random positions | Legal moves in generation order, status, check, perft(2), G0 value and hash identical |
| Bench, 12 positions at depth 7 | Same moves, scores and node counts (15,654,427 nodes); Rust ≈ 2.5M nodes/s, JS ≈ 0.66M |
| 200 games Rust vs JS at 3,000 nodes | +60 =80 −60, exactly 50%; all 100 colour-swapped pairs identical |

### Perft from the start position

| Depth | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Nodes | 10 | 100 | 1,185 | 13,770 | 181,548 |

Depths 1–3 equal the original 6×6 Drop Chess; from depth 4 the back-rank pawn-drop ban and the
new pawn moves change the counts. With the old pawn rules restored, this engine reproduces the
original project's numbers (13,788 and 180,967), which checks the shared move generator.
