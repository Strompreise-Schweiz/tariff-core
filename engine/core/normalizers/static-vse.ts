/**
 * Repairs published static tariff files into the binding VSE OpenAPI shape.
 *
 * The FAQ makes the OpenAPI 3.0.3 definition binding, but utilities also follow the illustrative
 * example in NNMV annex 10 or make small deviations. Every change is logged, so the published file
 * states what differs from the source. Unknown fields (such as standardBasegroup or url at EKZ) are
 * kept: OpenAPI objects allow additional properties. No Node APIs.
 */
import { compareText, isObject } from "../json.ts";
import type { Repair, Tariff } from "../types.ts";

/**
 * A source file before repair. Its shape is not known yet: that is what this module fixes. The
 * schema check after the repair decides whether the result is a valid tariff document, so this is
 * the one place that works with untyped data.
 */
type Loose = Record<string, any>;

export interface RepairedDocument {
  dsoName: string | null;
  dsoNumber: number | null;
  /** Repaired, but not yet validated. publish-static.ts assigns the ids. */
  tariffs: Omit<Tariff, "id">[];
}

const UNIT_BY_FIELD: Record<string, string> = {
  base: "CHF/M", energy: "CHF/kWh", power: "CHF/kW/M", reactivePower: "CHF/kVarh",
  refundStorage: "CHF/kWh", municipalityBase: "CHF/M", cantonBase: "CHF/M",
  municipalityEnergy: "CHF/kWh", cantonEnergy: "CHF/kWh",
};
// VSE 1.0.0 wrote Sunday as So, 1.0.1 as Su. Both are read, Su is written.
const WEEKDAYS = new Map([["mo", "Mo"], ["tu", "Tu"], ["we", "We"], ["th", "Th"], ["fr", "Fr"], ["sa", "Sa"], ["so", "Su"], ["su", "Su"]]);
// Ways sources write the end of a day. VSE 1.0.1 writes 23:59.
const END_OF_DAY = new Set(["23:59", "24:00", "23:59:59"]);

class RepairLog {
  private readonly seen = new Map<string, Repair>();

  add(code: string, detail: string): void {
    const entry = this.seen.get(code) ?? { code, detail, count: 0 };
    entry.count += 1;
    this.seen.set(code, entry);
  }

  entries(): Repair[] {
    return [...this.seen.values()];
  }
}

const isNumber = (value: unknown): value is number => typeof value === "number";

function toDsoNumber(value: string | number, log: RepairLog): number | string {
  if (Number.isInteger(value)) return value;
  const digits = String(value).replace(/\D/g, "");
  log.add("dso_number_to_integer", `converted ${JSON.stringify(value)} to an integer`);
  return digits ? Number(digits) : value;
}

function toIsoDate(value: unknown, log: RepairLog): unknown {
  const text = String(value).trim();
  const swiss = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (swiss) {
    log.add("date_to_iso", "converted dd.mm.yyyy (NNMV annex 10) to ISO 8601");
    return `${swiss[3]}-${swiss[2]}-${swiss[1]}`;
  }
  // BKW writes 2026-01-01T00:00:00. Only midnight is dropped: another time would change the meaning.
  const midnight = /^(\d{4}-\d{2}-\d{2})T00:00(:00(\.0+)?)?$/.exec(text);
  if (midnight) {
    log.add("datetime_to_date", "removed the time 00:00:00 from a date");
    return midnight[1];
  }
  return value;
}

/** A whole number written as text, such as "7", becomes a number. Anything else stays for the schema check. */
function toInteger(value: unknown, code: string, field: string, log: RepairLog): unknown {
  if (typeof value !== "string" || !/^\s*\d+\s*$/.test(value)) return value;
  log.add(code, `converted ${field} from text to a number`);
  return Number(value);
}

/**
 * The window of a time-based price in the form of VSE 1.0.1: the end of the day is 23:59, and from
 * is less than to, so a window across midnight becomes two. The whole day is 00:00 to 00:00, or
 * 00:00 to 23:59 as some sources write it: both are valid and kept as published.
 */
