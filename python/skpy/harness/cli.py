"""The `sk` command."""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

from .. import REPO, binary
from . import VERSION
from . import config as C
from .state import Run, RunError
from .util import (Interrupted, StepFailed, atomic_json, atomic_write, file_hash, fmt_bytes, host, install_signal_handlers,
                   machine, now, source_hash, tail)

CONFIGS = Path(REPO) / "configs"


def runs_dir() -> Path:
    return Path(os.environ.get("SK_RUNS", Path(REPO) / "runs"))


def find_run(name) -> Run:
    p = Path(name)
    if not (p.is_absolute() or p.exists() or "/" in name):
        p = runs_dir() / name
    return Run(p)


def open_run(name) -> Run:
    r = find_run(name)
    r.load()
    return r


def logger(run: Run):
    path = run.path("logs", "harness.log")
    path.parent.mkdir(parents=True, exist_ok=True)

    def log(msg):
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, flush=True)
        with open(path, "a") as f:
            f.write(line + "\n")
    return log


# --- commands -----------------------------------------------------------------------------------

def cmd_init(a):
    run = find_run(a.run)
    if run.exists():
        raise SystemExit(f"{run.root} already holds a run")
    base = Path(a.config) if a.config else CONFIGS / "default.toml"
    try:
        raw = __import__("tomllib").loads(base.read_text())
        overrides = list(a.set or [])
        if a.import_league:
            from .importer import league_overrides
            lg = json.loads((Path(a.import_league) / "league.json").read_text())
            overrides = league_overrides(lg) + overrides
        cfg = C.validate(C.merge(raw, overrides))
    except C.ConfigError as e:
        raise SystemExit("config problems:\n  " + "\n  ".join(e.problems))
    if a.description:
        cfg["run"]["description"] = a.description
    run.root.mkdir(parents=True, exist_ok=True)
    for d in ("nets", "data", "train", "matches", "logs"):
        run.path(d).mkdir(exist_ok=True)
    atomic_write(run.config_path, C.render(cfg))
    run.state = Run.new_state(run.name, cfg["run"]["description"], cfg["match"]["condition"], C.resolve(cfg))
    run.save()
    run.event("init", config=str(base), overrides=a.set or [])
    if a.import_league:
        from .importer import import_league
        import_league(run, a.import_league, link=a.link)
        from .report import write_all
        write_all(run, C.resolve(cfg))
    print(f"created {run.root}" + (f" from {a.import_league}" if a.import_league else ""))


def cmd_run(a):
    run = open_run(a.run)
    if a.detach:
        out = run.path("logs", "harness.out")
        args = [sys.executable, "-m", "skpy.harness", "run", str(run.root)] + \
            sum((["--set", s] for s in a.set or []), []) + \
            (["--generations", str(a.generations)] if a.generations else []) + \
            (["--hours", str(a.hours)] if a.hours else []) + (["--force"] if a.force else [])
        with open(out, "a") as f:
            p = subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 start_new_session=True, cwd=REPO,
                                 env={**os.environ, "PYTHONPATH": str(Path(REPO) / "python")})
        print(f"running detached (pid {p.pid}); output in {out}")
        return
    from .steps import Harness, Stop
    run.acquire(force=a.force)
    log = logger(run)
    install_signal_handlers()
    inv = {"started": now(), "pid": os.getpid(), "host": host(), "version": VERSION, "source_hash": source_hash(),
           "machine": machine(), "args": sys.argv[1:]}
    run.state["invocations"].append(inv)
    run.save()
    run.event("run_start", args=sys.argv[1:], pid=os.getpid())
    t0 = time.time()
    code, reason = 0, ""
    try:
        h = Harness(run, a.set or [], a.generations, a.hours, log)
        h.loop()
    except Stop as e:
        reason = str(e)
    except Interrupted as e:
        code, reason = 130, f"interrupted ({e})"
    except StepFailed as e:
        code, reason = 1, f"step failed: {str(e).splitlines()[0]}"
        log(str(e))
    except C.ConfigError as e:
        code, reason = 2, "config problems: " + "; ".join(e.problems)
    except Exception:
        code, reason = 1, "internal error"
        tb = traceback.format_exc()
        run.event("crash", traceback=tb)
        log(tb)
    finally:
        inv["finished"] = now()
        inv["reason"] = reason
        try:
            run.save()
            from .report import write_all
            write_all(run, C.resolve(run.state["config"]))
        except Exception as e:
            run.event("report_error", message=repr(e))
        run.event("run_end", reason=reason, code=code, seconds=round(time.time() - t0, 1))
        run.release()
    log(f"run ended: {reason} (exit {code})")
    sys.exit(code)


