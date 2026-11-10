#!/usr/bin/env python3
"""Validates an org repo or the hub repo: schema checks plus the rules JSON Schema cannot express.

Run from the root of the repo. Issue codes are stable, so curation/<year>.json
can accept a specific one with a reason. Requires jsonschema.
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ENGINE_ROOT, annotate, dynamic_dir, in_hub, load_json, org_roots  # noqa: E402
from normalizers import generic_vse  # noqa: E402

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "So"]
TIME_FIELDS = ("energy", "power", "reactivePower")
# Above this a price was probably entered in Rappen instead of francs.
MAX_PLAUSIBLE_CHF_KWH = 1.5
UNIT_RULES = {"base": {"CHF/M"}, "energy": {"CHF/kWh"}, "power": {"CHF/kW", "CHF/kW/M"}, "reactivePower": {"CHF/kVarh"}}


def _schema_registry() -> Registry:
    resources = []
    for path in (ENGINE_ROOT / "schemas").rglob("*.schema.json"):
        schema = load_json(path)
        resources.append((schema["$id"], Resource.from_contents(schema)))
    return Registry().with_resources(resources)


def schema_issues(instance, name: str) -> list[dict]:
    schema = load_json(ENGINE_ROOT / "schemas" / name / "v1.schema.json")
    validator = Draft202012Validator(schema, registry=_schema_registry(), format_checker=FormatChecker())
    return [{"severity": "error", "code": "schema", "path": "/".join(map(str, error.absolute_path)), "message": error.message}
            for error in sorted(validator.iter_errors(instance), key=lambda e: list(map(str, e.absolute_path)))]


def _minutes(value: str) -> int:
    return int(value[:2]) * 60 + int(value[3:])


def coverage_problems(entries: list[dict]) -> tuple[list[str], list[str]]:
    """Check that the time windows of a multilevel tariff cover each month and
    weekday exactly once. Windows are Swiss wall-clock time, also across a clock
    change: "high tariff from 07:00" stays 07:00 all year. Returns gaps and overlaps."""
    counts = {(month, day): [0] * 1440 for month in MONTHS for day in WEEKDAYS}
    for entry in entries:
        start, end = _minutes(entry["from"]), _minutes(entry["to"])
        if start == end:
            minutes = range(1440)
        elif start < end or end == 0:
            minutes = range(start, end or 1440)
        else:
            minutes = list(range(start, 1440)) + list(range(0, end))
        for month in entry.get("months") or MONTHS:
            for day in entry.get("weekdays") or WEEKDAYS:
                for minute in minutes:
                    counts[(month, day)][minute] += 1
    gaps = [f"{m}/{d}" for (m, d), c in counts.items() if 0 in c]
    overlaps = [f"{m}/{d}" for (m, d), c in counts.items() if any(v > 1 for v in c)]
    return gaps, overlaps


def _issue(severity: str, code: str, tariff: dict | None, message: str) -> dict:
    return {"severity": severity, "code": code, "tariff": tariff.get("id") if tariff else None, "message": message}


def tariff_issues(tariff: dict, year: int) -> list[dict]:
    issues = []
    if "customerVoltageLevel" not in tariff:
        # Required by the OpenAPI, but EKZ omits it where a tariff is not tied to a level.
        # Guessing a level would be inventing data, so this is reported and not blocked.
        issues.append(_issue("warning", "missing_voltage_level", tariff, "the source states no voltage level"))
    prices = tariff.get("prices", {})
    form = tariff.get("tariffForm")
    energy = prices.get("energy") or []
    for field, allowed in UNIT_RULES.items():
        values = prices.get(field)
        for entry in ([values] if isinstance(values, dict) else values or []):
            if entry.get("priceUnit") not in allowed:
                issues.append(_issue("warning", "unexpected_unit", tariff, f"{field} uses {entry.get('priceUnit')}"))
            if field == "energy" and entry.get("price", 0) > MAX_PLAUSIBLE_CHF_KWH:
                issues.append(_issue("error", "implausible_energy_price", tariff,
                                     f"{entry['price']} CHF/kWh: was it entered in Rappen?"))
    if form == "constant":
        for field in TIME_FIELDS:
            values = prices.get(field) or []
            if len(values) > 1:
                issues.append(_issue("error", "constant_with_several_prices", tariff, f"{field} has {len(values)} entries"))
            for value in values:
                restricted = value.get("months") or value.get("weekdays") or value["from"] != value["to"]
                if restricted:
                    issues.append(_issue("error", "constant_with_time_window", tariff, f"{field} applies only part of the time"))
    elif form == "multilevel":
        windows = [prices.get(f) or [] for f in TIME_FIELDS]
        if not any(len(values) > 1 for values in windows):
            issues.append(_issue("warning", "multilevel_with_single_price", tariff, "only one price level: should this be constant?"))
    elif form == "dynamic" and energy:
        issues.append(_issue("warning", "dynamic_with_energy_prices", tariff, "dynamic tariff also lists fixed energy prices"))
    if form in ("constant", "multilevel") and energy:
        gaps, overlaps = coverage_problems(energy)
        if gaps:
            issues.append(_issue("error", "energy_time_gap", tariff, f"no price for parts of {len(gaps)} month/weekday pairs, e.g. {gaps[0]}"))
        if overlaps:
            issues.append(_issue("error", "energy_time_overlap", tariff, f"several prices for parts of {len(overlaps)} month/weekday pairs, e.g. {overlaps[0]}"))
    start, end = tariff.get("startDate", ""), tariff.get("endDate", "")
    if start and end:
        if start > end:
            issues.append(_issue("error", "start_after_end", tariff, f"{start} is after {end}"))
        if not start.startswith(str(year)):
            issues.append(_issue("error", "wrong_year", tariff, f"starts {start}, document is {year}"))
        if int(end[:4]) > year + 1:
            issues.append(_issue("error", "implausible_end_date", tariff, f"ends {end}: tariffs are set per year"))
    return issues


def document_issues(document: dict, year: int, vse_id: str | None = None) -> list[dict]:
    issues = schema_issues(document, "tariff-document")
    if any(issue["severity"] == "error" for issue in issues):
        return issues
    tariffs = document["tariffs"]
    by_id = {tariff["id"]: tariff for tariff in tariffs}
    for tariff in tariffs:
        issues += tariff_issues(tariff, year)
    if vse_id and vse_id != f"CH{document['dsoNumber']}":
        issues.append(_issue("error", "dso_number_mismatch", None, f"file has {document['dsoNumber']}, config has {vse_id}"))
    keys = Counter((t["tariffType"], t["tariffName"], t.get("customerVoltageLevel"), t["customerType"], t["startDate"]) for t in tariffs)
    for key, count in keys.items():
        if count > 1:
            issues.append(_issue("warning", "indistinguishable_tariffs", None, f"{count} tariffs share {key[:4]}"))
    if len(by_id) != len(tariffs):
        issues.append(_issue("error", "duplicate_tariff_id", None, "tariff ids are not unique"))
    for product in document["products"]:
        for slot, reference in product["components"].items():
            target = by_id.get(reference)
            if target is None:
                issues.append({"severity": "error", "code": "product_unknown_tariff", "tariff": product["id"], "message": f"{slot} refers to {reference}"})
            elif target["tariffType"] != slot:
                issues.append({"severity": "error", "code": "product_wrong_slot", "tariff": product["id"], "message": f"{slot} refers to a {target['tariffType']} tariff"})
        if product["status"] == "verified" and not product.get("sourceUrl"):
            issues.append({"severity": "error", "code": "verified_without_source", "tariff": product["id"], "message": "a verified product needs sourceUrl"})
        levels = {by_id[r].get("customerVoltageLevel") for r in product["components"].values() if r in by_id} - {None}
        if len(levels) > 1:
            issues.append({"severity": "error", "code": "product_mixed_voltage", "tariff": product["id"], "message": f"voltage levels {sorted(levels)}"})
    return issues


def apply_waivers(issues: list[dict], waivers: list[dict]) -> list[dict]:
    """Downgrade accepted issues. They stay visible in the published _meta."""
    result = []
    for issue in issues:
        match = next((w for w in waivers if w["code"] == issue["code"] and w.get("tariff") in (None, issue.get("tariff"))), None)
        result.append({**issue, "severity": "accepted", "acceptReason": match["reason"]} if match else issue)
    return result


def report(issues: list[dict], label: str) -> int:
    errors = 0
    for issue in issues:
        where = issue.get("tariff") or issue.get("path") or ""
        text = f"{label} [{issue['code']}] {where}: {issue['message']}"
        if issue["severity"] == "error":
            errors += 1
            annotate("error", text)
        elif issue["severity"] == "warning":
            annotate("warning", text)
    return errors


def dynamic_day_issues(path: Path, document: dict) -> list[dict]:
    if "_meta" not in document:  # archived before version 2.0, kept as it was published
        return []
    issues = schema_issues(document, "dynamic-day")
    if issues or path.name == "latest.json":
        return issues
    check = generic_vse.check_day(path.stem, document["prices"])
    if check["complete"] != document["_meta"].get("complete"):
        issues.append({"severity": "error", "code": "complete_flag_wrong", "message": f"{path.name}: {check['issues']}"})
    return issues


def hub_issues(root: Path, config: dict) -> list[dict]:
    """Rules for a utility in the hub repo. Dynamic tariffs commit every day and grow the
    archive, so they belong in an own repo. The folder name is part of the public URL."""
    issues = []
    if any(t.get("enabled", True) for t in config.get("dynamic", [])):
        issues.append(_issue("error", "dynamic_in_hub", None, "a utility with dynamic tariffs needs its own repo"))
    if config.get("slug") != root.name:
        issues.append(_issue("error", "slug_mismatch", None, f"folder is {root.name}, slug is {config.get('slug')}"))
    return issues


def validate_root(root: Path, cwd: Path, all_days: bool) -> int:
    def label(path: Path) -> str:
        return str(path.relative_to(cwd))

    errors = 0
    config = load_json(root / "config" / "source.json")
    errors += report(schema_issues(config, "source-config"), label(root / "config" / "source.json"))
    if in_hub(root):
        errors += report(hub_issues(root, config), label(root))
    supplier = root / "data" / "supplier.json"
    if supplier.exists():
        errors += report(schema_issues(load_json(supplier), "supplier"), label(supplier))
    for path in sorted((root / "curation").glob("[0-9]*.json")) if (root / "curation").exists() else []:
        if not path.name.endswith(".source.json"):
            errors += report(schema_issues(load_json(path), "curation"), label(path))
    for path in sorted((root / "data" / "tariffs").glob("[0-9][0-9][0-9][0-9].json")) if (root / "data" / "tariffs").exists() else []:
        document = load_json(path)
        waivers = []
        curation = root / "curation" / path.name
        if curation.exists():
            waivers = load_json(curation).get("acceptIssues", [])
        issues = apply_waivers(document_issues(document, int(path.stem), config.get("vse_id")), waivers)
        errors += report(issues, label(path))
    for tariff in config.get("dynamic", []):
        base = dynamic_dir(root, tariff)
        days = sorted((base / "vse").rglob("*.json"))
        for path in (days if all_days else days[-3:]) + ([base / "latest.json"] if (base / "latest.json").exists() else []):
            errors += report(dynamic_day_issues(path, load_json(path)), label(path))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all-days", action="store_true", help="check the whole dynamic archive, not only the newest days")
    args = parser.parse_args()
    cwd = Path.cwd()
    roots = org_roots(cwd)
    if not roots:
        annotate("error", "no config/source.json here and no utilities/<slug>/config/source.json")
        return 1
    errors = sum(validate_root(root, cwd, args.all_days) for root in roots)
    print(f"validation finished: {errors} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
