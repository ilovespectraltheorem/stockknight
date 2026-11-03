"""The generation loop: steps, units, stop conditions and the storage policy.

```text
backfill → stop check → data → window → train → gate → league → decide → (gc, report) → backfill …
```

Every step records its progress in `state.json` after each unit (a shard, an epoch, a chunk of
games); `model.step` names the step to resume. Between units the harness checks the STOP file,
the time limit and free disk.
"""

import json
import math
import os
import shutil
import sys
import time
from pathlib import Path

from .. import binary
from .. import league as L
from . import config as C
from .state import Run
from .util import (StepFailed, atomic_json, file_hash, free_disk_gb, now, run as run_cmd, seed, source_hash)

STEPS = ["data", "window", "train", "gate", "league", "decide"]


class Stop(Exception):
    """A stop condition: the run ends cleanly between units."""


# --- pure helpers (tested) ----------------------------------------------------------------------

def round_target(cfg, done_rounds: int) -> int:
    d = cfg["datagen"]
    t = int(round(d["positions"] * (1 + d["growth"]) ** done_rounds))
    return min(t, d["max_positions"]) if d["max_positions"] else t


def shard_size(rate, minutes, remaining, first) -> int:
    """Positions for the next shard: `minutes` at the measured `rate` (positions per second),
    `first` before any rate is known. A last shard that would be tiny is folded into this one."""
    size = first if not rate else max(100, int(rate * minutes * 60))
    if remaining - size < size // 4:
        size = remaining
    return max(1, min(size, remaining))


def window_rounds(rounds, current: int, n: int) -> list:
    """Round numbers of the training window: the newest `n` finished rounds up to `current`."""
    done = sorted((r["round"] for r in rounds if r.get("status") == "done" and r["round"] <= current
                   and not r.get("deleted")), reverse=True)
    return done[:n]


def condition_args(condition: str) -> list:
    kind, value = C.parse_condition(condition)
    return [f"--{kind}", value]


def parse_info(path) -> dict:
    """An sk-datagen `.info.txt` as a dict (numbers converted)."""
    out = {}
    for line in Path(path).read_text().splitlines():
        if ": " not in line:
            continue
        k, v = line.split(": ", 1)
        try:
            out[k] = int(v)
        except ValueError:
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


def aggregate_infos(infos: list) -> dict:
    """Totals over the shards of a round: games, positions, results and endings."""
    total = {"shards": len(infos), "games": 0, "discarded_openings": 0, "positions_train": 0, "positions_val": 0,
             "seconds": 0.0, "results": {"white": 0, "draw": 0, "black": 0}, "endings": {}}
    plies = 0
    for i in infos:
        for k in ("games", "discarded_openings", "positions_train", "positions_val"):
            total[k] += int(i.get(k, 0))
        total["seconds"] += float(i.get("seconds", 0))
        plies += float(i.get("average_plies", 0)) * int(i.get("games", 0))
        words = str(i.get("results_white_view", "")).split()
        for name in ("white", "draw", "black"):
            if name in words:
                total["results"][name] += int(words[words.index(name) + 1])
        for k, v in i.items():
            if k.startswith("ending "):
                total["endings"][k[7:]] = total["endings"].get(k[7:], 0) + int(str(v).split()[0])
    total["average_plies"] = plies / total["games"] if total["games"] else 0
    for k in ("evaluator", "eval_file", "nodes", "ruleset"):
        if infos and k in infos[0]:
            total[k] = infos[0][k]
    return total


def net_sizes(path):
    """(ft, l1, l2) from a .nnue header."""
    with open(path, "rb") as f:
        head = f.read(24)
    return tuple(int.from_bytes(head[i:i + 4], "little") for i in (12, 16, 20))


def results_under(state, condition):
    return [g for g in state["results"] if g["condition"] == condition]


def league_owed(state, cfg, name) -> dict:
    """Games `name` still owes each earlier model under the schedule."""
    names = [m["name"] for m in state["models"] if m["status"] != "abandoned"]
    earlier = names[: names.index(name)]
    lg = cfg["league"]
    owed = L.schedule(name, earlier, lg["recent"], lg["decay"], lg["minimum"])
    games = results_under(state, state["condition"])
    out = {}
    for b, n in owed.items():
        played = sum(L.result_between(games, name, b))
        if played < n:
            out[b] = n - played
    return out


