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
VERSION = 2


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


def bucket_torch(raw: torch.Tensor, buckets: int) -> torch.Tensor:
    """Output bucket per record, as `features::bucket` in Rust: pieces besides the kings, on the
    board and in reserve (30 at the start), in `buckets` equal slices of 0..=30."""
    raw = raw.long()
    n = raw.shape[0]
    b = raw[:, :18]
    codes = torch.stack([b & 15, b >> 4], dim=2).reshape(n, 36)
    board = ((codes != 0) & ((codes & 7) != 6)).sum(1)
    hand = raw[:, 18]
    total = board
    for c in (0, 1):
        bits = (hand >> (4 * c)) & 15
        total = total + (bits & 3) + ((bits >> 2) & 1) + ((bits >> 3) & 1)
    return (total * buckets // 31).clamp(max=buckets - 1)


class SkNet(nn.Module):
    """Feature transformer, psqt weights and one layer stack per output bucket. Stacks are kept
    as single wide layers whose rows are grouped by bucket (`[bucket][out][in]`, the file
    order); each position uses its own bucket's slice."""

    def __init__(self, ft=256, l1=32, l2=32, output_scale=600.0, buckets=1):
        super().__init__()
        self.ft_size, self.l1_size, self.l2_size, self.output_scale = ft, l1, l2, output_scale
        self.buckets = buckets
        self.ft = nn.Embedding(NUM_FEATURES + 1, ft, padding_idx=PAD)
        self.ft_b = nn.Parameter(torch.full((ft,), 0.25))
        self.psqt = nn.Embedding(NUM_FEATURES + 1, buckets, padding_idx=PAD)
        self.l1 = nn.Linear(2 * ft, l1 * buckets)
        self.l2 = nn.Linear(l1, l2 * buckets)
        self.out = nn.Linear(l2, buckets)
        with torch.no_grad():
            self.ft.weight.normal_(0, 0.02)
            self.ft.weight[PAD].zero_()
            self.psqt.weight.zero_()

    def accumulate(self, idx):
        return self.ft(idx).sum(1) + self.ft_b

    @staticmethod
    def _pick(y, bucket, width):
        """Bucket `bucket[i]`'s `width` outputs of row i of `y` (N, buckets·width)."""
        y = y.view(y.shape[0], -1, width)
        return y.gather(1, bucket.view(-1, 1, 1).expand(-1, 1, width))[:, 0]

    def forward(self, stm_idx, other_idx, bucket=None):
        if bucket is None:
            bucket = torch.zeros(stm_idx.shape[0], dtype=torch.long, device=stm_idx.device)
        x = torch.cat([self.accumulate(stm_idx), self.accumulate(other_idx)], 1).clamp(0, 1)
        h1 = self._pick(self.l1(x), bucket, self.l1_size).clamp(0, 1)
        h2 = self._pick(self.l2(h1), bucket, self.l2_size).clamp(0, 1)
        out = self._pick(self.out(h2), bucket, 1)[:, 0]
        if self.buckets > 1:
            ps = self.psqt(stm_idx).sum(1).gather(1, bucket[:, None])[:, 0]
            po = self.psqt(other_idx).sum(1).gather(1, bucket[:, None])[:, 0]
            out = out + (ps - po) / 2
        return out

    def expand_from(self, src: "SkNet"):
        """Start from a single-bucket network of the same widths: its feature transformer and a
        copy of its layer stack in every bucket, psqt zero. Gives the same outputs as `src`."""
        if (src.ft_size, src.l1_size, src.l2_size, src.buckets) != (self.ft_size, self.l1_size, self.l2_size, 1):
            raise ValueError("expand_from needs a single-bucket network of the same widths")
        with torch.no_grad():
            self.ft.weight.copy_(src.ft.weight)
            self.ft_b.copy_(src.ft_b)
            self.psqt.weight.zero_()
            self.l1.weight.copy_(src.l1.weight.repeat(self.buckets, 1))
            self.l1.bias.copy_(src.l1.bias.repeat(self.buckets))
            self.l2.weight.copy_(src.l2.weight.repeat(self.buckets, 1))
            self.l2.bias.copy_(src.l2.bias.repeat(self.buckets))
            self.out.weight.copy_(src.out.weight.repeat(self.buckets, 1))
            self.out.bias.copy_(src.out.bias.repeat(self.buckets))

    def clamp_hidden(self, limit=127 / 64):
        """Keep hidden weights within what the int16 quantization can hold."""
        with torch.no_grad():
            for layer in (self.l1, self.l2, self.out):
                layer.weight.clamp_(-limit, limit)


def save_nnue(net: SkNet, path, description=""):
    desc = f"{RULESET} {description}".strip().encode()
    with torch.no_grad():
        B, l1, l2 = net.buckets, net.l1_size, net.l2_size
        parts = [net.ft.weight[:NUM_FEATURES], net.ft_b, net.psqt.weight[:NUM_FEATURES]]
        for b in range(B):
            parts += [
                net.l1.weight[b * l1:(b + 1) * l1],
                net.l1.bias[b * l1:(b + 1) * l1],
                net.l2.weight[b * l2:(b + 1) * l2],
                net.l2.bias[b * l2:(b + 1) * l2],
                net.out.weight[b],
                net.out.bias[b:b + 1],
            ]
        weights = np.concatenate([p.detach().cpu().float().numpy().reshape(-1) for p in parts]).astype("<f4")
    header = MAGIC + struct.pack("<6I", VERSION, NUM_FEATURES, net.ft_size, net.l1_size, net.l2_size, net.buckets)
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
    if version not in (1, 2) or inputs != NUM_FEATURES:
        raise ValueError(f"{path}: unsupported network (version {version}, {inputs} inputs)")
    at = 24
    B = 1
    if version >= 2:
        (B,) = struct.unpack_from("<I", data, at)
        at += 4
    (scale,) = struct.unpack_from("<f", data, at)
    (dlen,) = struct.unpack_from("<I", data, at + 4)
    w = np.frombuffer(data, dtype="<f4", offset=at + 8 + dlen)
    net = SkNet(ft, l1, l2, scale, B)
    sizes = [inputs * ft, ft] + ([inputs * B] if version >= 2 else [])
    sizes += [l1 * 2 * ft, l1, l2 * l1, l2, l2, 1] * B
    chunks = np.split(w, np.cumsum(sizes)[:-1])
    t = lambda a, *shape: torch.from_numpy(a.reshape(*shape).copy())
    with torch.no_grad():
        net.ft.weight[:NUM_FEATURES] = t(chunks[0], inputs, ft)
        net.ft.weight[PAD].zero_()
        net.ft_b.copy_(t(chunks[1], ft))
        i = 2
        if version >= 2:
            net.psqt.weight[:NUM_FEATURES] = t(chunks[2], inputs, B)
            net.psqt.weight[PAD].zero_()
            i = 3
        for b in range(B):
            c = chunks[i + 6 * b: i + 6 * b + 6]
            net.l1.weight[b * l1:(b + 1) * l1] = t(c[0], l1, 2 * ft)
            net.l1.bias[b * l1:(b + 1) * l1] = t(c[1], l1)
            net.l2.weight[b * l2:(b + 1) * l2] = t(c[2], l2, l1)
            net.l2.bias[b * l2:(b + 1) * l2] = t(c[3], l2)
            net.out.weight[b] = t(c[4], l2)
            net.out.bias[b] = float(c[5][0])
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
