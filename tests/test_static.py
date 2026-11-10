import json
from copy import deepcopy

import pytest

import publish_static
import suggest_products
from normalizers import static_vse
from validate import coverage_problems, document_issues


def price(value, **extra):
    return {"months": [], "weekdays": [], "from": "00:00", "to": "00:00", "price": value, "priceUnit": "CHF/kWh", **extra}


# Shape as published by EKZ (from a real file), with fictional values.
def ekz_like():
    def t(name, kind, form, level=7, customer="Private up to 100 MWh", **prices):
        return {"tariffName": name, "tariffType": kind, "tariffForm": form, "customerVoltageLevel": level,
                "startDate": "2026-01-01", "endDate": "2026-12-31", "customerType": customer, "comment": "ohne MwSt.",
                "standardBasegroup": True, "url": f"https://example.ch/{name}".replace(" ", "-"), "prices": prices}
    winter = ["Jan", "Feb", "Mar", "Oct", "Nov", "Dec"]
    summer = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"]
    all_days = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
    energy = [{"months": m, "weekdays": all_days, "from": "00:00", "to": "23:59", "price": p, "priceUnit": "CHF/kWh"}
              for m, p in ((winter, 0.13), (summer, 0.09))]
    return {"dsoName": "Muster", "dsoNumber": 10000000001, "tariffs": [
        t("Energie Erneuerbar", "electricity", "multilevel", base={"price": 3.0, "priceUnit": "CHF/M"}, energy=energy),
        t("Energie Dynamisch", "electricity", "dynamic", base={"price": 3.0, "priceUnit": "CHF/M"},
          dynamic={"url": "https://api.example.ch/v1/tariffs?tariff_name=electricity_d"}),
        t("Netz 400ST", "grid", "constant", base={"price": 0.0, "priceUnit": "CHF/M"}, energy=[price(0.1)],
          refundStorage={"price": 0.1, "priceUnit": "CHF/kWh", "url": "https://x.example/r"}),
        t("Netz 400F", "grid", "constant", energy=[price(0.09)]),
        t("Netz 400D", "grid", "dynamic", dynamic={"url": "https://api.example.ch/v1/tariffs?tariff_name=grid_d"}),
        t("Messung", "metering", "constant", customer="All", base={"price": 5.0, "priceUnit": "CHF/M"}),
        t("Abgaben", "regional_fees", "constant", customer="All",
          cantonalTaxes=[{"cantonName": "ZH", "cantonEnergy": [price(0.0016)]}],
          municipalityTaxes=[{"municipalityNumber": 12389, "municipalityName": "Menzingen", "municipalityEnergy": [price(0.0049)]}]),
        t("Abgaben", "regional_fees", "constant", level=5, customer="All",
          cantonalTaxes=[{"cantonName": "ZH", "cantonBase": {"price": 66.67, "priceUnit": "CHF/M"}}]),
    ]}


# Based on the example in NNMV annex 10, including its deviations from the OpenAPI.
def nnmv_like():
    common = {"dsoName": "Groupe E", "dsoNumber": 10063012345, "customerVoltageLevel": 7, "customerType": "bis 100 MWh",
              "startDate": "01.01.2026", "endDate": "31.12.2026"}
    day = lambda f, t, p: {"day": "*", "from": f, "to": t, "price": p}
    return {"tariffs": [
        {**common, "tariffType": "grid", "tariffForm": "constant", "tariffName": "Einheitstarif",
         "prices": {"base": 5.52, "grid": [{"prices": [day("00:00", "00:00", 0.0802)]}], "power": 0}},
        {**common, "tariffType": "refund", "tariffForm": "constant", "tariffName": "Einheitstarif",
         "prices": {"base": 0, "energy": [{"prices": [day("00:00", "00:00", -0.097)]}]}},
        {**common, "tariffType": "grid", "tariffForm": "multilevel", "tariffName": "Doppeltarif",
         "prices": {"base": 5.52, "energy": [{"prices": [day("00:00", "07:00", 0.053), day("07:00", "21:00", 0.082), day("21:00", "00:00", 0.053)]}], "power": 0}},
        {**common, "tariffType": " regional_fees ", "tariffForm": "constant", "tariffName": "Abgaben",
         "prices": {"base": 0, "municipalityTaxes": [{"municipalityNumber": 352, "municipalityName": "Bolligen",
                    "prices": [day("00:00", "00:00", 0.015)], "comment": "Maximum CHF 500 per year"}]}},
    ]}


