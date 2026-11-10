#!/usr/bin/env python3
"""Builds the folder that GitHub Pages serves. Run from the root of an org repo or the hub repo.

    org repo:  data/                    -> <out>/            served as /<slug>/
    hub repo:  utilities/<slug>/data/   -> <out>/<slug>/     served as /<slug>/
               every utility            -> <out>/index.json  served as /index.json

The hub repo is the organization site, an org repo a project site below it, so a
utility has the same URL in both places. A Pages site is limited to 1 GB, so the
dynamic archive is served for the current year only. Older years stay in git and
on raw.githubusercontent.com.

Stdlib only.
"""
import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ORG, SITE_BASE, ZURICH, annotate, in_hub, load_config, load_json, now_utc, org_roots, site_url, write_json  # noqa: E402
from site_index import repository_url  # noqa: E402

ARCHIVE_DIRS = {"raw", "vse", "normalized"}
# Warn well before the 1 GB limit of a Pages site.
WARN_BYTES = 800 * 1024 * 1024


def is_old_archive(relative: Path, current_year: int) -> bool:
    """True for data/dynamic/[<id>/](raw|vse|normalized)/<year>/... with a past year."""
    parts = relative.parts
    if not parts or parts[0] != "dynamic":
        return False
    for position, part in enumerate(parts[:-1]):
        following = parts[position + 1]
        if part in ARCHIVE_DIRS and following.isdigit() and len(following) == 4:
            return int(following) < current_year
    return False


def copy_data(data: Path, target: Path, current_year: int) -> int:
    """Copy one utility's data/ folder. Returns the bytes copied."""
    copied = 0
    for path in sorted(data.rglob("*")):
        relative = path.relative_to(data)
        if not path.is_file() or is_old_archive(relative, current_year):
            continue
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        copied += path.stat().st_size
    return copied


def overall_index(cwd: Path, roots: list[Path]) -> dict:
    """All utilities, in the hub and in own repos, from repositories.json."""
    entries = []
    for root in roots:
        org = load_config(root)
        entries.append({"slug": org["slug"], "name": org["name"], "vse_id": org.get("vse_id"),
                        "maintained_in": "hub", "repository": repository_url(root, org["slug"]),
                        "index": site_url(org["slug"], "data/index.json")})
    listing = cwd / "repositories.json"
    for repo in load_json(listing)["repositories"] if listing.exists() else []:
        entries.append({"slug": repo["slug"], "name": repo["name"], "vse_id": repo.get("vse_id"),
                        "maintained_in": "own repository", "repository": f"https://github.com/{ORG}/{repo['slug']}",
                        "index": site_url(repo["slug"], "data/index.json")})
    return {
        "$comment": "Every utility of Strompreise Schweiz. Follow index for its tariffs.",
        "site": f"{SITE_BASE}/",
        "utilities": sorted(entries, key=lambda e: e["slug"]),
    }


def build(cwd: Path, out: Path) -> int:
    roots = org_roots(cwd)
    if not roots:
        annotate("error", "no config/source.json here and no utilities/<slug>/config/source.json")
        return 1
    current_year = now_utc().astimezone(ZURICH).year
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    total = 0
    hub = in_hub(roots[0])
    for root in roots:
        data = root / "data"
        if data.is_dir():
            total += copy_data(data, out / root.name if hub else out, current_year)
    if hub:
        index = overall_index(cwd, roots)
        slugs = [entry["slug"] for entry in index["utilities"]]
        duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
        if duplicates:
            annotate("error", f"in the hub and in repositories.json at the same time: {', '.join(duplicates)}")
            return 1
        write_json(out / "index.json", index)
    if total > WARN_BYTES:
        annotate("warning", f"site is {total / 1024 / 1024:.0f} MB, GitHub Pages allows 1 GB")
    print(f"site built in {out}: {total / 1024 / 1024:.1f} MB")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="_site", help="output folder, default _site")
    args = parser.parse_args()
    cwd = Path.cwd()
    return build(cwd, cwd / args.out)


if __name__ == "__main__":
    sys.exit(main())
