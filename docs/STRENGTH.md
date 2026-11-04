# Playing strength by Elo

The play dialog sets Stockhorse's strength with an Elo slider, in 50-point steps from 100 to
3000. 3000 is full strength: the website's engine searching a million nodes a move (about
1.5–2 seconds on a laptop), with no randomness.

## How the engine plays weaker

Each Elo maps to two numbers, interpolated between the measured ladder points below:

- **Node budget.** How much the engine searches before it moves. Interpolated in log space, so
  the depth it reaches grows gradually.
- **Temperature** (centipawns). Every root move gets an exact score, and the engine picks a
  move with probability proportional to `exp((score − best) / temperature)`. A warm setting
  mostly plays reasonable moves and sometimes a worse one. A move that drops a piece (about
  three pawns) is 5% as likely as the best move at T = 100 and 0.25% as likely at T = 50; a
  move into a mate it can see is never picked. At 3000 the temperature is zero.

So a lower setting doesn't blunder on a fixed schedule or suddenly see half as far. It sees a
little less and is a little less fussy about choosing the best of what it sees. A wall-clock
cap of 3 s a move keeps slow devices from waiting longer than that.

## Calibration

`node web/calibrate.js` measured each ladder point by self-play. Neighbouring points (i, i+1)
and points two apart (i, i+2) played 40 games per pair: 20 random four-ply openings, each
played once with each colour. Searches were limited by nodes, never by time, so the result
doesn't depend on machine speed. Games over 240 plies were scored as draws, and a game was
adjudicated once both engines' own scores agreed on a 15-pawn advantage for 6 plies. Ratings
come from a Bradley–Terry (Elo) fit over all 1,840 games, anchored at full strength = 3000,
with standard errors from a bootstrap over games. The raw games are in
`web/calibration/calibration.json`, and `node web/calibrate.js --apply` writes the ratings into
`web/engine-tasks.js`.

| Point | Nodes | Temp | Elo | ± |
|---|---:|---:|---:|---:|
| L0 | depth 1 | 600 | 81 | 118 |
| L1 | depth 1 | 400 | 141 | 120 |
| L2 | depth 1 | 280 | 171 | 114 |
| L3 | depth 1 | 200 | 243 | 121 |
| L4 | 500 | 160 | 335 | 107 |
| L5 | 1,000 | 130 | 464 | 107 |
| L6 | 2,000 | 105 | 633 | 102 |
| L7 | 3,500 | 88 | 766 | 100 |
| L8 | 6,000 | 74 | 939 | 100 |
| L9 | 10,000 | 62 | 1090 | 95 |
| L10 | 16,000 | 52 | 1315 | 94 |
| L11 | 25,000 | 44 | 1552 | 97 |
| L12 | 40,000 | 37 | 1735 | 92 |
| L13 | 65,000 | 30 | 1962 | 87 |
| L14 | 100,000 | 24 | 2202 | 67 |
| L15 | 160,000 | 18 | 2405 | 59 |
| L16 | 250,000 | 13 | 2569 | 52 |
| L17 | 400,000 | 8 | 2668 | 47 |
| L18 | 650,000 | 4 | 2806 | 48 |
| L19 | 1,000,000 | 0 | **3000** | anchor |

No two neighbouring points are more than about 240 Elo apart, so interpolating between them in
50-point steps stays smooth. The ± column is relative to the anchor, so it grows toward the
bottom; neighbouring points are known relative to each other much more tightly than that.

### The old four opponents

Measured in the same run (40 games against each of three nearby points). Knight is limited by
time as well as depth, so its number depends a little on the machine; it was measured on 4 busy
cores.

| Old opponent | Settings | Elo |
|---|---|---:|
| Page | depth 1, random within 2.6 pawns | 379 ± 118 |
| Squire | depth 2, random within 0.9 pawns | 1201 ± 109 |
| Knight | depth 7 or 1 s, whichever comes first | 2872 ± 56 |
| Champion | 3 s (about 1.8M nodes) | above 3000, not measured |

Page to Squire was about 800 points and Squire to Knight about 1,650, which is the jump players
felt. Games saved with an old opponent, and a remembered old choice, map to 400, 1200, 2850 and
3000.

## What the numbers mean

This is a self-play scale: Stockhorse at one setting against Stockhorse at another. It measures
relative strength well (200 points means the stronger side scores about 76%) but has no
link to human ratings in Maki. No human pool exists yet to tie it to. Self-play scales also tend
to stretch gaps compared to play against people, so a 200-point step may feel smaller in
practice. Once there are rated human games, the ladder can be re-anchored with no change to the
mechanism.

The website's engine is the JavaScript reference engine with the hand-written G0 evaluation, not
the trained networks. When a network is served in the browser, rerun the calibration (expect
about 2.5 hours on 4 cores) and `--apply` it, keeping 3000 as the new full strength.