def build(raw, curation=None, year=2026):
    doc, log, problems = static_vse.normalize(raw)
    assert problems == []
    tariffs, applied, issues = publish_static.apply_curation(doc["tariffs"], curation or {})
    publish_static.assign_ids(tariffs)
    document = {"dsoName": doc["dsoName"], "dsoNumber": doc["dsoNumber"], "tariffs": tariffs,
                "products": (curation or {}).get("products", []),
                "_meta": {"schemaVersion": "1.0", "year": year, "source": [], "repairs": log, "overrides": applied}}
    return document, issues + document_issues(document, year)


def errors(issues):
    return [i for i in issues if i["severity"] == "error"]


def test_real_shape_passes_with_repairs_logged():
    document, issues = build(ekz_like())
    assert errors(issues) == []
    codes = {r["code"] for r in document["_meta"]["repairs"]}
    assert codes == {"end_of_day_to_midnight", "weekday_spelling"}
    energy = document["tariffs"][0]["prices"]["energy"][0]
    assert energy["to"] == "00:00" and "So" in energy["weekdays"]


def test_unknown_source_fields_survive():
    document, _ = build(ekz_like())
    assert document["tariffs"][0]["standardBasegroup"] is True
    assert document["tariffs"][2]["prices"]["refundStorage"]["url"] == "https://x.example/r"


def test_nnmv_example_is_repaired():
    document, issues = build(nnmv_like())
    assert errors(issues) == []
    assert document["dsoNumber"] == 10063012345
    grid = document["tariffs"][0]
    assert grid["startDate"] == "2026-01-01"
    assert grid["prices"]["base"] == {"price": 5.52, "priceUnit": "CHF/M"}
    assert grid["prices"]["energy"][0]["price"] == 0.0802
    assert "power" not in grid["prices"]
    assert grid["prices"]["refundStorage"]["price"] == 0.097
    assert not [t for t in document["tariffs"] if t["tariffType"] == "refund"]
    fee = next(t for t in document["tariffs"] if t["tariffType"] == "regional_fees")
    assert fee["prices"]["municipalityTaxes"][0]["municipalityEnergy"][0]["price"] == 0.015
    assert fee["prices"]["municipalityTaxes"][0]["municipalityComment"].startswith("Maximum")


def uznach_like():
    raw = ekz_like()
    for tariff in raw["tariffs"]:
        tariff["customerVoltageLevel"] = 0
        tariff["endDate"] = "2099-12-31"
    return raw


def test_defects_from_real_utility_block_publication():
    """Defects Philipp found at EW Uznach: voltage level 0 and end date 2099."""
    _, issues = build(uznach_like())
    assert any(i["code"] == "schema" and "customerVoltageLevel" in i["path"] for i in issues)


def test_curation_fixes_defects_and_records_reason():
    curation = {"overrides": [{"match": {"tariffType": kind}, "set": {"customerVoltageLevel": 7, "endDate": "2026-12-31"}, "reason": "Price sheet 2026"}
                              for kind in ("electricity", "grid", "metering", "regional_fees")],
                "acceptIssues": []}
    document, issues = build(uznach_like(), curation)
    remaining = [i for i in errors(issues)]
    assert remaining == []
    assert document["_meta"]["overrides"][0]["reason"] == "Price sheet 2026"


def test_stale_curation_rule_is_an_error():
    _, issues = build(ekz_like(), {"overrides": [{"match": {"tariffName": "does not exist"}, "set": {"comment": "x"}, "reason": "r"}]})
    assert any(i["code"] == "curation_no_match" for i in issues)


