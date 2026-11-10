"""Normalizer for sources that follow the VSE dynamic-tariff wire format:

    {"publication_timestamp": ..., "prices": [
        {"start_timestamp": ..., "end_timestamp": ...,
         "<tariff_type>": [{"unit": "CHF_kWh"|"CHF_m", "value": ...}, ...], ...}]}

Reference: VSE/AES Handbuch HDN 2025, chapters 7.3 and 7.4.
"""
from collections import defaultdict
from datetime import date, timezone

from common import ZURICH, day_bounds, parse_ts

NORMALIZED_VERSION = "1.1"
TIME_KEYS = ("start_timestamp", "end_timestamp")
# Handbook 7.4.1 uses tariff_type=dso for what table 3 calls grid.
DEFAULT_COMPONENT_MAP = {"dso": "grid"}
UNIT_ALIASES = {"CHF/kWh": "CHF_kWh", "CHF/m": "CHF_m", "CHF/M": "CHF_m"}


def _value(entries, unit):
    for entry in entries or []:
        if entry.get("unit") == unit:
            return entry.get("value")
    return None


def canonicalize(raw: dict, tariff: dict) -> tuple[list[dict], list[str]]:
    """Return all intervals in VSE shape, sorted by instant, with Swiss local
    timestamps, and the list of additions made to the source data."""
    component_map = {**DEFAULT_COMPONENT_MAP, **tariff.get("component_map", {})}
    additions = tariff.get("add_components", [])
    notes: set[str] = set()
    by_start = {}
    for source in raw["prices"]:
        start = parse_ts(source["start_timestamp"])
        end = parse_ts(source["end_timestamp"])
        entry = {
            "start_timestamp": start.astimezone(ZURICH).isoformat(),
            "end_timestamp": end.astimezone(ZURICH).isoformat(),
        }
        for key, values in source.items():
            if key in TIME_KEYS:
                continue
            target = component_map.get(key, key)
            if target != key:
                notes.add(f"renamed component {key} to {target}")
            entry[target] = [
                {**item, "unit": UNIT_ALIASES.get(item.get("unit"), item.get("unit"))}
                for item in values
            ]
        local_day = start.astimezone(ZURICH).date().isoformat()
        for extra in additions:
            in_range = extra.get("valid_from", "0000") <= local_day <= extra.get("valid_to", "9999")
            if in_range and extra["tariff_type"] not in entry:
                entry[extra["tariff_type"]] = [{"unit": extra["unit"], "value": extra["value"]}]
                notes.add(f"added {extra['tariff_type']} from config: {extra['reason']}")
        grid = _value(entry.get("grid"), "CHF_kWh")
        electricity = _value(entry.get("electricity"), "CHF_kWh")
        if "integrated" not in entry and grid is not None and electricity is not None:
            entry["integrated"] = [{"unit": "CHF_kWh", "value": round(grid + electricity, 6)}]
            notes.add("derived integrated = grid + electricity")
        by_start[start.astimezone(timezone.utc)] = entry
    return [by_start[key] for key in sorted(by_start)], sorted(notes)


def split_by_day(prices: list[dict]) -> dict[str, list[dict]]:
    days = defaultdict(list)
    for entry in prices:
        days[parse_ts(entry["start_timestamp"]).astimezone(ZURICH).date().isoformat()].append(entry)
    return dict(days)


def check_day(day: str, prices: list[dict]) -> dict:
    """Check that the intervals cover exactly one Swiss calendar day. The day
    has 92 quarter hours in March and 100 in October, so counts are derived
    from the calendar and never hardcoded to 96."""
    start, end = day_bounds(date.fromisoformat(day))
    issues = []
    first = parse_ts(prices[0]["start_timestamp"])
    last = parse_ts(prices[-1]["end_timestamp"])
    if first != start:
        issues.append(f"starts at {first.isoformat()}, expected {start.isoformat()}")
    if last != end:
        issues.append(f"ends at {last.isoformat()}, expected {end.isoformat()}")
    durations = set()
    for current, following in zip(prices, prices[1:]):
        if current["end_timestamp"] != following["start_timestamp"]:
            issues.append(f"gap or overlap at {current['end_timestamp']}")
    for entry in prices:
        durations.add((parse_ts(entry["end_timestamp"]) - parse_ts(entry["start_timestamp"])).total_seconds() / 60)
    resolution = durations.pop() if len(durations) == 1 else None
    if resolution is None:
        issues.append("intervals have different lengths")
    # Convert first: subtracting two datetimes with the same tzinfo ignores a clock change.
    day_minutes = (end.astimezone(timezone.utc) - start.astimezone(timezone.utc)).total_seconds() / 60
    return {
        "complete": not issues,
        "issues": issues,
        "resolution_minutes": int(resolution) if resolution else None,
        "interval_count": len(prices),
        "expected_interval_count": int(day_minutes / resolution) if resolution else None,
        "day_length_hours": int(day_minutes / 60),
    }


def normalize(doc: dict, *, org: dict, tariff: dict, date: str, retrieved_at: str, check: dict) -> dict:
    """Cross-organization schema with UTC timestamps. See SCHEMA.md."""
    prices = doc["prices"]
    keys = {key for entry in prices for key in entry if key not in TIME_KEYS}
    intervals = []
    fixed_charges = {}
    for entry in prices:
        components = {}
        for key in sorted(keys):
            values = entry.get(key)
            per_kwh = _value(values, "CHF_kWh")
            per_month = _value(values, "CHF_m")
            if per_kwh is not None:
                components[key] = {"chf_per_kwh": per_kwh}
            if per_month is not None:
                fixed_charges[key] = {"chf_per_month": per_month}
        total = components.get("integrated", components.get("feed_in", {})).get("chf_per_kwh")
        intervals.append({
            "start": parse_ts(entry["start_timestamp"]).astimezone(timezone.utc).isoformat(),
            "end": parse_ts(entry["end_timestamp"]).astimezone(timezone.utc).isoformat(),
            "components": components,
            "total_chf_per_kwh": total,
        })
    return {
        "schema_version": NORMALIZED_VERSION,
        "source": {
            "organization": org["name"],
            "organization_slug": org["slug"],
            "tariff_id": tariff.get("id"),
            "country": org.get("country", "CH"),
            "api_url": tariff["api_url"],
            "website": org.get("website"),
            "publication_timestamp": doc.get("publication_timestamp"),
            "attribution": f"Data sourced from {org['name']} ({org.get('website')}), archived by "
                           f"Strompreise-Schweiz (https://github.com/Strompreise-Schweiz/{org['slug']}).",
        },
        "retrieved_at": retrieved_at,
        "date": date,
        "complete": check["complete"],
        "tariff_type": "feed_in" if keys <= {"feed_in"} else "consumption",
        "timezone": "UTC",
        "currency": "CHF",
        "resolution_minutes": check["resolution_minutes"],
        "fixed_charges": fixed_charges,
        "intervals": intervals,
    }
