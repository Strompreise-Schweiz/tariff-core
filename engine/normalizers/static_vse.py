"""Repairs published static tariff files into the binding VSE OpenAPI shape.

The FAQ makes the OpenAPI 3.0.3 definition binding, but utilities also follow
the illustrative example in NNMV annex 10 or make small deviations. Every
change is logged, so the published file states what differs from the source.
Unknown fields (such as standardBasegroup or url at EKZ) are kept: OpenAPI
objects allow additional properties.
"""
import re
from copy import deepcopy

UNIT_BY_FIELD = {"base": "CHF/M", "energy": "CHF/kWh", "power": "CHF/kW/M", "reactivePower": "CHF/kVarh",
                 "refundStorage": "CHF/kWh", "municipalityBase": "CHF/M", "cantonBase": "CHF/M",
                 "municipalityEnergy": "CHF/kWh", "cantonEnergy": "CHF/kWh"}
WEEKDAYS = {"mo": "Mo", "tu": "Tu", "we": "We", "th": "Th", "fr": "Fr", "sa": "Sa", "so": "So", "su": "So"}


class Log:
    def __init__(self):
        self.seen = {}

    def add(self, code: str, detail: str) -> None:
        entry = self.seen.setdefault(code, {"code": code, "detail": detail, "count": 0})
        entry["count"] += 1

    def entries(self) -> list:
        return list(self.seen.values())


def _dso_number(value, log: Log):
    if isinstance(value, int):
        return value
    digits = re.sub(r"\D", "", str(value))
    log.add("dso_number_to_integer", f"converted {value!r} to an 11-digit integer")
    return int(digits) if digits else value


def _date(value, log: Log):
    match = re.fullmatch(r"(\d{2})\.(\d{2})\.(\d{4})", str(value).strip())
    if match:
        log.add("date_to_iso", "converted dd.mm.yyyy (NNMV annex 10) to ISO 8601")
        return f"{match[3]}-{match[2]}-{match[1]}"
    return value


def _time(value, log: Log):
    text = str(value).strip()
    if text in ("23:59", "24:00", "23:59:59"):
        log.add("end_of_day_to_midnight", f"converted {text} to 00:00: the VSE FAQ ends a day at 00:00")
        return "00:00"
    return text


def _weekdays(item: dict, log: Log) -> list:
    if "day" in item:
        day = str(item["day"]).strip().lower()
        log.add("day_to_weekdays", "converted day (NNMV annex 10) to weekdays")
        return [] if day in ("*", "ed", "") else [WEEKDAYS.get(day, day)]
    result = []
    for value in item.get("weekdays") or []:
        canonical = WEEKDAYS.get(str(value).strip().lower(), value)
        if canonical != value:
            log.add("weekday_spelling", f"converted weekday {value} to {canonical}, the OpenAPI enum value")
        result.append(canonical)
    return result


def _time_price(item, field: str, log: Log) -> dict:
    unit = UNIT_BY_FIELD[field]
    if isinstance(item, (int, float)):
        log.add("number_to_time_price", f"wrapped plain number in {field} as an all-day price")
        return {"months": [], "weekdays": [], "from": "00:00", "to": "00:00", "price": item, "priceUnit": unit}
    output = {k: v for k, v in item.items() if k != "day"}
    output["months"] = item.get("months") or []
    output["weekdays"] = _weekdays(item, log)
    output["from"] = _time(item.get("from", "00:00"), log)
    output["to"] = _time(item.get("to", "00:00"), log)
    if "priceUnit" not in output:
        log.add("price_unit_added", f"added the missing priceUnit in {field}")
        output["priceUnit"] = unit
    return output


def _time_prices(value, field: str, log: Log) -> list:
    """Accept a list of prices, a plain number and the nested NNMV {"prices": [...]} shape."""
    if isinstance(value, (int, float)):
        return [_time_price(value, field, log)]
    result = []
    for item in value or []:
        if isinstance(item, dict) and "prices" in item and "price" not in item:
            log.add("nested_prices_flattened", "flattened nested prices (NNMV annex 10)")
            result += [_time_price(inner, field, log) for inner in item["prices"]]
        else:
            result.append(_time_price(item, field, log))
    return result


def _simple(value, field: str, log: Log) -> dict:
    if isinstance(value, (int, float)):
        log.add("number_to_simple_price", f"wrapped plain number in {field} with its unit")
        return {"price": value, "priceUnit": UNIT_BY_FIELD[field]}
    return value


