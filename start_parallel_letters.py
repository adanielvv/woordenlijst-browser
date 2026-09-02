#!/usr/bin/env python3
"""Start one detached, resumable archive process for every requested letter."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import string
import subprocess
import sys

import downloader


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "config" / "a-z_woordenboek.org.txt"
SUPPLEMENT = ROOT / "config" / "special-initials-woordenlijst.org.txt"
SPLIT_PREFIXES = {
    "a": ["ap", "ar", "as", "au"],
    "b": ["bi", "bl", "bo", "br", "bu"],
    "d": ["du"],
    "g": ["gi", "gl", "gr"],
    "k": ["kw"],
    "l": ["le", "li", "lo", "lu"],
    "o": ["om", "on", "oo", "op", "or", "ou", "ov"],
    "s": ["sm", "sn", "so", "sp", "st", "su"],
    "v": ["vr", "vu"],
}


def alive(pid_path: Path) -> bool:
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        os.kill(pid, 0)
        return True
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--letters", default=string.ascii_lowercase)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=0.075)
    parser.add_argument("--skip-import", action="store_true",
                        help="Gebruik de reeds geïmporteerde actieve bronlijst")
    args = parser.parse_args()
    letters = "".join(dict.fromkeys(args.letters.lower()))
    if not letters or any(letter not in string.ascii_lowercase for letter in letters):
        parser.error("letters mogen alleen a-z bevatten")

    if not args.skip_import:
        downloader.import_word_list(SOURCE)
        if SUPPLEMENT.exists():
            downloader.append_word_list(SUPPLEMENT)
    started: list[tuple[str, int]] = []
    skipped: list[str] = []
    for letter in letters:
        run_name = f"letter-{letter}"
        pid_path = ROOT / "state" / f"{run_name}.pid"
        if alive(pid_path):
            skipped.append(letter)
            continue
        env = os.environ.copy()
        env["ARCHIVE_RUN_NAME"] = run_name
        command = [
            sys.executable, str(ROOT / "run_archive.py"),
            "--start-letter", letter,
            "--end-letter", letter,
            "--batch-size", str(args.batch_size),
            "--delay", str(args.delay),
            "--skip-discovery",
        ]
        for prefix in SPLIT_PREFIXES.get(letter, []):
            command.extend(["--exclude-prefix", prefix])
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        started.append((letter, process.pid))

    print("STARTED " + " ".join(f"{letter}:{pid}" for letter, pid in started))
    if skipped:
        print("ALREADY_RUNNING " + " ".join(skipped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
