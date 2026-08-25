"""Generic normalizer for any source following the VSE dynamic-tariff wire
format:

    {"publication_timestamp": ..., "prices": [
        {"start_timestamp": ..., "end_timestamp": ...,
         "<tariff_type>": [{"unit": "CHF_kWh"|"CHF_m", "value": ...}, ...], ...}
    ]}

Reference: VSE/AES Handbuch "Dynamische Netznutzungstarife im Verteilnetz"
(2025), Kapitel 7.3 (Tabelle 3: Standard tariff_types) und 7.4 (Antwortformat,
Schweizer Lokalzeit in den Beispielen). Works for both EKZ (consumption:
electricity/grid/integrated/metering/regional_fees) and BKW (feed_in only)
without any org-specific code.
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

SCHEMA_VERSION = "1.0"
ZURICH = ZoneInfo("Europe/Zurich")


def _parse_iso(ts: str) -> datetime:
    """datetime.fromisoformat only accepts the 'Z' suffix from Python 3.11
    onward; normalize it ourselves so this works on any Python 3 version."""
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    return datetime.fromisoformat(ts)


def _unit_value(entries, unit):
    for e in entries:
        if e.get("unit") == unit:
            return e.get("value")
    return None


def _component_keys(prices):
    keys = set()
    for p in prices:
        keys.update(k for k in p if k not in ("start_timestamp", "end_timestamp"))
    return keys


def local_date_of(raw: dict) -> str:
    """The Swiss calendar date these prices apply to, regardless of which
    timezone the source expresses its timestamps in."""
    first_start = raw["prices"][0]["start_timestamp"]
    return _parse_iso(first_start).astimezone(ZURICH).date().isoformat()


def to_vse(raw: dict) -> dict:
    """Re-emit the payload with timestamps normalized to Swiss local time
    (Europe/Zurich, ISO-8601 with offset) as shown in the VSE spec examples.
    Component keys/values are passed through unchanged."""
    prices = []
    for p in raw["prices"]:
        entry = {
            "start_timestamp": _parse_iso(p["start_timestamp"]).astimezone(ZURICH).isoformat(),
            "end_timestamp": _parse_iso(p["end_timestamp"]).astimezone(ZURICH).isoformat(),
        }
        for key, values in p.items():
            if key in ("start_timestamp", "end_timestamp"):
                continue
            entry[key] = values
        prices.append(entry)
    return {
        "publication_timestamp": raw.get("publication_timestamp"),
        "prices": prices,
    }


def normalize(raw: dict, *, org: dict, retrieved_at: str, date: str) -> dict:
    prices = raw["prices"]
    component_keys = _component_keys(prices)
    tariff_type = "feed_in" if component_keys <= {"feed_in"} else "consumption"

    intervals = []
    fixed_charges = {}
    for p in prices:
        components = {}
        for key in sorted(component_keys):
            values = p.get(key)
            if not values:
                continue
            per_kwh = _unit_value(values, "CHF_kWh")
            per_month = _unit_value(values, "CHF_m")
            if per_kwh is not None:
                components[key] = {"chf_per_kwh": per_kwh}
            if per_month is not None:
                fixed_charges[key] = {"chf_per_month": per_month}

        start_utc = _parse_iso(p["start_timestamp"]).astimezone(timezone.utc).isoformat()
        end_utc = _parse_iso(p["end_timestamp"]).astimezone(timezone.utc).isoformat()

        intervals.append({
            "start": start_utc,
            "end": end_utc,
            "components": components,
            "total_chf_per_kwh": (
                components.get("integrated", {}).get("chf_per_kwh")
                if "integrated" in components
                else components.get("feed_in", {}).get("chf_per_kwh")
            ),
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "organization": org["name"],
            "organization_slug": org["slug"],
            "country": org.get("country", "CH"),
            "api_url": org["api_url"],
            "website": org.get("website"),
            "publication_timestamp": raw.get("publication_timestamp"),
            "attribution": f"Data sourced from {org['name']} ({org.get('website')}), "
                            f"archived by Strompreise-Schweiz "
                            f"(https://github.com/Strompreise-Schweiz/{org['slug']}).",
        },
        "retrieved_at": retrieved_at,
        "date": date,
        "tariff_type": tariff_type,
        "timezone": "UTC",
        "currency": "CHF",
        "resolution_minutes": 15,
        "fixed_charges": fixed_charges,
        "intervals": intervals,
    }
