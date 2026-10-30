"""Harness tests that need no binaries."""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skpy import REPO
from skpy.harness import config as C
from skpy.harness import steps as S
from skpy.harness.state import Run, RunError
from skpy.harness.util import seed


def test_shipped_configs_are_valid():
    for name in ("default", "large", "smoke"):
        C.load(Path(REPO) / "configs" / f"{name}.toml")


def test_bad_configs_report_every_problem_with_suggestions():
    with pytest.raises(C.ConfigError) as e:
        C.validate({"gaet": {}, "gate": {"mdoe": "none", "elo1": -1}, "datagen": {"positions": "many"},
                    "match": {"condition": "seconds 3", "chunk_games": 3}})
    p = "\n".join(e.value.problems)
    assert "did you mean [gate]" in p and "did you mean gate.mode" in p
    assert "datagen.positions" in p and "match.condition" in p and "chunk_games" in p and "elo1" in p
    assert len(e.value.problems) >= 6


def test_render_round_trip_and_overrides(tmp_path):
    cfg = C.validate(C.merge({}, ["gate.mode=none", "training.lr=0.002", 'run.description="x y"']))
    f = tmp_path / "run.toml"
    f.write_text(C.render(cfg))
    assert C.load(f) == cfg
    assert C.load(f, ["stop.plateau=5"])["stop"]["plateau"] == 5
    assert C.differences(cfg) == [("run.description", "x y", ""), ("training.lr", 0.002, 0.001), ("gate.mode", "none", "sprt")]


def test_automatic_values_resolve():
    cfg = C.resolve(C.validate({}))
    assert cfg["hardware"]["threads"] == os.cpu_count() and cfg["match"]["concurrency"] == os.cpu_count()


def test_round_targets_and_shard_sizes():
    cfg = C.validate({"datagen": {"positions": 1000, "growth": 0.5, "max_positions": 2000}})
    assert [S.round_target(cfg, k) for k in range(4)] == [1000, 1500, 2000, 2000]
    assert S.shard_size(0, 10, 50_000, 1000) == 1000
    assert S.shard_size(100, 10, 1_000_000, 1000) == 60_000
    assert S.shard_size(100, 10, 70_000, 1000) == 70_000  # a tiny last shard is folded in
    assert S.shard_size(100, 10, 5_000, 1000) == 5_000


def test_window_selection():
    rounds = [{"round": k, "status": "done"} for k in range(1, 6)] + [{"round": 6, "status": "generating"}]
    rounds[1]["deleted"] = True
    assert S.window_rounds(rounds, 5, 3) == [5, 4, 3]
    assert S.window_rounds(rounds, 6, 3) == [5, 4, 3]
    assert S.window_rounds(rounds, 3, 3) == [3, 1]


def test_info_parsing_and_aggregation(tmp_path):
    a = tmp_path / "a.info.txt"
    a.write_text("games: 10\npositions_train: 700\npositions_val: 7\nseconds: 2.5\naverage_plies: 100.0\n"
                 "results_white_view: white 5 (50.0%) draw 3 (30.0%) black 2 (20.0%)\nending checkmate: 6 (60.0%)\n")
    b = tmp_path / "b.info.txt"
    b.write_text("games: 30\npositions_train: 2100\npositions_val: 21\nseconds: 7.5\naverage_plies: 140.0\n"
                 "results_white_view: white 10 (33.3%) draw 10 (33.3%) black 10 (33.3%)\nending checkmate: 20 (66.7%)\n")
    t = S.aggregate_infos([S.parse_info(a), S.parse_info(b)])
    assert t["games"] == 40 and t["positions_train"] == 2800 and t["seconds"] == 10.0
    assert t["results"] == {"white": 15, "draw": 13, "black": 12} and t["endings"] == {"checkmate": 26}
    assert t["average_plies"] == 130.0


def test_condition_args():
    assert S.condition_args("nodes 5000") == ["--nodes", 5000]
    assert S.condition_args("movetime 40") == ["--movetime", 40]
    with pytest.raises(ValueError):
        S.condition_args("nodes")


