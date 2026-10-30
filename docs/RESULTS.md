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
