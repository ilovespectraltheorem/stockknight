"""A run folder: its state, events, lock and stop request."""

import json
import os
import time
from pathlib import Path

from . import VERSION
from . import config as C
from .util import atomic_json, host, now, pid_alive

FORMAT = 2


class RunError(Exception):
    pass


class Run:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.name = self.root.name

    # --- files ----------------------------------------------------------------------------------

    @property
    def state_path(self):
        return self.root / "state.json"

    @property
    def config_path(self):
        return self.root / "run.toml"

    def exists(self):
        return self.state_path.exists()

    def path(self, *parts):
        return self.root.joinpath(*parts)

    def rel(self, p) -> str:
        return str(Path(p).resolve().relative_to(self.root))

    # --- state ----------------------------------------------------------------------------------

    def load(self) -> dict:
        if not self.exists():
            raise RunError(f"{self.root}: not a run (no state.json)")
        s = json.loads(self.state_path.read_text())
        if s.get("format") != FORMAT:
            raise RunError(f"{self.state_path}: format {s.get('format')}, this harness reads {FORMAT}")
        self.state = s
        return s

    def save(self):
        self.state["updated"] = now()
        atomic_json(self.state_path, self.state)

    @staticmethod
    def new_state(name, description, condition, cfg):
        return {"format": FORMAT, "name": name, "description": description, "created": now(), "updated": now(),
                "condition": condition, "config": cfg, "models": [
                    {"name": "g0", "status": "accepted", "teacher": None, "round": None, "net": None,
                     "created": now(), "finished": now()}],
                "rounds": [], "results": [], "invocations": [], "version": VERSION}

    def model(self, name):
        for m in self.state["models"]:
            if m["name"] == name:
                return m
        raise RunError(f"no model {name}")

    def models(self, status=None):
        return [m for m in self.state["models"] if status is None or m["status"] == status]

    def teacher(self) -> str:
        """The newest accepted model."""
        return self.models("accepted")[-1]["name"]

    def in_progress(self):
        return next((m for m in self.state["models"] if m["status"] == "in progress"), None)

    def round(self, k):
        return next((r for r in self.state["rounds"] if r["round"] == k), None)

    def net(self, name) -> str:
        n = self.model(name)["net"]
        return str(self.path(n)) if n else "none"

    def config(self, overrides=()) -> dict:
        return C.load(self.config_path, overrides)

    # --- events ---------------------------------------------------------------------------------

    def event(self, event, **fields):
        line = json.dumps({"time": now(), "t": round(time.time(), 3), "event": event, **fields})
        path = self.path("events.jsonl")
        with open(path, "a+b") as f:
            # A line cut off by a crash gets its own line ending, so this event is not glued to it.
            if f.tell() and (f.seek(-1, os.SEEK_END) or True) and f.read(1) != b"\n":
                f.write(b"\n")
            f.write((line + "\n").encode())

    def events(self, n=None) -> list:
        """Events, oldest first; a line cut off by a crash is skipped."""
        out = []
        try:
            for line in open(self.path("events.jsonl")):
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        except OSError:
            return []
        return out[-n:] if n else out

    # --- lock and stop --------------------------------------------------------------------------

    @property
    def lock_path(self):
        return self.root / "LOCK"

    def lock_info(self):
        try:
            return json.loads(self.lock_path.read_text())
        except (OSError, json.JSONDecodeError):
            return None

    def acquire(self, force=False):
        """Create LOCK exclusively. A lock whose process is gone on this host is stale and taken
        over; one held by another host needs `force`."""
        for _ in range(2):
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                info = self.lock_info() or {}
                if info.get("host") == host() and not pid_alive(int(info.get("pid", 0))):
                    self.event("stale_lock", lock=info)
                    self.lock_path.unlink(missing_ok=True)
                    continue
                if info.get("host") != host() and force:
                    self.event("stale_lock", lock=info, forced=True)
                    self.lock_path.unlink(missing_ok=True)
                    continue
                raise RunError(f"{self.name} is locked by pid {info.get('pid')} on {info.get('host')} "
                               f"since {info.get('started')}" + ("" if info.get("host") == host() else "; --force takes it over"))
            with os.fdopen(fd, "w") as f:
                json.dump({"pid": os.getpid(), "host": host(), "started": now()}, f)
            return
        raise RunError("could not take the lock")

    def release(self):
        info = self.lock_info()
        if info and info.get("pid") == os.getpid():
            self.lock_path.unlink(missing_ok=True)

    def running(self):
        info = self.lock_info()
        if not info:
            return None
        if info.get("host") == host() and not pid_alive(int(info.get("pid", 0))):
            return None
        return info

    @property
    def stop_path(self):
        return self.root / "STOP"

    def request_stop(self):
        self.stop_path.write_text(now() + "\n")

    def stop_requested(self):
        return self.stop_path.exists()

    def clear_stop(self):
        self.stop_path.unlink(missing_ok=True)
