"""`sk smoke`: an end-to-end run with stop, interrupt and resume (a few minutes).

1. g1 with the SPRT gate (`run --generations 1`).
2. run.toml edited to `gate.mode = "none"` (live reload); a graceful stop during g2's data.
3. Ctrl-C while g2 trains (after its first checkpoint).
4. Resume to the end (stop.generations = 3): round 3 has a network teacher.
5. About 35 checks: states, files, storage policy, report, status, export, redo.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from .. import REPO
from .state import Run

SK = [sys.executable, "-m", "skpy.harness"]


def smoke(keep=False) -> int:
    runs = Path(os.environ.get("SK_RUNS", Path(REPO) / "runs"))
    root = runs / "_smoke"
    if root.exists():
        shutil.rmtree(root)
    env = {**os.environ, "PYTHONPATH": str(Path(REPO) / "python"), "SK_RUNS": str(runs)}
    t0 = time.time()
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok)))
        print(f"  {'ok  ' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)

    def sk(*args, check_code=None):
        r = subprocess.run(SK + [str(a) for a in args], cwd=REPO, env=env, capture_output=True, text=True)
        if check_code is not None and r.returncode != check_code:
            print(r.stdout[-2000:], r.stderr[-2000:])
        return r

    def start(*args):
        return subprocess.Popen(SK + [str(a) for a in args], cwd=REPO, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)

    def state():
        try:
            return json.loads((root / "state.json").read_text())
        except (OSError, json.JSONDecodeError):
            return None

    def model(s, name):
        return next((m for m in s["models"] if m["name"] == name), None)

    print(f"smoke run in {root}")
    r = sk("init", root, "--config", Path(REPO) / "configs" / "smoke.toml", check_code=0)
    check("init creates the run", r.returncode == 0 and (root / "run.toml").exists())

    print("1. one generation with the SPRT gate", flush=True)
    r = sk("run", root, "--generations", "1", check_code=0)
    s = state()
    g1 = model(s, "g1")
    check("first run exits 0", r.returncode == 0)
    check("g1 decided with an SPRT gate", g1 and g1["status"] in ("accepted", "rejected") and g1["gate"]["decision"] in ("H0", "H1", "none"))

    print("2. gate.mode = none (live edit), then a graceful stop during data", flush=True)
    toml = (root / "run.toml").read_text().replace('mode = "sprt"', 'mode = "none"')
    (root / "run.toml").write_text(toml)
    p = start("run", root)
    stopped_in = None
    deadline = time.time() + 300
    while time.time() < deadline and p.poll() is None:
        s = state()
        g2 = s and model(s, "g2")
        rd = s and next((x for x in s["rounds"] if x["round"] == 2), None)
        if g2 and g2.get("step") == "data" and rd and rd["shards"]:
            (root / "STOP").write_text("smoke\n")
            stopped_in = "data"
            break
        time.sleep(0.05)
    code = p.wait(timeout=300)
    s = state()
    g2 = model(s, "g2")
    rd = next(x for x in s["rounds"] if x["round"] == 2)
    check("stop requested during g2's data", stopped_in == "data")
    check("graceful stop exits 0", code == 0, f"exit {code}")
    check("stopped between shards, round 2 unfinished", g2["step"] == "data" and rd["status"] == "generating"
          and 0 < sum(x["positions"] for x in rd["shards"]) < rd["target"])
    check("STOP file consumed", not (root / "STOP").exists())
    check("lock released after the stop", not (root / "LOCK").exists())

    print("3. interrupt (Ctrl-C) while g2 trains", flush=True)
    p = start("run", root)
    where = None
    deadline = time.time() + 300
    while time.time() < deadline and p.poll() is None:
        ck = root / "train" / "g2" / "checkpoint.pt"
        lock = Run(root).lock_info() or {}
        if lock.get("pid") != p.pid:
            time.sleep(0.02)
            continue
        s = state()
        step = s and (model(s, "g2") or {}).get("step")
        if ck.exists() or step in ("gate", "league", "decide"):
            p.send_signal(signal.SIGINT)
            where = "train" if ck.exists() else step
            break
        time.sleep(0.02)
    code = p.wait(timeout=120)
    s = state()
    check("interrupted while training (after a checkpoint)", where == "train", f"interrupted in {where}")
    check("interrupt exits 130", code == 130, f"exit {code}")
    check("lock released after the interrupt", not (root / "LOCK").exists())
    check("no engine or trainer left running", subprocess.run(["pgrep", "-f", str(root / "train" / "g2")],
                                                               capture_output=True).returncode != 0)

    print("4. resume to the end", flush=True)
    r = sk("run", root, check_code=0)
    s = state()
    check("resumed run exits 0", r.returncode == 0)
    names = [m["name"] for m in s["models"]]
    check("three generations", names == ["g0", "g1", "g2", "g3"], str(names))
    check("g2 and g3 accepted with the gate off", all(model(s, n)["status"] == "accepted" and model(s, n)["gate"]["decision"] == "skipped"
                                                      for n in ("g2", "g3")))
    teacher3 = next(x for x in s["rounds"] if x["round"] == 3)["teacher"]
    check("round 3 made by a network teacher", teacher3 == "g2", teacher3)
    check("g3 trained from its teacher's weights", (model(s, "g3")["training"] or {}).get("init") == "teacher")
    check("every round done", [x["status"] for x in s["rounds"]] == ["done"] * 3)
    check("rounds deduplicated and on disk", all((root / f"data/round{k}.train.bin").exists() and (root / f"data/round{k}.val.bin").exists()
                                                 and (root / f"data/round{k}.info.json").exists() for k in (1, 2, 3)))
    check("shards deleted after merging (storage policy)", not any((root / "data").glob("round*/shard-*")))
    check("windows deleted after training", not any((root / "train").glob("*/window.bin")))
    check("no trainer checkpoints left", not any((root / "train").glob("*/checkpoint.pt")))
    check("networks saved", all((root / f"nets/g{i}.nnue").exists() for i in (1, 2, 3)))
    check("training summaries", all((root / f"train/g{i}/summary.json").exists() for i in (1, 2, 3)))
    check("every step timed", all(set(model(s, n)["steps"]) == {"data", "window", "train", "gate", "league", "decide"}
                                  for n in ("g1", "g2", "g3")))
    league = [g for g in s["results"] if g["kind"] == "league"]
    check("league games against older models", any(g["a"] == "g3" and g["b"] == "g0" for g in league))
    check("match files recorded", all((root / g["file"]).exists() for g in s["results"]))
    ev = Run(root).events()
    kinds = [e["event"] for e in ev]
    ends = [e["code"] for e in ev if e["event"] == "run_end"]
    check("run_end codes 0, 0, 130, 0", ends == [0, 0, 130, 0], str(ends))
    check("config change logged", "config_changed" in kinds)
    check("shard, round, training, match and decision events", all(k in kinds for k in ("shard_done", "round_done", "trained", "match", "decided")))
    check("4 invocations recorded", len(s["invocations"]) == 4)
    check("report.md written", "## Ratings" in (root / "report.md").read_text())
    check("dashboard.html written", "application/json" in (root / "dashboard.html").read_text())
    r = sk("status", root)
    check("status works", r.returncode == 0 and "teacher" in r.stdout)
    r = sk("config", root)
    check("config validates", r.returncode == 0)
    r = sk("export", root, "--out", root / "export" / "best")
    man = root / "export" / "best" / "manifest.json"
    check("export writes a network and manifest", r.returncode == 0 and man.exists()
          and (root / "export" / "best" / json.loads(man.read_text())["file"]).exists())
    r = sk("gc", root, "--dry-run")
    check("nothing left for the storage policy", r.returncode == 0 and r.stdout.strip().startswith("0 file"), r.stdout[-200:])

    print("5. redo g3's league", flush=True)
    before = len([g for g in state()["results"] if g["generation"] == "g3" and g["kind"] == "league"])
    r = sk("redo", root, "league")
    s = state()
    check("redo sends g3 back to its league", r.returncode == 0 and model(s, "g3")["status"] == "in progress"
          and model(s, "g3")["step"] == "league")
    check("its league games set aside", before > 0 and len(list((root / "matches" / "discarded").glob("*.json"))) == before)
    r = sk("run", root, check_code=0)
    s = state()
    check("redone generation decided again", r.returncode == 0 and model(s, "g3")["status"] == "accepted")
    check("league games played again", len([g for g in s["results"] if g["generation"] == "g3" and g["kind"] == "league"]) == before)

    failed = [n for n, ok in results if not ok]
    print(f"{len(results) - len(failed)} of {len(results)} checks passed in {time.time() - t0:.0f} s")
    if not keep and not failed:
        shutil.rmtree(root)
    return 1 if failed else 0