def test_dotted_override_replaces_prices():
    curation = {"overrides": [{"match": {"tariffName": "Netz 400F"}, "set": {"prices.energy": [price(0.2)]}, "reason": "JSON differs from the PDF"}]}
    document, _ = build(ekz_like(), curation)
    assert next(t for t in document["tariffs"] if t["tariffName"] == "Netz 400F")["prices"]["energy"][0]["price"] == 0.2


def single(form, **prices):
    return {"tariffs": [{"tariffName": "T", "tariffType": "grid", "tariffForm": form, "customerVoltageLevel": 7,
                         "startDate": "2026-01-01", "endDate": "2026-12-31", "customerType": "A", "prices": prices}],
            "dsoName": "M", "dsoNumber": 10000000001}


@pytest.mark.parametrize("form,prices,code", [
    ("constant", {"energy": [price(0.1), price(0.2)]}, "constant_with_several_prices"),
    ("constant", {"energy": [{**price(0.1), "from": "07:00", "to": "20:00"}]}, "constant_with_time_window"),
    ("multilevel", {"energy": [{**price(0.1), "from": "07:00", "to": "20:00"}, {**price(0.2), "from": "21:00", "to": "07:00"}]}, "energy_time_gap"),
    ("multilevel", {"energy": [{**price(0.1), "from": "07:00", "to": "21:00"}, {**price(0.2), "from": "20:00", "to": "07:00"}]}, "energy_time_overlap"),
    ("constant", {"energy": [price(28.8)]}, "implausible_energy_price"),
])
def test_form_rules(form, prices, code):
    _, issues = build(single(form, **prices))
    assert code in {i["code"] for i in errors(issues)}


def test_dynamic_needs_url():
    _, issues = build(single("dynamic", base={"price": 1, "priceUnit": "CHF/M"}))
    assert any(i["code"] == "schema" for i in issues)


def test_overnight_window_covers_day():
    entries = [{**price(0.1), "from": "07:00", "to": "21:00"}, {**price(0.05), "from": "21:00", "to": "07:00"}]
    assert coverage_problems(entries) == ([], [])


def test_weekend_low_tariff_covers_week():
    weekday = ["Mo", "Tu", "We", "Th", "Fr"]
    entries = [{**price(0.1), "weekdays": weekday, "from": "07:00", "to": "20:00"},
               {**price(0.05), "weekdays": weekday, "from": "20:00", "to": "07:00"},
               {**price(0.05), "weekdays": ["Sa", "So"]}]
    assert coverage_problems(entries) == ([], [])


def test_duplicate_names_get_distinct_ids():
    raw = ekz_like()
    raw["tariffs"].append({**deepcopy(raw["tariffs"][-1]), "customerType": "Above 500 MWh"})
    document, issues = build(raw)
    ids = [t["id"] for t in document["tariffs"]]
    assert len(ids) == len(set(ids))
    assert errors(issues) == []


def test_ids_are_stable():
    assert [t["id"] for t in build(ekz_like())[0]["tariffs"]] == [t["id"] for t in build(ekz_like())[0]["tariffs"]]


def test_suggestions_pair_static_and_dynamic_correctly():
    document, _ = build(ekz_like())
    names = {p["name"] for p in suggest_products.suggest(document)}
    assert names == {"Energie Erneuerbar + Netz 400ST", "Energie Erneuerbar + Netz 400F", "Energie Dynamisch + Netz 400D"}


def test_product_rules():
    document, _ = build(ekz_like())
    ids = {t["tariffName"]: t["id"] for t in document["tariffs"] if t["customerVoltageLevel"] == 7}
    product = {"id": "p", "name": "P", "status": "verified",
               "components": {"electricity": ids["Netz 400ST"], "grid": "missing"}}
    document["products"] = [product]
    codes = {i["code"] for i in errors(document_issues(document, 2026))}
    assert {"product_wrong_slot", "product_unknown_tariff", "verified_without_source"} <= codes


