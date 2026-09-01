#!/usr/bin/env python3
"""Estimate compressed publication detail size from representative prefixes."""

from __future__ import annotations

import gzip
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "database" / "woordenlijst.sqlite"


def export_prefix(db: sqlite3.Connection, prefix: str, target: Path) -> tuple[int, int]:
    rows = db.execute(
        "SELECT id, query_word, prefix_bucket, bytes, downloaded_at FROM responses WHERE prefix_bucket=? ORDER BY id",
        (prefix,),
    )
    lemma_query = db.cursor()
    form_query = db.cursor()
    count = 0
    with gzip.open(target, "wt", encoding="utf-8", compresslevel=6) as output:
        for response in rows:
            item = dict(response)
            lemmata = []
            for lemma in lemma_query.execute("SELECT * FROM lemmata WHERE response_id=? ORDER BY id", (response["id"],)):
                entry = dict(lemma)
                entry["paradigms"] = [dict(form) for form in form_query.execute(
                    "SELECT label,wordform,hyphenation,part_of_speech,position FROM paradigms WHERE lemma_row_id=? ORDER BY id",
                    (lemma["id"],),
                )]
                lemmata.append(entry)
            item["lemmata"] = lemmata
            output.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return count, target.stat().st_size


def main() -> None:
    prefixes = sys.argv[1:] or ["aa", "st", "vo", "on", "ge"]
    output_dir = ROOT / "publication" / ".estimates"
    output_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    total_responses = db.execute("SELECT COUNT(*) FROM responses").fetchone()[0]
    sampled_rows = sampled_bytes = 0
    for prefix in prefixes:
        count, size = export_prefix(db, prefix, output_dir / f"{prefix}.ndjson.gz")
        sampled_rows += count
        sampled_bytes += size
        print(f"{prefix}: {count:,} responses, {size / 1024 / 1024:.2f} MiB")
    estimate = sampled_bytes / sampled_rows * total_responses if sampled_rows else 0
    print(f"Sample: {sampled_rows:,} responses, {sampled_bytes / 1024 / 1024:.2f} MiB")
    print(f"Estimated full compressed details: {estimate / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()

