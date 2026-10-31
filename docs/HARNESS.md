# The training harness (`sk`)

`./sk` runs the generation loop (see `docs/LEAGUE.md` for the steps) as a system you can leave
running for days. Each run has one config file, can resume after any interruption, and writes
reports. It runs `python -m skpy.harness` with `python/` on the path, using `.venv` when it
exists. Environment variables: `SK_PYTHON` (interpreter), `SK_BIN` (binaries), `SK_RUNS` (runs
folder, default `runs/`).

```sh
./sk build && ./sk doctor --bench --config configs/large.toml
./sk init big --config configs/large.toml [--import-league runs/league] [--set gate.elo1=6]
./sk run big --detach          # until a stop condition; ./sk stop big to end after the current unit
./sk status big                # live progress, ratings, warnings, disk, recent events
./sk smoke                     # end to end: stop, interrupt, resume (about a minute)
```

## Commands

| Command | |
|---|---|
| `init <run> [--config f] [--set k=v]… [--import-league dir] [--link] [--description t]` | Create a run (`--link` links imported data instead of copying it) |
| `run <run> [--generations N] [--hours H] [--set k=v]… [--detach] [--force]` | Run until a stop condition |
| `status [<run>] [--brief]`, `list` | Progress, ratings, warnings, disk and events, or all runs; `--brief` prints one line |
| `watch <run> [--every quarter\|generation] [--stall M] [--max M] [--interval S]` | Block until a milestone or a problem, print two lines, exit (see below) |
| `stop <run> [--now]` | Stop after the current unit, or interrupt now |
| `log <run> [-n N] [-f]` | Harness log |
| `report <run>` | Rewrite `report.md` and `dashboard.html` |
| `config [<run>\|file] [--reference [--markdown]]` | Validate, show differences from the defaults and machine-resolved values, or list every key |
| `gc <run> [--dry-run]` | Apply the storage policy |
| `export <run> [--model best\|gN] [--out dir]` | Network, manifest, report, dashboard, config and state |
| `match <run> <a> <b> [--games N]` | Extra games, counted in the ratings |
| `redo <run> train\|gate\|league` | Redo a step of the newest generation, and the steps after it; its old games go to `matches/discarded/` |
| `abandon <run>` | Give up the generation in progress |
| `build`, `test [--rust] [--python]`, `doctor [--bench]`, `smoke [--keep]`, `tool <name> …` | Machine and maintenance |

## Watching a run cheaply

`sk watch` is for whoever supervises a long run, a person or an agent. Start it in the background and
wait for it to exit, instead of polling `sk status`. It checks the run every `--interval` seconds (30)
and exits with two lines (what happened, then the `status --brief` line):

| Exit | Meaning |
|---|---|
| 0 | Milestone: the generation crossed a quarter (`--every quarter`, the default) or was decided |
| 1 | Heartbeat: `--max` minutes (115) passed with nothing to report; the run is healthy |
| 2 | Alert: an `error`, `crash` or `config_error` event, no progress for `--stall` minutes (45), or the harness died without `run_end` |
| 3 | The run ended (`run_end`): plateau, stop request or a limit |

Quarters are estimated from the step times of the newest decided generation: positions written
during data, epochs against the expected early stop during training. Watching is read-only.

```sh
./sk watch large --every generation   # one exit per generation, plus alerts
./sk status large --brief             # large · running · g9 train 81% (epoch 3, best val 0.00471) · teacher g8 +439 · 19 GB free
```

## Configuration (`run.toml`)

`skpy/harness/config.py` holds the schema: the default, type, range and help for every key.
Unknown sections or keys are errors, with suggestions, and every problem is reported at once.
`0` means "automatic" for machine-dependent values.

- **Live edits:** `run.toml` is re-read between units. A broken edit is logged and ignored.
- **One-off overrides:** `--set` applies to one invocation only.
- **Frozen condition:** `match.condition` is frozen once the run has rated games.
- **Shipped configs:**
  - `configs/default.toml` (all defaults)
  - `configs/large.toml` (5M-position rounds growing 25% up to 15M; a 4-round window capped at 60M; gate [0, 6] up to 4,000 games; more league games)
  - `configs/smoke.toml` (tiny)

