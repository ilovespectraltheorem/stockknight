"""Read 24-byte training records with numpy (layout: crates/data/src/lib.rs)."""

import argparse

import numpy as np

RECORD_SIZE = 24
PIECE_CHARS = ".PNBRQK..pnbrqk."


def load(path, limit=None) -> np.ndarray:
    """Raw records as a `(N, 24)` uint8 array."""
    raw = np.fromfile(path, dtype=np.uint8, count=-1 if limit is None else limit * RECORD_SIZE)
    if raw.size % RECORD_SIZE:
        raise ValueError(f"{path}: size is not a multiple of {RECORD_SIZE}")
    return raw.reshape(-1, RECORD_SIZE)


def squares(rec: np.ndarray) -> np.ndarray:
    """Piece codes, `(N, 36)`."""
    b = rec[:, :18]
    out = np.empty((rec.shape[0], 36), dtype=np.uint8)
    out[:, 0::2] = b & 15
    out[:, 1::2] = b >> 4
    return out


def reserves(rec: np.ndarray) -> np.ndarray:
    """Reserve counts `(N, 2, 3)`: per color, pawns, rook, bishop."""
    h = rec[:, 18]
    out = np.empty((rec.shape[0], 2, 3), dtype=np.uint8)
    for c in range(2):
        bits = h >> (4 * c)
        out[:, c, 0] = bits & 3
        out[:, c, 1] = (bits >> 2) & 1
        out[:, c, 2] = (bits >> 3) & 1
    return out


def side_to_move(rec: np.ndarray) -> np.ndarray:
    return rec[:, 19] & 1


def result_white(rec: np.ndarray) -> np.ndarray:
    """0 Black won, 1 draw, 2 White won."""
    return (rec[:, 19] >> 1) & 3


def result_stm(rec: np.ndarray) -> np.ndarray:
    """The game result for the side to move: 1, 0.5 or 0."""
    white = result_white(rec).astype(np.float32) / 2
    return np.where(side_to_move(rec) == 0, white, 1 - white)


def score(rec: np.ndarray) -> np.ndarray:
    return rec[:, 20:22].copy().view("<i2").reshape(-1)


def best_move(rec: np.ndarray) -> np.ndarray:
    return rec[:, 22:24].copy().view("<u2").reshape(-1)


def fen(r: np.ndarray) -> str:
    sq = squares(r[None])[0]
    rows = []
    for rank in range(5, -1, -1):
        row, empty = "", 0
        for f in range(6):
            code = sq[rank * 6 + f]
            if code == 0:
                empty += 1
                continue
            if empty:
                row += str(empty)
                empty = 0
            row += PIECE_CHARS[code]
        rows.append(row + (str(empty) if empty else ""))
    hand = reserves(r[None])[0]
    res = ""
    for c in range(2):
        for i, t in enumerate("PRB"):
            res += (t if c == 0 else t.lower()) * hand[c, i]
    side = "w" if side_to_move(r[None])[0] == 0 else "b"
    return f"{'/'.join(rows)}[{res or '-'}] {side} 0 1"


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def fit_k(rec: np.ndarray, lo=100, hi=2000) -> float:
    """The K for which sigmoid(score / K) best predicts the side to move's result."""
    s = score(rec).astype(np.float64)
    r = result_stm(rec).astype(np.float64)
    ks = np.arange(lo, hi + 1, 10, dtype=np.float64)
    errors = [np.mean((sigmoid(s / k) - r) ** 2) for k in ks]
    return float(ks[int(np.argmin(errors))])


def summary(rec: np.ndarray) -> dict:
    res = result_white(rec)
    return {
        "records": int(rec.shape[0]),
        "white_won": float(np.mean(res == 2)),
        "draw": float(np.mean(res == 1)),
        "black_won": float(np.mean(res == 0)),
        "mean_abs_score": float(np.mean(np.abs(score(rec).astype(np.float64)))),
        "K": fit_k(rec),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--dump", type=int, default=0)
    a = ap.parse_args()
    rec = load(a.file)
    if a.summary:
        for k, v in summary(rec).items():
            print(f"{k}: {v}")
    for r in rec[: a.dump]:
        print(fen(r), score(r[None])[0], result_white(r[None])[0])
