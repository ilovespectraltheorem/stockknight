# The generation loop and the league

```sh
python -m skpy.loop init runs/league --import-pilot runs/pilot [--set positions=1200000]...
python -m skpy.loop run runs/league --until g4          # or --generations N
python -m skpy.loop report runs/league                  # rewrite and print report.md
python -m skpy.loop reopen runs/league g4 --set gate_max_games=3200
```

(Run with `python/` on `PYTHONPATH`.) One generation, with teacher T (the newest accepted model):

| Step | What happens |
|---|---|
| data | T plays itself: `sk-datagen run`, round K |
| window | the newest `window` rounds, newest labels first, minus round K's validation positions (`sk-datagen dedup`) |
| train | `skpy.train` on the window; starts from T's weights when T is a network |
| gate | gN vs T in chunks of `chunk_games` until the SPRT [`gate_elo0`, `gate_elo1`] decides, or `gate_max_games` |
| league | gN vs every older model: `league_recent` games against the newest, × `league_decay` per step back, at least `league_minimum` (even numbers); gate games count |
| decide | accepted if the gate passed and gN scores significantly below 50% against no older accepted model; an accepted model becomes the teacher |

`reopen` sends the newest generation back to its gate with new settings. The games it already
played still count, so the same sequential test simply continues.

## The league folder

| Path | Contents |
|---|---|
| `league.json` | Format 1: config, models (name, file, teacher, round, status), teacher, rounds, generations (step, window, training summary, gate, decision, seconds per step), every chunk of games `{a, b, w, d, l, condition, kind, generation, file, date, seed, seconds}` |
| `nets/gN.nnue` | Every model, accepted or not |
| `data/roundK.*`, `data/windowK.bin` | Self-play rounds and training windows |
| `train/gN/` | Trainer output (`summary.json`, metrics, best and last networks) |
| `matches/` | `sk-match` JSON for every chunk |
| `logs/` | One log per generation and step |
| `report.md` | Ratings, head to head, generations, rounds |

`league.json` is rewritten atomically after every step and every chunk of games. Interrupting
`run` and starting it again continues from there: data and training resume from their own
outputs, and gate and league games count what has been played.

## Maths (`skpy.league`)

- Ratings: joint maximum-likelihood Elo (Bradley–Terry on the Elo scale), G0 = 0, one virtual
  draw per pair that has played, standard errors from the curvature. Models not connected to G0
  get NaN.
- Regressions: older models the new one scores below 50% against, with the 95% interval's upper
  end below 0.5.
- SPRT: the same normal-approximation log-likelihood ratio as `sk-match`, α = β = 0.05. A sweep
  gets half a win and half a loss added so it still decides.

## Settings (defaults)

`positions` 1,200,000, `nodes` 5,000, `threads` (all cores), `window` 3, `init_from_teacher`
true, `epochs` 25, `patience` 3, `match_nodes` 5,000, `chunk_games` 200, `gate_elo0` 0,
`gate_elo1` 10, `gate_max_games` 1,600, `league_recent` 200, `league_decay` 0.5,
`league_minimum` 60.
