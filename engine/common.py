"""Helpers shared by the dynamic and static pipelines. Stdlib only."""
import json
import os
import re
import sys
import unicodedata
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ZURICH = ZoneInfo("Europe/Zurich")
USER_AGENT = "strompreise-schweiz-tariff-core/2.0 (+https://github.com/Strompreise-Schweiz/tariff-core)"
ORG = "Strompreise-Schweiz"
SCHEMA_BASE = f"https://raw.githubusercontent.com/{ORG}/tariff-core/main/schemas"
ENGINE_ROOT = Path(__file__).resolve().parent.parent
# Own domain in front of GitHub Pages. The hub repo is the organization site, so every
# utility has the same URL whether it lives in the hub or in its own repo.
SITE_BASE = "https://data.strompreise-schweiz.ch"
# Utilities without dynamic tariffs live in this repo, one folder each under HUB_DIR.
HUB_REPO = "strompreise-schweiz.github.io"
HUB_DIR = "utilities"


def now_utc() -> datetime:
    """Current time. TARIFF_ETL_NOW pins it for tests and reproductions."""
    pinned = os.environ.get("TARIFF_ETL_NOW")
    if pinned:
        return parse_ts(pinned).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def parse_ts(value: str) -> datetime:
    """Parse ISO-8601. Timestamps without an offset are rejected: during the
    autumn clock change the local hour 02:00-03:00 occurs twice, so a naive
    timestamp cannot identify one instant."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp without UTC offset: {value}")
    return parsed


def day_bounds(day: date) -> tuple[datetime, datetime]:
    """Start and end of a Swiss calendar day. Such a day lasts 23, 24 or 25 hours."""
    start = datetime(day.year, day.month, day.day, tzinfo=ZURICH)
    following = day + timedelta(days=1)
    end = datetime(following.year, following.month, following.day, tzinfo=ZURICH)
    return start, end


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - URLs come from reviewed config
        return response.read()


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if data.endswith(b"\n") else data + b"\n")


def write_json(path: Path, obj) -> None:
    write_bytes(path, json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8"))


def write_price_doc(path: Path, doc: dict) -> None:
    """Write a VSE day document with one interval per line. That keeps files
    about half the size of indented JSON and keeps git diffs readable."""
    head = {k: v for k, v in doc.items() if k != "prices"}
    lines = [json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in doc["prices"]]
    body = json.dumps(head, indent=2, ensure_ascii=False)
    joined = ",\n    ".join(lines)
    text = f'{body[:-2]},\n  "prices": [\n    {joined}\n  ]\n}}\n'
    write_bytes(path, text.encode("utf-8"))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_config(root: Path) -> dict:
    """Read config/source.json. The pre-2.0 flat shape keeps working so org
    repos do not break between the tariff-core commit and their own commit."""
    config = load_json(root / "config" / "source.json")
    if "api_url" in config and "dynamic" not in config:
        config["dynamic"] = [{
            "id": None,
            "api_url": config["api_url"],
            "normalizer": config.get("normalizer", "generic_vse"),
        }]
    config.setdefault("dynamic", [])
    config.setdefault("static", {"sources": []})
    return config


def dynamic_dir(root: Path, tariff: dict) -> Path:
    base = root / "data" / "dynamic"
    return base / tariff["id"] if tariff.get("id") else base


def org_roots(cwd: Path) -> list[Path]:
    """The utility roots to process from cwd. An own repo is one utility; the hub
    repo holds one utility per folder under utilities/."""
    if (cwd / "config" / "source.json").exists():
        return [cwd]
    hub = cwd / HUB_DIR
    if not hub.is_dir():
        return []
    return sorted(p for p in hub.iterdir() if (p / "config" / "source.json").exists())


def in_hub(root: Path) -> bool:
    return root.resolve().parent.name == HUB_DIR


def raw_url(root: Path, slug: str, relative: str) -> str:
    """URL of a file in git, relative to the utility root. Works without the own domain."""
    if in_hub(root):
        return f"https://raw.githubusercontent.com/{ORG}/{HUB_REPO}/main/{HUB_DIR}/{slug}/{relative}"
    return f"https://raw.githubusercontent.com/{ORG}/{slug}/main/{relative}"


def site_url(slug: str, relative: str) -> str:
    """URL on the own domain. The site serves the utility's data/ folder under /<slug>/."""
    return f"{SITE_BASE}/{slug}/{relative.removeprefix('data/')}"


def slugify(value: str, limit: int = 60) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:limit].rstrip("-") or "x"


def annotate(level: str, message: str) -> None:
    """Print a message and surface it as a GitHub Actions annotation."""
    stream = sys.stderr if level == "error" else sys.stdout
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::{level}::{message}", file=stream)
    else:
        print(f"[{level}] {message}", file=stream)