| Key | Default | Range | |
|---|---|---|---|
| `run.description` | `""` |  | Free text shown in reports |
| `run.seed` | `1` | 0– | Base seed; every shard, chunk and training run derives its seed from it |
| `hardware.threads` | `0` | 0– | Threads for data generation and games (0 = all cores) |
| `hardware.train_threads` | `0` | 0– | PyTorch threads (0 = PyTorch's choice) |
| `hardware.min_free_disk_gb` | `2.0` | 0– | Stop the run when free disk falls below this |
| `datagen.positions` | `1200000` | 100– | Training positions per round (first round) |
| `datagen.growth` | `0.0` | 0–10 | Each round is this fraction larger than the one before |
| `datagen.max_positions` | `0` | 0– | Upper limit on a round's size (0 = none) |
| `datagen.shard_minutes` | `10.0` | 0.01– | Length of one shard of data generation, the unit an interruption can lose |
| `datagen.shard_positions` | `100000` | 100– | Size of the first shard, before the speed is known |
| `datagen.nodes` | `5000` | 1– | Nodes per move in self-play |
| `datagen.random_plies` | `8` | 0– | Random opening plies (not recorded) |
| `datagen.opening_limit` | `600` | 0– | Discard openings whose first search scores beyond this (cp) |
| `datagen.max_plies` | `400` | 1– | Game length cap (a draw) |
| `datagen.adjudicate` | `1500` | 0– | Adjudicate when one side is beyond this (cp) |
| `datagen.adjudicate_plies` | `8` | 1– | ... for this many plies |
| `datagen.quiet_draw` | `120` | 1– | Draw after this many quiet plies |
| `datagen.record_quiet_limit` | `40` | 0– | Do not record positions this many quiet plies into a shuffle |
| `datagen.val_fraction` | `0.01` | 0–0.5 | Share of games kept for validation |
| `training.window_rounds` | `3` | 1– | Train on the newest this many rounds |
| `training.window_positions` | `0` | 0– | Upper limit on the training window, newest kept (0 = none) |
| `training.init` | `"teacher"` | teacher / fresh | Start from the teacher's weights, or from random weights |
| `training.lambda` | `0.75` | 0–1 | Weight of the search score against the game result |
| `training.epochs` | `25` | 1– | Most epochs |
| `training.patience` | `3` | 1– | Stop after this many epochs without improvement |
| `training.batch` | `16384` | 1– | Batch size |
| `training.lr` | `0.001` | 0– | Adam learning rate |
| `training.lr_decay` | `0.3` | 0–1 | Learning rate factor every decay_every epochs |
| `training.decay_every` | `5` | 1– | Epochs between learning rate decays |
| `training.K` | `0.0` | 0– | Score scale of the sigmoid (0 = fit on the data) |
| `training.ft` | `256` | 8–1024 | Accumulator size |
| `training.l1` | `32` | 1–128 | First hidden layer |
| `training.l2` | `32` | 1–128 | Second hidden layer |
| `training.output_scale` | `600.0` | 1– | Centipawns per unit of network output |
| `match.condition` | `"nodes 5000"` |  | Search limit of every rated game: 'nodes N', 'movetime MS' or 'depth N'; frozen once the run has games |
| `match.concurrency` | `0` | 0– | Games in parallel (0 = all cores) |
| `match.chunk_games` | `200` | 2– | Games per chunk, the unit an interruption can lose (even) |
| `match.opening_plies` | `8` | 0– | Random opening plies |
| `match.max_plies` | `400` | 1– | Game length cap |
| `match.adjudicate` | `1500` | 0– | Adjudication threshold (cp) |
| `gate.mode` | `"sprt"` | sprt / none | 'sprt': a new model must beat its teacher; 'none': every model is accepted |
| `gate.elo0` | `0.0` |  | SPRT null hypothesis (Elo over the teacher) |
| `gate.elo1` | `10.0` |  | SPRT alternative hypothesis |
| `gate.min_games` | `40` | 2– | Fewest games before the SPRT may decide |
| `gate.max_games` | `1600` | 2– | Most gate games; undecided at this point means rejected |
| `gate.strict` | `true` |  | Also reject a model scoring significantly below 50% against any older accepted model |
| `league.recent` | `200` | 0– | League games against the previous model |
| `league.decay` | `0.5` | 0–1 | Factor per step further back |
| `league.minimum` | `60` | 0– | Fewest games against any older model |
| `league.backfill` | `true` |  | Before each generation, play league games the schedule owes |
| `stop.generations` | `0` | 0– | Stop after this many generations in the run (0 = no limit) |
| `stop.hours` | `0.0` | 0– | Stop after this many hours of one invocation (0 = no limit) |
| `stop.plateau` | `3` | 0– | Stop after this many rejections in a row (0 = never) |
| `storage.keep_shards` | `false` |  | Keep data shards after a round is merged |
| `storage.keep_windows` | `false` |  | Keep merged training windows |
| `storage.keep_checkpoints` | `false` |  | Keep trainer checkpoints |
| `storage.keep_rounds` | `0` | 0– | Keep only the newest this many rounds (0 = all; never fewer than the window) |
| `storage.keep_game_logs` | `true` |  | Keep per-game match logs |

## The run folder

```text
runs/<name>/
├── run.toml, state.json, events.jsonl, report.md, dashboard.html
├── LOCK                  while `sk run` works on it: {pid, host, started}
├── STOP                  a stop request (consumed by the run)
├── nets/gN.nnue          every model's network
├── data/roundK.{train,val}.bin, roundK.info.json; data/roundK/shard-NNN.* while generating
├── train/gN/             trainer output (+ window.bin while training a multi-round window)
├── matches/<a>-vs-<b>-<kind>-NNN.json (+ .games.txt); matches/discarded/
├── logs/harness.log, harness.out (detached), roundK-datagen.log, roundK-dedup.log, gN-window.log, gN-train.log, gN-gate.log, gN-league.log
└── export/
```

`state.json` (format 2) holds:
- the run's name, description and match condition, and the latest config;
- **models**, each with: status (`accepted`, `rejected`, `in progress` or `abandoned`), teacher, round, current step, network and its hash, window, training summary, gate (decision, games, W/D/L, LLR, Elo interval), seconds per step, reason, rating at decision, error;
- **rounds**, each with: teacher, status, target, shards (positions, games, seconds, rate, seed), files and totals;
- **results**: every chunk of games, as a, b, W, D, L, condition, kind, generation, file, seed and seconds;
- **invocations**: start, end, pid, host, source hash, machine, arguments and reason.

`events.jsonl` has one JSON object per line. The events are:
- `init`, `import`, `run_start`, `run_end`;
- `config_changed`, `config_error`, `stale_lock`;
- `generation_start`, `step_start`, `step_end`;
- `shard_done`, `round_done`, `trained`, `match`, `gate`, `decided`;
- `gc`, `error`, `crash`, `redo`, `abandon`, `report_error`.

A line cut off by a crash is skipped.

## Units and resuming

| Step | Unit (what an interruption can lose) | Resume |
|---|---|---|
| data | one shard (`datagen.shard_minutes` at the measured speed) | Finished shards are in the state. A shard whose info file exists but isn't recorded is adopted; an unfinished one is regenerated. The round is then merged and deduplicated. |
| window | the merge | Skipped if the window exists. A single round is used directly. |
| train | one epoch | The trainer continues from `checkpoint.pt`, which is saved atomically. `summary.json` marks completion. |
| gate | one chunk of games | The SPRT is recomputed from recorded totals. A finished chunk not yet recorded is adopted. |
| league | one chunk of games | The schedule is compared with games already played. |
| decide | | Deterministic from the recorded results. |

Between units the harness checks the STOP file, the time limit and free disk.

Before each generation it **backfills**: it plays any league games that the (possibly changed) schedule asks for.

Process control:
- **Children** run in their own process group. Ctrl-C, SIGTERM or SIGHUP stops the whole group, engines included, and exits with 130.
- **Locks:** `LOCK` is created exclusively. A lock whose process is gone on the same host is stale and taken over. One held by another host needs `--force`.
- **Failures:** a failing command saves the end of its log in the model and the events, and the next `sk run` retries the step.

**Stop conditions:**
- `stop.generations`, `stop.hours` or `--hours`, and `--generations`;
- `stop.plateau`, that many rejections in a row;
- the STOP file;
- low disk (`hardware.min_free_disk_gb`).

**Decisions:**
- A model is accepted when the SPRT accepts H1.
- With `gate.strict`, it must also score significantly below 50% against no older accepted model.
- With `gate.mode = "none"`, every model is accepted.

**Storage policy**, applied after each generation and by `sk gc`. It deletes:
- shards of merged rounds;
- training windows;
- trainer checkpoints;
- per-game logs (optional);
- rounds older than `storage.keep_rounds`, never fewer than the training window;
- leftover `.tmp` files.

## Reports

- **`report.md`:** warnings, ratings, a head-to-head matrix, generations (gate, validation loss against G0, time per step) and data rounds.
- **`dashboard.html`:** one self-contained file with the data embedded and charts drawn as inline SVG. It has:
  - KPI tiles and a rating ladder with error bars;
  - validation loss relative to G0, and training curves;
  - time per generation by step, and a head-to-head heatmap;
  - data rounds, warnings and recent events.

  Charts have a table view. There is a light, dark or auto theme. The page reloads every minute while the run is active.
- **`sk status`:** live progress, such as positions in the shard being generated, epochs done, and the gate's score and LLR.
- **Warnings:**
  - an accepted model scoring significantly below 50% against an older one;
  - an accepted model rated clearly below an older one;
  - two or more rejections in a row.

## Importing a Phase 5 league

`sk init <run> --import-league runs/league` brings across the league's:
- networks;
- rounds, with their info aggregated;
- training folders;
- every chunk of games.

The league's condition, gate and schedule override the chosen config. `--set` overrides after that.

## Tests

- **`python/tests/test_harness.py`** (13 tests) covers:
  - shipped configs, bad values with suggestions, the render round trip and overrides;
  - automatic values, round sizes and shard sizing;
  - window selection, info aggregation and condition arguments;
  - plateau and league debts, seeds, locks, torn event lines and the storage policy.
- **`sk smoke`** (43 checks) runs, in order:
  - g1 with the SPRT gate;
  - a live edit to `gate.mode = "none"`;
  - a graceful stop during data generation;
  - Ctrl-C after the trainer's first checkpoint;
  - a resume to three generations, with a network teacher for round 3;
  - checks of states, files, the storage policy, events, reports, status, config, export and `gc`;
  - `redo league` and a re-run.
