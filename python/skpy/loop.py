"""The generation loop and the league.

    python -m skpy.loop init <dir> [--import-pilot runs/pilot] [--set key=value]...
    python -m skpy.loop run <dir> [--until g4] [--generations N]
    python -m skpy.loop report <dir>
    python -m skpy.loop reopen <dir> <model> [--set key=value]...   decide a model again, e.g.
        with a higher gate_max_games: its gate continues from the games already played

One generation, with teacher T (the newest accepted model):

1. data: T plays itself (sk-datagen), round K.
2. window: rounds K, K−1, … (the newest `window` rounds), newest labels first, minus round K's
   validation positions (sk-datagen dedup).
3. train: a new network gN on the window, starting from T's weights when T is a network.
4. gate: gN vs T in chunks of games until the SPRT [elo0, elo1] decides (or `gate_max_games`).
5. league: gN vs every older model, as many games as the schedule owes.
6. decide: accepted if the gate passed and gN scores significantly below 50% against no older
   accepted model. An accepted model becomes the teacher.

Everything lives in the league folder: `league.json` (format 1, the whole state, rewritten
atomically after every step and every chunk of games), `nets/`, `data/`, `train/`, `matches/`,
`logs/`, `report.md`. Rerunning `run` continues where it stopped.
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import REPO, RULESET, binary
from . import league as L
from .train import write_json

FORMAT = 1

DEFAULTS = {
    "positions": 1_200_000,
    "nodes": 5000,
    "threads": os.cpu_count() or 2,
    "window": 3,
    "init_from_teacher": True,
    "epochs": 25,
    "patience": 3,
    "match_nodes": 5000,
    "chunk_games": 200,
    "gate_elo0": 0.0,
    "gate_elo1": 10.0,
    "gate_max_games": 1600,
    "league_recent": 200,
    "league_decay": 0.5,
    "league_minimum": 60,
}

STEPS = ["data", "window", "train", "gate", "league", "decide"]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def log(msg):
    print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


class League:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.path = self.root / "league.json"
        self.state = json.loads(self.path.read_text())
        if self.state.get("format") != FORMAT:
            raise SystemExit(f"{self.path}: unsupported format {self.state.get('format')}")
        self.cfg = {**DEFAULTS, **self.state["config"]}

    def save(self):
        write_json(self.path, self.state)

    # --- models -------------------------------------------------------------------------------

    def model(self, name):
        return next(m for m in self.state["models"] if m["name"] == name)

    def accepted(self):
        return [m["name"] for m in self.state["models"] if m["status"] == "accepted"]

    def net_path(self, name):
        f = self.model(name)["file"]
        return str(self.root / f) if f else "none"

    def engine(self, name):
        net = self.net_path(name)
        return "" if net == "none" else f"setoption name EvalFile value {net}"

    # --- subprocesses -------------------------------------------------------------------------

    def run(self, cmd, logname):
        (self.root / "logs").mkdir(exist_ok=True)
        logfile = self.root / "logs" / logname
        log(f"$ {' '.join(map(str, cmd))}  (log: logs/{logname})")
        with open(logfile, "a") as f:
            f.write(f"\n# {now()} {' '.join(map(str, cmd))}\n")
            f.flush()
            env = {**os.environ, "PYTHONPATH": str(Path(REPO) / "python")}
            r = subprocess.run([str(c) for c in cmd], stdout=f, stderr=subprocess.STDOUT, cwd=REPO, env=env)
        if r.returncode != 0:
            raise SystemExit(f"command failed ({r.returncode}); see {logfile}")

    # --- games --------------------------------------------------------------------------------

    def play(self, a, b, games, seed, kind, generation):
        """One chunk of games, a vs b, recorded in the state."""
        out = self.root / "matches" / f"{a}-vs-{b}-s{seed}.json"
        out.parent.mkdir(exist_ok=True)
        cmd = [binary("sk-match"), "--e1", binary("stockknight"), "--e2", binary("stockknight"),
               "--name1", a, "--name2", b, "--games", games, "--nodes", self.cfg["match_nodes"],
               "--concurrency", self.cfg["threads"], "--seed", seed, "--json", out]
        if self.engine(a):
            cmd += ["--init1", self.engine(a)]
        if self.engine(b):
            cmd += ["--init2", self.engine(b)]
        self.run(cmd, f"{generation}-{kind}.log")
        r = json.loads(out.read_text())
        self.state["games"].append({
            "a": a, "b": b, "w": r["wins"], "d": r["draws"], "l": r["losses"],
            "condition": r["condition"], "kind": kind, "generation": generation,
            "file": str(out.relative_to(self.root)), "date": now(), "seed": seed, "seconds": r["seconds"],
        })
        self.save()
        log(f"{a} vs {b}: +{r['wins']} ={r['draws']} -{r['losses']}")

    def seed(self, *parts):
        h = hashlib.sha256("/".join(map(str, parts)).encode()).digest()
        return int.from_bytes(h[:4], "little") % 1_000_000_000

    # --- the generation -----------------------------------------------------------------------

    def current(self):
        gens = self.state["generations"]
        if gens and gens[-1]["step"] != "done":
            return gens[-1]
        return None

    def start_generation(self):
        n = max(int(m["name"][1:]) for m in self.state["models"]) + 1
        rnd = max((r["round"] for r in self.state["rounds"]), default=0) + 1
        g = {"name": f"g{n}", "teacher": self.state["teacher"], "round": rnd, "step": "data",
             "started": now()}
        self.state["generations"].append(g)
        self.save()
        log(f"generation {g['name']}: teacher {g['teacher']}, round {rnd}")
        return g

    def step_data(self, g):
        prefix = self.root / "data" / f"round{g['round']}"
        prefix.parent.mkdir(exist_ok=True)
        info = Path(f"{prefix}.info.txt")
        if not info.exists():
            self.run([binary("sk-datagen"), "run", "--eval-file", self.net_path(g["teacher"]), "--out", prefix,
                      "--positions", self.cfg["positions"], "--nodes", self.cfg["nodes"],
                      "--threads", self.cfg["threads"], "--seed", g["round"]], f"{g['name']}-data.log")
        stats = dict(line.split(": ", 1) for line in info.read_text().splitlines() if ": " in line)
        self.state["rounds"] = [r for r in self.state["rounds"] if r["round"] != g["round"]]
        self.state["rounds"].append({
            "round": g["round"], "teacher": g["teacher"], "prefix": f"data/round{g['round']}",
            "positions_train": int(stats["positions_train"]), "positions_val": int(stats["positions_val"]),
            "games": int(stats["games"]), "results_white_view": stats["results_white_view"],
            "seconds": float(stats["seconds"]),
        })

    def step_window(self, g):
        rounds = sorted((r for r in self.state["rounds"] if r["round"] <= g["round"]),
                        key=lambda r: -r["round"])[: self.cfg["window"]]
        out = self.root / "data" / f"window{g['round']}.bin"
        inputs = [self.root / f"{r['prefix']}.train.bin" for r in rounds]
        self.run([binary("sk-datagen"), "dedup", *inputs, out,
                  "--exclude", self.root / f"data/round{g['round']}.val.bin"], f"{g['name']}-window.log")
        g["window"] = [r["round"] for r in rounds]
        g["window_positions"] = out.stat().st_size // 24

    def step_train(self, g):
        out = self.root / "train" / g["name"]
        cmd = [sys.executable, "-m", "skpy.train", "--train", self.root / f"data/window{g['round']}.bin",
               "--val", self.root / f"data/round{g['round']}.val.bin", "--out", out,
               "--epochs", self.cfg["epochs"], "--patience", self.cfg["patience"],
               "--name", f"{g['name']} round {g['round']}", "--seed", g["round"]]
        if self.cfg["init_from_teacher"] and self.net_path(g["teacher"]) != "none":
            cmd += ["--init-from", self.net_path(g["teacher"])]
        if not (out / "summary.json").exists():
            self.run(cmd, f"{g['name']}-train.log")
        (self.root / "nets").mkdir(exist_ok=True)
        shutil.copyfile(out / "best.nnue", self.root / "nets" / f"{g['name']}.nnue")
        summary = json.loads((out / "summary.json").read_text())
        g["train"] = {"val_loss": summary["best"]["val_loss"], "best_epoch": summary["best_epoch"],
                      "epochs_run": summary["epochs_run"], "K": summary["K"]}
        self.state["models"] = [m for m in self.state["models"] if m["name"] != g["name"]]
        self.state["models"].append({"name": g["name"], "file": f"nets/{g['name']}.nnue", "teacher": g["teacher"],
                                     "round": g["round"], "status": "candidate"})

    def step_gate(self, g):
        a, b = g["name"], g["teacher"]
        while True:
            w, d, l = L.result_between(self.state["games"], a, b)
            decision = L.sprt_decision(w, d, l, self.cfg["gate_elo0"], self.cfg["gate_elo1"])
            n = w + d + l
            if decision or n >= self.cfg["gate_max_games"]:
                break
            chunk = min(self.cfg["chunk_games"], self.cfg["gate_max_games"] - n)
            self.play(a, b, chunk, self.seed(a, b, n), "gate", a)
        g["gate"] = {"w": w, "d": d, "l": l, "llr": L.llr(w, d, l, self.cfg["gate_elo0"], self.cfg["gate_elo1"]),
                     "decision": decision or "undecided"}
        log(f"gate {a} vs {b}: {g['gate']}")

    def step_league(self, g):
        a = g["name"]
        earlier = [m["name"] for m in self.state["models"] if m["name"] != a]
        owed = L.schedule(a, earlier, self.cfg["league_recent"], self.cfg["league_decay"],
                          self.cfg["league_minimum"])
        for b, games in owed.items():
            while True:
                n = sum(L.result_between(self.state["games"], a, b))
                if n >= games:
                    break
                self.play(a, b, min(self.cfg["chunk_games"], games - n), self.seed(a, b, n), "league", a)

    def step_decide(self, g):
        older = [m for m in self.accepted() if m != g["name"]]
        regs = L.regressions(self.state["games"], g["name"], older)
        accepted = g["gate"]["decision"] == "H1" and not regs
        g["regressions"] = regs
        g["decision"] = "accepted" if accepted else "rejected"
        self.model(g["name"])["status"] = g["decision"]
        if accepted:
            self.state["teacher"] = g["name"]
        log(f"{g['name']} {g['decision']}" + (f" (regressions: {regs})" if regs else ""))

    def run_generation(self, g):
        while g["step"] != "done":
            step = g["step"]
            t = time.time()
            log(f"{g['name']}: {step}")
            getattr(self, f"step_{step}")(g)
            g.setdefault("seconds", {})[step] = round(time.time() - t, 1) + g.get("seconds", {}).get(step, 0)
            i = STEPS.index(step)
            g["step"] = STEPS[i + 1] if i + 1 < len(STEPS) else "done"
            if g["step"] == "done":
                g["finished"] = now()
            self.save()
            self.write_report()

    # --- the report ---------------------------------------------------------------------------

    def write_report(self):
        models = [m["name"] for m in self.state["models"]]
        ratings = L.fit_ratings(self.state["games"], models)
        lines = [f"# League report ({RULESET})", "", f"Updated {now()}. Teacher: **{self.state['teacher']}**. "
                 f"Games at {self.cfg['match_nodes']} nodes per move.", "", "## Ratings", "",
                 "Joint maximum-likelihood Elo, G0 = 0.", "", "| Model | Status | Elo | ± (1 s.e.) | Games |",
                 "|---|---|---|---|---|"]
        for m in self.state["models"]:
            e, se = ratings[m["name"]]
            n = sum(g["w"] + g["d"] + g["l"] for g in self.state["games"] if m["name"] in (g["a"], g["b"]))
            lines.append(f"| {m['name']} | {m['status']} | {e:+.0f} | {se:.0f} | {n} |")
        lines += ["", "## Head to head", "", "Score of the row model against the column model (games).", "",
                  "| | " + " | ".join(models) + " |", "|---" * (len(models) + 1) + "|"]
        for a in models:
            row = [a]
            for b in models:
                w, d, l = L.result_between(self.state["games"], a, b)
                row.append("" if a == b or not w + d + l else f"{(w + d / 2) / (w + d + l):.2f} ({w + d + l})")
            lines.append("| " + " | ".join(row) + " |")
        lines += ["", "## Generations", "",
                  "| Model | Teacher | Round | Window | Val loss | Gate (W-D-L, LLR) | Decision | Hours |",
                  "|---|---|---|---|---|---|---|---|"]
        for g in self.state["generations"]:
            gate = g.get("gate")
            gate_s = f"{gate['w']}-{gate['d']}-{gate['l']}, {gate['llr']:.2f} {gate['decision']}" if gate else ""
            tr = g.get("train", {})
            hours = sum(g.get("seconds", {}).values()) / 3600
            lines.append(f"| {g['name']} | {g['teacher']} | {g['round']} | {g.get('window', '')} | "
                         f"{tr.get('val_loss', float('nan')):.6f} | {gate_s} | {g.get('decision', g['step'])} | "
                         f"{hours:.2f} |")
        lines += ["", "## Data rounds", "", "| Round | Teacher | Games | Train positions | Results (White's view) | Minutes |",
                  "|---|---|---|---|---|---|"]
        for r in self.state["rounds"]:
            lines.append(f"| {r['round']} | {r['teacher']} | {r['games']} | {r['positions_train']:,} | "
                         f"{r['results_white_view']} | {r['seconds'] / 60:.0f} |")
        tmp = self.root / "report.md.tmp"
        tmp.write_text("\n".join(lines) + "\n")
        os.replace(tmp, self.root / "report.md")


def parse_value(v):
    for t in (int, float):
        try:
            return t(v)
        except ValueError:
            pass
    return {"true": True, "false": False}.get(v.lower(), v)


def init(a):
    root = Path(a.dir).resolve()
    if (root / "league.json").exists():
        raise SystemExit(f"{root} already holds a league")
    root.mkdir(parents=True, exist_ok=True)
    cfg = {}
    for kv in a.set or []:
        k, v = kv.split("=", 1)
        if k not in DEFAULTS:
            raise SystemExit(f"unknown setting {k}")
        cfg[k] = parse_value(v)
    state = {"format": FORMAT, "ruleset": RULESET, "created": now(), "config": {**DEFAULTS, **cfg},
             "models": [{"name": "g0", "file": None, "teacher": None, "round": None, "status": "accepted"}],
             "teacher": "g0", "rounds": [], "generations": [], "games": []}
    write_json(root / "league.json", state)
    if a.import_pilot:
        lg = League(root)
        pilot = Path(a.import_pilot).resolve()
        (root / "data").mkdir(exist_ok=True)
        for ext in ("train.bin", "val.bin", "info.txt"):
            shutil.copyfile(pilot / f"round1.{ext}", root / "data" / f"round1.{ext}")
        g = {"name": "g1", "teacher": "g0", "round": 1, "step": "data", "started": now(), "imported": str(pilot)}
        lg.state["generations"].append(g)
        lg.step_data(g)
        (root / "train").mkdir(exist_ok=True)
        shutil.copytree(pilot / "train" / "g1", root / "train" / "g1")
        g["window"] = [1]
        g["window_positions"] = lg.state["rounds"][0]["positions_train"]
        g["step"] = "train"
        lg.step_train(g)
        g["step"] = "gate"
        lg.save()
        log("imported round 1 and g1; run continues with g1's gate and league")
    log(f"league created at {root}")


def reopen(lg, a):
    """Send the newest generation back to its gate (its games so far still count)."""
    g = lg.state["generations"][-1]
    if g["name"] != a.model or g["step"] != "done":
        raise SystemExit(f"only the newest finished generation can be reopened ({g['name']}, {g['step']})")
    for kv in a.set or []:
        k, v = kv.split("=", 1)
        if k not in DEFAULTS:
            raise SystemExit(f"unknown setting {k}")
        lg.state["config"][k] = parse_value(v)
    if g.get("decision") == "accepted":
        lg.state["teacher"] = g["teacher"]
    g["step"] = "gate"
    g.pop("decision", None)
    g.setdefault("reopened", []).append(now())
    lg.model(g["name"])["status"] = "candidate"
    lg.save()
    log(f"{g['name']} reopened at its gate; settings {lg.state['config']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("dir")
    p.add_argument("--import-pilot", default="")
    p.add_argument("--set", action="append")
    p = sub.add_parser("run")
    p.add_argument("dir")
    p.add_argument("--until", default="", help="stop once this model is decided, e.g. g4")
    p.add_argument("--generations", type=int, default=0, help="at most this many new generations")
    p = sub.add_parser("report")
    p.add_argument("dir")
    p = sub.add_parser("reopen")
    p.add_argument("dir")
    p.add_argument("model")
    p.add_argument("--set", action="append")
    a = ap.parse_args()
    if a.cmd == "init":
        return init(a)
    lg = League(a.dir)
    if a.cmd == "reopen":
        return reopen(lg, a)
    if a.cmd == "report":
        lg.write_report()
        return print((lg.root / "report.md").read_text())
    started = 0
    while True:
        g = lg.current()
        if g is None:
            done = [x["name"] for x in lg.state["generations"]]
            if a.until and a.until in done:
                break
            if a.generations and started >= a.generations:
                break
            if not a.until and not a.generations:
                break
            g = lg.start_generation()
            started += 1
        lg.run_generation(g)
    lg.write_report()
    log("done")


if __name__ == "__main__":
    main()
