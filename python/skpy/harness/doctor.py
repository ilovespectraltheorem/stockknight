"""`sk doctor`: machine checks, and with --bench speeds and per-generation estimates."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .. import REPO, bin_dir
from . import config as C
from .util import fmt_duration, free_disk_gb, machine, source_hash


def doctor(a) -> int:
    problems = 0
    ok = lambda m: print(f"  ok    {m}")

    def bad(m):
        nonlocal problems
        problems += 1
        print(f"  FAIL  {m}")

    warn = lambda m: print(f"  warn  {m}")
    print("machine")
    mc = machine()
    ok(f"{mc['os']}, {mc['cpus']} CPUs, {mc['memory_gb']} GB memory")
    (ok if mc["avx2"] else warn)(f"AVX2 {'yes' if mc['avx2'] else 'no (portable kernels, slower)'}; VNNI {'yes' if mc['vnni'] else 'no'}")
    (ok if sys.version_info >= (3, 11) else bad)(f"Python {mc['python']} (3.11 or newer needed)")
    for mod in ("numpy", "torch"):
        try:
            m = __import__(mod)
            ok(f"{mod} {m.__version__}")
        except ImportError:
            bad(f"{mod} missing")
    try:
        import torch
        dev = "cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
        ok(f"training device: {dev}")
    except ImportError:
        pass
    (ok if shutil.which("cargo") else warn)("cargo " + ("found" if shutil.which("cargo") else "not found (needed only to build)"))
    for b in ("stockknight", "sk-datagen", "sk-match", "sk-nnue"):
        (ok if (bin_dir() / b).exists() else bad)(f"{bin_dir() / b}")
    stamp = bin_dir() / ".sk-source-hash"
    cur = source_hash()
    if stamp.exists():
        (ok if stamp.read_text().strip() == cur else warn)(
            "binaries built from the current source" if stamp.read_text().strip() == cur else "binaries built from older source; run ./sk build")
    else:
        warn("binaries have no source stamp; ./sk build records one")
    free = free_disk_gb(REPO)
    (ok if free > 10 else warn)(f"{free:.0f} GB free disk")
    runs = Path(os.environ.get("SK_RUNS", Path(REPO) / "runs"))
    if runs.is_dir():
        print("runs")
        from .state import Run
        for p in sorted(runs.iterdir()):
            r = Run(p)
            if not r.exists():
                continue
            try:
                r.load()
                C.load(r.config_path)
                ok(f"{p.name}: {len(r.state['models']) - 1} models, config valid" + (", running" if r.running() else ""))
            except Exception as e:
                bad(f"{p.name}: {e}")
    if a.bench:
        bench(a)
    print("no problems" if not problems else f"{problems} problem(s)")
    return 1 if problems else 0


def bench(a):
    print("bench (about a minute)")
    cfg = C.resolve(C.load(a.config) if a.config else C.load(Path(a.run) / "run.toml") if a.run else C.validate({}))
    threads = cfg["hardware"]["threads"]
    out = subprocess.run([str(bin_dir() / "stockknight"), "bench 6"], capture_output=True, text=True).stdout.strip().splitlines()[-1]
    print(f"  engine (G0, one thread): {out}")
    with tempfile.TemporaryDirectory() as d:
        t = time.time()
        subprocess.run([str(bin_dir() / "sk-datagen"), "run", "--out", f"{d}/b", "--minutes", "0.3",
                        "--nodes", str(cfg["datagen"]["nodes"]), "--threads", str(threads)], capture_output=True, check=True)
        info = dict(l.split(": ", 1) for l in open(f"{d}/b.info.txt").read().splitlines() if ": " in l)
        rate = float(info["positions_per_second"])
        print(f"  data generation (G0, {threads} threads): {rate:,.0f} positions/s")
        t = time.time()
        r = subprocess.run([str(bin_dir() / "sk-match"), "--e1", str(bin_dir() / "stockknight"), "--e2", str(bin_dir() / "stockknight"),
                            "--games", "20", *cfg["match"]["condition"].replace("nodes", "--nodes").replace("movetime", "--movetime").replace("depth", "--depth").split(),
                            "--concurrency", str(cfg["match"]["concurrency"]), "--json", f"{d}/m.json"], capture_output=True)
        gpm = 20 / (time.time() - t) * 60
        print(f"  games ({cfg['match']['condition']}, {cfg['match']['concurrency']} at a time): {gpm:.0f} per minute")
    # A network teacher is slower than G0; 0.65 is what G1 measured on 4 cores.
    net_rate = rate * 0.65
    print("  estimates per generation (network teacher, CPU training at ~35k positions/s, 8 epochs):")
    for g in (1, 5, 10, 20):
        pos = min(cfg["datagen"]["positions"] * (1 + cfg["datagen"]["growth"]) ** (g - 1), cfg["datagen"]["max_positions"] or 1e18)
        window = pos * min(g, cfg["training"]["window_rounds"])
        data_s = pos / net_rate
        train_s = window * 8 / 35_000
        games = 400 + cfg["league"]["recent"] * 2
        print(f"    g{g}: {pos:,.0f} positions, data {fmt_duration(data_s)}, training ~{fmt_duration(train_s)}, "
              f"games ~{fmt_duration(games / gpm * 60)}, disk +{pos * 24 / 1e9:.2f} GB")
