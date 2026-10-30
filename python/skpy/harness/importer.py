"""Import a Phase 5 league folder (`league.json` format 1) as a run.

Networks, data rounds (info files aggregated), training folders and every match come across.
The league's condition, schedule and gate settings override the chosen config.
"""

import json
import os
import shutil
from pathlib import Path

from .state import Run
from .steps import aggregate_infos, parse_info
from .util import atomic_json, file_hash, now


def league_overrides(league: dict) -> list:
    """The league's condition, schedule and gate settings, as config overrides."""
    c = league["config"]
    return [f'match.condition="nodes {c["match_nodes"]}"', f"match.chunk_games={c['chunk_games']}",
            f"gate.elo0={float(c['gate_elo0'])}", f"gate.elo1={float(c['gate_elo1'])}",
            f"gate.max_games={c['gate_max_games']}", f"league.recent={c['league_recent']}",
            f"league.decay={float(c['league_decay'])}", f"league.minimum={c['league_minimum']}"]


def _put(src: Path, dst: Path, link: bool):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if link:
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        os.symlink(src.resolve(), dst)
    else:
        shutil.copyfile(src, dst)


def import_league(run: Run, src, link=False):
    src = Path(src).resolve()
    lg = json.loads((src / "league.json").read_text())
    if lg.get("format") != 1:
        raise SystemExit(f"{src}/league.json: expected format 1")
    s = run.state
    s["imported_from"] = {"path": str(src), "date": now(), "format": 1}
    gens = {g["name"]: g for g in lg["generations"]}
    for r in lg["rounds"]:
        k = r["round"]
        for ext in ("train.bin", "val.bin"):
            _put(src / f"data/round{k}.{ext}", run.path("data", f"round{k}.{ext}"), link)
        info = aggregate_infos([parse_info(src / f"data/round{k}.info.txt")])
        info["positions_train_dedup"] = info["positions_train"]
        info["positions_val_dedup"] = info["positions_val"]
        atomic_json(run.path("data", f"round{k}.info.json"), info)
        s["rounds"].append({"round": k, "teacher": r["teacher"], "generation": next(
            (g["name"] for g in lg["generations"] if g["round"] == k), None), "status": "done",
            "target": r["positions_train"], "shards": [], "train": f"data/round{k}.train.bin",
            "val": f"data/round{k}.val.bin", "info": f"data/round{k}.info.json",
            "positions_train": r["positions_train"], "positions_val": r["positions_val"], "games": r["games"],
            "results": info["results"], "seconds": r["seconds"], "imported": True})
    for m in lg["models"]:
        if m["name"] == "g0":
            continue
        g = gens.get(m["name"], {})
        net = run.path("nets", f"{m['name']}.nnue")
        _put(src / m["file"], net, link)
        train_src = src / "train" / m["name"]
        training = None
        if train_src.is_dir():
            dst = run.path("train", m["name"])
            shutil.copytree(train_src, dst, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("checkpoint.pt", "*.tmp"))
            summary = json.loads((train_src / "summary.json").read_text())
            training = {k: summary.get(k) for k in ("train_positions", "val_positions", "K", "lambda", "best_epoch",
                                                     "epochs_run", "best", "g0", "architecture", "rust_max_difference")}
            training["init"] = "teacher" if summary.get("init_from") else "fresh"
        gate = g.get("gate")
        if gate:
            gate = {**gate, "games": gate["w"] + gate["d"] + gate["l"], "elo0": lg["config"]["gate_elo0"],
                    "elo1": lg["config"]["gate_elo1"]}
        status = m["status"] if m["status"] in ("accepted", "rejected") else "rejected"
        s["models"].append({
            "name": m["name"], "status": status, "teacher": m["teacher"], "round": m["round"],
            "net": f"nets/{m['name']}.nnue", "net_hash": file_hash(net), "data_rounds": g.get("window"),
            "window": {"file": None, "positions": g.get("window_positions"), "merged": len(g.get("window", [])) > 1,
                       "deleted": True},
            "training": training, "gate": gate,
            "steps": {k: {"seconds": v} for k, v in (g.get("seconds") or {}).items()},
            "reason": f"imported: {g.get('decision', status)}" + (f" (regressions {g['regressions']})" if g.get("regressions") else ""),
            "created": g.get("started"), "finished": g.get("finished"), "imported": True})
    for r in lg["games"]:
        f = src / r["file"]
        dst = run.path("matches", Path(r["file"]).name)
        if f.exists():
            _put(f, dst, link=False)
        s["results"].append({**r, "file": run.rel(dst)})
    s["condition"] = f"nodes {lg['config']['match_nodes']}"
    run.save()
    run.event("import", source=str(src), models=len(lg["models"]) - 1, rounds=len(lg["rounds"]),
              results=len(lg["games"]))
