"""Rust vs PyTorch: the same network gives the same outputs on the same records.

    python -m skpy.check_nnue <net.nnue> <records.bin> [--n 2000]
"""

import argparse
import subprocess

import numpy as np
import torch

from . import binary
from .nnue import batch_torch, load_nnue
from .records import load


def max_difference(net_path, records_path, n=2000) -> float:
    rust = subprocess.run(
        [binary("sk-nnue"), "eval", str(net_path), str(records_path), "--n", str(n)],
        check=True, capture_output=True, text=True,
    ).stdout.split()
    rust = np.array([float(x) for x in rust], dtype=np.float64)
    net = load_nnue(net_path).eval()
    raw = torch.from_numpy(load(records_path, limit=n).copy())
    with torch.no_grad():
        stm, other, _, _ = batch_torch(raw)
        torch_out = net(stm, other).double().numpy()
    if len(rust) != len(torch_out):
        raise RuntimeError(f"Rust gave {len(rust)} outputs, PyTorch {len(torch_out)}")
    return float(np.max(np.abs(rust - torch_out)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("net")
    ap.add_argument("records")
    ap.add_argument("--n", type=int, default=2000)
    a = ap.parse_args()
    d = max_difference(a.net, a.records, a.n)
    print(f"max |Rust - PyTorch| = {d:.2e} (raw output; ×600 for centipawns)")
    raise SystemExit(0 if d < 1e-4 else 1)
