#!/usr/bin/env python3
"""Dynamic tariffs: fetch, check, archive and publish the stable latest.json.

Run from the root of an org repo or of the hub repo. Safe to run several times a day: a day is
only rewritten when its prices changed, so the fallback cron runs create no
noise. Writes, per tariff, under data/dynamic/<id>/:

    raw/<year>/<date>.json          byte-exact source response
    vse/<year>/<date>.json          VSE format, Swiss local time with offset
    normalized/<year>/<date>.json   cross-organization schema, UTC
    latest.json                     today + tomorrow, stable URL

Stdlib only.
"""
import json
import sys
import urllib.error
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (SCHEMA_BASE, ZURICH, annotate, day_bounds, dynamic_dir, fetch_bytes, load_config,  # noqa: E402
                    load_json, now_utc, org_roots, raw_url, write_bytes, write_json, write_price_doc)
from normalizers import REGISTRY  # noqa: E402
from site_index import write_index  # noqa: E402

DEFAULT_BACKFILL_DAYS = 3
# After this local hour a missing day for tomorrow fails the run. The handbook
# recommends publishing between 12:00 and about 18:00 on the day before.
DEFAULT_ALERT_AFTER_HOUR = 21


def _iso_z(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_url(tariff: dict, day: date | None) -> str:
    parts = urllib.parse.urlsplit(tariff["api_url"])
    query = urllib.parse.parse_qsl(parts.query) + list(tariff.get("query", {}).items())
    if day is not None:
        # UTC keeps the URL free of a "+" in the offset. Handbook 7.4.1 allows any timezone.
        start, end = day_bounds(day)
        query += [("start_timestamp", _iso_z(start)), ("end_timestamp", _iso_z(end))]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def fetch_day(tariff: dict, day: date) -> bytes:
    """Ask for one day. Sources without window support get a second, plain request."""
    try:
        return fetch_bytes(build_url(tariff, day))
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 404, 422):
            raise
        return fetch_bytes(build_url(tariff, None))


def read_day(path: Path) -> dict | None:
    return load_json(path) if path.exists() else None


def store_day(base: Path, org: dict, tariff: dict, module, day: str, prices: list, raw_bytes: bytes,
              raw: dict, notes: list, retrieved_at: str) -> str:
    """Write one day. Returns "new", "changed" or "unchanged"."""
    year = day[:4]
    vse_path = base / "vse" / year / f"{day}.json"
    existing = read_day(vse_path)
    check = module.check_day(day, prices)
    if existing is not None:
        if existing["prices"] == prices:
            return "unchanged"
        if existing.get("_meta", {}).get("complete", True) and not check["complete"]:
            annotate("warning", f"{org['slug']}/{tariff.get('id')} {day}: kept complete archive, new response is partial")
            return "unchanged"
    doc = {
        "$schema": f"{SCHEMA_BASE}/dynamic-day/v1.schema.json",
        "publication_timestamp": raw.get("publication_timestamp"),
        "_meta": {
            "date": day,
            "complete": check["complete"],
            "issues": check["issues"],
            "resolution_minutes": check["resolution_minutes"],
            "day_length_hours": check["day_length_hours"],
            "retrieved_at": retrieved_at,
            "additions": notes,
            "source_url": tariff["api_url"],
        },
        "prices": prices,
    }
    write_bytes(base / "raw" / year / f"{day}.json", raw_bytes)
    write_price_doc(vse_path, doc)
    write_json(base / "normalized" / year / f"{day}.json",
               module.normalize(doc, org=org, tariff=tariff, date=day, retrieved_at=retrieved_at, check=check))
    if not check["complete"]:
        annotate("warning", f"{org['slug']}/{tariff.get('id')} {day} incomplete: {'; '.join(check['issues'])}")
    return "changed" if existing is not None else "new"


