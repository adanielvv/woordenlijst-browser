#!/usr/bin/env python3
"""Discover and archive the complete alphabetical woordenlijst.org dataset."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import re
import string
import sys
import traceback

import downloader


ROOT = Path(__file__).resolve().parent
RUN_NAME = os.environ.get("ARCHIVE_RUN_NAME", "full-run")
if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", RUN_NAME):
    raise SystemExit("ongeldige ARCHIVE_RUN_NAME")
RUN_STATE = ROOT / "state" / f"{RUN_NAME}.json"
PID_FILE = ROOT / "state" / f"{RUN_NAME}.pid"
LOG_FILE = ROOT / "logs" / f"{RUN_NAME}.log"


def timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def save_state(**values) -> None:
    current = {}
    if RUN_STATE.exists():
        try:
            current = json.loads(RUN_STATE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            current = {}
    current.update(values)
    current["updated_at"] = timestamp()
    RUN_STATE.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bucket_counts(bucket: str) -> dict[str, int]:
    with downloader.state_conn() as db:
        rows = db.execute(
            "SELECT status, COUNT(*) n FROM candidates WHERE prefix_bucket=? AND active_source=1 GROUP BY status",
            (bucket,),
        ).fetchall()
    result = {row["status"]: row["n"] for row in rows}
    result["total"] = sum(result.values())
    return result


def letter_buckets(letter: str) -> list[str]:
    with downloader.state_conn() as db:
        rows = db.execute(
            "SELECT DISTINCT prefix_bucket FROM candidates WHERE first_bucket=? AND active_source=1 ORDER BY prefix_bucket",
            (letter,),
        ).fetchall()
    return [row[0] for row in rows]


def write_complete_marker(bucket: str, counts: dict[str, int]) -> None:
    marker = ROOT / "raw" / bucket[0] / bucket / "_COMPLETE.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps({"prefix": bucket, "counts": counts, "completed_at": timestamp()},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run_bucket(bucket: str, batch_size: int, delay: float) -> bool:
    while True:
        before = bucket_counts(bucket)
        pending = before.get("pending", 0)
        retryable_failed = before.get("failed", 0) + before.get("invalid_xml", 0)
        if pending == 0 and retryable_failed == 0:
            downloader.validate(bucket)
            write_complete_marker(bucket, before)
            return True
        save_state(status="running", current_prefix=bucket, counts=before)
        success, failed = downloader.fetch(bucket, batch_size, delay, 5)
        after = bucket_counts(bucket)
        if success == 0:
            print(f"BLOCKED {bucket}: geen voortgang; counts={after}", flush=True)
            save_state(status="blocked", current_prefix=bucket, counts=after)
            return False
        print(f"CHECKPOINT {bucket}: {after}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-letter", default="a", choices=string.ascii_lowercase)
    parser.add_argument("--end-letter", default="z", choices=string.ascii_lowercase)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=0.075)
    parser.add_argument("--word-list", type=Path,
                        help="Importeer deze bronlijst eenmaal vóór het hervatten")
    parser.add_argument("--skip-discovery", action="store_true",
                        help="Gebruik de geïmporteerde kandidaten en sla API-prefixdiscovery over")
    parser.add_argument("--include-prefix", action="append", default=[],
                        help="Verwerk uitsluitend deze bucket; mag meerdere keren")
    parser.add_argument("--exclude-prefix", action="append", default=[],
                        help="Sla deze bucket over; mag meerdere keren")
    args = parser.parse_args()
    if args.start_letter > args.end_letter:
        parser.error("start-letter moet voor end-letter liggen")
    include_prefixes = {downloader.ascii_fold(value).lower() for value in args.include_prefix}
    exclude_prefixes = {downloader.ascii_fold(value).lower() for value in args.exclude_prefix}
    if include_prefixes & exclude_prefixes:
        parser.error("dezelfde prefix kan niet tegelijk inbegrepen en uitgesloten zijn")

    downloader.init_databases()
    if args.word_list:
        downloader.import_word_list(args.word_list)
    PID_FILE.write_text(str(os.getpid()) + "\n", encoding="utf-8")
    letters = string.ascii_lowercase[
        string.ascii_lowercase.index(args.start_letter):string.ascii_lowercase.index(args.end_letter) + 1
    ]
    save_state(status="running", started_at=timestamp(), letters=letters,
               batch_size=args.batch_size, delay=args.delay,
               run_name=RUN_NAME,
               source_mode="file" if args.skip_discovery else "api-discovery",
               include_prefixes=sorted(include_prefixes),
               exclude_prefixes=sorted(exclude_prefixes),
               word_list=str(args.word_list.resolve()) if args.word_list else None)
    try:
        for letter in letters:
            if args.skip_discovery:
                print(f"FILE SOURCE LETTER {letter}", flush=True)
            else:
                print(f"DISCOVERY LETTER {letter}", flush=True)
                downloader.discover(letter)
            buckets = letter_buckets(letter)
            if include_prefixes:
                buckets = [bucket for bucket in buckets if bucket in include_prefixes]
            if exclude_prefixes:
                buckets = [bucket for bucket in buckets if bucket not in exclude_prefixes]
            save_state(status="running", current_letter=letter, buckets=buckets)
            for bucket in buckets:
                print(f"PREFIX {bucket}", flush=True)
                if not run_bucket(bucket, args.batch_size, args.delay):
                    return 2
        save_state(status="complete", completed_at=timestamp(), current_letter=None, current_prefix=None)
        print("FULL ARCHIVE COMPLETE", flush=True)
        return 0
    except KeyboardInterrupt:
        save_state(status="stopped", reason="KeyboardInterrupt")
        return 130
    except Exception as exc:
        traceback.print_exc()
        save_state(status="failed", reason=str(exc))
        return 1


if __name__ == "__main__":
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8", buffering=1) as log, \
         contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        raise SystemExit(main())
