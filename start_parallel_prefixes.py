#!/usr/bin/env python3
"""Start detached archive processes for selected two-letter buckets."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
DEFAULT_PREFIXES = (
    "ap ar as au bi bl bo br bu du gi gl gr "
    "kw le li lo lu om on oo op or ou ov "
    "sm sn so sp st su vr vu"
)


def alive(pid_path: Path) -> bool:
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        os.kill(pid, 0)
        return True
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefixes", nargs="*", default=DEFAULT_PREFIXES.split())
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=0.075)
    args = parser.parse_args()
    prefixes = list(dict.fromkeys(prefix.lower() for prefix in args.prefixes))
    if not prefixes or any(not re.fullmatch(r"[a-z]{2}", prefix) for prefix in prefixes):
        parser.error("prefixes moeten exact twee letters a-z bevatten")

    started: list[tuple[str, int]] = []
    skipped: list[str] = []
    for prefix in prefixes:
        run_name = f"prefix-{prefix}"
        pid_path = ROOT / "state" / f"{run_name}.pid"
        if alive(pid_path):
            skipped.append(prefix)
            continue
        env = os.environ.copy()
        env["ARCHIVE_RUN_NAME"] = run_name
        command = [
            sys.executable, str(ROOT / "run_archive.py"),
            "--start-letter", prefix[0],
            "--end-letter", prefix[0],
            "--batch-size", str(args.batch_size),
            "--delay", str(args.delay),
            "--skip-discovery",
            "--include-prefix", prefix,
        ]
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        started.append((prefix, process.pid))

    print("STARTED " + " ".join(f"{prefix}:{pid}" for prefix, pid in started))
    if skipped:
        print("ALREADY_RUNNING " + " ".join(skipped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