def repo(tmp_path, monkeypatch, source):
    (tmp_path / "config").mkdir()
    (tmp_path / "curation").mkdir()
    (tmp_path / "curation/source.json").write_text(json.dumps(source))
    (tmp_path / "config/source.json").write_text(json.dumps({
        "slug": "muster", "name": "Muster", "vse_id": "CH10000000001", "dynamic": [],
        "static": {"sources": [{"name": "main", "file": "curation/source.json"}]}}))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-11-02T10:00:00Z")
    return tmp_path


def test_multi_year_source_is_split_by_year(tmp_path, monkeypatch):
    """EKZ publishes 2026 and 2027 in one file."""
    raw = ekz_like()
    next_year = deepcopy(raw["tariffs"][0])
    next_year.update(startDate="2027-01-01", endDate="2027-12-31")
    raw["tariffs"].append(next_year)
    root = repo(tmp_path, monkeypatch, raw)
    assert publish_static.publish(root) == 0
    assert len(json.loads((root / "data/tariffs/2027.json").read_text())["tariffs"]) == 1
    assert (root / "data/tariffs/current.json").read_bytes() == (root / "data/tariffs/2026.json").read_bytes()
    index = json.loads((root / "data/index.json").read_text())
    assert set(index["static"]["years"]) == {"2026", "2027"}


def test_failed_year_keeps_previous_file_online(tmp_path, monkeypatch):
    root = repo(tmp_path, monkeypatch, ekz_like())
    assert publish_static.publish(root) == 0
    good = (root / "data/tariffs/2026.json").read_bytes()
    (root / "curation/source.json").write_text(json.dumps(uznach_like()))
    assert publish_static.publish(root) == 1
    assert (root / "data/tariffs/2026.json").read_bytes() == good
    assert not json.loads((root / "data/tariffs/2026.report.json").read_text())["published"]


def test_rerun_writes_nothing(tmp_path, monkeypatch):
    root = repo(tmp_path, monkeypatch, ekz_like())
    publish_static.publish(root)
    first = (root / "data/tariffs/2026.json").read_bytes()
    monkeypatch.setenv("TARIFF_ETL_NOW", "2026-11-03T10:00:00Z")
    publish_static.publish(root)
    assert (root / "data/tariffs/2026.json").read_bytes() == first


def ekz_2027_like():
    """Shape of the EKZ 2027 data: four grid clusters, no voltage level on electricity, metering and fees."""
    raw = ekz_like()
    tariffs = [t for t in raw["tariffs"] if t["tariffName"] in ("Energie Dynamisch", "Messung") or (t["tariffName"] == "Abgaben" and t["customerVoltageLevel"] == 7)]
    for tariff in tariffs:
        del tariff["customerVoltageLevel"]
    template = next(t for t in raw["tariffs"] if t["tariffName"] == "Netz 400D")
    for cluster in range(1, 5):
        tariffs.append({**deepcopy(template), "tariffName": f"Netz 400D Cluster {cluster}",
                        "prices": {"dynamic": {"url": f"https://api.example.ch/v1/tariffs?tariff_name=grid_400D{cluster}_inclFees"}}})
    raw["tariffs"] = tariffs
    return raw


def test_missing_voltage_level_warns_and_is_not_invented():
    document, issues = build(ekz_2027_like())
    assert errors(issues) == []
    assert "missing_voltage_level" in {i["code"] for i in issues}
    energy = next(t for t in document["tariffs"] if t["tariffType"] == "electricity")
    assert "customerVoltageLevel" not in energy and energy["id"] == "electricity-energie-dynamisch"


def test_each_cluster_becomes_its_own_product():
    document, _ = build(ekz_2027_like())
    products = suggest_products.suggest(document)
    assert {p["components"]["grid"] for p in products} == {f"grid-netz-400d-cluster-{n}-ne7" for n in range(1, 5)}
    assert {p["components"]["electricity"] for p in products} == {"electricity-energie-dynamisch"}


def test_product_selection_is_valid():
    document, _ = build(ekz_2027_like())
    product = suggest_products.suggest(document)[0]
    product["selection"] = {"kind": "grid-cluster", "value": "1", "howToFind": "Shown in myEKZ"}
    document["products"] = [product]
    assert errors(document_issues(document, 2026)) == []
