"""StockKnight training tools: records, the network in PyTorch, the trainer."""

import os
from pathlib import Path

RULESET = "knightchess-2"
REPO = Path(__file__).resolve().parents[2]


def bin_dir() -> Path:
    """Folder of the Rust binaries: `$SK_BIN`, else `target/release`."""
    return Path(os.environ.get("SK_BIN", REPO / "target" / "release"))


def binary(name: str) -> str:
    path = bin_dir() / name
    if not path.exists():
        raise FileNotFoundError(f"{path} not found; run `cargo build --release`")
    return str(path)
