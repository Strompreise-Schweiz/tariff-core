#!/usr/bin/env python3
"""Shared tariff ETL engine. Run from a calling org repo's root (cwd), e.g.:

    python3 _engine/engine/fetch_and_normalize.py

Reads config/source.json (single object: slug, name, api_url, ..., normalizer)
from the caller's cwd, fetches the source's dynamic tariff API, and writes
three tiers under data/dynamic/<year>/<date>.json:

  raw/         byte-exact response from the source API (provenance)
  vse/         same structure, timestamps normalized to Europe/Zurich
  normalized/  this project's own schema (UTC timestamps, deduplicated
               fixed charges, etc.) -- see SCHEMA.md in this repo.

Stdlib only, no third-party dependencies.
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CALLER_ROOT = Path.cwd()
CONFIG_PATH = CALLER_ROOT / "config" / "source.json"
DATA_ROOT = CALLER_ROOT / "data" / "dynamic"

ENGINE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ENGINE_DIR))
from normalizers import REGISTRY  # noqa: E402

USER_AGENT = "strompreise-schweiz-tariff-etl/1.0 (+https://github.com/Strompreise-Schweiz/tariff-etl)"


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError(f"unexpected HTTP status {resp.status} from {url}")
        return resp.read()


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not data.endswith(b"\n"):
        data += b"\n"
    path.write_bytes(data)


def write_json(path: Path, obj) -> None:
    write_bytes(path, json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"))


def main() -> int:
    org = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    slug = org["slug"]
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    mod = REGISTRY.get(org["normalizer"])
    if mod is None:
        print(f"[{slug}] ERROR: no normalizer registered for '{org['normalizer']}'", file=sys.stderr)
        return 1

    try:
        raw_bytes = fetch_bytes(org["api_url"])
        raw_data = json.loads(raw_bytes)
    except (urllib.error.URLError, json.JSONDecodeError, RuntimeError, TimeoutError) as exc:
        print(f"[{slug}] ERROR fetching/parsing {org['api_url']}: {exc}", file=sys.stderr)
        return 1

    try:
        date = mod.local_date_of(raw_data)
        vse_data = mod.to_vse(raw_data)
        normalized_data = mod.normalize(raw_data, org=org, retrieved_at=retrieved_at, date=date)
    except Exception as exc:  # noqa: BLE001 - surface any normalizer bug clearly
        print(f"[{slug}] ERROR normalizing: {exc}", file=sys.stderr)
        return 1

    year = date[:4]
    raw_path = DATA_ROOT / "raw" / year / f"{date}.json"
    vse_path = DATA_ROOT / "vse" / year / f"{date}.json"
    normalized_path = DATA_ROOT / "normalized" / year / f"{date}.json"

    write_bytes(raw_path, raw_bytes)
    write_json(vse_path, vse_data)
    write_json(normalized_path, normalized_data)

    for p in (raw_path, vse_path, normalized_path):
        print(f"[{slug}] wrote {p.relative_to(CALLER_ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
