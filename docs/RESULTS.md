# Results

## Pilot round (Phase 2), 30 Oct 2026

G0 self-play, 5,000 nodes per move, default `sk-datagen` settings, seed 1, 4 threads.

| | |
|---|---|
| Games | 17,241 (253 openings discarded) |
| Positions | 1,189,210 train + 10,980 validation; 91.0% distinct |
| Average game length | 135.8 plies |
| Speed | 1,130 positions/s on 4 threads (17.7 minutes) |
| Results (White's view) | White 38.1%, draw 39.4%, Black 22.5% |

How games ended:

| Ending | Share |
|---|---|
| Checkmate | 38.0% |
| Quiet-ply draw (120 plies without capture, drop or forward pawn step) | 26.4% |
| Stalemate (loses) | 17.5% |
| Bare kings | 6.9% |
| Threefold repetition | 6.0% |
| Adjudication | 5.0% |
| 400-ply cap | 0.1% |

Observations:

- White's first-move advantage is about as large as under the original Drop Chess rules
  (38% vs 22.5% decisive results; the original measured 36–39% vs 23–24%).
- About two games in five are drawn, mostly by the quiet-ply limit: with sideways pawn moves,
  G0 often shuffles. Drawn games are long, so 57.7% of recorded positions come from draws.
  Better evaluations (trained networks) should convert more of these; the draw rate is the
  number to watch from generation to generation.
- 10% of recorded best moves are drops; a position has 1.45 pawns in their enemy half on average.

## G1, the first network (Phase 3), 30 Oct 2026

Trained on the pilot round (1,189,210 positions), validated on its 10,980 held-out positions.
256-32-32, K 470 (fitted), λ 0.75, CPU, 12 epochs (early stop; best epoch 8), 11 minutes.

| | G0 | G1 |
|---|---|---|
| Validation loss | 0.005135 | 0.004010 |
| Error against game results (`result_mse`) | 0.0594 | 0.0518 |

Rust and PyTorch outputs differ by at most 9.1e-7.

Gate, G1 vs G0 at 5,000 nodes per move, 400 games (200 openings, colours swapped), seed 11:

| | |
|---|---|
| Result for G1 | +201 =133 −66, score 0.669 |
| Elo | **+122** (95% interval +94 to +152) |
| Endings | checkmate 50%, length cap 23%, stalemate 15%, bare kings 8%, threefold 2%, adjudication 2% |
| Speed | G1 101k nodes/s (float, recomputed every node), G0 1.44M nodes/s |

G1 is clearly stronger than G0 at equal nodes, though below the +150 hoped for in the plan.
Validation loss stopped improving after epoch 8, so more data (the generation loop) is the main
lever. At equal time G1 is not yet stronger: it searches 14× fewer nodes per second until
Phase 4 makes inference incremental and quantized.

## Fast inference (Phase 4), 30 Oct 2026

G1 run quantized and incremental (`docs/NNUE.md`), on a 4-core Xeon at 2.1 GHz with AVX-512 VNNI.

`stockknight bench 6` (12 positions, one thread):

| Evaluation | Nodes/s |
|---|---|
| G0 | 2.49M |
| G1 quantized (VNNI) | 1.56–1.62M |
| G1 quantized (AVX2 only) | 1.49M |
| G1 portable integer path | 0.40M |
| G1 float, recomputed every node (Phase 3) | 0.14M |

Quantization error against float on the 10,980 validation positions: mean 2.6 cp, max 13 cp.

Matches, 400 games each (200 openings, colours swapped), 4 at a time:

| Match | Result | Elo (95% interval) |
|---|---|---|
| G1 quantized vs G1 float, 5,000 nodes per move, seed 11 | +135 =142 −123, score 0.515 | +10 (−17 to +38) |
| G1 vs G0, 40 ms per move, seed 12 | +218 =129 −53, score 0.706 | **+152** (+124 to +183) |

Quantization costs no measurable strength. At equal time, G1 is now well ahead of G0: about 11×
faster than float made its nodes-per-move deficit small (1.06M vs 1.68M nodes/s in the match, 4
games in parallel). 43% of the timed games ended by adjudication, since a 40 ms search finds
decisive material swings quickly.

## The generation loop, G1 → G4 (Phase 5), 30 Oct 2026

`python -m skpy.loop` (see `docs/LEAGUE.md`), started from the pilot round and G1. Each round
is 1.2M positions made by the teacher at 5,000 nodes per move. Each network trains on the newest
3 rounds, starting from its teacher's weights. The gate is an SPRT [0, 10] Elo against the
teacher, and league games are against every older model. All games use 5,000 nodes per move.
4 cores, about 40 minutes per generation (data 25, training 8–10, games 5).

| Model | Teacher | Elo vs G0 (± 1 s.e.) | Gate against teacher (W-D-L) | Decision |
|---|---|---|---|---|
| G1 | G0 | +130 (21) | 105-64-31 | accepted |
| G2 | G1 | +201 (22) | 177-136-87 | accepted |
| G3 | G2 | +261 (23) | 176-124-100 | accepted |
| G4 | G3 | +279 (23) | 644-608-548 | accepted after 1,800 games |

Ratings are joint maximum-likelihood over all 2,880 league games. Each model scores above 50%
against every older one. G4 hit the original 1,600-game cap undecided (LLR 2.46 of the 2.94
needed). Its gate was reopened with a 3,200-game cap and passed at 1,800 games.

| Round | Teacher | White | Draw | Black |
|---|---|---|---|---|
| 1 | G0 | 38.1% | 39.4% | 22.5% |
| 2 | G1 | 39.1% | 38.2% | 22.7% |
| 3 | G2 | 41.1% | 34.9% | 23.9% |
| 4 | G3 | 40.8% | 35.5% | 23.7% |

The gain per generation is shrinking: +130, +71, +60, +18. Stronger teachers draw less (39% →
35%), but the White advantage stays. With the window fixed at 3 rounds of 1.2M positions, the
next levers are bigger rounds and deeper label searches. Those are for the harness phase.