def cmd_status(a):
    from .report import status_text
    if not a.run:
        return cmd_list(a)
    run = open_run(a.run)
    cfg = C.resolve(run.state["config"])
    if a.brief:
        from .watch import brief
        print(brief(run, cfg))
        return
    print(status_text(run, cfg))


def cmd_watch(a):
    from .watch import watch
    run = open_run(a.run)
    code, lines = watch(run, lambda r: C.resolve(r.state["config"]), every=a.every, stall_minutes=a.stall,
                        max_minutes=a.max, interval=a.interval)
    print("\n".join(lines), flush=True)
    sys.exit(code)


def cmd_list(a):
    root = runs_dir()
    rows = []
    for p in sorted(root.iterdir()) if root.is_dir() else []:
        r = Run(p)
        if not r.exists():
            continue
        try:
            s = r.load()
        except (RunError, json.JSONDecodeError) as e:
            rows.append((p.name, "?", "?", str(e)[:40]))
            continue
        busy = "running" if r.running() else "idle"
        rows.append((p.name, busy, r.teacher(), f"{len(s['models']) - 1} models, updated {s['updated']}"))
    if not rows:
        print(f"no runs in {root}")
    for row in rows:
        print("  ".join(f"{c:<14}" for c in row))


def cmd_stop(a):
    run = open_run(a.run)
    info = run.running()
    if a.now:
        if not info:
            raise SystemExit(f"{run.name} is not running")
        if info["host"] != host():
            raise SystemExit(f"{run.name} runs on {info['host']}; stop it there")
        os.kill(int(info["pid"]), signal.SIGTERM)
        print(f"interrupted pid {info['pid']}")
    else:
        run.request_stop()
        print(f"stop requested; {run.name} stops after its current unit" + ("" if info else " (it is not running now)"))


def cmd_log(a):
    run = open_run(a.run)
    path = run.path("logs", "harness.log")
    print(tail(path, a.n), end="")
    if a.follow:
        with open(path) as f:
            f.seek(0, 2)
            try:
                while True:
                    line = f.readline()
                    if line:
                        print(line, end="", flush=True)
                    else:
                        time.sleep(1)
            except KeyboardInterrupt:
                pass


def cmd_report(a):
    from .report import write_all
    run = open_run(a.run)
    write_all(run, C.resolve(run.state["config"]))
    print(f"wrote {run.path('report.md')} and {run.path('dashboard.html')}")


def cmd_config(a):
    if a.reference:
        print(C.reference(markdown=a.markdown))
        return
    if not a.target:
        print(C.render())
        return
    p = Path(a.target)
    if p.suffix == ".toml" and p.exists():
        path = p
    else:
        path = open_run(a.target).config_path
    try:
        cfg = C.load(path)
    except C.ConfigError as e:
        print(f"{path}: {len(e.problems)} problem(s)")
        for x in e.problems:
            print(f"  {x}")
        sys.exit(2)
    print(f"{path}: valid")
    diffs = C.differences(cfg)
    if diffs:
        print("differences from the defaults:")
        for k, v, d in diffs:
            print(f"  {k} = {v!r} (default {d!r})")
    res = C.resolve(cfg)
    for k in (("hardware", "threads"), ("match", "concurrency")):
        if cfg[k[0]][k[1]] != res[k[0]][k[1]]:
            print(f"  {k[0]}.{k[1]} resolves to {res[k[0]][k[1]]} on this machine")


def cmd_gc(a):
    from .steps import Harness
    run = open_run(a.run)
    if run.running() and not a.dry_run:
        raise SystemExit(f"{run.name} is running; it applies the storage policy itself")
    h = Harness(run, log=lambda m: None)
    plan, size = h.gc(dry_run=a.dry_run)
    for p in plan:
        print(("would delete " if a.dry_run else "deleted ") + run.rel(p))
    print(f"{len(plan)} file(s), {fmt_bytes(size)}")


