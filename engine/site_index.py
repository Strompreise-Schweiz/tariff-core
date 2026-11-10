"""data/index.json: one stable entry point per org repo that lists every URL."""
from pathlib import Path

from common import dynamic_dir, load_json, raw_url, write_json


def write_index(root: Path, org: dict) -> None:
    slug = org["slug"]
    dynamic = []
    for tariff in org["dynamic"]:
        identifier = tariff.get("id")
        if not tariff.get("enabled", True) or not identifier:
            continue
        if (dynamic_dir(root, tariff) / "latest.json").exists():
            dynamic.append({
                "id": identifier,
                "name": tariff.get("name"),
                "components": tariff.get("components", []),
                "valid_from": tariff.get("valid_from"),
                "valid_to": tariff.get("valid_to"),
                "latest": raw_url(slug, f"data/dynamic/{identifier}/latest.json"),
                "archive": raw_url(slug, f"data/dynamic/{identifier}/vse/{{year}}/{{date}}.json"),
                "source": tariff["api_url"],
            })
    tariffs_dir = root / "data" / "tariffs"
    years = sorted(p.stem for p in tariffs_dir.glob("[0-9][0-9][0-9][0-9].json")) if tariffs_dir.exists() else []
    index = {
        "$comment": "Stable entry point for this organization. All URLs below stay valid.",
        "organization": org["name"],
        "slug": slug,
        "vse_id": org.get("vse_id"),
        "website": org.get("website"),
        "license": org.get("data_license"),
        "static": {
            "current": raw_url(slug, "data/tariffs/current.json") if (tariffs_dir / "current.json").exists() else None,
            "years": {year: raw_url(slug, f"data/tariffs/{year}.json") for year in years},
        },
        "dynamic": dynamic,
    }
    path = root / "data" / "index.json"
    if not path.exists() or load_json(path) != index:
        write_json(path, index)