def plateau(state, n) -> bool:
    decided = [m["status"] for m in state["models"][1:] if m["status"] in ("accepted", "rejected")]
    return n > 0 and len(decided) >= n and all(s == "rejected" for s in decided[-n:])


def storage_plan(state, cfg, root) -> list:
    """Files the storage policy deletes now."""
    root = Path(root)
    st = cfg["storage"]
    out = []
    decided = {m["name"] for m in state["models"] if m["status"] in ("accepted", "rejected", "abandoned")}
    for r in state["rounds"]:
        d = root / "data" / f"round{r['round']}"
        if r.get("status") == "done" and not st["keep_shards"] and d.is_dir():
            out += sorted(p for p in d.iterdir() if p.is_file())
    for m in state["models"]:
        t = root / "train" / m["name"]
        if m["name"] in decided:
            if not st["keep_windows"] and (t / "window.bin").exists():
                out.append(t / "window.bin")
            if not st["keep_checkpoints"] and (t / "checkpoint.pt").exists():
                out.append(t / "checkpoint.pt")
    if st["keep_rounds"]:
        keep = max(st["keep_rounds"], cfg["training"]["window_rounds"])
        done = sorted((r for r in state["rounds"] if r.get("status") == "done"), key=lambda r: -r["round"])
        busy = any(m["status"] == "in progress" for m in state["models"])
        for r in done[keep:] if not busy else []:
            for ext in ("train.bin", "val.bin"):
                p = root / "data" / f"round{r['round']}.{ext}"
                if p.exists():
                    out.append(p)
    if not st["keep_game_logs"] and (root / "matches").is_dir():
        out += sorted((root / "matches").glob("*.games.txt"))
    out += sorted(p for p in root.rglob("*.tmp") if p.is_file())
    return out


# --- the harness --------------------------------------------------------------------------------

