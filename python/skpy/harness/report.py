"""report.md, the status text and warnings."""

import json
import math
import time
from pathlib import Path

from .. import league as L
from .state import Run
from .util import atomic_write, fmt_bytes, fmt_duration, folder_bytes, free_disk_gb


def ratings(state):
    games = [g for g in state["results"] if g["condition"] == state["condition"]]
    names = [m["name"] for m in state["models"] if m["status"] != "abandoned"]
    return L.fit_ratings(games, names), games


def warnings(state) -> list:
    out = []
    r, games = ratings(state)
    accepted = [m["name"] for m in state["models"] if m["status"] == "accepted"]
    for i, a in enumerate(accepted):
        for b in accepted[:i]:
            w, d, l = L.result_between(games, a, b)
            if w + d + l and L.score_interval(w, d, l)[2] < 0.5:
                out.append(f"accepted {a} scores significantly below 50% against older {b}")
            ea, sa = r[a]
            eb, sb = r[b]
            if not math.isnan(ea) and not math.isnan(eb) and ea + 2 * math.hypot(sa, sb) < eb:
                out.append(f"accepted {a} is rated clearly below older {b} ({ea:+.0f} vs {eb:+.0f})")
    decided = [m["status"] for m in state["models"][1:] if m["status"] in ("accepted", "rejected")]
    streak = 0
    for s in reversed(decided):
        if s != "rejected":
            break
        streak += 1
    if streak >= 2:
        out.append(f"{streak} rejections in a row")
    return out


def step_seconds(m):
    return {k: v.get("seconds", 0) for k, v in (m.get("steps") or {}).items()}


