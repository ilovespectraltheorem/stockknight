"""sk watch and sk status --brief on synthetic runs (no engines needed)."""

import json
import os

from skpy.harness import config as C
from skpy.harness import watch as W
from skpy.harness.state import Run
from skpy.harness.util import host, now


def make_run(tmp_path, running=True):
    root = tmp_path / "r"
    root.mkdir()
    cfg = C.resolve(C.validate(C.merge({}, ())))
    run = Run(root)
    run.state = Run.new_state("r", "", "nodes 5000", cfg)
    g1 = {"name": "g1", "status": "accepted", "teacher": "g0", "round": 1, "net": None, "rating_at_decision": 120.0,
          "steps": {"data": {"seconds": 700}, "window": {"seconds": 0}, "train": {"seconds": 200},
                    "gate": {"seconds": 100}, "league": {"seconds": 0}, "decide": {"seconds": 0}}}
    g2 = {"name": "g2", "status": "in progress", "teacher": "g1", "round": 2, "step": "data", "net": None,
          "steps": {}, "created": now()}
    run.state["models"] += [g1, g2]
    run.state["rounds"] = [{"round": 2, "teacher": "g1", "target": 1000, "shards": []}]
    run.save()
    run.config_path.write_text("")
    if running:
        run.lock_path.write_text(json.dumps({"pid": os.getpid(), "host": host(), "started": now()}))
    return run, cfg


class Sim:
    """A fake clock whose sleep applies the next scripted change to the run."""

    def __init__(self, run, changes):
        self.run, self.changes, self.t = run, list(changes), 0.0

    def clock(self):
        return self.t

    def sleep(self, s):
        self.t += s
        if self.changes:
            self.changes.pop(0)(self.run)


def add_shard(n):
    def f(run):
        run.load()
        run.round(2)["shards"].append({"positions": n})
        run.save()
    return f


def watch(run, cfg, changes, **kw):
    sim = Sim(run, changes)
    return W.watch(run, lambda r: cfg, clock=sim.clock, sleep=sim.sleep, interval=60, **kw)


def test_progress_uses_last_generation_shares(tmp_path):
    run, cfg = make_run(tmp_path)
    run.load()
    run.round(2)["shards"].append({"positions": 500})
    m, f = W.progress(run, cfg)
    assert m["name"] == "g2" and abs(f - 0.35) < 1e-9  # half of data, which took 70% of g1


def test_brief_is_one_line(tmp_path):
    run, cfg = make_run(tmp_path)
    run.load()
    b = W.brief(run, cfg)
    assert "\n" not in b and "g2 data 0%" in b and "teacher g1 +120" in b and "running" in b


def test_quarter_milestone(tmp_path):
    run, cfg = make_run(tmp_path)
    code, lines = watch(run, cfg, [add_shard(100), add_shard(300)])  # 10%, then 40% of data = 28% of g2
    assert code == 0 and lines[0] == "MILESTONE g2 25%"


def test_every_generation_ignores_quarters_until_decided(tmp_path):
    run, cfg = make_run(tmp_path)

    def decide(run):
        run.load()
        m = run.model("g2")
        m.update({"status": "accepted", "rating_at_decision": 180.0, "gate": {"w": 10, "d": 5, "l": 3}})
        m.pop("step")
        run.save()
        run.event("decided", model="g2", status="accepted", reason="gate H1 after 18 games", rating=180.0)

    code, lines = watch(run, cfg, [add_shard(600), decide], every="generation")
    assert code == 0 and lines[0].startswith("DECIDED g2 accepted +180") and "+10 =5 -3" in lines[0]


def test_alerts_and_run_end(tmp_path):
    run, cfg = make_run(tmp_path)
    code, lines = watch(run, cfg, [lambda r: r.event("error", model="g2", step="data", message="boom")])
    assert code == 2 and lines[0].startswith("ALERT error")
    code, lines = watch(run, cfg, [lambda r: r.event("run_end", reason="plateau", code=0)])
    assert code == 3 and lines[0].startswith("RUN ENDED")


def test_stall_heartbeat_and_dead_harness(tmp_path):
    run, cfg = make_run(tmp_path)
    code, lines = watch(run, cfg, [], stall_minutes=10, max_minutes=60)
    assert code == 2 and "stalled" in lines[0]
    code, lines = watch(run, cfg, [add_shard(10 * i) for i in range(1, 20)], stall_minutes=10, max_minutes=5)
    assert code == 1 and lines[0].startswith("HEARTBEAT")
    run.lock_path.unlink()
    code, lines = watch(run, cfg, [add_shard(10)])
    assert code == 2 and "not running" in lines[0]