def test_plateau_and_league_owed():
    state = {"condition": "nodes 1", "models": [{"name": "g0", "status": "accepted"}] +
             [{"name": f"g{i}", "status": s} for i, s in enumerate(["accepted", "rejected", "rejected", "rejected"], 1)],
             "results": [{"a": "g4", "b": "g3", "w": 50, "d": 0, "l": 50, "condition": "nodes 1"},
                         {"a": "g4", "b": "g0", "w": 60, "d": 0, "l": 0, "condition": "nodes 2"}]}
    assert S.plateau(state, 3) and not S.plateau(state, 4) and not S.plateau(state, 0)
    cfg = C.validate({"league": {"recent": 200, "decay": 0.5, "minimum": 60}})
    assert S.league_owed(state, cfg, "g4") == {"g3": 100, "g2": 100, "g1": 60, "g0": 60}


def test_seeds_are_stable_and_distinct():
    assert seed(1, "round", 3, "shard", 0) == seed(1, "round", 3, "shard", 0)
    assert len({seed(1, "round", 3, "shard", i) for i in range(100)}) == 100
    assert seed(1, "x") != seed(2, "x")


def make_run(tmp_path):
    r = Run(tmp_path / "r")
    r.root.mkdir()
    cfg = C.validate({})
    r.config_path.write_text(C.render(cfg))
    r.state = Run.new_state("r", "", "nodes 5000", cfg)
    r.save()
    return r


def test_locks(tmp_path):
    r = make_run(tmp_path)
    r.acquire()
    with pytest.raises(RunError):
        Run(r.root).acquire()
    r.release()
    assert not r.lock_path.exists()
    # A lock left by a process that is gone is stale and taken over.
    from skpy.harness.util import host
    r.lock_path.write_text(json.dumps({"pid": 2 ** 22 + 12345, "host": host(), "started": "x"}))
    r.acquire()
    assert any(e["event"] == "stale_lock" for e in r.events())
    r.release()
    # One held on another host needs force.
    r.lock_path.write_text(json.dumps({"pid": 1, "host": "elsewhere", "started": "x"}))
    with pytest.raises(RunError):
        r.acquire()
    r.acquire(force=True)
    r.release()


def test_torn_event_lines_are_skipped(tmp_path):
    r = make_run(tmp_path)
    r.event("a", x=1)
    with open(r.path("events.jsonl"), "a") as f:
        f.write('{"time": "t", "event": "b", "x": ')
    r.event("c")
    assert [e["event"] for e in r.events()] == ["a", "c"]


def test_storage_policy(tmp_path):
    r = make_run(tmp_path)
    root = r.root
    for p in ["data/round1/shard-000.train.bin", "data/round2/shard-000.train.bin", "data/round1.train.bin",
              "data/round1.val.bin", "data/round2.train.bin", "data/round3.train.bin", "data/round4.train.bin",
              "train/g1/window.bin", "train/g2/window.bin", "train/g1/checkpoint.pt", "matches/a.games.txt", "x.json.tmp"]:
        (root / p).parent.mkdir(parents=True, exist_ok=True)
        (root / p).write_bytes(b"0" * 24)
    state = {"models": [{"name": "g0", "status": "accepted"}, {"name": "g1", "status": "accepted"},
                        {"name": "g2", "status": "in progress"}],
             "rounds": [{"round": 1, "status": "done"}, {"round": 2, "status": "generating"},
                        {"round": 3, "status": "done"}, {"round": 4, "status": "done"}]}
    cfg = C.validate({"storage": {"keep_rounds": 1, "keep_game_logs": False}, "training": {"window_rounds": 2}})
    plan = {str(p.relative_to(root)) for p in S.storage_plan(state, cfg, root)}
    assert plan == {"data/round1/shard-000.train.bin", "train/g1/window.bin", "train/g1/checkpoint.pt",
                    "matches/a.games.txt", "x.json.tmp"}  # no old rounds while a generation is in progress
    state["models"][2]["status"] = "accepted"
    plan = {str(p.relative_to(root)) for p in S.storage_plan(state, cfg, root)}
    assert {"data/round1.train.bin", "data/round1.val.bin", "train/g2/window.bin"} <= plan
    assert "data/round3.train.bin" not in plan  # the window (2 rounds) is always kept
    keep = C.validate({})
    assert {str(p.relative_to(root)) for p in S.storage_plan(state, keep, root)} == {
        "data/round1/shard-000.train.bin", "train/g1/window.bin", "train/g2/window.bin", "train/g1/checkpoint.pt", "x.json.tmp"}
