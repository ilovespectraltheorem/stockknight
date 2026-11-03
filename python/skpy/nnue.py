"""The network in PyTorch, its inputs (as in crates/nnue/src/features.rs) and the .nnue file."""

import argparse
import struct

import numpy as np
import torch
from torch import nn

from . import RULESET

BOARD_FEATURES = 36 * 11 * 36
NUM_FEATURES = BOARD_FEATURES + 10
PAD = NUM_FEATURES  # index of an all-zero row: inactive slots
MAGIC = b"SKNN"
VERSION = 1


def batch_torch(raw: torch.Tensor):
    """Inputs and labels from raw `(N, 24)` uint8 records, on the tensor's device.

    Returns (stm_idx, other_idx, score, result): index tensors `(N, 46)` padded with PAD,
    the search score (side to move's view) and the game result for the side to move.
    """
    raw = raw.long()
    n = raw.shape[0]
    b = raw[:, :18]
    codes = torch.stack([b & 15, b >> 4], dim=2).reshape(n, 36)
    side = raw[:, 19] & 1
    color = codes >> 3
    kind = codes & 7
    sq = torch.arange(36, device=raw.device).expand(n, 36)
    hand = raw[:, 18]
    rb_on_board = [((kind == 3) | (kind == 4)) & (color == c) & (codes != 0) for c in (0, 1)]
    rb_count = torch.stack([m.sum(1) for m in rb_on_board], dim=1)  # (N, 2)

    def side_inputs(p):  # p: (N,) perspective colour
        pc = p[:, None]
        own_king = (codes == (6 | (pc << 3)))
        ksq = own_king.long().argmax(1)
        ksq_o = torch.where(p == 0, ksq, 35 - ksq)
        sq_o = torch.where(pc == 0, sq, 35 - sq)
        k = torch.where(color == pc, kind - 1, 5 + kind - 1)
        valid = (codes != 0) & ~own_king
        idx = ksq_o[:, None] * 396 + k * 36 + sq_o
        idx = torch.where(valid, idx, torch.full_like(idx, PAD))
        res = []
        for i, c in enumerate((p, 1 - p)):
            bits = (hand >> (4 * c)) & 15
            pawns, rook, bishop = bits & 3, (bits >> 2) & 1, (bits >> 3) & 1
            rb = rb_count.gather(1, c[:, None])[:, 0]
            base = BOARD_FEATURES + 5 * i
            for j, on in enumerate((pawns >= 1, pawns >= 2, rook == 1, bishop == 1, rb < 2)):
                res.append(torch.where(on, torch.full_like(p, base + j), torch.full_like(p, PAD)))
        return torch.cat([idx, torch.stack(res, 1)], 1)

    stm = side_inputs(side)
    other = side_inputs(1 - side)
    score = raw[:, 20:22]
    score = (score[:, 0] | (score[:, 1] << 8)).to(torch.int16).float()
    white = ((raw[:, 19] >> 1) & 3).float() / 2
    result = torch.where(side == 0, white, 1 - white)
    return stm, other, score, result


class SkNet(nn.Module):
    def __init__(self, ft=256, l1=32, l2=32, output_scale=600.0):
        super().__init__()
        self.ft_size, self.l1_size, self.l2_size, self.output_scale = ft, l1, l2, output_scale
        self.ft = nn.Embedding(NUM_FEATURES + 1, ft, padding_idx=PAD)
        self.ft_b = nn.Parameter(torch.full((ft,), 0.25))
        self.l1 = nn.Linear(2 * ft, l1)
        self.l2 = nn.Linear(l1, l2)
        self.out = nn.Linear(l2, 1)
        with torch.no_grad():
            self.ft.weight.normal_(0, 0.02)
            self.ft.weight[PAD].zero_()

    def accumulate(self, idx):
        return self.ft(idx).sum(1) + self.ft_b

    def forward(self, stm_idx, other_idx):
        x = torch.cat([self.accumulate(stm_idx), self.accumulate(other_idx)], 1).clamp(0, 1)
        h1 = self.l1(x).clamp(0, 1)
        h2 = self.l2(h1).clamp(0, 1)
        return self.out(h2)[:, 0]

    def clamp_hidden(self, limit=127 / 64):
        """Keep hidden weights within what the int16 quantization can hold."""
        with torch.no_grad():
            for layer in (self.l1, self.l2, self.out):
                layer.weight.clamp_(-limit, limit)


def save_nnue(net: SkNet, path, description=""):
    desc = f"{RULESET} {description}".strip().encode()
    with torch.no_grad():
        parts = [
            net.ft.weight[:NUM_FEATURES],
            net.ft_b,
            net.l1.weight,
            net.l1.bias,
            net.l2.weight,
            net.l2.bias,
            net.out.weight.reshape(-1),
            net.out.bias,
        ]
        weights = np.concatenate([p.detach().cpu().float().numpy().reshape(-1) for p in parts]).astype("<f4")
    header = MAGIC + struct.pack("<5I", VERSION, NUM_FEATURES, net.ft_size, net.l1_size, net.l2_size)
    header += struct.pack("<f", net.output_scale) + struct.pack("<I", len(desc)) + desc
    tmp = f"{path}.tmp"
    with open(tmp, "wb") as f:
        f.write(header)
        f.write(weights.tobytes())
    import os

    os.replace(tmp, path)


def load_nnue(path) -> SkNet:
    data = open(path, "rb").read()
    if data[:4] != MAGIC:
        raise ValueError(f"{path}: not a StockKnight network")
    version, inputs, ft, l1, l2 = struct.unpack_from("<5I", data, 4)
    if version != VERSION or inputs != NUM_FEATURES:
        raise ValueError(f"{path}: unsupported network (version {version}, {inputs} inputs)")
    (scale,) = struct.unpack_from("<f", data, 24)
    (dlen,) = struct.unpack_from("<I", data, 28)
    w = np.frombuffer(data, dtype="<f4", offset=32 + dlen)
    net = SkNet(ft, l1, l2, scale)
    sizes = [inputs * ft, ft, l1 * 2 * ft, l1, l2 * l1, l2, l2, 1]
    chunks = np.split(w, np.cumsum(sizes)[:-1])
    with torch.no_grad():
        net.ft.weight[:NUM_FEATURES] = torch.from_numpy(chunks[0].reshape(inputs, ft).copy())
        net.ft.weight[PAD].zero_()
        net.ft_b.copy_(torch.from_numpy(chunks[1].copy()))
        net.l1.weight.copy_(torch.from_numpy(chunks[2].reshape(l1, 2 * ft).copy()))
        net.l1.bias.copy_(torch.from_numpy(chunks[3].copy()))
        net.l2.weight.copy_(torch.from_numpy(chunks[4].reshape(l2, l1).copy()))
        net.l2.bias.copy_(torch.from_numpy(chunks[5].copy()))
        net.out.weight.copy_(torch.from_numpy(chunks[6].reshape(1, l2).copy()))
        net.out.bias.copy_(torch.from_numpy(chunks[7].copy()))
    return net


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="network tools")
    ap.add_argument("command", choices=["random"])
    ap.add_argument("out")
    ap.add_argument("--ft", type=int, default=256)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    save_nnue(SkNet(a.ft), a.out, f"random seed {a.seed}")
