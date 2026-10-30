# The network (NNUE) and its training

## Architecture

```text
14,266 sparse inputs per side ─► 256 accumulator (same weights for both sides)
[side to move, other side] = 512 ─► clipped ReLU ─► 32 ─► clipped ReLU ─► 32 ─► clipped ReLU ─► 1
centipawns = output × output_scale (600)
```

Clipped ReLU is `clamp(x, 0, 1)`.

## Inputs (per perspective)

- **Board, 14,256** = 36 king squares × 11 piece kinds × 36 squares:
  `king_sq × 396 + kind × 36 + sq`, squares seen from that side (Black's rotated: `35 − sq`).
  Kinds 0–4 are the perspective's own pawn, knight, bishop, rook, queen; 5–10 the opponent's
  pawn, knight, bishop, rook, queen, king.
- **Reserves, 10**: own (14,256–14,260) then opponent (14,261–14,265): at least one pawn in
  hand, two pawns, a rook, a bishop, and "a rook or bishop drop is allowed".

A position and its 180°-rotated, colour-swapped mirror have identical inputs (tested). Defined in
`crates/nnue/src/features.rs` and `python/skpy/nnue.py` (`batch_torch`); a test checks that the
two agree.

## `.nnue` file

`SKNN` magic, version 1, input count, accumulator size, the two hidden sizes, the output scale,
a description that starts with the ruleset id (`knightchess-1`; other rulesets are refused),
then all weights as little-endian float32: feature transformer `[inputs][ft]` and bias, hidden
layers `[out][in]` and biases, output weights and bias. 256-32-32 networks are about 15 MB.

## Training (`python -m skpy.train`)

```text
p = sigmoid(output × output_scale / K)            the network's prediction (side to move)
t = λ · sigmoid(score / K) + (1 − λ) · result      score: the search score in the record
loss = mean((p − t)²)
```

K is fitted on the data; λ = 0.75. Adam, learning rate 1e-3 × 0.3 every 5 epochs, batch 16,384,
up to 25 epochs, early stopping after 4 epochs without a better validation loss. Hidden weights
are clamped to ±127/64 so they can be quantized later. Each epoch reports the validation loss,
the error against game results alone (`result_mse`) and the mean difference from the search
score; G0 is measured the same way as the baseline. After training, `best.nnue` is evaluated in
Rust and the run fails if Rust and PyTorch differ by more than 1e-3.

```sh
pip install -r requirements.txt && cargo build --release
cd python
python -m skpy.train --train ../runs/pilot/round1.train.bin --val ../runs/pilot/round1.val.bin \
    --out ../runs/pilot/train/g1 --name G1
python -m skpy.check_nnue ../runs/pilot/train/g1/best.nnue ../runs/pilot/round1.val.bin
python -m pytest tests
```

## Using a network

```sh
target/release/stockknight "setoption name EvalFile value g1.nnue" "position startpos" "go depth 8"
target/release/sk-datagen run --eval-file g1.nnue --out round2 --positions 1200000
target/release/sk-match --e1 target/release/stockknight --init1 "setoption name EvalFile value g1.nnue" \
    --e2 target/release/stockknight --games 400 --nodes 5000 --concurrency 4
```

In this phase the engine evaluates a network from scratch at every node (float). Incremental,
quantized inference is Phase 4.