function toWindows(rawFrom: unknown, rawTo: unknown, log: RepairLog): [string, string][] {
  const from = String(rawFrom ?? "00:00").trim();
  let to = String(rawTo ?? "00:00").trim();
  if (from === to) {
    if (from !== "00:00") log.add("whole_day_to_0000", "wrote a whole-day window as 00:00 to 00:00 (VSE 1.0.1)");
    return [["00:00", "00:00"]];
  }
  if (END_OF_DAY.has(to) || to === "00:00") {
    if (to !== "23:59") log.add("end_of_day_to_2359", `converted the end of day ${to} to 23:59 (VSE 1.0.1)`);
    to = "23:59";
  }
  if (from > to) {
    log.add("overnight_window_split", "split a window across midnight in two, because VSE 1.0.1 requires from < to");
    return [[from, "23:59"], ["00:00", to]];
  }
  return [[from, to]];
}

function toWeekdays(item: Loose, log: RepairLog): string[] {
  if ("day" in item) {
    const day = String(item.day).trim().toLowerCase();
    log.add("day_to_weekdays", "converted day (NNMV annex 10) to weekdays");
    return day === "*" || day === "ed" || day === "" ? [] : [WEEKDAYS.get(day) ?? day];
  }
  return (item.weekdays ?? []).map((value: string) => {
    const canonical = WEEKDAYS.get(String(value).trim().toLowerCase()) ?? value;
    if (canonical !== value) log.add("weekday_spelling", `converted weekday ${value} to ${canonical}, the OpenAPI enum value`);
    return canonical;
  });
}

function toTimePrice(item: unknown, field: string, log: RepairLog): Loose[] {
  const priceUnit = UNIT_BY_FIELD[field];
  if (isNumber(item)) {
    log.add("number_to_time_price", `wrapped plain number in ${field} as an all-day price`);
    return [{ months: [], weekdays: [], from: "00:00", to: "00:00", price: item, priceUnit }];
  }
  const { day: _day, ...output } = item as Loose;
  output.months = output.months?.length ? output.months : [];
  output.weekdays = toWeekdays(item as Loose, log);
  if (!("priceUnit" in output)) {
    log.add("price_unit_added", `added the missing priceUnit in ${field}`);
    output.priceUnit = priceUnit;
  }
  return toWindows(output.from, output.to, log).map(([from, to]) => ({ ...output, from, to }));
}

/** Accept a list of prices, a plain number and the nested NNMV {"prices": [...]} shape. */
function toTimePrices(value: unknown, field: string, log: RepairLog): Loose[] {
  if (isNumber(value)) return toTimePrice(value, field, log);
  return ((value ?? []) as unknown[]).flatMap((item) => {
    if (isObject(item) && "prices" in item && !("price" in item)) {
      log.add("nested_prices_flattened", "flattened nested prices (NNMV annex 10)");
      return (item.prices as unknown[]).flatMap((inner) => toTimePrice(inner, field, log));
    }
    return toTimePrice(item, field, log);
  });
}

function toSimplePrice(value: unknown, field: string, log: RepairLog): unknown {
  if (!isNumber(value)) return value;
  log.add("number_to_simple_price", `wrapped plain number in ${field} with its unit`);
  return { price: value, priceUnit: UNIT_BY_FIELD[field] };
}

/** Rename a key. The renamed key moves to the end. */
function rename(item: Loose, from: string, to: string): void {
  const { [from]: value, ...rest } = item;
  for (const key of Object.keys(item)) delete item[key];
  Object.assign(item, rest, { [to]: value });
}

function repairRegional(entries: Loose[] | undefined, base: string, energy: string, comment: string, log: RepairLog): Loose[] {
  return (entries ?? []).map((entry) => {
    const item = { ...entry };
    if ("prices" in item && !(energy in item)) {
      log.add("regional_prices_renamed", `renamed prices to ${energy} (NNMV annex 10)`);
      rename(item, "prices", energy);
    }
    if ("comment" in item && !(comment in item)) rename(item, "comment", comment);
    if (energy in item) item[energy] = toTimePrices(item[energy], energy, log);
    if (base in item) item[base] = toSimplePrice(item[base], base, log);
    if ("municipalityNumber" in item) {
      item.municipalityNumber = toInteger(item.municipalityNumber, "municipality_number_to_integer", "municipalityNumber", log);
    }
    return item;
  });
}

