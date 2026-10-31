"""`sk status --brief` and `sk watch`: cheap monitoring.

`sk watch` blocks until something worth reporting happens, then prints a few lines and exits, so
whoever watches a long run (a person or an agent) can sleep until it returns instead of polling.

Exit codes:
  0  milestone: a quarter of the generation (with --every quarter) or a generation decided
  1  heartbeat: --max reached with nothing to report; the run is healthy
  2  alert: error, crash, config error, stall, or the harness is no longer running
  3  the run ended (run_end), e.g. by plateau, a stop request or a limit
"""

import json
import math
import time

from .state import Run
from .util import free_disk_gb

STEPS_ORDER = ["data", "window", "train", "gate", "league", "decide"]  # as in steps.STEPS
# Shares of a generation's time per step, used until the run has a finished generation.
DEFAULT_SHARES = {"data": 0.70, "window": 0.02, "train": 0.22, "gate": 0.05, "league": 0.01, "decide": 0.0}
ALERT_EVENTS = ("error", "crash", "config_error")


def step_shares(state) -> dict:
    """Each step's share of a generation's time, from the newest decided generation."""
    for m in reversed(state["models"][1:]):
        if m["status"] in ("accepted", "rejected"):
            sec = {k: (m.get("steps") or {}).get(k, {}).get("seconds", 0.0) for k in STEPS_ORDER}
            total = sum(sec.values())
            if total > 0:
                return {k: v / total for k, v in sec.items()}
    return dict(DEFAULT_SHARES)


