#!/usr/bin/env python3
"""Static tariffs: fetch, repair, apply curation, validate, publish.

Run from the root of an org repo, or of the hub repo to publish every utility in it.

    source (url or file) -> data/static/raw/<name>.json   byte-exact
                         -> repairs in normalizers/static_vse.py
                         -> curation/<year>.json          overrides and products
                         -> validate
                         -> data/tariffs/<year>.json + current.json

A source can hold several years (EKZ publishes 2026 and 2027 in one file), so the
output is split by the start year of each tariff. A year with errors is not
published: the previous file stays online and data/tariffs/<year>.report.json
explains what is wrong.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import SCHEMA_BASE, annotate, fetch_bytes, load_config, load_json, now_utc, org_roots, slugify, write_bytes, write_json, ZURICH  # noqa: E402
from normalizers import static_vse  # noqa: E402
from site_index import write_index  # noqa: E402
from validate import apply_waivers, document_issues, report  # noqa: E402


def read_source(root: Path, source: dict, offline: bool) -> tuple[bytes, dict]:
    """Returns the source bytes and its provenance."""
    name = source["name"]
    raw_path = root / "data" / "static" / "raw" / f"{name}.json"
    if "file" in source:
        data = (root / source["file"]).read_bytes()
        origin = {"name": name, "file": source["file"]}
    else:
        origin = {"name": name, "url": source["url"]}
        data = raw_path.read_bytes() if offline else fetch_bytes(source["url"])
    if not offline:
        write_bytes(raw_path, data)
    origin["sha256"] = hashlib.sha256(data.rstrip(b"\n")).hexdigest()
    return data, origin


def _matches(tariff: dict, match: dict) -> bool:
    return all(tariff.get(key) == value for key, value in match.items())


def _set_dotted(target: dict, key: str, value) -> None:
    parts = key.split(".")
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value


def apply_curation(tariffs: list[dict], curation: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """Apply manual corrections. A rule that matches nothing is an error: it means
    the source changed and the correction no longer does what it was written for."""
    applied, issues = [], []
    for rule in curation.get("removeTariffs", []):
        before = len(tariffs)
        tariffs = [t for t in tariffs if not _matches(t, rule["match"])]
        if len(tariffs) == before:
            issues.append({"severity": "error", "code": "curation_no_match", "tariff": None, "message": f"removeTariffs: {rule['match']}"})
        applied.append({"action": "remove", "match": rule["match"], "reason": rule["reason"]})
    for rule in curation.get("overrides", []):
        hits = [t for t in tariffs if _matches(t, rule["match"])]
        if not hits:
            issues.append({"severity": "error", "code": "curation_no_match", "tariff": None, "message": f"override: {rule['match']}"})
        for tariff in hits:
            for key, value in rule["set"].items():
                _set_dotted(tariff, key, value)
        applied.append({"action": "override", "match": rule["match"], "set": sorted(rule["set"]),
                        "reason": rule["reason"], "sourceUrl": rule.get("sourceUrl"), "count": len(hits)})
    for rule in curation.get("addTariffs", []):
        tariffs.append(dict(rule["tariff"]))
        applied.append({"action": "add", "tariffName": rule["tariff"].get("tariffName"), "reason": rule["reason"], "sourceUrl": rule.get("sourceUrl")})
    return tariffs, applied, issues


def assign_ids(tariffs: list[dict]) -> None:
    """Stable ids. tariffName alone is not unique: EKZ repeats names across
    voltage levels and customer groups."""
    groups: dict[str, list[dict]] = {}
    for tariff in tariffs:
        level = tariff.get("customerVoltageLevel")
        suffix = f"-ne{level}" if level is not None else ""
        base = f"{slugify(str(tariff.get('tariffType')))}-{slugify(str(tariff.get('tariffName')))}{suffix}"
        groups.setdefault(base, []).append(tariff)
    for base, members in groups.items():
        for tariff in members:
            tariff["id"] = base
        if len(members) > 1:
            for tariff in members:
                discriminator = f"{tariff.get('customerType')}|{tariff.get('url')}|{tariff.get('comment')}"
                tariff["id"] = f"{base}-{hashlib.sha1(discriminator.encode()).hexdigest()[:6]}"
            seen: dict[str, int] = {}
            for tariff in members:  # identical discriminators: fall back to file order
                seen[tariff["id"]] = seen.get(tariff["id"], 0) + 1
                if seen[tariff["id"]] > 1:
                    tariff["id"] = f"{tariff['id']}-{seen[tariff['id']]}"


def build_year(year: int, tariffs: list[dict], header: dict, repairs: list, origins: list, curation: dict, retrieved_at: str) -> tuple[dict, list]:
    tariffs, applied, issues = apply_curation(tariffs, curation)
    assign_ids(tariffs)
    document = {
        "$schema": f"{SCHEMA_BASE}/tariff-document/v1.schema.json",
        "dsoName": header["dsoName"],
        "dsoNumber": header["dsoNumber"],
        "_meta": {
            "schemaVersion": "1.0",
            "year": year,
            "generatedAt": retrieved_at,
            "source": origins,
            "pricesExcludeVat": True,
            "repairs": repairs,
            "overrides": applied,
            "issues": [],
        },
        "tariffs": tariffs,
        "products": curation.get("products", []),
    }
    return document, issues


def publish(root: Path, offline: bool = False) -> int:
    org = load_config(root)
    retrieved_at = now_utc().isoformat(timespec="seconds")
    current_year = now_utc().astimezone(ZURICH).year
    failures = 0
    collected: dict[int, list] = {}
    repairs, origins, header = [], [], {"dsoName": None, "dsoNumber": None}
    for source in org["static"]["sources"]:
        if not source.get("enabled", True):
            continue
        try:
            data, origin = read_source(root, source, offline)
            document, log, problems = static_vse.normalize(json.loads(data))
        except Exception as exc:  # noqa: BLE001 - report it and keep the online version
            annotate("error", f"{org['slug']} source {source['name']}: {exc}")
            failures += 1
            continue
        for problem in problems:
            annotate("error", f"{org['slug']} source {source['name']}: {problem}")
            failures += 1
        origins.append(origin)
        repairs += log
        header["dsoName"] = header["dsoName"] or document["dsoName"]
        header["dsoNumber"] = header["dsoNumber"] or document["dsoNumber"]
        for tariff in document["tariffs"]:
            start = str(tariff.get("startDate", ""))
            year = int(start[:4]) if start[:4].isdigit() else current_year
            collected.setdefault(year, []).append(tariff)

    for year, tariffs in sorted(collected.items()):
        curation_path = root / "curation" / f"{year}.json"
        curation = load_json(curation_path) if curation_path.exists() else {}
        document, issues = build_year(year, tariffs, header, repairs, origins, curation, retrieved_at)
        issues = apply_waivers(issues + document_issues(document, year, org.get("vse_id")), curation.get("acceptIssues", []))
        document["_meta"]["issues"] = [i for i in issues if i["severity"] != "error"]
        errors = report(issues, f"{org['slug']} {year}")
        report_path = root / "data" / "tariffs" / f"{year}.report.json"
        if errors:
            failures += errors
            write_json(report_path, {"year": year, "published": False, "issues": issues})
            continue
        report_path.unlink(missing_ok=True)
        output = root / "data" / "tariffs" / f"{year}.json"
        if output.exists():
            previous = load_json(output)
            previous["_meta"]["generatedAt"] = retrieved_at
            if previous == document:
                print(f"[{org['slug']}] {year}: unchanged")
                continue
        write_json(output, document)
        print(f"[{org['slug']}] {year}: published {len(document['tariffs'])} tariffs, {len(document['products'])} products")

    current = root / "data" / "tariffs" / f"{current_year}.json"
    alias = root / "data" / "tariffs" / "current.json"
    if current.exists() and (not alias.exists() or alias.read_bytes() != current.read_bytes()):
        write_bytes(alias, current.read_bytes())
    write_index(root, org)
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="rebuild from data/static/raw without fetching")
    offline = parser.parse_args().offline
    roots = org_roots(Path.cwd())
    if not roots:
        annotate("error", "no config/source.json here and no utilities/<slug>/config/source.json")
        return 1
    # Publish every utility, also after a failure: one broken source must not block the others.
    results = [publish(root, offline=offline) for root in roots]
    return 1 if any(results) else 0


if __name__ == "__main__":
    sys.exit(main())
