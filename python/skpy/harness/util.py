"""Subprocesses in their own process group, atomic files, hardware facts, seeds, formatting."""

import datetime
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

from .. import REPO


class StepFailed(Exception):
    """A command a step ran failed; the message ends with the end of its log."""


class Interrupted(Exception):
    """Ctrl-C, SIGTERM or SIGHUP: the child group has been stopped."""


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def host() -> str:
    return socket.gethostname()


def atomic_write(path, text: str):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def atomic_json(path, obj):
    atomic_write(path, json.dumps(obj, indent=1) + "\n")


def seed(base: int, *parts) -> int:
    """A seed derived from the run's base seed and a path of names, stable across machines."""
    h = hashlib.sha256("/".join(map(str, (base, *parts))).encode()).digest()
    return int.from_bytes(h[:4], "little") % 1_000_000_000


def file_hash(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:16]


def source_hash() -> str:
    """Hash of the Rust sources, to tell whether the binaries are current."""
    h = hashlib.sha256()
    for p in sorted(Path(REPO).glob("crates/**/*.rs")) + sorted(Path(REPO).glob("**/Cargo.toml")):
        if "target" in p.parts:
            continue
        h.update(str(p.relative_to(REPO)).encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def free_disk_gb(path) -> float:
    return shutil.disk_usage(path).free / 1e9


def folder_bytes(path) -> int:
    return sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file())


def machine() -> dict:
    mem = 0
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemTotal"):
                mem = int(line.split()[1]) * 1024
    except OSError:
        pass
    flags = ""
    try:
        flags = next((l for l in open("/proc/cpuinfo") if l.startswith("flags")), "")
    except OSError:
        pass
    return {"host": host(), "os": platform.platform(), "python": sys.version.split()[0],
            "cpus": os.cpu_count(), "memory_gb": round(mem / 1e9, 1), "avx2": " avx2" in flags,
            "vnni": "avx512_vnni" in flags}


def tail(path, n=20) -> str:
    try:
        return "".join(open(path, errors="replace").readlines()[-n:])
    except OSError:
        return ""


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# --- running children ---------------------------------------------------------------------------

_current = None  # the child process group being run


def _on_signal(signum, frame):
    stop_child()
    raise Interrupted(signal.Signals(signum).name)


def install_signal_handlers():
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, _on_signal)


def stop_child():
    global _current
    p = _current
    if p is None or p.poll() is not None:
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
    except ProcessLookupError:
        pass


def run(cmd, log_path, cwd=None, env=None, poll=None):
    """Run `cmd` in its own process group, output appended to `log_path`. `poll()` is called
    every second while it runs and may raise to stop it. Raises StepFailed on failure."""
    global _current
    cmd = [str(c) for c in cmd]
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    full_env = {**os.environ, "PYTHONPATH": str(Path(REPO) / "python"), **(env or {})}
    with open(log_path, "a") as f:
        f.write(f"\n# {now()} {' '.join(cmd)}\n")
        f.flush()
        _current = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=cwd or REPO, env=full_env,
                                    start_new_session=True)
        try:
            while _current.poll() is None:
                if poll:
                    try:
                        poll()
                    except BaseException:
                        stop_child()
                        raise
                time.sleep(1)
        finally:
            code = _current.returncode
            _current = None
    if code != 0:
        raise StepFailed(f"{Path(cmd[0]).name} exited with {code}; end of {log_path}:\n{tail(log_path)}")


def fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 90:
        return f"{seconds} s"
    if seconds < 5400:
        return f"{seconds // 60} min"
    return f"{seconds / 3600:.1f} h"


def fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} PB"
