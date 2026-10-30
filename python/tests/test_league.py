import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skpy import league as L


def test_elo_round_trip():
    for e in (-300, -10, 0, 55, 400):
        assert abs(L.elo_of_score(L.score_of_elo(e)) - e) < 1e-6


def test_sprt_matches_sk_match():
    lo, hi = L.sprt_bounds()
    assert abs(hi - 2.944) < 1e-3 and abs(lo + 2.944) < 1e-3
    assert L.sprt_decision(300, 100, 100, 0, 10) == "H1"
    assert L.sprt_decision(100, 100, 300, 0, 10) == "H0"
    assert L.sprt_decision(10, 10, 10, 0, 10) is None
    assert math.isfinite(L.llr(40, 0, 0, 0, 10))


def test_schedule():
    s = L.schedule("g4", ["g0", "g1", "g2", "g3"], recent=200, decay=0.5, minimum=60)
    assert s == {"g3": 200, "g2": 100, "g1": 60, "g0": 60}
    assert L.schedule("g1", ["g0"], recent=101) == {"g0": 102}


def test_head_to_head_and_regressions():
    games = [{"a": "g2", "b": "g1", "w": 10, "d": 5, "l": 85}, {"a": "g1", "b": "g2", "w": 0, "d": 0, "l": 4}]
    assert L.result_between(games, "g1", "g2") == [85, 5, 14]
    assert L.regressions(games, "g2", ["g1"]) == ["g1"]
    assert L.regressions(games, "g1", ["g2"]) == []


def test_ratings_recover_known_gaps():
    def g(a, b, elo, n=4000):
        s = L.score_of_elo(elo)
        w = round(n * (s - 0.1))  # score s with 20% draws
        l = round(n * (0.9 - s))
        return {"a": a, "b": b, "w": w, "d": n - w - l, "l": l}

    games = [g("g1", "g0", 100), g("g2", "g1", 100), g("g2", "g0", 200)]
    r = L.fit_ratings(games, ["g0", "g1", "g2", "g9"])
    assert r["g0"] == (0.0, 0.0)
    assert abs(r["g1"][0] - 100) < 5 and abs(r["g2"][0] - 200) < 5
    assert 0 < r["g1"][1] < 20
    assert math.isnan(r["g9"][0])
