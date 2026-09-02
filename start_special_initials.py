#!/usr/bin/env python3
"""Download and validate digit-, apostrophe-, micro- and omega-initial forms."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import downloader


ROOT = Path(__file__).resolve().parent
SUPPLEMENT = ROOT / "config" / "special-initials-woordenlijst.org.txt"
BUCKETS = [
    "symbol-apostrophe",
    *(f"digit-{digit}" for digit in "0123456789"),
    "symbol-micro",
    "symbol-omega",
]


def run_bucket(bucket: str, delay: float) -> tuple[str, int]:
    downloader.fetch(bucket, None, delay, 5)
    return bucket, downloader.validate(bucket)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--delay", type=float, default=0.075)
    args = parser.parse_args()
    if not 1 <= args.workers <= len(BUCKETS):
        parser.error(f"workers moet tussen 1 en {len(BUCKETS)} liggen")

    downloader.append_word_list(SUPPLEMENT)
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_bucket, bucket, args.delay): bucket for bucket in BUCKETS}
        for future in as_completed(futures):
            bucket = futures[future]
            try:
                _, validation_status = future.result()
                if validation_status:
                    failures.append(bucket)
            except Exception as exc:  # preserve remaining bucket progress
                print(f"FAILED {bucket}: {exc}", flush=True)
                failures.append(bucket)
    if failures:
        print("SPECIAL INITIALS INCOMPLETE: " + ", ".join(sorted(failures)))
        return 1
    print("SPECIAL INITIALS COMPLETE: " + ", ".join(BUCKETS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
