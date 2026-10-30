"""The trainer.

    python -m skpy.train --train <file>... --val <file> --out <dir> [options]

Loss: p = sigmoid(output × scale / K); t = λ·sigmoid(score / K) + (1 − λ)·result; mean (p − t)².
Writes best.nnue, last.nnue, metrics.jsonl, checkpoint.pt (while training) and summary.json
(last: its presence means training finished). After training, best.nnue is checked against
the Rust engine and the run fails if the two differ by more than 1e-3.
"""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import torch

from . import RULESET, binary
from .check_nnue import max_difference
from .nnue import SkNet, batch_torch, load_nnue, save_nnue
from .records import fit_k, load


def write_json(path, obj):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def g0_values(records_path) -> np.ndarray:
    """G0 static values for every record, from the Rust tool."""
    out = f"{records_path}.g0.tmp"
    subprocess.run([binary("sk-nnue"), "g0", str(records_path), out], check=True)
    v = np.fromfile(out, dtype="<i4")
    os.remove(out)
    return v


def evaluate(net, raw, K, lam, scale, batch=65536):
    """Validation loss, the error against game results alone, and the mean |cp − score|."""
    net.eval()
    loss = result_mse = mae = 0.0
    n = raw.shape[0]
    with torch.no_grad():
        for i in range(0, n, batch):
            stm, other, score, result = batch_torch(raw[i : i + batch])
            out = net(stm, other)
            p = torch.sigmoid(out * scale / K)
            t = lam * torch.sigmoid(score / K) + (1 - lam) * result
            loss += float(((p - t) ** 2).sum())
            result_mse += float(((p - result) ** 2).sum())
            mae += float((out * scale - score).abs().sum())
    net.train()
    return loss / n, result_mse / n, mae / n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", nargs="+", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--batch", type=int, default=16384)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--decay", type=float, default=0.3)
    ap.add_argument("--decay-every", type=int, default=5)
    ap.add_argument("--lambda", dest="lam", type=float, default=0.75)
    ap.add_argument("--K", type=float, default=0, help="0 = fit on the training data")
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--ft", type=int, default=256)
    ap.add_argument("--l1", type=int, default=32)
    ap.add_argument("--l2", type=int, default=32)
    ap.add_argument("--output-scale", type=float, default=600.0)
    ap.add_argument("--init-from", default="", help="start from this network's weights")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--name", default="")
    ap.add_argument("--fresh", action="store_true")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.threads:
        torch.set_num_threads(a.threads)
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)

    train_np = np.concatenate([load(p) for p in a.train])
    val_np = load(a.val)
    K = a.K or fit_k(train_np)
    train = torch.from_numpy(train_np)
    val = torch.from_numpy(val_np.copy())
    print(f"train {len(train_np):,} positions, val {len(val_np):,}, K {K:.0f}, lambda {a.lam}", flush=True)

    # G0 baseline on the validation set, measured the same way.
    g0 = torch.from_numpy(g0_values(a.val).astype(np.float32))
    _, _, score, result = batch_torch(val)
    t = a.lam * torch.sigmoid(score / K) + (1 - a.lam) * result
    p = torch.sigmoid(g0 / K)
    g0_stats = {
        "val_loss": float(((p - t) ** 2).mean()),
        "result_mse": float(((p - result) ** 2).mean()),
        "score_mae_cp": float((g0 - score).abs().mean()),
    }
    print(f"G0 baseline: val_loss {g0_stats['val_loss']:.6f} result_mse {g0_stats['result_mse']:.5f}", flush=True)

    net = SkNet(a.ft, a.l1, a.l2, a.output_scale)
    if a.init_from:
        net.load_state_dict(load_nnue(a.init_from).state_dict())
        print(f"starting from {a.init_from}", flush=True)
    opt = torch.optim.Adam(net.parameters(), lr=a.lr)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=a.decay_every, gamma=a.decay)
    history, best, best_epoch, start_epoch = [], float("inf"), 0, 0
    ckpt = out / "checkpoint.pt"
    if ckpt.exists() and not a.fresh:
        state = torch.load(ckpt, weights_only=False)
        net.load_state_dict(state["net"])
        opt.load_state_dict(state["opt"])
        sched.load_state_dict(state["sched"])
        history, best, best_epoch, start_epoch = state["history"], state["best"], state["best_epoch"], state["epoch"]
        rng = state["rng"]
        torch.set_rng_state(state["torch_rng"])
        print(f"resuming after epoch {start_epoch}", flush=True)

    desc = f"{a.name} K {K:.0f} lambda {a.lam}".strip()
    n = train.shape[0]
    for epoch in range(start_epoch + 1, a.epochs + 1):
        t0 = time.time()
        perm = torch.from_numpy(rng.permutation(n))
        total = 0.0
        for i in range(0, n - a.batch + 1, a.batch):
            stm, other, score, result = batch_torch(train[perm[i : i + a.batch]])
            out_raw = net(stm, other)
            p = torch.sigmoid(out_raw * a.output_scale / K)
            target = a.lam * torch.sigmoid(score / K) + (1 - a.lam) * result
            loss = ((p - target) ** 2).mean()
            if not torch.isfinite(loss):
                raise SystemExit(f"non-finite loss at epoch {epoch}")
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            net.clamp_hidden()
            total += loss.item() * a.batch
        sched.step()
        val_loss, result_mse, mae = evaluate(net, val, K, a.lam, a.output_scale)
        secs = time.time() - t0
        improved = val_loss < best
        if improved:
            best, best_epoch = val_loss, epoch
            save_nnue(net, out / "best.nnue", f"{desc} epoch {epoch}")
        save_nnue(net, out / "last.nnue", f"{desc} epoch {epoch}")
        row = {
            "epoch": epoch, "lr": opt.param_groups[0]["lr"], "train_loss": total / (n // a.batch * a.batch),
            "val_loss": val_loss, "result_mse": result_mse, "score_mae_cp": mae, "seconds": secs,
            "positions_per_second": n / secs, "best": improved,
        }
        history.append(row)
        with open(out / "metrics.jsonl", "a") as f:
            f.write(json.dumps(row) + "\n")
        print(
            f"epoch {epoch:2d}  train {row['train_loss']:.6f}  val {val_loss:.6f}  result_mse {result_mse:.5f}  "
            f"mae {mae:.0f} cp  {secs:.0f} s{'  *' if improved else ''}",
            flush=True,
        )
        torch.save(
            {"net": net.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "history": history,
             "best": best, "best_epoch": best_epoch, "epoch": epoch, "rng": rng, "torch_rng": torch.get_rng_state()},
            ckpt,
        )
        if epoch - best_epoch >= a.patience:
            print(f"no improvement for {a.patience} epochs; stopping", flush=True)
            break

    diff = max_difference(out / "best.nnue", a.val, 2000)
    print(f"Rust vs PyTorch on best.nnue: max difference {diff:.2e}", flush=True)
    if diff > 1e-3:
        raise SystemExit("best.nnue gives different results in Rust and PyTorch")
    ckpt.unlink(missing_ok=True)
    write_json(out / "summary.json", {
        "ruleset": RULESET, "train_positions": int(n), "val_positions": int(val.shape[0]), "K": K, "lambda": a.lam,
        "best_epoch": best_epoch, "epochs_run": len(history), "best": history[best_epoch - 1] if best_epoch else None,
        "g0": g0_stats, "architecture": f"{a.ft}-{a.l1}-{a.l2}", "rust_max_difference": diff,
    })


if __name__ == "__main__":
    main()