def _train_rows(run: Run, m):
    mf = run.path("train", m["name"], "metrics.jsonl")
    try:
        return [json.loads(x) for x in mf.read_text().splitlines() if x.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def step_fraction(run: Run, m, cfg) -> float:
    """How far the current step is, 0 to 1 (an estimate for training; 0 for games)."""
    s = run.state
    if m["step"] == "data":
        rd = run.round(m["round"])
        if not rd or not rd.get("target"):
            return 0.0
        done = sum(x["positions"] for x in rd["shards"])
        live = s.get("live") or {}
        if live.get("shard"):
            p = run.path(live["shard"])
            done += p.stat().st_size // 24 if p.exists() else 0
        return min(1.0, done / rd["target"])
    if m["step"] == "train":
        rows = _train_rows(run, m)
        if not rows:
            return 0.0
        best = min(range(len(rows)), key=lambda i: rows[i]["val_loss"])
        # Early stopping ends at best + patience; never past the epoch limit.
        expected = min(cfg["training"]["epochs"], max(len(rows) + 1, best + 1 + cfg["training"]["patience"]))
        return min(1.0, len(rows) / expected)
    return 0.0


def progress(run: Run, cfg):
    """(model in progress or None, fraction of its generation done)."""
    m = run.in_progress()
    if not m:
        return None, 0.0
    shares = step_shares(run.state)
    i = STEPS_ORDER.index(m["step"])
    done = sum(shares[k] for k in STEPS_ORDER[:i])
    return m, min(1.0, done + shares[m["step"]] * step_fraction(run, m, cfg))


def pulse(run: Run, m) -> tuple:
    """Anything that changes while the run makes progress."""
    s = run.state
    live = s.get("live") or {}
    size = 0
    if live.get("shard"):
        p = run.path(live["shard"])
        size = p.stat().st_size if p.exists() else 0
    return (len(run.events()), size, len(_train_rows(run, m)) if m else 0, len(s["results"]), s.get("updated"))


def _rating(m):
    r = m.get("rating_at_decision")
    return "" if r is None or (isinstance(r, float) and math.isnan(r)) else f" {r:+.0f}"


def brief(run: Run, cfg) -> str:
    """One line: run, generation, step, %, teacher, last decision, disk."""
    s = run.state
    teacher = run.models("accepted")[-1]
    parts = [s["name"], "running" if run.running() else "not running"]
    m, frac = progress(run, cfg)
    if m:
        bit = f"{m['name']} {m['step']} {frac:.0%}"
        if m["step"] == "data":
            rd = run.round(m["round"])
            t = rd["target"]
            size = f"{t / 1e6:.1f}M" if t >= 1e6 else f"{t:,}"
            bit += f" (data {step_fraction(run, m, cfg):.0%} of {size})"
        elif m["step"] == "train":
            rows = _train_rows(run, m)
            if rows:
                bit += f" (epoch {len(rows)}, best val {min(r['val_loss'] for r in rows):.5f})"
        elif m["step"] == "gate":
            g = m.get("gate") or {}
            if g.get("games"):
                bit += f" ({g['games']} games, LLR {g.get('llr', 0):.2f})"
        parts.append(bit)
    parts.append(f"teacher {teacher['name']}{_rating(teacher)}")
    last = next((x for x in reversed(s["models"][1:]) if x["status"] in ("accepted", "rejected")), None)
    if last and last is not teacher:
        parts.append(f"last {last['name']} {last['status']}")
    parts.append(f"{free_disk_gb(run.root):.0f} GB free")
    return " · ".join(parts)


def _describe(e) -> str:
    rest = {k: v for k, v in e.items() if k not in ("time", "t", "event", "traceback")}
    if e["event"] == "crash":
        rest["traceback"] = (e.get("traceback") or "").strip().splitlines()[-1:]  # the last line only
    return f"{e['event']} {json.dumps(rest)[:300]}"


def watch(run: Run, cfg_of, every="quarter", stall_minutes=45.0, max_minutes=115.0, interval=30.0,
          clock=time.time, sleep=time.sleep):
    """Block until there is something to report. Returns (exit code, lines). `cfg_of(run)` gives
    the run's resolved config (re-read every poll, as the run itself does)."""
    run.load()
    start_events = len(run.events())
    m0, f0 = progress(run, cfg_of(run))
    q0 = (m0["name"], int(f0 * 4)) if m0 else None
    t0 = last_change = clock()
    last_pulse = pulse(run, m0)
    while True:
        sleep(interval)
        try:
            run.load()
        except (OSError, json.JSONDecodeError):
            continue  # caught mid-write; try again next poll
        cfg = cfg_of(run)
        now = clock()
        new = run.events()[start_events:]
        for e in new:
            if e["event"] in ALERT_EVENTS:
                return 2, [f"ALERT {_describe(e)}", brief(run, cfg)]
        for e in new:
            if e["event"] == "run_end":
                return 3, [f"RUN ENDED {_describe(e)}", brief(run, cfg)]
        for e in new:
            if e["event"] == "decided":
                m = run.model(e["model"])
                g = m.get("gate") or {}
                gate = f", gate +{g['w']} ={g['d']} -{g['l']}" if g.get("w") is not None else ""
                return 0, [f"DECIDED {e['model']} {e['status']}{_rating(m)} ({e['reason']}{gate})", brief(run, cfg)]
        m, f = progress(run, cfg)
        q = (m["name"], int(f * 4)) if m else None
        if every == "quarter" and q and q[1] > 0 and (not q0 or q[0] != q0[0] or q[1] > q0[1]):
            return 0, [f"MILESTONE {m['name']} {int(f * 4) * 25}%", brief(run, cfg)]
        p = pulse(run, m)
        if p != last_pulse:
            last_pulse, last_change = p, now
        if not run.running():
            return 2, ["ALERT the harness is not running and logged no run_end", brief(run, cfg)]
        if now - last_change >= stall_minutes * 60:
            return 2, [f"ALERT stalled: no progress for {(now - last_change) / 60:.0f} minutes", brief(run, cfg)]
        if now - t0 >= max_minutes * 60:
            return 1, [f"HEARTBEAT healthy, nothing to report in {(now - t0) / 60:.0f} minutes", brief(run, cfg)]