def report_md(run: Run, cfg) -> str:
    s = run.state
    r, games = ratings(s)
    models = [m for m in s["models"] if m["status"] != "abandoned"]
    names = [m["name"] for m in models]
    teacher = run.teacher()
    lines = [f"# {s['name']}", ""]
    if s.get("description"):
        lines += [s["description"], ""]
    lines += [f"Updated {s['updated']}. Teacher **{teacher}**. Rated games: {s['condition']} per move, "
              f"{sum(g['w'] + g['d'] + g['l'] for g in games):,} in all.", ""]
    w = warnings(s)
    if w:
        lines += ["## Warnings", ""] + [f"- {x}" for x in w] + [""]
    lines += ["## Ratings", "", "Joint maximum-likelihood Elo, G0 = 0.", "",
              "| Model | Status | Elo | ± (1 s.e.) | Games | Teacher | Reason |", "|---|---|---|---|---|---|---|"]
    for m in models:
        e, se = r[m["name"]]
        n = sum(g["w"] + g["d"] + g["l"] for g in games if m["name"] in (g["a"], g["b"]))
        es = "–" if math.isnan(e) else f"{e:+.0f}"
        ses = "–" if math.isnan(se) else f"{se:.0f}"
        lines.append(f"| {m['name']} | {m['status']} | {es} | {ses} | {n} | {m.get('teacher') or ''} | {m.get('reason', '')} |")
    lines += ["", "## Head to head", "", "Score of the row model against the column model (games).", "",
              "| | " + " | ".join(names) + " |", "|---" * (len(names) + 1) + "|"]
    for a in names:
        row = [a]
        for b in names:
            w_, d_, l_ = L.result_between(games, a, b)
            n = w_ + d_ + l_
            row.append("" if a == b or not n else f"{(w_ + d_ / 2) / n:.2f} ({n})")
        lines.append("| " + " | ".join(row) + " |")
    lines += ["", "## Generations", "",
              "| Model | Round | Window | Val loss | G0 val loss | Gate | Data | Train | Games | Total |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for m in s["models"][1:]:
        t = m.get("training") or {}
        best = t.get("best") or {}
        g0 = t.get("g0") or {}
        gate = m.get("gate") or {}
        if gate.get("decision") == "skipped":
            gs = "skipped"
        elif gate:
            gs = f"{gate['w']}-{gate['d']}-{gate['l']}, LLR {gate['llr']:.2f}, {gate['decision']}"
        else:
            gs = m.get("step", "")
        st = step_seconds(m)
        games_s = st.get("gate", 0) + st.get("league", 0)
        lines.append(f"| {m['name']} | {m.get('round', '')} | {m.get('data_rounds', '')} | "
                     f"{best.get('val_loss', float('nan')):.6f} | {g0.get('val_loss', float('nan')):.6f} | {gs} | "
                     f"{fmt_duration(st.get('data', 0))} | {fmt_duration(st.get('train', 0))} | {fmt_duration(games_s)} | "
                     f"{fmt_duration(sum(st.values()))} |")
    lines += ["", "## Data rounds", "", "| Round | Teacher | Status | Games | Train positions | White / draw / Black | Hours |",
              "|---|---|---|---|---|---|---|"]
    for rd in s["rounds"]:
        res = rd.get("results") or {}
        n = sum(res.values()) or 1
        rs = f"{res.get('white', 0) / n:.1%} / {res.get('draw', 0) / n:.1%} / {res.get('black', 0) / n:.1%}" if res else ""
        pos = rd.get("positions_train") or sum(x["positions"] for x in rd.get("shards", []))
        status = rd.get("status", "") + (" (deleted)" if rd.get("deleted") else "")
        lines.append(f"| {rd['round']} | {rd['teacher']} | {status} | {rd.get('games', '')} | {pos:,} | {rs} | "
                     f"{rd.get('seconds', 0) / 3600:.2f} |")
    lines += ["", f"Disk: {fmt_bytes(folder_bytes(run.root))} in the run, {free_disk_gb(run.root):.0f} GB free.", ""]
    return "\n".join(lines)


def live_progress(run: Run, cfg) -> list:
    """What the model in progress is doing right now."""
    s = run.state
    m = run.in_progress()
    if not m:
        return []
    out = [f"{m['name']} (teacher {m['teacher']}, round {m['round']}): step {m['step']}"]
    if m["step"] == "data":
        rd = run.round(m["round"])
        done = sum(x["positions"] for x in rd["shards"])
        live = s.get("live") or {}
        cur = 0
        if live.get("shard"):
            p = run.path(live["shard"])
            cur = p.stat().st_size // 24 if p.exists() else 0
        total = done + cur
        out.append(f"  data: {total:,} of {rd['target']:,} positions ({total / rd['target']:.0%}), "
                   f"{len(rd['shards'])} shard(s) done")
    elif m["step"] == "train":
        mf = run.path("train", m["name"], "metrics.jsonl")
        if mf.exists():
            rows = [json.loads(x) for x in mf.read_text().splitlines() if x.strip()]
            if rows:
                best = min(x["val_loss"] for x in rows)
                out.append(f"  training: {len(rows)} epoch(s), last val loss {rows[-1]['val_loss']:.6f}, best {best:.6f}")
        else:
            out.append("  training: starting")
    elif m["step"] in ("gate", "league"):
        games = [g for g in s["results"] if g["condition"] == s["condition"]]
        w, d, l = L.result_between(games, m["name"], m["teacher"])
        if w + d + l:
            g = cfg["gate"]
            out.append(f"  gate vs {m['teacher']}: +{w} ={d} -{l}, score {(w + d / 2) / (w + d + l):.3f}, "
                       f"LLR {L.llr(w, d, l, g['elo0'], g['elo1']):.2f} (bounds ±{L.sprt_bounds()[1]:.2f})")
    return out


def status_text(run: Run, cfg) -> str:
    s = run.state
    r, games = ratings(s)
    info = run.running()
    lines = [f"{s['name']}: " + (f"running (pid {info['pid']} on {info['host']} since {info['started']})" if info
                                  else "not running")]
    if s.get("description"):
        lines.append(f"  {s['description']}")
    lines += live_progress(run, cfg)
    lines.append(f"teacher {run.teacher()}; ratings ({s['condition']}):")
    for m in s["models"]:
        if m["status"] == "abandoned":
            continue
        e, se = r[m["name"]]
        es = "  –" if math.isnan(e) else f"{e:+5.0f} ± {se:.0f}"
        lines.append(f"  {m['name']:<5} {m['status']:<12} {es}")
    for w in warnings(s):
        lines.append(f"warning: {w}")
    lines.append(f"disk: {fmt_bytes(folder_bytes(run.root))} in the run, {free_disk_gb(run.root):.0f} GB free")
    ev = run.events(5)
    if ev:
        lines.append("recent events:")
        for e in ev:
            rest = {k: v for k, v in e.items() if k not in ("time", "t", "event")}
            lines.append(f"  {e['time']} {e['event']} {json.dumps(rest)[:120]}")
    return "\n".join(lines)


def write_all(run: Run, cfg):
    atomic_write(run.path("report.md"), report_md(run, cfg))
    from .dashboard import dashboard_html
    atomic_write(run.path("dashboard.html"), dashboard_html(run, cfg))