class Harness:
    def __init__(self, run: Run, overrides=(), generations=0, hours=0.0, log=print):
        self.run = run
        self.overrides = list(overrides)
        self.limit_generations = generations
        self.started = time.time()
        self.hours = hours
        self.generations_started = 0
        self.log = log
        self.cfg = None
        self.reload()

    @property
    def state(self):
        return self.run.state

    # --- configuration --------------------------------------------------------------------------

    def reload(self):
        """Re-read run.toml; a broken edit is logged and the previous configuration kept."""
        try:
            cfg = C.resolve(self.run.config(self.overrides))
        except C.ConfigError as e:
            self.run.event("config_error", problems=e.problems)
            self.log(f"run.toml has problems, keeping the previous configuration: {'; '.join(e.problems)}")
            if self.cfg is None:
                raise
            return
        if cfg["match"]["condition"] != self.state["condition"]:
            if self.state["results"]:
                self.log(f"match.condition is frozen at {self.state['condition']!r} (this run has games)")
                cfg["match"]["condition"] = self.state["condition"]
            else:
                self.state["condition"] = cfg["match"]["condition"]
        before = self.cfg if self.cfg is not None else self.state.get("config")
        if before and cfg != before:
            changed = {f"{s}.{k}": v for s, ks in cfg.items() for k, v in ks.items() if before.get(s, {}).get(k) != v}
            self.run.event("config_changed", changed=changed)
            self.log(f"configuration changed: {changed}")
        self.cfg = cfg
        self.state["config"] = cfg

    def seed(self, *parts):
        return seed(self.cfg["run"]["seed"], *parts)

    # --- stop conditions ------------------------------------------------------------------------

    def check(self):
        """Between units: the STOP file, the time limit and free disk."""
        if self.run.stop_requested():
            self.run.clear_stop()
            raise Stop("stop requested")
        hours = self.hours or self.cfg["stop"]["hours"]
        if hours and time.time() - self.started >= hours * 3600:
            raise Stop(f"time limit ({hours} h)")
        limit = self.cfg["hardware"]["min_free_disk_gb"]
        if limit and free_disk_gb(self.run.root) < limit:
            raise Stop(f"free disk below {limit} GB")

    def stop_reason(self):
        if self.limit_generations and self.generations_started >= self.limit_generations:
            return f"{self.limit_generations} generation(s) done"
        g = self.cfg["stop"]["generations"]
        if g and len(self.state["models"]) - 1 >= g:
            return f"stop.generations ({g}) reached"
        if plateau(self.state, self.cfg["stop"]["plateau"]):
            return f"plateau: {self.cfg['stop']['plateau']} rejections in a row"
        return None

    # --- the loop -------------------------------------------------------------------------------

    def loop(self):
        while True:
            self.reload()
            self.check()
            if self.cfg["league"]["backfill"]:
                self.backfill()
            m = self.run.in_progress()
            if m is None:
                reason = self.stop_reason()
                if reason:
                    raise Stop(reason)
                m = self.start_generation()
            self.generation(m)

    def start_generation(self):
        n = max(int(m["name"][1:]) for m in self.state["models"]) + 1
        k = max((r["round"] for r in self.state["rounds"]), default=0) + 1
        teacher = self.run.teacher()
        # Growth counts the rounds this run made itself, so an imported league's rounds don't count.
        done = sum(1 for r in self.state["rounds"] if r.get("status") == "done" and not r.get("imported"))
        m = {"name": f"g{n}", "status": "in progress", "teacher": teacher, "round": k, "step": "data",
             "net": None, "steps": {}, "created": now(), "source_hash": source_hash(), "host": os.uname().nodename}
        self.state["models"].append(m)
        self.state["rounds"].append({"round": k, "teacher": teacher, "generation": m["name"], "status": "generating",
                                     "target": round_target(self.cfg, done), "shards": []})
        self.generations_started += 1
        self.run.save()
        self.run.event("generation_start", model=m["name"], teacher=teacher, round=k)
        self.log(f"generation {m['name']}: teacher {teacher}, round {k}")
        return m

    def generation(self, m):
        while m["status"] == "in progress":
            step = m["step"]
            t = m.setdefault("steps", {}).setdefault(step, {"seconds": 0.0})
            t.setdefault("started", now())
            self.run.event("step_start", model=m["name"], step=step)
            self.log(f"{m['name']}: {step}")
            t0 = time.time()
            try:
                getattr(self, f"step_{step}")(m)
            except StepFailed as e:
                m["error"] = {"step": step, "message": str(e)[-2000:], "time": now()}
                self.run.event("error", model=m["name"], step=step, message=str(e)[-2000:])
                raise
            finally:
                t["seconds"] = round(t["seconds"] + time.time() - t0, 1)
                self.run.save()
            t["finished"] = now()
            m.pop("error", None)
            self.run.event("step_end", model=m["name"], step=step, seconds=t["seconds"])
            if step != "decide":
                m["step"] = STEPS[STEPS.index(step) + 1]
            self.run.save()
        self.after_generation()

    def after_generation(self):
        self.gc()
        from .report import write_all
        try:
            write_all(self.run, self.cfg)
        except Exception as e:  # a report must never stop a run
            self.run.event("report_error", message=repr(e))

    # --- data -----------------------------------------------------------------------------------

    def datagen_args(self):
        d = self.cfg["datagen"]
        return ["--nodes", d["nodes"], "--threads", self.cfg["hardware"]["threads"],
                "--random-plies", d["random_plies"], "--opening-limit", d["opening_limit"],
                "--max-plies", d["max_plies"], "--adjudicate", d["adjudicate"],
                "--adjudicate-plies", d["adjudicate_plies"], "--quiet-draw", d["quiet_draw"],
                "--record-quiet-limit", d["record_quiet_limit"], "--val-fraction", d["val_fraction"]]

    def step_data(self, m):
        r = self.run.round(m["round"])
        k = r["round"]
        folder = self.run.path("data", f"round{k}")
        folder.mkdir(parents=True, exist_ok=True)
        while sum(s["positions"] for s in r["shards"]) < r["target"]:
            self.reload()
            self.check()
            i = len(r["shards"])
            prefix = folder / f"shard-{i:03d}"
            info = Path(f"{prefix}.info.txt")
            sd = self.seed("round", k, "shard", i)
            if not info.exists():
                done = sum(s["positions"] for s in r["shards"])
                rate = r["shards"][-1]["rate"] if r["shards"] else 0
                size = shard_size(rate, self.cfg["datagen"]["shard_minutes"], r["target"] - done,
                                  self.cfg["datagen"]["shard_positions"])
                self.run.state["live"] = {"shard": self.run.rel(prefix) + ".train.bin", "size": size}
                run_cmd([binary("sk-datagen"), "run", "--eval-file", self.run.net(m["teacher"]), "--out", prefix,
                         "--positions", size, "--seed", sd, *self.datagen_args()],
                        self.run.path("logs", f"round{k}-datagen.log"), poll=self.check_now)
            else:
                self.log(f"adopting finished shard {prefix.name}")
            inf = parse_info(info)
            s = {"index": i, "prefix": self.run.rel(prefix), "positions": inf["positions_train"],
                 "val": inf["positions_val"], "games": inf["games"], "seconds": inf["seconds"],
                 "rate": inf["positions_per_second"], "seed": sd, "finished": now()}
            r["shards"].append(s)
            self.state.pop("live", None)
            self.run.save()
            self.run.event("shard_done", round=k, **{x: s[x] for x in ("index", "positions", "games", "seconds", "rate")})
            self.log(f"round {k} shard {i}: {s['positions']:,} positions in {s['seconds']:.0f} s")
        self.merge_round(r)

    def check_now(self):
        """While a child runs: only an interrupt-now style stop (handled by signals) and disk."""
        limit = self.cfg["hardware"]["min_free_disk_gb"]
        if limit and free_disk_gb(self.run.root) < limit / 2:
            raise Stop(f"free disk below {limit / 2} GB")

    def merge_round(self, r):
        k = r["round"]
        train = self.run.path("data", f"round{k}.train.bin")
        val = self.run.path("data", f"round{k}.val.bin")
        prefixes = [self.run.path(s["prefix"]) for s in r["shards"]]
        log = self.run.path("logs", f"round{k}-dedup.log")
        run_cmd([binary("sk-datagen"), "dedup", *[f"{p}.val.bin" for p in prefixes], val], log)
        run_cmd([binary("sk-datagen"), "dedup", *[f"{p}.train.bin" for p in prefixes], train, "--exclude", val], log)
        info = aggregate_infos([parse_info(f"{p}.info.txt") for p in prefixes])
        info["positions_train_dedup"] = train.stat().st_size // 24
        info["positions_val_dedup"] = val.stat().st_size // 24
        atomic_json(self.run.path("data", f"round{k}.info.json"), info)
        r.update({"status": "done", "train": self.run.rel(train), "val": self.run.rel(val),
                  "info": self.run.rel(self.run.path("data", f"round{k}.info.json")),
                  "positions_train": info["positions_train_dedup"], "positions_val": info["positions_val_dedup"],
                  "games": info["games"], "results": info["results"], "seconds": info["seconds"]})
        self.run.save()
        self.run.event("round_done", round=k, positions=r["positions_train"], games=r["games"])

    # --- window and training --------------------------------------------------------------------

    def step_window(self, m):
        k = m["round"]
        rounds = window_rounds(self.state["rounds"], k, self.cfg["training"]["window_rounds"])
        out_dir = self.run.path("train", m["name"])
        out_dir.mkdir(parents=True, exist_ok=True)
        cap = self.cfg["training"]["window_positions"]
        if len(rounds) == 1 and not cap:
            f, merged = self.run.path("data", f"round{k}.train.bin"), False
        else:
            f, merged = out_dir / "window.bin", True
            if not f.exists():
                inputs = [self.run.path("data", f"round{x}.train.bin") for x in rounds]
                tmp = out_dir / "window.bin.part"
                run_cmd([binary("sk-datagen"), "dedup", *inputs, tmp, "--exclude",
                         self.run.path("data", f"round{k}.val.bin")], self.run.path("logs", f"{m['name']}-window.log"))
                if cap and tmp.stat().st_size > cap * 24:
                    with open(tmp, "r+b") as fh:
                        fh.truncate(cap * 24)
                os.replace(tmp, f)
        m["data_rounds"] = rounds
        m["window"] = {"file": self.run.rel(f), "positions": f.stat().st_size // 24, "merged": merged}

    def step_train(self, m):
        tc = self.cfg["training"]
        out = self.run.path("train", m["name"])
        window = self.run.path(m["window"]["file"])
        if not (out / "summary.json").exists():
            if not window.exists():
                m["step"] = "window"
                raise StepFailed(f"training window {window} is gone; run again to rebuild it")
            cmd = [sys.executable, "-m", "skpy.train", "--train", window,
                   "--val", self.run.path("data", f"round{m['round']}.val.bin"), "--out", out,
                   "--epochs", tc["epochs"], "--patience", tc["patience"], "--batch", tc["batch"], "--lr", tc["lr"],
                   "--decay", tc["lr_decay"], "--decay-every", tc["decay_every"], "--lambda", tc["lambda"],
                   "--K", tc["K"], "--ft", tc["ft"], "--l1", tc["l1"], "--l2", tc["l2"],
                   "--output-scale", tc["output_scale"], "--seed", self.seed("train", m["name"]),
                   "--name", f"{self.run.name} {m['name']} round {m['round']}"]
            if self.cfg["hardware"]["train_threads"]:
                cmd += ["--threads", self.cfg["hardware"]["train_threads"]]
            if self.cfg["storage"]["keep_checkpoints"]:
                cmd += ["--keep-checkpoint"]
            teacher_net = self.run.net(m["teacher"])
            init = tc["init"] == "teacher" and teacher_net != "none"
            if init:
                init = net_sizes(teacher_net) == (tc["ft"], tc["l1"], tc["l2"])
            if init:
                cmd += ["--init-from", teacher_net]
            run_cmd(cmd, self.run.path("logs", f"{m['name']}-train.log"))
        summary = json.loads((out / "summary.json").read_text())
        nets = self.run.path("nets")
        nets.mkdir(exist_ok=True)
        net = nets / f"{m['name']}.nnue"
        shutil.copyfile(out / "best.nnue", net)
        m["net"] = self.run.rel(net)
        m["net_hash"] = file_hash(net)
        m["training"] = {k: summary.get(k) for k in ("train_positions", "val_positions", "K", "lambda", "best_epoch",
                                                      "epochs_run", "best", "g0", "architecture", "rust_max_difference")}
        m["training"]["init"] = "teacher" if summary.get("init_from") else "fresh"
        self.run.event("trained", model=m["name"], val_loss=summary["best"]["val_loss"], best_epoch=summary["best_epoch"])

    # --- games ----------------------------------------------------------------------------------

    def play(self, a, b, games, kind, generation):
        """One chunk of games a vs b, recorded in the results."""
        mc = self.cfg["match"]
        recorded = {g["file"] for g in self.state["results"]}
        i = 0
        while True:
            name = f"{a}-vs-{b}-{kind}-{i:03d}"
            out = self.run.path("matches", f"{name}.json")
            if self.run.rel(out) not in recorded:
                break
            i += 1
        sd = self.seed("match", a, b, kind, i)
        if out.exists():
            self.log(f"adopting finished chunk {out.name}")
        else:
            out.parent.mkdir(exist_ok=True)
            part = out.with_name(out.name + ".part")
            cmd = [binary("sk-match"), "--e1", binary("stockknight"), "--e2", binary("stockknight"),
                   "--name1", a, "--name2", b, "--games", games, *condition_args(self.state["condition"]),
                   "--concurrency", mc["concurrency"], "--seed", sd, "--random-plies", mc["opening_plies"],
                   "--max-plies", mc["max_plies"], "--adjudicate", mc["adjudicate"], "--json", part]
            if self.cfg["storage"]["keep_game_logs"]:
                cmd += ["--log", self.run.path("matches", f"{name}.games.txt")]
            for which, model in (("1", a), ("2", b)):
                net = self.run.net(model)
                if net != "none":
                    cmd += [f"--init{which}", f"setoption name EvalFile value {net}"]
            run_cmd(cmd, self.run.path("logs", f"{generation}-{kind}.log"), poll=self.check_now)
            os.replace(part, out)
        r = json.loads(out.read_text())
        self.state["results"].append({"a": a, "b": b, "w": r["wins"], "d": r["draws"], "l": r["losses"],
                                      "condition": self.state["condition"], "kind": kind, "generation": generation,
                                      "file": self.run.rel(out), "date": now(), "seed": sd, "seconds": r["seconds"]})
        self.run.save()
        self.run.event("match", a=a, b=b, w=r["wins"], d=r["draws"], l=r["losses"], kind=kind)
        self.log(f"{a} vs {b} ({kind}): +{r['wins']} ={r['draws']} -{r['losses']}")

    def pair(self, a, b):
        return L.result_between(results_under(self.state, self.state["condition"]), a, b)

    def step_gate(self, m):
        g = self.cfg["gate"]
        a, b = m["name"], m["teacher"]
        if g["mode"] == "none":
            m["gate"] = {"decision": "skipped"}
            return
        while True:
            w, d, l = self.pair(a, b)
            n = w + d + l
            decision = L.sprt_decision(w, d, l, g["elo0"], g["elo1"], g["min_games"])
            if decision or n >= g["max_games"]:
                break
            self.reload()
            self.check()
            chunk = min(self.cfg["match"]["chunk_games"], g["max_games"] - n)
            self.play(a, b, chunk + chunk % 2, "gate", a)
        s, lo, hi = L.score_interval(w, d, l)
        m["gate"] = {"decision": decision or "none", "games": n, "w": w, "d": d, "l": l,
                     "llr": round(L.llr(w, d, l, g["elo0"], g["elo1"]), 3), "elo": round(L.elo_of_score(s), 1),
                     "elo_low": round(L.elo_of_score(lo), 1), "elo_high": round(L.elo_of_score(hi), 1),
                     "elo0": g["elo0"], "elo1": g["elo1"]}
        self.run.event("gate", model=a, decision=m["gate"]["decision"], games=n, llr=m["gate"]["llr"])
        self.log(f"gate {a} vs {b}: +{w} ={d} -{l}, LLR {m['gate']['llr']}, {m['gate']['decision']}")

    def owe(self, name):
        for b, n in league_owed(self.state, self.cfg, name).items():
            while n > 0:
                self.reload()
                self.check()
                chunk = min(self.cfg["match"]["chunk_games"], n)
                chunk += chunk % 2
                self.play(name, b, chunk, "league", name)
                n -= chunk

    def step_league(self, m):
        self.owe(m["name"])

    def backfill(self):
        for m in self.state["models"][1:]:
            if m["status"] in ("accepted", "rejected") and league_owed(self.state, self.cfg, m["name"]):
                self.log(f"backfill: league games owed by {m['name']}")
                self.owe(m["name"])

    def step_decide(self, m):
        games = results_under(self.state, self.state["condition"])
        older = [x["name"] for x in self.state["models"] if x["status"] == "accepted" and x["name"] != m["name"]]
        strict = self.cfg["gate"]["strict"] and self.cfg["gate"]["mode"] == "sprt"
        regs = L.regressions(games, m["name"], older) if strict else []
        gate = m["gate"]["decision"]
        if gate not in ("H1", "skipped"):
            status, reason = "rejected", f"gate {gate} after {m['gate'].get('games', 0)} games"
        elif regs:
            status, reason = "rejected", f"scores significantly below 50% against {', '.join(regs)}"
        else:
            status = "accepted"
            reason = "gate skipped (gate.mode = none)" if gate == "skipped" else f"gate H1 after {m['gate']['games']} games"
        ratings = L.fit_ratings(games, [x["name"] for x in self.state["models"] if x["status"] != "abandoned"])
        m.update({"status": status, "reason": reason, "regressions": regs, "finished": now(),
                  "rating_at_decision": ratings[m["name"]][0], "config_hash": file_hash(self.run.config_path)})
        m.pop("step", None)
        self.run.event("decided", model=m["name"], status=status, reason=reason, rating=ratings[m["name"]][0])
        self.log(f"{m['name']} {status}: {reason}")

    # --- storage --------------------------------------------------------------------------------

    def gc(self, dry_run=False):
        plan = storage_plan(self.state, self.cfg, self.run.root)
        size = sum(p.stat().st_size for p in plan if p.exists())
        if dry_run:
            return plan, size
        for p in plan:
            p.unlink(missing_ok=True)
        for r in self.state["rounds"]:
            d = self.run.path("data", f"round{r['round']}")
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
            if r.get("status") == "done" and not self.run.path("data", f"round{r['round']}.train.bin").exists():
                r["deleted"] = True
        if plan:
            self.run.event("gc", files=len(plan), bytes=size)
        self.run.save()
        return plan, size
