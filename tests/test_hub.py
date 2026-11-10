import json
from pathlib import Path

import pytest

import build_site
import common
import publish_static
import validate
from test_static import ekz_like


def add_utility(hub: Path, slug: str, *, folder: str | None = None, dynamic: list | None = None) -> Path:
    root = hub / "utilities" / (folder or slug)
    (root / "config").mkdir(parents=True)
    (root / "curation").mkdir()
    (root / "curation/source.json").write_text(json.dumps(ekz_like()))
    (root / "config/source.json").write_text(json.dumps({
        "slug": slug, "name": slug.title(), "vse_id": "CH10000000001", "dynamic": dynamic or [],
        "static": {"sources": [{"name": "main", "file": "curation/source.json"}]}}))
    return root


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-11-02T10:00:00Z")
    return tmp_path


def test_org_repo_is_one_root(tmp_path):
    (tmp_path / "config").mkdir()
    (tmp_path / "config/source.json").write_text("{}")
    assert common.org_roots(tmp_path) == [tmp_path]


def test_hub_lists_each_utility(hub):
    add_utility(hub, "beta")
    add_utility(hub, "alpha")
    (hub / "utilities" / "notes").mkdir()
    assert [p.name for p in common.org_roots(hub)] == ["alpha", "beta"]
    assert common.org_roots(hub / "utilities" / "notes") == []


def test_urls_depend_on_where_a_utility_lives(hub):
    root = add_utility(hub, "alpha")
    assert common.raw_url(root, "alpha", "data/index.json") == \
        "https://raw.githubusercontent.com/Strompreise-Schweiz/strompreise-schweiz.github.io/main/utilities/alpha/data/index.json"
    assert common.raw_url(hub, "ekz", "data/index.json") == \
        "https://raw.githubusercontent.com/Strompreise-Schweiz/ekz/main/data/index.json"
    # The site URL is the same in both cases, so a utility can move without breaking consumers.
    assert common.site_url("alpha", "data/tariffs/current.json") == "https://data.strompreise-schweiz.ch/alpha/tariffs/current.json"


def test_hub_publishes_every_utility(hub):
    add_utility(hub, "alpha")
    add_utility(hub, "beta")
    for root in common.org_roots(hub):
        assert publish_static.publish(root) == 0
        index = json.loads((root / "data/index.json").read_text())
        assert index["site"] == f"https://data.strompreise-schweiz.ch/{root.name}/"
        assert index["repository"].endswith(f"/strompreise-schweiz.github.io/tree/main/utilities/{root.name}")
        assert f"/utilities/{root.name}/data/tariffs/current.json" in index["static"]["current"]


def test_hub_main_continues_after_a_failing_utility(hub, monkeypatch):
    add_utility(hub, "alpha")
    broken = add_utility(hub, "beta")
    (broken / "curation/source.json").write_text("not json")
    monkeypatch.setattr("sys.argv", ["publish_static.py"])
    assert publish_static.main() == 1
    assert (hub / "utilities/alpha/data/tariffs/2026.json").exists()


@pytest.mark.parametrize("folder,dynamic,code", [
    ("other-name", None, "slug_mismatch"),
    (None, [{"id": "d", "name": "D", "api_url": "https://api.example.ch/v1/tariffs"}], "dynamic_in_hub"),
])
def test_hub_rules(hub, folder, dynamic, code):
    root = add_utility(hub, "alpha", folder=folder, dynamic=dynamic)
    config = json.loads((root / "config/source.json").read_text())
    assert code in {issue["code"] for issue in validate.hub_issues(root, config)}


def test_disabled_dynamic_tariff_is_allowed_in_hub(hub):
    root = add_utility(hub, "alpha", dynamic=[{"id": "d", "name": "D", "enabled": False, "api_url": "https://api.example.ch/v1/tariffs"}])
    assert validate.hub_issues(root, json.loads((root / "config/source.json").read_text())) == []


def test_hub_validates_cleanly(hub, monkeypatch):
    for root in (add_utility(hub, "alpha"), add_utility(hub, "beta")):
        publish_static.publish(root)
    monkeypatch.setattr("sys.argv", ["validate.py"])
    assert validate.main() == 0


def test_site_of_hub_has_one_folder_per_utility_and_overall_index(hub):
    for root in (add_utility(hub, "alpha"), add_utility(hub, "beta")):
        publish_static.publish(root)
    (hub / "repositories.json").write_text(json.dumps({"repositories": [{"slug": "ekz", "name": "EKZ"}]}))
    assert build_site.build(hub, hub / "_site") == 0
    assert (hub / "_site/alpha/tariffs/current.json").exists()
    assert (hub / "_site/beta/index.json").exists()
    index = json.loads((hub / "_site/index.json").read_text())
    assert [(u["slug"], u["maintained_in"]) for u in index["utilities"]] == \
        [("alpha", "hub"), ("beta", "hub"), ("ekz", "own repository")]
    assert index["utilities"][2]["index"] == "https://data.strompreise-schweiz.ch/ekz/index.json"


def test_utility_in_hub_and_own_repo_is_an_error(hub):
    add_utility(hub, "alpha")
    (hub / "repositories.json").write_text(json.dumps({"repositories": [{"slug": "alpha", "name": "Alpha"}]}))
    assert build_site.build(hub, hub / "_site") == 1


def test_site_of_org_repo_serves_current_archive_year_only(tmp_path, monkeypatch):
    monkeypatch.setenv("TARIFF_ETL_NOW", "2027-01-05T10:00:00Z")
    (tmp_path / "config").mkdir()
    (tmp_path / "config/source.json").write_text(json.dumps({"slug": "ekz", "name": "EKZ", "dynamic": [], "static": {"sources": []}}))
    for relative in ("dynamic/grid-d/vse/2026/2026-12-31.json", "dynamic/grid-d/vse/2027/2027-01-05.json",
                     "dynamic/grid-d/raw/2026/2026-12-31.json", "dynamic/vse/2026/2026-08-25.json",
                     "dynamic/grid-d/latest.json", "tariffs/2026.json", "index.json"):
        path = tmp_path / "data" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}")
    assert build_site.build(tmp_path, tmp_path / "_site") == 0
    served = sorted(str(p.relative_to(tmp_path / "_site")) for p in (tmp_path / "_site").rglob("*") if p.is_file())
    assert served == ["dynamic/grid-d/latest.json", "dynamic/grid-d/vse/2027/2027-01-05.json", "index.json", "tariffs/2026.json"]
