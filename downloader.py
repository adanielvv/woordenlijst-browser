#!/usr/bin/env python3
"""Archive woordenlijst.org XML responses and normalize them into SQLite."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sqlite3
import subprocess
import tempfile
import time
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
STATE_DB = ROOT / "state" / "downloader.sqlite"
CONTENT_DB = ROOT / "database" / "woordenlijst.sqlite"
BASE_URL = "https://woordenlijst.org/MolexServe/lexicon"
POS = "AA|ADV|NUM|INT|CONJ|PD|ADP|VRB|NOU|RES"
USER_AGENT = "GroeneBoekjeArchive/1.0 (personal archival research; sequential requests)"
SPECIAL_INITIAL_BUCKETS = {
    "'": "symbol-apostrophe",
    "µ": "symbol-micro",
    "Ω": "symbol-omega",
}


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def text_of(parent: ET.Element, tag: str) -> str:
    child = parent.find(tag)
    return "" if child is None or child.text is None else child.text.strip()


def ascii_fold(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold())
    return "".join(ch for ch in folded if not unicodedata.combining(ch))


def bucket_for(word: str) -> tuple[str, str]:
    initial = word[:1]
    if initial.isascii() and initial.isdigit():
        return "_numeric", f"digit-{initial}"
    if initial in SPECIAL_INITIAL_BUCKETS:
        return "_symbols", SPECIAL_INITIAL_BUCKETS[initial]
    folded = ascii_fold(word)
    first = folded[:1] if folded[:1].isalpha() and folded[:1].isascii() else "_other"
    if first == "_other":
        codepoint = f"u{ord(initial):04x}" if initial else "empty"
        return "_symbols", f"symbol-{codepoint}"
    second = folded[1:2]
    if second.isalpha() and second.isascii():
        return first, first + second
    return first, first + "_"


def safe_slug(word: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_fold(word)).strip("-")[:70]
    return slug or "woord"


def ensure_dirs() -> None:
    for rel in ("config", "discovery", "raw", "manifests", "state", "database", "logs", "exports"):
        (ROOT / rel).mkdir(parents=True, exist_ok=True)


def state_conn() -> sqlite3.Connection:
    db = sqlite3.connect(STATE_DB, timeout=60)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=60000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def content_conn() -> sqlite3.Connection:
    db = sqlite3.connect(CONTENT_DB, timeout=60)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=60000")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_databases() -> None:
    ensure_dirs()
    with state_conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS discoveries (
              prefix TEXT PRIMARY KEY, pattern TEXT NOT NULL,
              xml_path TEXT NOT NULL, txt_path TEXT NOT NULL,
              sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
              word_count INTEGER NOT NULL, status TEXT NOT NULL,
              downloaded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS candidates (
              id INTEGER PRIMARY KEY,
              word TEXT NOT NULL COLLATE BINARY UNIQUE,
              first_bucket TEXT NOT NULL, prefix_bucket TEXT NOT NULL,
              discovered_from TEXT NOT NULL,
              active_source INTEGER NOT NULL DEFAULT 1,
              status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
              http_status INTEGER, xml_path TEXT, sha256 TEXT, bytes INTEGER,
              last_error TEXT, fetched_at TEXT
            );
            CREATE INDEX IF NOT EXISTS candidates_status_prefix
              ON candidates(status, prefix_bucket, id);
            CREATE INDEX IF NOT EXISTS candidates_active_status
              ON candidates(active_source, status);
            CREATE INDEX IF NOT EXISTS candidates_active_prefix
              ON candidates(active_source, prefix_bucket, status);
            CREATE INDEX IF NOT EXISTS candidates_active_letter
              ON candidates(active_source, first_bucket, status);
            CREATE TABLE IF NOT EXISTS fetch_attempts (
              id INTEGER PRIMARY KEY,
              candidate_id INTEGER NOT NULL REFERENCES candidates(id),
              attempted_at TEXT NOT NULL, http_status INTEGER,
              bytes INTEGER, error TEXT
            );
            CREATE TABLE IF NOT EXISTS source_imports (
              id INTEGER PRIMARY KEY,
              source_path TEXT NOT NULL,
              source_sha256 TEXT NOT NULL,
              source_bytes INTEGER NOT NULL,
              word_count INTEGER NOT NULL,
              inserted_count INTEGER NOT NULL,
              imported_at TEXT NOT NULL
            );
            """
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(candidates)")}
        if "active_source" not in columns:
            db.execute("ALTER TABLE candidates ADD COLUMN active_source INTEGER NOT NULL DEFAULT 1")
    with content_conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS responses (
              id INTEGER PRIMARY KEY,
              query_word TEXT NOT NULL COLLATE BINARY UNIQUE,
              prefix_bucket TEXT NOT NULL, xml_path TEXT NOT NULL,
              sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
              http_status INTEGER NOT NULL, xml_message TEXT,
              raw_xml BLOB NOT NULL, downloaded_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS xml_nodes (
              id INTEGER PRIMARY KEY,
              response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
              node_order INTEGER NOT NULL, xpath TEXT NOT NULL, tag TEXT NOT NULL,
              text_value TEXT, attributes_json TEXT NOT NULL,
              UNIQUE(response_id, node_order)
            );
            CREATE TABLE IF NOT EXISTS lemmata (
              id INTEGER PRIMARY KEY,
              response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
              node_xpath TEXT NOT NULL, lemma_id TEXT, lemma TEXT, parent TEXT,
              lemma_part_of_speech TEXT, entry_type TEXT, label TEXT,
              pronunciation TEXT, verb_features TEXT, nuancerende_opmerking TEXT,
              external_link TEXT, diminutive_info TEXT, wordparts_info TEXT,
              gloss TEXT, taalvariant TEXT, taaladvies TEXT, trademark TEXT,
              keurmerk TEXT, message TEXT, hulpwerkwoord TEXT, part_number TEXT,
              online TEXT, subset_name TEXT, source_name TEXT
            );
            CREATE INDEX IF NOT EXISTS lemmata_lemma ON lemmata(lemma);
            CREATE INDEX IF NOT EXISTS lemmata_lemma_id ON lemmata(lemma_id);
            CREATE INDEX IF NOT EXISTS lemmata_response ON lemmata(response_id, id);
            CREATE TABLE IF NOT EXISTS paradigms (
              id INTEGER PRIMARY KEY,
              lemma_row_id INTEGER NOT NULL REFERENCES lemmata(id) ON DELETE CASCADE,
              node_xpath TEXT NOT NULL, arch TEXT, group_label TEXT,
              hyphenation TEXT, keurmerk TEXT, label TEXT, part_of_speech TEXT,
              position TEXT, wordform TEXT, wordform_id TEXT
            );
            CREATE INDEX IF NOT EXISTS paradigms_wordform ON paradigms(wordform);
            CREATE INDEX IF NOT EXISTS paradigms_lemma ON paradigms(lemma_row_id, id);
            CREATE INDEX IF NOT EXISTS responses_prefix_word ON responses(prefix_bucket, query_word);
            """
        )
    config_path = ROOT / "config" / "source.json"
    if not config_path.exists():
        config = {
            "created_at": now(), "base_url": BASE_URL,
            "database": "gig_pro_wrdlst", "part_of_speech": POS,
            "onlyvalid": True, "paradigm": True, "diminutive": True,
            "raw_xml_is_canonical": True,
        }
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def curl_get(endpoint: str, params: dict[str, str], timeout: int = 45) -> tuple[int, bytes, str]:
    url = f"{BASE_URL}/{endpoint}?{urllib.parse.urlencode(params)}"
    with tempfile.NamedTemporaryFile(prefix="woordenlijst-", suffix=".xml", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        cmd = ["curl", "--silent", "--show-error", "--location",
               "--max-time", str(timeout), "--user-agent", USER_AGENT,
               "--output", str(tmp_path), "--write-out", "%{http_code}", url]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        data = tmp_path.read_bytes() if tmp_path.exists() else b""
        code_text = proc.stdout.strip()[-3:]
        return (int(code_text) if code_text.isdigit() else 0), data, proc.stderr.strip()
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".partial-", delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)


def parse_suggestions(data: bytes) -> list[str]:
    root = ET.fromstring(data)
    if text_of(root, "message") != "OK":
        raise ValueError(f"suggestion API message: {text_of(root, 'message')!r}")
    raw = text_of(root, "suggestions")
    if not raw or raw == "UNKNOWN":
        return []
    return list(dict.fromkeys(part.strip() for part in raw.split(" | ") if part.strip()))


def parse_word_list(path: Path) -> list[str]:
    """Read one pipe-delimited initial-letter list per line, preserving source order."""
    text = path.read_text(encoding="utf-8-sig")
    words: list[str] = []
    for line in text.splitlines():
        words.extend(part.strip() for part in line.split("|") if part.strip())
    return list(dict.fromkeys(words))


def import_word_list(path: Path) -> tuple[int, int]:
    """Append unseen words to the candidate queue in their original source order."""
    init_databases()
    path = path.expanduser().resolve()
    data = path.read_bytes()
    words = parse_word_list(path)
    source_name = f"file:{path.name}"
    with state_conn() as db:
        before = db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        db.execute("UPDATE candidates SET active_source=0")
        for word in words:
            first, bucket = bucket_for(word)
            db.execute(
                """INSERT INTO candidates
                   (word, first_bucket, prefix_bucket, discovered_from, active_source)
                   VALUES (?, ?, ?, ?, 1)
                   ON CONFLICT(word) DO UPDATE SET active_source=1""",
                (word, first, bucket, source_name),
            )
        after = db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        inserted = after - before
        db.execute(
            """INSERT INTO source_imports
               (source_path, source_sha256, source_bytes, word_count,
                inserted_count, imported_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(path), sha256(data), len(data), len(words), inserted, now()),
        )
    print(f"IMPORTED {len(words)} woorden; {inserted} nieuw achteraan toegevoegd uit {path}")
    return len(words), inserted


