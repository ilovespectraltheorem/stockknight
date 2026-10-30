"""The run configuration (`run.toml`): one schema, validation and rendering.

The schema is the single source of truth: default, type, constraint and help for every key.
Unknown sections or keys are errors (with suggestions), and every problem is reported at once.
`0` means "automatic" for machine-dependent values, resolved on the machine running the run.
"""

import difflib
import os
import tomllib
from dataclasses import dataclass, field


@dataclass
class Key:
    default: object
    help: str
    choices: tuple = ()
    min: float | None = None
    max: float | None = None


def K(default, help, choices=(), min=None, max=None):
    return Key(default, help, tuple(choices), min, max)


SCHEMA = {
    "run": {
        "description": K("", "Free text shown in reports"),
        "seed": K(1, "Base seed; every shard, chunk and training run derives its seed from it", min=0),
    },
    "hardware": {
        "threads": K(0, "Threads for data generation and games (0 = all cores)", min=0),
        "train_threads": K(0, "PyTorch threads (0 = PyTorch's choice)", min=0),
        "min_free_disk_gb": K(2.0, "Stop the run when free disk falls below this", min=0),
    },
    "datagen": {
        "positions": K(1_200_000, "Training positions per round (first round)", min=100),
        "growth": K(0.0, "Each round is this fraction larger than the one before", min=0, max=10),
        "max_positions": K(0, "Upper limit on a round's size (0 = none)", min=0),
        "shard_minutes": K(10.0, "Length of one shard of data generation, the unit an interruption can lose", min=0.01),
        "shard_positions": K(100_000, "Size of the first shard, before the speed is known", min=100),
        "nodes": K(5000, "Nodes per move in self-play", min=1),
        "random_plies": K(8, "Random opening plies (not recorded)", min=0),
        "opening_limit": K(600, "Discard openings whose first search scores beyond this (cp)", min=0),
        "max_plies": K(400, "Game length cap (a draw)", min=1),
        "adjudicate": K(1500, "Adjudicate when one side is beyond this (cp)", min=0),
        "adjudicate_plies": K(8, "... for this many plies", min=1),
        "quiet_draw": K(120, "Draw after this many quiet plies", min=1),
        "record_quiet_limit": K(40, "Do not record positions this many quiet plies into a shuffle", min=0),
        "val_fraction": K(0.01, "Share of games kept for validation", min=0, max=0.5),
    },
    "training": {
        "window_rounds": K(3, "Train on the newest this many rounds", min=1),
        "window_positions": K(0, "Upper limit on the training window, newest kept (0 = none)", min=0),
        "init": K("teacher", "Start from the teacher's weights, or from random weights", ("teacher", "fresh")),
        "lambda": K(0.75, "Weight of the search score against the game result", min=0, max=1),
        "epochs": K(25, "Most epochs", min=1),
        "patience": K(3, "Stop after this many epochs without improvement", min=1),
        "batch": K(16384, "Batch size", min=1),
        "lr": K(1e-3, "Adam learning rate", min=0),
        "lr_decay": K(0.3, "Learning rate factor every decay_every epochs", min=0, max=1),
        "decay_every": K(5, "Epochs between learning rate decays", min=1),
        "K": K(0.0, "Score scale of the sigmoid (0 = fit on the data)", min=0),
        "ft": K(256, "Accumulator size", min=8, max=1024),
        "l1": K(32, "First hidden layer", min=1, max=128),
        "l2": K(32, "Second hidden layer", min=1, max=128),
        "output_scale": K(600.0, "Centipawns per unit of network output", min=1),
    },
    "match": {
        "condition": K("nodes 5000", "Search limit of every rated game: 'nodes N', 'movetime MS' or 'depth N'; frozen once the run has games"),
        "concurrency": K(0, "Games in parallel (0 = all cores)", min=0),
        "chunk_games": K(200, "Games per chunk, the unit an interruption can lose (even)", min=2),
        "opening_plies": K(8, "Random opening plies", min=0),
        "max_plies": K(400, "Game length cap", min=1),
        "adjudicate": K(1500, "Adjudication threshold (cp)", min=0),
    },
    "gate": {
        "mode": K("sprt", "'sprt': a new model must beat its teacher; 'none': every model is accepted", ("sprt", "none")),
        "elo0": K(0.0, "SPRT null hypothesis (Elo over the teacher)"),
        "elo1": K(10.0, "SPRT alternative hypothesis"),
        "min_games": K(40, "Fewest games before the SPRT may decide", min=2),
        "max_games": K(1600, "Most gate games; undecided at this point means rejected", min=2),
        "strict": K(True, "Also reject a model scoring significantly below 50% against any older accepted model"),
    },
    "league": {
        "recent": K(200, "League games against the previous model", min=0),
        "decay": K(0.5, "Factor per step further back", min=0, max=1),
        "minimum": K(60, "Fewest games against any older model", min=0),
        "backfill": K(True, "Before each generation, play league games the schedule owes"),
    },
    "stop": {
        "generations": K(0, "Stop after this many generations in the run (0 = no limit)", min=0),
        "hours": K(0.0, "Stop after this many hours of one invocation (0 = no limit)", min=0),
        "plateau": K(3, "Stop after this many rejections in a row (0 = never)", min=0),
    },
    "storage": {
        "keep_shards": K(False, "Keep data shards after a round is merged"),
        "keep_windows": K(False, "Keep merged training windows"),
        "keep_checkpoints": K(False, "Keep trainer checkpoints"),
        "keep_rounds": K(0, "Keep only the newest this many rounds (0 = all; never fewer than the window)", min=0),
        "keep_game_logs": K(True, "Keep per-game match logs"),
    },
}