def _regional(entries, base_key: str, energy_key: str, comment_key: str, log: Log) -> list:
    output = []
    for entry in entries or []:
        item = dict(entry)
        if "prices" in item and energy_key not in item:
            log.add("regional_prices_renamed", f"renamed prices to {energy_key} (NNMV annex 10)")
            item[energy_key] = item.pop("prices")
        if "comment" in item and comment_key not in item:
            item[comment_key] = item.pop("comment")
        if energy_key in item:
            item[energy_key] = _time_prices(item[energy_key], energy_key, log)
        if base_key in item:
            item[base_key] = _simple(item[base_key], base_key, log)
        output.append(item)
    return output


def _prices(prices: dict, log: Log) -> dict:
    output = dict(prices)
    # NNMV annex 10 uses "grid" inside prices of a grid tariff where the OpenAPI has "energy".
    if "grid" in output and "energy" not in output:
        log.add("grid_key_to_energy", "renamed prices.grid to prices.energy (NNMV annex 10)")
        output["energy"] = output.pop("grid")
    if "base" in output:
        output["base"] = _simple(output["base"], "base", log)
    if "refundStorage" in output:
        output["refundStorage"] = _simple(output["refundStorage"], "refundStorage", log)
    for field in ("energy", "power", "reactivePower"):
        if field in output:
            if output[field] == 0:
                log.add("zero_price_removed", f"removed {field} = 0, which means the tariff has no such price")
                del output[field]
            else:
                output[field] = _time_prices(output[field], field, log)
    if "municipalityTaxes" in output:
        output["municipalityTaxes"] = _regional(output["municipalityTaxes"], "municipalityBase",
                                                "municipalityEnergy", "municipalityComment", log)
    if "cantonalTaxes" in output:
        output["cantonalTaxes"] = _regional(output["cantonalTaxes"], "cantonBase", "cantonEnergy", "cantonComment", log)
    return output


def _fold_refunds(tariffs: list, log: Log) -> tuple[list, list]:
    """NNMV annex 10 publishes refunds as tariffType "refund". The OpenAPI
    expects prices.refundStorage on the matching grid tariff."""
    kept, unmatched = [], []
    refunds = [t for t in tariffs if t.get("tariffType") == "refund"]
    others = [t for t in tariffs if t.get("tariffType") != "refund"]
    for refund in refunds:
        energy = refund.get("prices", {}).get("energy") or []
        value = abs(energy[0]["price"]) if energy else None
        matches = [t for t in others if t.get("tariffType") == "grid"
                   and t.get("tariffName") == refund.get("tariffName")
                   and t.get("customerVoltageLevel") == refund.get("customerVoltageLevel")]
        if value is None or not matches:
            unmatched.append(refund.get("tariffName"))
            continue
        for match in matches:
            match["prices"]["refundStorage"] = {"price": value, "priceUnit": "CHF/kWh"}
        log.add("refund_to_refund_storage", "moved tariffType refund to prices.refundStorage of the grid tariff")
    kept.extend(others)
    return kept, unmatched


def normalize(raw) -> tuple[dict, list, list]:
    """Returns the repaired document, the repair log and problems it cannot repair."""
    log = Log()
    problems = []
    source = deepcopy(raw)
    tariffs = source.get("tariffs", source if isinstance(source, list) else [])
    names = {t["dsoName"] for t in tariffs if "dsoName" in t}
    numbers = {str(t["dsoNumber"]) for t in tariffs if "dsoNumber" in t}
    dso_name = source.get("dsoName") if isinstance(source, dict) else None
    dso_number = source.get("dsoNumber") if isinstance(source, dict) else None
    if (not dso_name and names) or (not dso_number and numbers):
        log.add("dso_moved_to_top_level", "moved dsoName and dsoNumber from the tariffs to the top level")
        if len(names) > 1 or len(numbers) > 1:
            problems.append(f"file mixes several operators: {sorted(names)} {sorted(numbers)}")
        dso_name = dso_name or (sorted(names)[0] if names else None)
        dso_number = dso_number or (sorted(numbers)[0] if numbers else None)
    repaired = []
    for tariff in tariffs:
        item = {k: v for k, v in tariff.items() if k not in ("dsoName", "dsoNumber")}
        if isinstance(item.get("tariffType"), str):
            stripped = item["tariffType"].strip()
            if stripped != item["tariffType"]:
                log.add("tariff_type_trimmed", "removed whitespace around tariffType")
            item["tariffType"] = stripped
        for key in ("startDate", "endDate"):
            if key in item:
                item[key] = _date(item[key], log)
        item["prices"] = _prices(item.get("prices", {}), log)
        repaired.append(item)
    repaired, unmatched = _fold_refunds(repaired, log)
    problems += [f"refund tariff without a matching grid tariff: {name}" for name in unmatched]
    document = {"dsoName": dso_name, "dsoNumber": _dso_number(dso_number, log) if dso_number is not None else None,
                "tariffs": repaired}
    return document, log.entries(), problems