def append_word_list(path: Path) -> tuple[int, int]:
    """Append a supplemental source without deactivating the primary source."""
    init_databases()
    path = path.expanduser().resolve()
    data = path.read_bytes()
    words = parse_word_list(path)
    source_name = f"file:{path.name}"
    with state_conn() as db:
        before = db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        for word in words:
            first, bucket = bucket_for(word)
            db.execute(
                """INSERT INTO candidates
                   (word, first_bucket, prefix_bucket, discovered_from, active_source)
                   VALUES (?, ?, ?, ?, 1)
                   ON CONFLICT(word) DO UPDATE SET active_source=1""",
                (word, first, bucket, source_name),
            )
        after = db.execute("SELECT COUNT(*) FROM candidates").fetchone()[0]
        inserted = after - before
        db.execute(
            """INSERT INTO source_imports
               (source_path, source_sha256, source_bytes, word_count,
                inserted_count, imported_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(path), sha256(data), len(data), len(words), inserted, now()),
        )
    print(f"APPENDED {len(words)} woorden; {inserted} nieuw toegevoegd uit {path}")
    return len(words), inserted


def discover(prefix: str, retries: int = 5) -> int:
    init_databases()
    prefix = ascii_fold(prefix.strip()).lower()
    if not re.fullmatch(r"[a-z]{1,4}", prefix):
        raise SystemExit("prefix moet 1-4 letters bevatten, bijvoorbeeld aa")
    params = {"database": "gig_pro_wrdlst", "wordform": prefix + "%",
              "part_of_speech": POS, "onlyvalid": "true"}
    last_error = ""
    for attempt in range(1, retries + 1):
        code, data, error = curl_get("get_suggestions", params)
        if code == 200:
            try:
                words = parse_suggestions(data)
                break
            except (ET.ParseError, ValueError) as exc:
                last_error = str(exc)
        else:
            last_error = error or f"HTTP {code}"
        if attempt < retries:
            time.sleep(min(30, 2 ** attempt) + random.random())
    else:
        raise SystemExit(f"discovery mislukt voor {prefix}: {last_error}")
    letter = prefix[0]
    xml_path = ROOT / "discovery" / letter / f"{prefix}.xml"
    txt_path = ROOT / "discovery" / letter / f"{prefix}.txt"
    atomic_write(xml_path, data)
    atomic_write(txt_path, ("\n".join(words) + "\n").encode("utf-8"))
    with state_conn() as db:
        db.execute(
            """INSERT INTO discoveries
               (prefix, pattern, xml_path, txt_path, sha256, bytes, word_count, status, downloaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?)
               ON CONFLICT(prefix) DO UPDATE SET pattern=excluded.pattern,
                 xml_path=excluded.xml_path, txt_path=excluded.txt_path,
                 sha256=excluded.sha256, bytes=excluded.bytes,
                 word_count=excluded.word_count, status='complete',
                 downloaded_at=excluded.downloaded_at""",
            (prefix, prefix + "%", str(xml_path.relative_to(ROOT)), str(txt_path.relative_to(ROOT)),
             sha256(data), len(data), len(words), now()),
        )
        for word in words:
            first, bucket = bucket_for(word)
            db.execute(
                """INSERT INTO candidates(word, first_bucket, prefix_bucket, discovered_from)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(word) DO UPDATE SET discovered_from=excluded.discovered_from""",
                (word, first, bucket, prefix),
            )
    print(f"DISCOVERED {prefix}: {len(words)} woorden -> {txt_path}")
    return len(words)


def discover_initial(initial: str, retries: int = 5) -> int:
    """Archive and enqueue all suggestions beginning with one exact character."""
    init_databases()
    if len(initial) != 1:
        raise SystemExit("initial moet exact één teken bevatten")
    params = {"database": "gig_pro_wrdlst", "wordform": initial + "%",
              "part_of_speech": "", "onlyvalid": "true"}
    last_error = ""
    for attempt in range(1, retries + 1):
        code, data, error = curl_get("get_suggestions", params)
        if code == 200:
            try:
                returned = parse_suggestions(data)
                words = [word for word in returned if word.startswith(initial)]
                break
            except (ET.ParseError, ValueError) as exc:
                last_error = str(exc)
        else:
            last_error = error or f"HTTP {code}"
        if attempt < retries:
            time.sleep(min(30, 2 ** attempt) + random.random())
    else:
        raise SystemExit(f"discovery mislukt voor {initial!r}: {last_error}")

    first, bucket = bucket_for(initial)
    key = f"initial-u{ord(initial):04x}"
    xml_path = ROOT / "discovery" / first / f"{key}.xml"
    txt_path = ROOT / "discovery" / first / f"{key}.txt"
    atomic_write(xml_path, data)
    atomic_write(txt_path, ("\n".join(words) + "\n").encode("utf-8"))
    with state_conn() as db:
        db.execute(
            """INSERT INTO discoveries
               (prefix, pattern, xml_path, txt_path, sha256, bytes, word_count, status, downloaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?)
               ON CONFLICT(prefix) DO UPDATE SET pattern=excluded.pattern,
                 xml_path=excluded.xml_path, txt_path=excluded.txt_path,
                 sha256=excluded.sha256, bytes=excluded.bytes,
                 word_count=excluded.word_count, status='complete',
                 downloaded_at=excluded.downloaded_at""",
            (key, initial + "%", str(xml_path.relative_to(ROOT)), str(txt_path.relative_to(ROOT)),
             sha256(data), len(data), len(words), now()),
        )
        for word in words:
            word_first, word_bucket = bucket_for(word)
            db.execute(
                """INSERT INTO candidates
                   (word, first_bucket, prefix_bucket, discovered_from, active_source)
                   VALUES (?, ?, ?, ?, 1)
                   ON CONFLICT(word) DO UPDATE SET active_source=1""",
                (word, word_first, word_bucket, key),
            )
    print(f"DISCOVERED {initial!r}: {len(words)} woorden -> {txt_path}")
    return len(words)


def xml_path_for(word: str, candidate_id: int) -> Path:
    first, bucket = bucket_for(word)
    digest = hashlib.sha256(word.encode("utf-8")).hexdigest()[:12]
    return ROOT / "raw" / first / bucket / f"{candidate_id:07d}__{safe_slug(word)}__{digest}.xml"


def enumerate_nodes(root: ET.Element):
    order = 0
    def walk(node: ET.Element, path: str):
        nonlocal order
        order += 1
        yield order, path, node
        counts: dict[str, int] = {}
        for child in list(node):
            counts[child.tag] = counts.get(child.tag, 0) + 1
            yield from walk(child, f"{path}/{child.tag}[{counts[child.tag]}]")
    yield from walk(root, f"/{root.tag}[1]")


def normalize_response(word: str, prefix_bucket: str, path: Path, code: int, data: bytes) -> tuple[str, int]:
    root = ET.fromstring(data)
    message = text_of(root, "message")
    with content_conn() as db:
        old = db.execute("SELECT id FROM responses WHERE query_word=?", (word,)).fetchone()
        if old:
            db.execute("DELETE FROM responses WHERE id=?", (old["id"],))
        cur = db.execute(
            """INSERT INTO responses
               (query_word, prefix_bucket, xml_path, sha256, bytes, http_status,
                xml_message, raw_xml, downloaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (word, prefix_bucket, str(path.relative_to(ROOT)), sha256(data), len(data), code,
             message, data, now()),
        )
        response_id = cur.lastrowid
        nodes = list(enumerate_nodes(root))
        path_by_element = {id(node): node_path for _, node_path, node in nodes}
        for node_order, xpath, node in nodes:
            db.execute(
                """INSERT INTO xml_nodes
                   (response_id, node_order, xpath, tag, text_value, attributes_json)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (response_id, node_order, xpath, node.tag, (node.text or "").strip(),
                 json.dumps(node.attrib, ensure_ascii=False, sort_keys=True)),
            )
        lemma_count = 0
        for elem in root.iter():
            if elem.tag not in {"found_lemmata", "diminutives"} or elem.find("lemma") is None:
                continue
            lemma_count += 1
            cur = db.execute(
                """INSERT INTO lemmata
                   (response_id, node_xpath, lemma_id, lemma, parent,
                    lemma_part_of_speech, entry_type, label, pronunciation,
                    verb_features, nuancerende_opmerking, external_link,
                    diminutive_info, wordparts_info, gloss, taalvariant,
                    taaladvies, trademark, keurmerk, message, hulpwerkwoord,
                    part_number, online, subset_name, source_name)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (response_id, path_by_element[id(elem)], text_of(elem, "lemma_id"), text_of(elem, "lemma"),
                 text_of(elem, "parent"), text_of(elem, "lemma_part_of_speech"), text_of(elem, "entry_type"),
                 text_of(elem, "label"), text_of(elem, "pronunciation"), text_of(elem, "verb_features"),
                 text_of(elem, "nuancerende_opmerking"), text_of(elem, "external_link"),
                 text_of(elem, "diminutive_info"), text_of(elem, "wordparts_info"), text_of(elem, "gloss"),
                 text_of(elem, "taalvariant"), text_of(elem, "taaladvies"), text_of(elem, "trademark"),
                 text_of(elem, "keurmerk"), text_of(elem, "message"), text_of(elem, "hulpwerkwoord"),
                 text_of(elem, "part_number"), text_of(elem, "online"), text_of(elem, "subset"), text_of(elem, "source")),
            )
            lemma_row_id = cur.lastrowid
            paradigm_container = elem.find("paradigm")
            if paradigm_container is not None:
                for par in paradigm_container.findall("paradigm"):
                    db.execute(
                        """INSERT INTO paradigms
                           (lemma_row_id, node_xpath, arch, group_label, hyphenation,
                            keurmerk, label, part_of_speech, position, wordform, wordform_id)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (lemma_row_id, path_by_element[id(par)], text_of(par, "arch"), text_of(par, "group_label"),
                         text_of(par, "hyphenation"), text_of(par, "keurmerk"), text_of(par, "label"),
                         text_of(par, "part_of_speech"), text_of(par, "position"), text_of(par, "wordform"),
                         text_of(par, "wordform_id")),
                    )
    return message, lemma_count


def append_manifest(bucket: str, record: dict) -> None:
    if bucket.startswith("digit-"):
        first = "_numeric"
    elif bucket.startswith("symbol-"):
        first = "_symbols"
    else:
        first = bucket[:1]
    path = ROOT / "manifests" / first / f"{bucket}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def fetch(prefix: str, limit: int | None, delay: float, retries: int) -> tuple[int, int]:
    init_databases()
    prefix = ascii_fold(prefix.strip()).lower()
    with state_conn() as db:
        sql = """SELECT * FROM candidates WHERE prefix_bucket=? AND active_source=1
                 AND status IN ('pending','failed','invalid_xml')
                 AND attempts < 10 ORDER BY id"""
        params: list[object] = [prefix]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        rows = db.execute(sql, params).fetchall()
    success = failed = 0
    total = len(rows)
    for index, row in enumerate(rows, 1):
        word, candidate_id = row["word"], row["id"]
        target = xml_path_for(word, candidate_id)
        params = {"database": "gig_pro_wrdlst", "wordform": word,
                  "part_of_speech": POS, "paradigm": "true", "diminutive": "true",
                  "onlyvalid": "true", "regex": "false"}
        final_error = ""
        code, data, lemma_count, message = 0, b"", 0, ""
        for attempt in range(1, retries + 1):
            code, data, curl_error = curl_get("find_wordform", params)
            with state_conn() as db:
                db.execute("INSERT INTO fetch_attempts(candidate_id, attempted_at, http_status, bytes, error) VALUES (?, ?, ?, ?, ?)",
                           (candidate_id, now(), code, len(data), curl_error))
                db.execute("UPDATE candidates SET attempts=attempts+1 WHERE id=?", (candidate_id,))
            if code == 200:
                try:
                    ET.fromstring(data)
                    atomic_write(target, data)
                    message, lemma_count = normalize_response(word, row["prefix_bucket"], target, code, data)
                    final_error = ""
                    break
                except (ET.ParseError, sqlite3.Error, ValueError) as exc:
                    final_error = f"invalid XML/database: {exc}"
            else:
                final_error = curl_error or f"HTTP {code}"
            if attempt < retries:
                time.sleep(min(30, 2 ** attempt) + random.random())
        record = {"query": word, "prefix": row["prefix_bucket"], "http_status": code,
                  "bytes": len(data), "sha256": sha256(data) if data else "",
                  "xml_path": str(target.relative_to(ROOT)) if target.exists() else "",
                  "xml_message": message, "lemma_count": lemma_count,
                  "error": final_error, "fetched_at": now()}
        append_manifest(row["prefix_bucket"], record)
        with state_conn() as db:
            if not final_error:
                status = "complete" if message == "OK" else "api_message"
                db.execute("""UPDATE candidates SET status=?, http_status=?, xml_path=?, sha256=?, bytes=?,
                           last_error=NULL, fetched_at=? WHERE id=?""",
                           (status, code, str(target.relative_to(ROOT)), sha256(data), len(data), now(), candidate_id))
                success += 1
                print(f"[{index}/{total}] OK {word!r} ({len(data)} B, {lemma_count} lemma's)", flush=True)
            else:
                db.execute("UPDATE candidates SET status='failed', http_status=?, last_error=?, fetched_at=? WHERE id=?",
                           (code, final_error, now(), candidate_id))
                failed += 1
                print(f"[{index}/{total}] FAIL {word!r}: {final_error}", flush=True)
        if index < total:
            time.sleep(max(0.0, delay) + random.uniform(0.0, min(0.5, delay / 3 if delay else 0.0)))
    print(f"FETCHED {prefix}: success={success}, failed={failed}")
    return success, failed


def validate(prefix: str) -> int:
    init_databases()
    prefix = ascii_fold(prefix.strip()).lower()
    problems: list[str] = []
    with state_conn() as sdb, content_conn() as cdb:
        candidates = sdb.execute(
            "SELECT * FROM candidates WHERE prefix_bucket=? AND active_source=1 ORDER BY id",
            (prefix,),
        ).fetchall()
        completed = [row for row in candidates if row["status"] in {"complete", "api_message"}]
        for row in completed:
            if not row["xml_path"]:
                problems.append(f"{row['word']}: ontbrekend xml_path")
                continue
            path = ROOT / row["xml_path"]
            if not path.exists():
                problems.append(f"{row['word']}: bestand ontbreekt")
                continue
            data = path.read_bytes()
            if sha256(data) != row["sha256"]:
                problems.append(f"{row['word']}: checksum mismatch")
            try:
                ET.fromstring(data)
            except ET.ParseError as exc:
                problems.append(f"{row['word']}: ongeldige XML: {exc}")
            response = cdb.execute("SELECT id FROM responses WHERE query_word=?", (row["word"],)).fetchone()
            if response is None:
                problems.append(f"{row['word']}: ontbreekt in contentdatabase")
            elif cdb.execute("SELECT COUNT(*) FROM xml_nodes WHERE response_id=?", (response["id"],)).fetchone()[0] == 0:
                problems.append(f"{row['word']}: geen XML-nodes opgeslagen")
        summary = {"prefix": prefix, "candidate_count": len(candidates),
                   "completed_count": len(completed),
                   "pending_count": sum(row["status"] == "pending" for row in candidates),
                   "failed_count": sum(row["status"] == "failed" for row in candidates),
                   "problem_count": len(problems), "problems": problems,
                   "validated_at": now()}
    if prefix.startswith("digit-"):
        report_group = "_numeric"
    elif prefix.startswith("symbol-"):
        report_group = "_symbols"
    else:
        report_group = prefix[:1]
    report = ROOT / "manifests" / report_group / f"{prefix}.validation.json"
    atomic_write(report, (json.dumps(summary, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not problems else 1


def status(prefix: str | None) -> None:
    init_databases()
    with state_conn() as db:
        if prefix:
            rows = db.execute("SELECT status, COUNT(*) n FROM candidates WHERE prefix_bucket=? AND active_source=1 GROUP BY status ORDER BY status",
                              (ascii_fold(prefix).lower(),)).fetchall()
        else:
            rows = db.execute("SELECT status, COUNT(*) n FROM candidates WHERE active_source=1 GROUP BY status ORDER BY status").fetchall()
        print(json.dumps({row["status"]: row["n"] for row in rows}, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    p = sub.add_parser("import-list"); p.add_argument("--file", required=True, type=Path)
    p = sub.add_parser("append-list"); p.add_argument("--file", required=True, type=Path)
    p = sub.add_parser("discover"); p.add_argument("--prefix", required=True)
    p = sub.add_parser("discover-initial"); p.add_argument("--initial", required=True)
    p = sub.add_parser("fetch"); p.add_argument("--prefix", required=True); p.add_argument("--limit", type=int); p.add_argument("--delay", type=float, default=1.25); p.add_argument("--retries", type=int, default=5)
    p = sub.add_parser("validate"); p.add_argument("--prefix", required=True)
    p = sub.add_parser("status"); p.add_argument("--prefix")
    args = parser.parse_args()
    if args.command == "init": init_databases(); print(f"INITIALIZED {ROOT}")
    elif args.command == "import-list": import_word_list(args.file)
    elif args.command == "append-list": append_word_list(args.file)
    elif args.command == "discover": discover(args.prefix)
    elif args.command == "discover-initial": discover_initial(args.initial)
    elif args.command == "fetch": fetch(args.prefix, args.limit, args.delay, args.retries)
    elif args.command == "validate": return validate(args.prefix)
    elif args.command == "status": status(args.prefix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
