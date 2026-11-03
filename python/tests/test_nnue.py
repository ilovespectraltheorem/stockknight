"""Python side of the network: inputs equal the Rust inputs; files round-trip.

Run with `python -m pytest python/tests` (needs `cargo build --release` and the pilot data,
or any record file in $SK_RECORDS).
"""

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from skpy import REPO, binary  # noqa: E402
from skpy.nnue import PAD, SkNet, batch_torch, load_nnue, save_nnue  # noqa: E402
from skpy.records import fen, fit_k, load, result_stm, score  # noqa: E402


def records():
    path = os.environ.get("SK_RECORDS", REPO / "testdata" / "kc2-sample.val.bin")
    return load(path, limit=300)


def test_inputs_match_rust():
    rec = records()
    stm, other, _, _ = batch_torch(torch.from_numpy(rec.copy()))
    for i in range(0, len(rec), 15):
        out = subprocess.run([binary("sk-nnue"), "features", fen(rec[i])], capture_output=True, text=True, check=True)
        rust_stm, rust_other = (sorted(eval(line)) for line in out.stdout.strip().splitlines())
        assert sorted(x for x in stm[i].tolist() if x != PAD) == rust_stm
        assert sorted(x for x in other[i].tolist() if x != PAD) == rust_other


def test_labels():
    rec = records()
    _, _, s, r = batch_torch(torch.from_numpy(rec.copy()))
    assert np.array_equal(s.numpy().astype(int), score(rec).astype(int))
    assert np.allclose(r.numpy(), result_stm(rec))
    assert 100 <= fit_k(rec) <= 2000


def test_file_round_trip(tmp_path):
    torch.manual_seed(3)
    net = SkNet(16, 8, 4)
    save_nnue(net, tmp_path / "n.nnue", "test")
    back = load_nnue(tmp_path / "n.nnue")
    rec = torch.from_numpy(records().copy())
    stm, other, _, _ = batch_torch(rec)
    with torch.no_grad():
        assert torch.equal(net(stm, other), back(stm, other))