def write_latest(root: Path, base: Path, org: dict, tariff: dict, today: date, generated_at: str) -> None:
    """Rolling window of today and, once published, tomorrow. The URL never changes."""
    days, prices, publication = [], [], None
    for day in (today, today + timedelta(days=1)):
        doc = read_day(base / "vse" / str(day.year) / f"{day.isoformat()}.json")
        if doc is None:
            continue
        days.append({"date": day.isoformat(), "complete": doc.get("_meta", {}).get("complete", True)})
        prices.extend(doc["prices"])
        publication = doc.get("publication_timestamp") or publication
    if not prices:
        annotate("warning", f"{org['slug']}/{tariff.get('id')}: no data for today or tomorrow, latest.json left as is")
        return
    identifier = tariff.get("id")
    relative = f"data/dynamic/{identifier}/latest.json" if identifier else "data/dynamic/latest.json"
    latest = {
        "$schema": f"{SCHEMA_BASE}/dynamic-day/v1.schema.json",
        "publication_timestamp": publication,
        "_meta": {
            "organization": org["name"],
            "tariff_id": identifier,
            "tariff_name": tariff.get("name"),
            "url": raw_url(root, org["slug"], relative),
            "generated_at": generated_at,
            "valid_from": prices[0]["start_timestamp"],
            "valid_to": prices[-1]["end_timestamp"],
            "days": days,
            "license": org.get("data_license"),
            "attribution": f"Data sourced from {org['name']} ({org.get('website')}), republished by Strompreise-Schweiz.",
        },
        "prices": prices,
    }
    path = base / "latest.json"
    previous = read_day(path)
    if previous is not None:
        previous["_meta"]["generated_at"] = generated_at
        if previous == latest:
            return
    write_price_doc(path, latest)


def run_tariff(root: Path, org: dict, tariff: dict, now: datetime) -> list[str]:
    """Process one tariff. Returns the failures that should fail the workflow."""
    module = REGISTRY.get(tariff.get("normalizer", "generic_vse"))
    label = f"{org['slug']}/{tariff.get('id')}"
    if module is None:
        return [f"{label}: unknown normalizer {tariff.get('normalizer')}"]
    base = dynamic_dir(root, tariff)
    local_now = now.astimezone(ZURICH)
    today = local_now.date()
    tomorrow = today + timedelta(days=1)
    retrieved_at = now.isoformat(timespec="seconds")
    backfill = tariff.get("backfill_days", DEFAULT_BACKFILL_DAYS)
    first_day = tariff.get("valid_from", "0000-00-00")
    last_day = tariff.get("valid_to", "9999-99-99")
    if tomorrow.isoformat() < first_day or today.isoformat() > last_day:
        print(f"[{label}] outside its validity {first_day} to {last_day}, skipped")
        return []
    targets = [today - timedelta(days=n) for n in range(backfill, -1, -1)] + [tomorrow]
    targets = [day for day in targets if first_day <= day.isoformat() <= last_day]
    errors = []
    for target in targets:
        known = read_day(base / "vse" / str(target.year) / f"{target.isoformat()}.json")
        if known is not None and known.get("_meta", {}).get("complete", True) and target < today:
            continue
        try:
            raw_bytes = fetch_day(tariff, target)
            raw = json.loads(raw_bytes)
            prices, notes = module.canonicalize(raw, tariff)
        except Exception as exc:  # noqa: BLE001 - one failing day must not stop the others
            errors.append(f"{target}: {exc}")
            continue
        for day, day_prices in module.split_by_day(prices).items():
            if day > tomorrow.isoformat():
                continue
            result = store_day(base, org, tariff, module, day, day_prices, raw_bytes, raw, notes, retrieved_at)
            print(f"[{label}] {day}: {result}")
    write_latest(root, base, org, tariff, today, retrieved_at)

    for message in errors:
        annotate("warning", f"{label} {message}")
    alert_hour = tariff.get("alert_after_hour", DEFAULT_ALERT_AFTER_HOUR)
    expected = tomorrow if local_now.hour >= alert_hour else today
    if not first_day <= expected.isoformat() <= last_day:
        return []
    if not (base / "vse" / str(expected.year) / f"{expected.isoformat()}.json").exists():
        return [f"{label}: no data for {expected} at {local_now.isoformat(timespec='minutes')}"]
    return []


def main() -> int:
    roots = org_roots(Path.cwd())
    if not roots:
        annotate("error", "no config/source.json here and no utilities/<slug>/config/source.json")
        return 1
    now = now_utc()
    failures = []
    for root in roots:
        org = load_config(root)
        for tariff in org["dynamic"]:
            if tariff.get("enabled", True):
                failures += run_tariff(root, org, tariff, now)
        write_index(root, org)
    for failure in failures:
        annotate("error", failure)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