def cmd_export(a):
    from .report import ratings, write_all
    run = open_run(a.run)
    r, _ = ratings(run.state)
    if a.model == "best":
        accepted = [m for m in run.models("accepted") if m["net"]]
        if not accepted:
            raise SystemExit("no trained accepted model")
        m = max(accepted, key=lambda m: r[m["name"]][0])
    else:
        m = run.model(a.model)
    if not m.get("net"):
        raise SystemExit(f"{m['name']} has no network")
    out = Path(a.out) if a.out else run.path("export", m["name"])
    out.mkdir(parents=True, exist_ok=True)
    write_all(run, C.resolve(run.state["config"]))
    shutil.copyfile(run.path(m["net"]), out / f"{m['name']}.nnue")
    for f in ("report.md", "dashboard.html", "run.toml", "state.json"):
        shutil.copyfile(run.path(f), out / f)
    atomic_json(out / "manifest.json", {
        "run": run.name, "model": m["name"], "file": f"{m['name']}.nnue", "sha256_16": file_hash(out / f"{m['name']}.nnue"),
        "status": m["status"], "teacher": m["teacher"], "elo_vs_g0": r[m["name"]][0], "se": r[m["name"]][1],
        "condition": run.state["condition"], "training": m.get("training"), "gate": m.get("gate"),
        "exported": now(), "ruleset": __import__("skpy").RULESET})
    print(f"exported {m['name']} to {out}")


def cmd_match(a):
    from .steps import Harness
    run = open_run(a.run)
    run.acquire()
    install_signal_handlers()
    try:
        h = Harness(run, log=logger(run))
        for x in (a.a, a.b):
            run.model(x)
        left = a.games
        while left > 0:
            chunk = min(h.cfg["match"]["chunk_games"], left)
            chunk += chunk % 2
            h.play(a.a, a.b, chunk, "manual", "manual")
            left -= chunk
    finally:
        run.release()


def _discard_matches(run, model, kinds):
    keep, gone = [], []
    for g in run.state["results"]:
        (gone if g["generation"] == model and g["kind"] in kinds else keep).append(g)
    d = run.path("matches", "discarded")
    d.mkdir(parents=True, exist_ok=True)
    for g in gone:
        f = run.path(g["file"])
        for p in [f, f.with_suffix(".games.txt")]:
            if p.exists():
                p.rename(d / p.name)
    run.state["results"] = keep
    return len(gone)


def cmd_redo(a):
    run = open_run(a.run)
    if run.running():
        raise SystemExit(f"{run.name} is running; stop it first")
    m = [x for x in run.state["models"] if x["status"] != "abandoned"][-1]
    if m["name"] == "g0":
        raise SystemExit("nothing to redo")
    kinds = {"train": ("gate", "league"), "gate": ("gate", "league"), "league": ("league",)}[a.step]
    n = _discard_matches(run, m["name"], kinds)
    if a.step == "train":
        t = run.path("train", m["name"])
        if t.exists():
            t.rename(t.with_name(f"{m['name']}.discarded-{int(time.time())}"))
        m.pop("training", None)
        m["net"] = None
        win = m.get("window") or {}
        step = "train" if win.get("file") and run.path(win["file"]).exists() else "window"
    else:
        step = a.step
    if a.step in ("train", "gate"):
        m.pop("gate", None)
    for k in ("reason", "regressions", "rating_at_decision", "finished"):
        m.pop(k, None)
    m["status"], m["step"] = "in progress", step
    run.save()
    run.event("redo", model=m["name"], step=a.step, discarded_results=n)
    print(f"{m['name']} goes back to {step}; {n} chunk(s) of games set aside in matches/discarded")


def cmd_abandon(a):
    run = open_run(a.run)
    if run.running():
        raise SystemExit(f"{run.name} is running; stop it first")
    m = run.in_progress()
    if not m:
        raise SystemExit("no generation in progress")
    m["status"] = "abandoned"
    m["finished"] = now()
    r = run.round(m["round"])
    if r and r.get("status") != "done":
        r["status"] = "abandoned"
    run.save()
    run.event("abandon", model=m["name"])
    print(f"abandoned {m['name']}")


def cmd_build(a):
    subprocess.run(["cargo", "build", "--release", "--offline"], cwd=REPO, check=True)
    h = source_hash()
    (Path(REPO) / "target" / "release" / ".sk-source-hash").write_text(h + "\n")
    print(f"built from source {h}")


def cmd_test(a):
    both = not a.rust and not a.python
    ok = True
    if a.rust or both:
        ok &= subprocess.run(["cargo", "test", "--release", "--offline"], cwd=REPO).returncode == 0
    if a.python or both:
        ok &= subprocess.run([sys.executable, "-m", "pytest", "-q", "python/tests"], cwd=REPO).returncode == 0
    sys.exit(0 if ok else 1)


