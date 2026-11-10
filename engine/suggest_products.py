#!/usr/bin/env python3
"""Proposes which tariffs form a product, because the VSE format has no link
between electricity, grid, metering and regional_fees. It matches on voltage
level and customer group and prints candidates with status "suggested".

A person checks them against the price sheet, sets "verified" plus sourceUrl
and copies them to curation/<year>.json. Usage: suggest_products.py <year>
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_json, slugify  # noqa: E402


def fits(tariff: dict, level: int | None) -> bool:
    """A tariff without a voltage level is not tied to one, so it fits any level."""
    own = tariff.get("customerVoltageLevel")
    return own is None or level is None or own == level


def first(tariffs: list[dict], tariff_type: str, level: int | None) -> dict | None:
    return next((t for t in tariffs if t["tariffType"] == tariff_type and fits(t, level)), None)


def suggest(document: dict) -> list[dict]:
    tariffs = document["tariffs"]
    products = []
    for electricity in (t for t in tariffs if t["tariffType"] == "electricity"):
        is_dynamic = electricity["tariffForm"] == "dynamic"
        grids = [g for g in tariffs if g["tariffType"] == "grid" and fits(g, electricity.get("customerVoltageLevel"))
                 and g["customerType"] == electricity["customerType"] and (g["tariffForm"] == "dynamic") == is_dynamic]
        for grid in grids:
            level = grid.get("customerVoltageLevel")
            components = {"electricity": electricity["id"], "grid": grid["id"]}
            for slot in ("metering", "regional_fees"):
                match = first(tariffs, slot, level)
                if match:
                    components[slot] = match["id"]
            products.append({
                "id": slugify(f"{electricity['tariffName']} {grid['tariffName']}", 80) + (f"-ne{level}" if level else ""),
                "name": f"{electricity['tariffName']} + {grid['tariffName']}",
                "status": "suggested",
                "components": components,
            })
    return products


def main() -> int:
    year = sys.argv[1]
    document = load_json(Path.cwd() / "data" / "tariffs" / f"{year}.json")
    print(json.dumps({"year": int(year), "products": suggest(document)}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