class ConfigError(Exception):
    def __init__(self, problems):
        self.problems = problems
        super().__init__("\n".join(problems))


def defaults() -> dict:
    return {s: {k: key.default for k, key in keys.items()} for s, keys in SCHEMA.items()}


def _check(section, k, v, problems):
    key = SCHEMA[section][k]
    d = key.default
    where = f"{section}.{k}"
    if isinstance(d, bool):
        if not isinstance(v, bool):
            problems.append(f"{where}: expected true or false, got {v!r}")
            return d
    elif isinstance(d, int):
        if isinstance(v, bool) or not isinstance(v, int):
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            else:
                problems.append(f"{where}: expected a whole number, got {v!r}")
                return d
    elif isinstance(d, float):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            problems.append(f"{where}: expected a number, got {v!r}")
            return d
        v = float(v)
    elif isinstance(d, str) and not isinstance(v, str):
        problems.append(f"{where}: expected text, got {v!r}")
        return d
    if key.choices and v not in key.choices:
        problems.append(f"{where}: {v!r} is not one of {', '.join(key.choices)}")
    if key.min is not None and v < key.min:
        problems.append(f"{where}: {v} is below the minimum {key.min}")
    if key.max is not None and v > key.max:
        problems.append(f"{where}: {v} is above the maximum {key.max}")
    return v


def parse_condition(c: str):
    """'nodes 5000' → ('nodes', 5000), or raise ValueError."""
    parts = c.split()
    if len(parts) != 2 or parts[0] not in ("nodes", "movetime", "depth") or not parts[1].isdigit() or int(parts[1]) <= 0:
        raise ValueError(f"match.condition: expected 'nodes N', 'movetime MS' or 'depth N', got {c!r}")
    return parts[0], int(parts[1])


