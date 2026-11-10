import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import common
import fetch_and_normalize as fetch
from normalizers import generic_vse
from validate import dynamic_day_issues


def make_day(day: str, *, utc=False, drop_last=0, grid=0.11):
    start, end = common.day_bounds(datetime.fromisoformat(day).date())
    prices, moment = [], start.astimezone(timezone.utc)
    while moment < end.astimezone(timezone.utc):
        following = moment + timedelta(minutes=15)
        convert = (lambda m: m.isoformat().replace("+00:00", "Z")) if utc else (lambda m: m.astimezone(common.ZURICH).isoformat())
        prices.append({"start_timestamp": convert(moment), "end_timestamp": convert(following),
                       "grid": [{"unit": "CHF_kWh", "value": grid}, {"unit": "CHF_m", "value": 5.0}],
                       "electricity": [{"unit": "CHF_kWh", "value": 0.09}]})
        moment = following
    return {"publication_timestamp": f"{day}T10:00:00Z", "prices": prices[:len(prices) - drop_last]}


@pytest.fixture
def org_repo(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    config = {"slug": "muster", "name": "Muster AG", "vse_id": "CH10000000001", "website": "https://example.ch",
              "dynamic": [{"id": "grid-d", "name": "Dyn", "api_url": "https://api.example.ch/v1/tariffs",
                           "query": {"tariff_name": "grid_d"}}],
              "static": {"sources": []}}
    (tmp_path / "config" / "source.json").write_text(json.dumps(config))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def serve(monkeypatch, responses: dict):
    """Serve days by the start_timestamp in the request."""
    def fake(url, timeout=30):
        for day, payload in responses.items():
            start = common.day_bounds(datetime.fromisoformat(day).date())[0].astimezone(timezone.utc)
            if start.strftime("%Y-%m-%dT%H%%3A%M%%3A%SZ") in url:
                return json.dumps(payload).encode()
        return json.dumps({"publication_timestamp": None, "prices": []}).encode()
    monkeypatch.setattr(fetch, "fetch_bytes", fake)


@pytest.mark.parametrize("day,hours,count", [("2026-03-29", 23, 92), ("2026-07-01", 24, 96), ("2026-10-25", 25, 100)])
def test_day_length_follows_clock_change(day, hours, count):
    prices, _ = generic_vse.canonicalize(make_day(day), {})
    check = generic_vse.check_day(day, prices)
    assert check["complete"], check["issues"]
    assert (check["day_length_hours"], check["interval_count"]) == (hours, count)


def test_real_bug_96_intervals_on_25_hour_day_is_flagged():
    """EKZ and BKW both delivered 96 intervals for 2026-10-25, ending one hour early."""
    prices, _ = generic_vse.canonicalize(make_day("2026-10-25", drop_last=4), {})
    check = generic_vse.check_day("2026-10-25", prices)
    assert not check["complete"]
    assert "ends at 2026-10-25T23:00:00+01:00" in check["issues"][0]


def test_utc_source_lands_on_swiss_day():
    prices, _ = generic_vse.canonicalize(make_day("2026-07-02", utc=True), {})
    assert set(generic_vse.split_by_day(prices)) == {"2026-07-02"}
    assert prices[0]["start_timestamp"] == "2026-07-02T00:00:00+02:00"


def test_naive_timestamp_is_rejected():
    with pytest.raises(ValueError):
        common.parse_ts("2026-10-25T02:30:00")


def test_integrated_is_derived_and_logged():
    prices, notes = generic_vse.canonicalize(make_day("2026-07-02"), {})
    assert prices[0]["integrated"] == [{"unit": "CHF_kWh", "value": 0.2}]
    assert any("derived integrated" in note for note in notes)


def test_missing_component_added_from_config():
    raw = make_day("2026-07-02")
    tariff = {"add_components": [{"tariff_type": "regional_fees", "unit": "CHF_kWh", "value": 0.0016, "reason": "Kanton ZH"}]}
    prices, notes = generic_vse.canonicalize(raw, tariff)
    assert prices[0]["regional_fees"][0]["value"] == 0.0016
    assert any("Kanton ZH" in note for note in notes)


def test_component_rename():
    raw = make_day("2026-07-02")
    for entry in raw["prices"]:
        entry["dso"] = entry.pop("grid")
    prices, _ = generic_vse.canonicalize(raw, {})
    assert "grid" in prices[0] and "dso" not in prices[0]


def test_latest_has_today_and_tomorrow(org_repo, monkeypatch):
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    serve(monkeypatch, {"2026-07-01": make_day("2026-07-01"), "2026-07-02": make_day("2026-07-02")})
    assert fetch.main() == 0
    latest = json.loads((org_repo / "data/dynamic/grid-d/latest.json").read_text())
    assert len(latest["prices"]) == 192
    assert latest["_meta"]["valid_to"] == "2026-07-03T00:00:00+02:00"
    assert latest["_meta"]["url"].endswith("/muster/main/data/dynamic/grid-d/latest.json")
    assert dynamic_day_issues(Path("latest.json"), latest) == []
    day = org_repo / "data/dynamic/grid-d/vse/2026/2026-07-02.json"
    assert dynamic_day_issues(day, json.loads(day.read_text())) == []


def test_late_run_after_midnight_loses_no_day(org_repo, monkeypatch):
    """Real archive: a run delayed past midnight lost the day before. Backfill recovers it."""
    responses = {d: make_day(d) for d in ("2026-07-01", "2026-07-02", "2026-07-03")}
    serve(monkeypatch, responses)
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    fetch.main()
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-02T23:30:00Z")  # 01:30 on 3 July in Zurich
    assert fetch.main() == 0
    assert (org_repo / "data/dynamic/grid-d/vse/2026/2026-07-03.json").exists()
    assert (org_repo / "data/dynamic/grid-d/vse/2026/2026-07-02.json").exists()


def test_repeated_run_changes_nothing(org_repo, monkeypatch):
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    serve(monkeypatch, {"2026-07-01": make_day("2026-07-01"), "2026-07-02": make_day("2026-07-02")})
    fetch.main()
    files = sorted(p for p in org_repo.rglob("*.json"))
    before = {p: p.read_bytes() for p in files}
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T19:00:00Z")
    fetch.main()
    assert before == {p: p.read_bytes() for p in files}


def test_correction_overwrites_but_partial_does_not(org_repo, monkeypatch):
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    serve(monkeypatch, {"2026-07-02": make_day("2026-07-02")})
    fetch.main()
    path = org_repo / "data/dynamic/grid-d/vse/2026/2026-07-02.json"
    serve(monkeypatch, {"2026-07-02": make_day("2026-07-02", drop_last=8)})
    fetch.main()
    assert len(json.loads(path.read_text())["prices"]) == 96
    serve(monkeypatch, {"2026-07-02": make_day("2026-07-02", grid=0.2)})
    fetch.main()
    assert json.loads(path.read_text())["prices"][0]["grid"][0]["value"] == 0.2


def test_missing_tomorrow_fails_only_after_alert_hour(org_repo, monkeypatch):
    serve(monkeypatch, {"2026-07-01": make_day("2026-07-01")})
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")  # 19:00
    assert fetch.main() == 0
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T20:00:00Z")  # 22:00
    assert fetch.main() == 1


def test_source_without_window_support_gets_plain_request(org_repo, monkeypatch):
    import urllib.error
    calls = []
    def fake(url, timeout=30):
        calls.append(url)
        if "start_timestamp" in url:
            raise urllib.error.HTTPError(url, 400, "bad", {}, None)
        return json.dumps(make_day("2026-07-02", utc=True)).encode()
    monkeypatch.setattr(fetch, "fetch_bytes", fake)
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    fetch.main()
    assert (org_repo / "data/dynamic/grid-d/vse/2026/2026-07-02.json").exists()
    assert any("tariff_name=grid_d" in c and "start_timestamp" not in c for c in calls)


def test_legacy_flat_config_writes_old_paths(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config/source.json").write_text(json.dumps({"slug": "old", "name": "Old", "api_url": "https://a.example/t", "normalizer": "generic_vse"}))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    serve(monkeypatch, {"2026-07-02": make_day("2026-07-02")})
    fetch.main()
    assert (tmp_path / "data/dynamic/vse/2026/2026-07-02.json").exists()


def test_archive_from_before_2_0_is_usable(org_repo, monkeypatch):
    """Files written by the old engine have no _meta."""
    old = org_repo / "data/dynamic/grid-d/vse/2026/2026-07-01.json"
    old.parent.mkdir(parents=True)
    old.write_text(json.dumps({"publication_timestamp": None, "prices": generic_vse.canonicalize(make_day("2026-07-01"), {})[0]}))
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-07-01T17:00:00Z")
    serve(monkeypatch, {"2026-07-02": make_day("2026-07-02")})
    assert fetch.main() == 0
    latest = json.loads((org_repo / "data/dynamic/grid-d/latest.json").read_text())
    assert [d["date"] for d in latest["_meta"]["days"]] == ["2026-07-01", "2026-07-02"]
    assert dynamic_day_issues(old, json.loads(old.read_text())) == []


def test_tariff_starts_on_first_day_and_stops_after_last(org_repo, monkeypatch):
    config = json.loads((org_repo / "config/source.json").read_text())
    config["dynamic"][0].update(valid_from="2027-01-01", valid_to="2027-12-31")
    (org_repo / "config/source.json").write_text(json.dumps(config))
    serve(monkeypatch, {"2027-01-01": make_day("2027-01-01")})
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-12-30T20:00:00Z")
    assert fetch.main() == 0
    assert not (org_repo / "data/dynamic/grid-d").exists()
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-12-31T20:30:00Z")
    assert fetch.main() == 0
    assert (org_repo / "data/dynamic/grid-d/vse/2027/2027-01-01.json").exists()
    assert not (org_repo / "data/dynamic/grid-d/vse/2026").exists()
    monkeypatch.setenv("TARIFF_ETL_NOW", "2028-01-02T20:30:00Z")
    assert fetch.main() == 0