def cmd_tool(a):
    mod = {"train": "skpy.train", "records": "skpy.records", "check_nnue": "skpy.check_nnue",
           "league": "skpy.loop"}.get(a.name)
    if not mod:
        raise SystemExit(f"unknown tool {a.name}")
    sys.exit(subprocess.run([sys.executable, "-m", mod, *a.args], cwd=REPO,
                            env={**os.environ, "PYTHONPATH": str(Path(REPO) / "python")}).returncode)


def cmd_doctor(a):
    from .doctor import doctor
    sys.exit(doctor(a))


def cmd_smoke(a):
    from .smoke import smoke
    sys.exit(smoke(keep=a.keep))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sk", description="StockKnight training harness")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init", help="create a run")
    p.add_argument("run")
    p.add_argument("--config")
    p.add_argument("--set", action="append")
    p.add_argument("--import-league")
    p.add_argument("--link", action="store_true", help="link imported data and networks instead of copying")
    p.add_argument("--description", default="")
    p = sub.add_parser("run", help="run until a stop condition")
    p.add_argument("run")
    p.add_argument("--generations", type=int, default=0)
    p.add_argument("--hours", type=float, default=0.0)
    p.add_argument("--set", action="append")
    p.add_argument("--detach", action="store_true")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("status", help="progress, ratings, warnings")
    p.add_argument("run", nargs="?")
    p.add_argument("--brief", action="store_true", help="one line")
    p = sub.add_parser("watch", help="block until a milestone, alert or --max; exit 0 milestone, 1 heartbeat, "
                                     "2 alert, 3 run ended")
    p.add_argument("run")
    p.add_argument("--every", choices=["quarter", "generation"], default="quarter")
    p.add_argument("--stall", type=float, default=45.0, help="minutes without progress before an alert")
    p.add_argument("--max", type=float, default=115.0, help="minutes before a heartbeat exit")
    p.add_argument("--interval", type=float, default=30.0, help="seconds between checks")
    sub.add_parser("list", help="all runs")
    p = sub.add_parser("stop", help="stop after the current unit (--now: interrupt)")
    p.add_argument("run")
    p.add_argument("--now", action="store_true")
    p = sub.add_parser("log", help="harness log")
    p.add_argument("run")
    p.add_argument("-n", type=int, default=40)
    p.add_argument("-f", "--follow", action="store_true")
    p = sub.add_parser("report", help="rewrite report.md and dashboard.html")
    p.add_argument("run")
    p = sub.add_parser("config", help="validate a run's config or a file; --reference lists every key")
    p.add_argument("target", nargs="?")
    p.add_argument("--reference", action="store_true")
    p.add_argument("--markdown", action="store_true")
    p = sub.add_parser("gc", help="apply the storage policy")
    p.add_argument("run")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("export", help="network, manifest, report, dashboard, config, state")
    p.add_argument("run")
    p.add_argument("--model", default="best")
    p.add_argument("--out")
    p = sub.add_parser("match", help="extra games, counted in the ratings")
    p.add_argument("run")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--games", type=int, default=200)
    p = sub.add_parser("redo", help="redo a step of the newest generation (and the steps after it)")
    p.add_argument("run")
    p.add_argument("step", choices=["train", "gate", "league"])
    p = sub.add_parser("abandon", help="give up the generation in progress")
    p.add_argument("run")
    sub.add_parser("build", help="cargo build --release --offline")
    p = sub.add_parser("test", help="test suites")
    p.add_argument("--rust", action="store_true")
    p.add_argument("--python", action="store_true")
    p = sub.add_parser("doctor", help="machine checks; --bench measures speeds and estimates")
    p.add_argument("--bench", action="store_true")
    p.add_argument("--config")
    p.add_argument("--run")
    p = sub.add_parser("smoke", help="end-to-end run with stop, interrupt and resume")
    p.add_argument("--keep", action="store_true")
    p = sub.add_parser("tool", help="Python tools: train, records, check_nnue, league")
    p.add_argument("name")
    p.add_argument("args", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    try:
        globals()[f"cmd_{a.cmd}"](a)
    except (RunError, C.ConfigError) as e:
        raise SystemExit(str(e))


if __name__ == "__main__":
    main()
