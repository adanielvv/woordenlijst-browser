#!/usr/bin/env python3
"""Build the compact GitHub Pages and Supabase publication artifacts."""

from __future__ import annotations

import csv
import gzip
import json
import shutil
import sqlite3
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "database" / "woordenlijst.sqlite"
DIST = ROOT / "docs"
EXPORT = ROOT / "publication" / "dist"
DETAILS = DIST / "data" / "details"


def scalar(db: sqlite3.Connection, query: str, params: tuple = ()) -> int:
    return int(db.execute(query, params).fetchone()[0])


def build_entries(db: sqlite3.Connection) -> None:
    target = EXPORT / "supabase" / "entries.csv.gz"
    target.parent.mkdir(parents=True, exist_ok=True)
    query = """
      SELECT r.id, r.query_word, r.prefix_bucket,
        COALESCE((SELECT label FROM lemmata WHERE response_id=r.id ORDER BY id LIMIT 1), ''),
        COALESCE((SELECT pronunciation FROM lemmata WHERE response_id=r.id AND pronunciation<>'' ORDER BY id LIMIT 1), ''),
        COALESCE((SELECT gloss FROM lemmata WHERE response_id=r.id AND gloss<>'' ORDER BY id LIMIT 1), ''),
        (SELECT COUNT(*) FROM lemmata WHERE response_id=r.id)
      FROM responses r ORDER BY r.id
    """
    with gzip.open(target, "wt", encoding="utf-8", newline="", compresslevel=6) as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(("id", "word", "prefix", "label", "pronunciation", "gloss", "lemma_count"))
        for row in db.execute(query):
            writer.writerow(row)


def build_details(db: sqlite3.Connection) -> dict[str, int]:
    DETAILS.mkdir(parents=True, exist_ok=True)
    prefixes = [row[0] for row in db.execute("SELECT DISTINCT prefix_bucket FROM responses ORDER BY prefix_bucket")]
    counts: dict[str, int] = {}
    lemma_query = db.cursor()
    form_query = db.cursor()
    for number, prefix in enumerate(prefixes, 1):
        safe_prefix = prefix.encode("utf-8").hex()
        target = DETAILS / f"{safe_prefix}.ndjson.gz"
        count = 0
        with gzip.open(target, "wt", encoding="utf-8", compresslevel=6) as output:
            responses = db.execute(
                "SELECT id,query_word,prefix_bucket,bytes,downloaded_at FROM responses WHERE prefix_bucket=? ORDER BY id",
                (prefix,),
            )
            for response in responses:
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
        counts[prefix] = count
        if number % 25 == 0 or number == len(prefixes):
            print(f"details {number}/{len(prefixes)} prefixes", flush=True)
    return counts


def build_metadata(db: sqlite3.Connection, prefix_counts: dict[str, int]) -> None:
    letter_counts: dict[str, int] = defaultdict(int)
    for prefix, count in prefix_counts.items():
        if prefix and prefix[0].lower() in "abcdefghijklmnopqrstuvwxyz":
            letter_counts[prefix[0].lower()] += count
    stats = {
        "responses": scalar(db, "SELECT COUNT(*) FROM responses"),
        "lemmata": scalar(db, "SELECT COUNT(*) FROM lemmata"),
        "paradigms": scalar(db, "SELECT COUNT(*) FROM paradigms"),
        "prefixes": len(prefix_counts),
        "letters": dict(sorted(letter_counts.items())),
    }
    data_dir = DIST / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (data_dir / "prefixes.json").write_text(
        json.dumps([{"prefix": key, "total": value} for key, value in sorted(prefix_counts.items())], ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def copy_site() -> None:
    shutil.copytree(ROOT / "web" / "public", DIST, dirs_exist_ok=True)
    (DIST / "config.example.js").unlink(missing_ok=True)
    site = ROOT / "site"
    # Only deployment-specific files may override the canonical frontend.
    # Copying the whole legacy site directory here used to replace the current
    # access gate and combined-PDF implementation with stale app.js/index.html.
    for name in ("config.js", ".nojekyll"):
        source = site / name
        if source.exists():
            shutil.copy2(source, DIST / name)


def main() -> None:
    DIST.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    print("Building Supabase entries export…", flush=True)
    build_entries(db)
    print("Building static detail shards…", flush=True)
    counts = build_details(db)
    build_metadata(db, counts)
    copy_site()
    print(f"Publication ready at {DIST}", flush=True)


if __name__ == "__main__":
    main()