function repairPrices(source: Loose, log: RepairLog): Loose {
  const output = { ...source };
  // NNMV annex 10 uses "grid" inside prices of a grid tariff where the OpenAPI has "energy".
  if ("grid" in output && !("energy" in output)) {
    log.add("grid_key_to_energy", "renamed prices.grid to prices.energy (NNMV annex 10)");
    rename(output, "grid", "energy");
  }
  for (const field of ["base", "refundStorage"]) {
    if (field in output) output[field] = toSimplePrice(output[field], field, log);
  }
  for (const field of ["energy", "power", "reactivePower"]) {
    if (!(field in output)) continue;
    if (output[field] === 0) {
      log.add("zero_price_removed", `removed ${field} = 0, which means the tariff has no such price`);
      delete output[field];
    } else {
      output[field] = toTimePrices(output[field], field, log);
    }
  }
  if ("municipalityTaxes" in output) {
    output.municipalityTaxes = repairRegional(output.municipalityTaxes, "municipalityBase", "municipalityEnergy", "municipalityComment", log);
  }
  if ("cantonalTaxes" in output) {
    output.cantonalTaxes = repairRegional(output.cantonalTaxes, "cantonBase", "cantonEnergy", "cantonComment", log);
  }
  return output;
}

/**
 * NNMV annex 10 publishes refunds as tariffType "refund". The OpenAPI expects prices.refundStorage
 * on the matching grid tariff. Returns the tariffs without refunds and the names of unmatched ones.
 */
function foldRefunds(tariffs: Loose[], log: RepairLog): { tariffs: Loose[]; unmatched: string[] } {
  const others = tariffs.filter((t) => t.tariffType !== "refund");
  const unmatched: string[] = [];
  for (const refund of tariffs.filter((t) => t.tariffType === "refund")) {
    const amount = refund.prices?.energy?.[0]?.price;
    const grids = others.filter((t) => t.tariffType === "grid" && t.tariffName === refund.tariffName
      && t.customerVoltageLevel === refund.customerVoltageLevel);
    if (!isNumber(amount) || grids.length === 0) {
      unmatched.push(String(refund.tariffName));
      continue;
    }
    for (const grid of grids) grid.prices.refundStorage = { price: Math.abs(amount), priceUnit: "CHF/kWh" };
    log.add("refund_to_refund_storage", "moved tariffType refund to prices.refundStorage of the grid tariff");
  }
  return { tariffs: others, unmatched };
}

/** The repaired document, the repair log and the problems it cannot repair. */
export function repairStatic(raw: unknown): { document: RepairedDocument; repairs: Repair[]; problems: string[] } {
  const log = new RepairLog();
  const problems: string[] = [];
  const source: Loose = structuredClone(isObject(raw) ? raw : { tariffs: raw });
  const tariffs: Loose[] = Array.isArray(source.tariffs) ? source.tariffs : [];
  const names = [...new Set(tariffs.filter((t) => "dsoName" in t).map((t) => String(t.dsoName)))].sort(compareText);
  const numbers = [...new Set(tariffs.filter((t) => "dsoNumber" in t).map((t) => String(t.dsoNumber)))].sort(compareText);
  let dsoName: string | null = source.dsoName || null;
  let dsoNumber: string | number | null = source.dsoNumber || null;
  if ((!dsoName && names.length) || (!dsoNumber && numbers.length)) {
    log.add("dso_moved_to_top_level", "moved dsoName and dsoNumber from the tariffs to the top level");
    if (names.length > 1 || numbers.length > 1) {
      problems.push(`file mixes several operators: ${names.join(", ")} / ${numbers.join(", ")}`);
    }
    dsoName ||= names[0] ?? null;
    dsoNumber ||= numbers[0] ?? null;
  }
  const repaired = tariffs.map(({ dsoName: _name, dsoNumber: _number, ...item }) => {
    if (typeof item.tariffType === "string" && item.tariffType !== item.tariffType.trim()) {
      log.add("tariff_type_trimmed", "removed whitespace around tariffType");
      item.tariffType = item.tariffType.trim();
    }
    for (const key of ["startDate", "endDate"]) {
      if (key in item) item[key] = toIsoDate(item[key], log);
    }
    if ("customerVoltageLevel" in item) {
      item.customerVoltageLevel = toInteger(item.customerVoltageLevel, "voltage_level_to_integer", "customerVoltageLevel", log);
    }
    item.prices = repairPrices(item.prices ?? {}, log);
    return item;
  });
  const folded = foldRefunds(repaired, log);
  problems.push(...folded.unmatched.map((name) => `refund tariff without a matching grid tariff: ${name}`));
  const document = {
    dsoName,
    dsoNumber: dsoNumber === null ? null : toDsoNumber(dsoNumber, log),
    tariffs: folded.tariffs,
  } as RepairedDocument;
  return { document, repairs: log.entries(), problems };
}