def validate(raw: dict) -> dict:
    """A complete config from a partial one; raises ConfigError listing every problem."""
    problems = []
    cfg = defaults()
    for section, values in raw.items():
        if section not in SCHEMA:
            near = difflib.get_close_matches(section, SCHEMA, 1)
            problems.append(f"unknown section [{section}]" + (f"; did you mean [{near[0]}]?" if near else ""))
            continue
        if not isinstance(values, dict):
            problems.append(f"[{section}] must be a table")
            continue
        for k, v in values.items():
            if k not in SCHEMA[section]:
                near = difflib.get_close_matches(k, SCHEMA[section], 1)
                problems.append(f"unknown key {section}.{k}" + (f"; did you mean {section}.{near[0]}?" if near else ""))
                continue
            cfg[section][k] = _check(section, k, v, problems)
    try:
        parse_condition(cfg["match"]["condition"])
    except ValueError as e:
        problems.append(str(e))
    if cfg["match"]["chunk_games"] % 2:
        problems.append("match.chunk_games: must be even (each opening is played with both colours)")
    if cfg["gate"]["elo1"] <= cfg["gate"]["elo0"]:
        problems.append("gate.elo1 must be above gate.elo0")
    if cfg["gate"]["min_games"] > cfg["gate"]["max_games"]:
        problems.append("gate.min_games must not exceed gate.max_games")
    if problems:
        raise ConfigError(problems)
    return cfg


def parse_override(text: str) -> tuple:
    """'gate.mode=none' → ('gate', 'mode', 'none'), the value read as TOML when it can be."""
    if "=" not in text or "." not in text.split("=", 1)[0]:
        raise ConfigError([f"--set {text}: expected section.key=value"])
    path, value = text.split("=", 1)
    section, k = path.strip().split(".", 1)
    try:
        v = tomllib.loads(f"v = {value}")["v"]
    except tomllib.TOMLDecodeError:
        v = value
    return section, k, v


def merge(raw: dict, overrides) -> dict:
    out = {s: dict(v) if isinstance(v, dict) else v for s, v in raw.items()}
    for text in overrides or []:
        section, k, v = parse_override(text)
        out.setdefault(section, {})[k] = v
    return out


def load(path, overrides=()) -> dict:
    with open(path, "rb") as f:
        try:
            raw = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            raise ConfigError([f"{path}: {e}"])
    return validate(merge(raw, overrides))


def resolve(cfg: dict) -> dict:
    """Machine-dependent automatic values filled in."""
    out = {s: dict(v) for s, v in cfg.items()}
    cores = os.cpu_count() or 1
    if not out["hardware"]["threads"]:
        out["hardware"]["threads"] = cores
    if not out["match"]["concurrency"]:
        out["match"]["concurrency"] = out["hardware"]["threads"]
    return out


def _toml_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, float):
        return repr(v)
    return str(v)


def render(cfg: dict | None = None, comments=True) -> str:
    """A complete `run.toml`, every key with its help text."""
    cfg = cfg or defaults()
    lines = ["# StockKnight run configuration. Edit freely: it is re-read between steps.", ""]
    for section, keys in SCHEMA.items():
        lines.append(f"[{section}]")
        for k, key in keys.items():
            if comments:
                extra = f" ({' | '.join(key.choices)})" if key.choices else ""
                lines.append(f"# {key.help}{extra}. Default {_toml_value(key.default)}.")
            lines.append(f"{k} = {_toml_value(cfg[section][k])}")
        lines.append("")
    return "\n".join(lines)


def differences(cfg: dict) -> list:
    """(section.key, value, default) for every value that differs from the default."""
    d = defaults()
    return [(f"{s}.{k}", v, d[s][k]) for s, keys in cfg.items() for k, v in keys.items() if v != d[s][k]]


def reference(markdown=False) -> str:
    rows = []
    for section, keys in SCHEMA.items():
        for k, key in keys.items():
            rng = ""
            if key.min is not None or key.max is not None:
                rng = f"{'' if key.min is None else key.min}–{'' if key.max is None else key.max}"
            if key.choices:
                rng = " / ".join(key.choices)
            rows.append((f"{section}.{k}", _toml_value(key.default), rng, key.help))
    if markdown:
        out = ["| Key | Default | Range | |", "|---|---|---|---|"]
        out += [f"| `{a}` | `{b}` | {c} | {d} |" for a, b, c, d in rows]
        return "\n".join(out)
    w = max(len(r[0]) for r in rows)
    return "\n".join(f"{a:<{w}}  {b:<12} {c:<14} {d}" for a, b, c, d in rows)
