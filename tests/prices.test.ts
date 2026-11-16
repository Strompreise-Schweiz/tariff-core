import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { checkDay, readResponse, splitByDay, toQuarterHours, type ApiResponse } from "../engine/core/price-day.ts";
import { productTotal } from "../engine/core/product-year.ts";
import { priceDayIssues, schemaIssues } from "../engine/core/rules.ts";
import { dayBounds, formatTimestamp, formatUtcZ, inUtc, inZurich, parseTimestamp } from "../engine/core/time.ts";
import type { PriceDay, Tariff } from "../engine/core/types.ts";
import { build } from "../engine/build.ts";
import { main as fetchMain } from "../engine/fetch.ts";
import { http, HttpError } from "../engine/lib/http.ts";
import { ekzLike, price, readJsonFile, setNow, tempDir, writeJsonFile, type Obj } from "./helpers.ts";

const read = (raw: Obj, source: Obj = {}) => readResponse(raw as ApiResponse, source);

interface DayOptions {
  utcStamps?: boolean;
  dropLast?: number;
  grid?: number;
  minutes?: number;
  withoutKwh?: boolean;
}

function makeDay(day: string, { utcStamps = false, dropLast = 0, grid = 0.11, minutes = 15, withoutKwh = false }: DayOptions = {}): Obj {
  const [start, end] = dayBounds(day);
  const stamp = (ms: number) => (utcStamps ? formatUtcZ(ms) : formatTimestamp(inZurich(ms)));
  const prices: Obj[] = [];
  for (let moment = start.ms; moment < end.ms; moment += minutes * 60_000) {
    const values = withoutKwh ? [{ unit: "CHF_m", value: 5.0 }] : [{ unit: "CHF_kWh", value: grid }, { unit: "CHF_m", value: 5.0 }];
    prices.push({ start_timestamp: stamp(moment), end_timestamp: stamp(moment + minutes * 60_000), grid: values });
  }
  return { publication_timestamp: `${day}T10:00:00Z`, prices: prices.slice(0, prices.length - dropLast) };
}

const SOURCE_URL = "https://api.example.ch/v1/tariffs?tariff_name=grid_d";

function orgRepo(): string {
  const root = tempDir();
  writeJsonFile(path.join(root, "config/source.json"), {
    slug: "muster", name: "Muster AG", vse_id: "CH10000000001", website: "https://example.ch",
    tariffs: [], prices: [{ id: "grid-d", name: "Dyn", url: SOURCE_URL }],
  });
  return root;
}

/** Serve days by the start_timestamp in the request. */
function serve(responses: Record<string, Obj>): void {
  http.fetchBytes = async (url: string) => {
    for (const [day, payload] of Object.entries(responses)) {
      if (url.includes(formatUtcZ(dayBounds(day)[0].ms).replaceAll(":", "%3A"))) return Buffer.from(JSON.stringify(payload));
    }
    return Buffer.from(JSON.stringify({ publication_timestamp: null, prices: [] }));
  };
}

const fetchPrices = (root: string) => fetchMain(["--prices"], root);
const stored = (root: string, day: string) => path.join(root, "data/sources/days/grid-d", day.slice(0, 4), `${day}.json`);
// The dynamic grid tariff of the yearly file of productRepo uses the price source grid-d.
const GRID = "grid-netz-400d-ne7";
const published = (root: string, day: string) => path.join(root, "data/tariffs", day.slice(0, 4), GRID, `${day}.json`);

// ---------------------------------------------------------------------------------------------
// Reading and checking a day

for (const [day, hours, count] of [["2026-03-29", 23, 92], ["2026-07-01", 24, 96], ["2026-10-25", 25, 100]] as const) {
  test(`day length follows the clock change on ${day}`, () => {
    const { prices } = read(makeDay(day));
    const check = checkDay(day, prices);
    assert.ok(check.complete, check.issues.join("; "));
    assert.deepEqual([check.day_length_hours, check.interval_count], [hours, count]);
  });
}

test("Swiss time conversions around the clock changes", () => {
  const zurich = (value: string) => formatTimestamp(inZurich(parseTimestamp(value).ms));
  assert.equal(formatTimestamp(dayBounds("2026-03-29")[1]), "2026-03-30T00:00:00+02:00");
  assert.equal(zurich("2026-03-29T00:59:00Z"), "2026-03-29T01:59:00+01:00");
  assert.equal(zurich("2026-03-29T01:00:00Z"), "2026-03-29T03:00:00+02:00");
  // The hour from 02:00 to 03:00 exists twice on 2026-10-25.
  assert.equal(zurich("2026-10-25T00:30:00Z"), "2026-10-25T02:30:00+02:00");
  assert.equal(zurich("2026-10-25T01:30:00Z"), "2026-10-25T02:30:00+01:00");
  assert.equal(formatTimestamp(inUtc(parseTimestamp("2026-07-02T00:00:00+02:00").ms)), "2026-07-01T22:00:00+00:00");
  assert.equal(formatTimestamp(parseTimestamp("2026-07-02T00:00:00.5+0200")), "2026-07-02T00:00:00+02:00");
  assert.throws(() => parseTimestamp("2026-02-30T00:00:00Z"), /invalid timestamp/);
});

test("the real bug of 96 intervals on a 25 hour day is flagged", () => {
  // EKZ and BKW both delivered 96 intervals for 2026-10-25, ending one hour early.
  const { prices } = read(makeDay("2026-10-25", { dropLast: 4 }));
  const check = checkDay("2026-10-25", prices);
  assert.ok(!check.complete);
  assert.ok(check.issues[0].includes("ends at 2026-10-25T23:00:00+01:00"));
});

test("a day with only the monthly base is not complete", () => {
  // EKZ answered for 2026-11-14 with 96 intervals that had only CHF_m, before publishing the day.
  const { prices } = read(makeDay("2026-11-14", { withoutKwh: true }));
  const check = checkDay("2026-11-14", prices);
  assert.ok(!check.complete);
  assert.deepEqual(check.issues, ["96 of 96 intervals have no price per kWh"]);
});

test("a UTC source lands on the Swiss day", () => {
  const { prices } = read(makeDay("2026-07-02", { utcStamps: true }));
  assert.deepEqual([...splitByDay(prices).keys()], ["2026-07-02"]);
  assert.equal(prices[0].start_timestamp, "2026-07-02T00:00:00+02:00");
});

test("a naive timestamp is rejected", () => {
  assert.throws(() => parseTimestamp("2026-10-25T02:30:00"), /without UTC offset/);
});

test("a component and a unit are renamed and logged", () => {
  const raw = makeDay("2026-07-02");
  for (const entry of raw.prices) {
    entry.dso = entry.grid.map((value: Obj) => ({ ...value, unit: value.unit === "CHF_kWh" ? "CHF/kWh" : value.unit }));
    delete entry.grid;
  }
  const { prices, notes } = read(raw);
  assert.deepEqual(prices[0].grid, [{ unit: "CHF_kWh", value: 0.11 }, { unit: "CHF_m", value: 5 }]);
  assert.deepEqual(notes, ["renamed component dso to grid", "wrote unit CHF/kWh as CHF_kWh"]);
});

test("hourly values become four quarter hours", () => {
  const { prices } = read(makeDay("2026-10-25", { minutes: 60 }));
  const quarters = toQuarterHours(prices);
  assert.equal(quarters.length, 100);
  assert.ok(checkDay("2026-10-25", quarters).complete);
  assert.deepEqual(quarters.slice(0, 4).map((q) => q.grid), Array(4).fill(prices[0].grid));
});

// ---------------------------------------------------------------------------------------------
// Fetching

test("a fetch stores the responses unchanged, and the build publishes them under the tariff", async () => {
  const root = productRepo();
  setNow("2026-07-01T17:00:00Z");
  const day = makeDay("2026-07-02");
  serve({ "2026-07-01": makeDay("2026-07-01"), "2026-07-02": day });
  assert.equal(await fetchPrices(root), 0);
  assert.equal(readFileSync(stored(root, "2026-07-02"), "utf8").trim(), JSON.stringify(day));
  assert.ok(!existsSync(path.join(root, "data/tariffs")), "fetch writes only data/sources");
  assert.equal(build(root), 0);
  const latest = readJsonFile(path.join(root, `data/tariffs/current/${GRID}.json`));
  assert.equal(latest.prices.length, 192);
  assert.equal(latest._meta.valid_to, "2026-07-03T00:00:00+02:00");
  assert.deepEqual(priceDayIssues("latest.json", latest as PriceDay), []);
  const doc = readJsonFile(published(root, "2026-07-02"));
  assert.deepEqual(priceDayIssues("2026-07-02.json", doc as PriceDay), []);
  assert.equal(doc._meta.source.file, "sources/days/grid-d/2026/2026-07-02.json");
  assert.equal(doc._meta.tariff, GRID);
  assert.equal(doc._meta.tariffs, "tariffs/2026.json");
});

test("a late run after midnight loses no day", async () => {
  // Real archive: a run delayed past midnight lost the day before. Backfill recovers it.
  const root = orgRepo();
  serve(Object.fromEntries(["2026-07-01", "2026-07-02", "2026-07-03"].map((d) => [d, makeDay(d)])));
  setNow("2026-07-01T17:00:00Z");
  await fetchPrices(root);
  setNow("2026-07-02T23:30:00Z"); // 01:30 on 3 July in Zurich
  assert.equal(await fetchPrices(root), 0);
  assert.ok(existsSync(stored(root, "2026-07-03")));
  assert.ok(existsSync(stored(root, "2026-07-02")));
});

function snapshot(root: string): Map<string, Buffer> {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(e.parentPath, e.name));
  return new Map(files.sort().map((file) => [file, readFileSync(file)]));
}

test("a repeated fetch and build changes nothing", async () => {
  const root = orgRepo();
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-01": makeDay("2026-07-01"), "2026-07-02": makeDay("2026-07-02") });
  await fetchPrices(root);
  build(root);
  const before = snapshot(root);
  setNow("2026-07-01T19:00:00Z");
  await fetchPrices(root);
  build(root);
  assert.deepEqual(snapshot(root), before);
});

test("a correction overwrites, a partial response does not", async () => {
  const root = orgRepo();
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-02": makeDay("2026-07-02") });
  await fetchPrices(root);
  serve({ "2026-07-02": makeDay("2026-07-02", { dropLast: 8 }) });
  await fetchPrices(root);
  assert.equal(readJsonFile(stored(root, "2026-07-02")).prices.length, 96);
  serve({ "2026-07-02": makeDay("2026-07-02", { grid: 0.2 }) });
  await fetchPrices(root);
  assert.equal(readJsonFile(stored(root, "2026-07-02")).prices[0].grid[0].value, 0.2);
});

test("a missing or incomplete tomorrow fails only after the alert hour", async () => {
  const root = orgRepo();
  serve({ "2026-07-01": makeDay("2026-07-01"), "2026-07-02": makeDay("2026-07-02", { withoutKwh: true }) });
  setNow("2026-07-01T17:00:00Z"); // 19:00
  assert.equal(await fetchPrices(root), 0);
  setNow("2026-07-01T20:00:00Z"); // 22:00
  assert.equal(await fetchPrices(root), 1);
});

test("a source without window support gets a plain request", async () => {
  const root = orgRepo();
  const calls: string[] = [];
  http.fetchBytes = async (url: string) => {
    calls.push(url);
    if (url.includes("start_timestamp")) throw new HttpError(url, 400, "Bad Request");
    return Buffer.from(JSON.stringify(makeDay("2026-07-02", { utcStamps: true })));
  };
  setNow("2026-07-01T17:00:00Z");
  await fetchPrices(root);
  assert.ok(existsSync(stored(root, "2026-07-02")));
  assert.ok(calls.some((c) => c.includes("tariff_name=grid_d") && !c.includes("start_timestamp")));
});

test("a source starts on its first day and stops after its last", async () => {
  const root = orgRepo();
  const config = readJsonFile(path.join(root, "config/source.json"));
  Object.assign(config.prices[0], { valid_from: "2027-01-01", valid_to: "2027-12-31" });
  writeJsonFile(path.join(root, "config/source.json"), config);
  serve({ "2027-01-01": makeDay("2027-01-01") });
  setNow("2026-12-30T20:00:00Z");
  assert.equal(await fetchPrices(root), 0);
  assert.ok(!existsSync(path.join(root, "data/sources/days/grid-d")));
  setNow("2026-12-31T20:30:00Z");
  assert.equal(await fetchPrices(root), 0);
  assert.ok(existsSync(stored(root, "2027-01-01")));
  assert.ok(!existsSync(path.join(root, "data/sources/days/grid-d/2026")));
  setNow("2028-01-02T20:30:00Z");
  assert.equal(await fetchPrices(root), 0);
});

// ---------------------------------------------------------------------------------------------
// Building: corrections and products

test("a correction from curation replaces a component and is recorded", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  writeJsonFile(stored(root, "2026-07-02"), makeDay("2026-07-02"));
  writeJsonFile(path.join(root, "curation/2026.json"), {
    year: 2026,
    prices: [{ prices: "grid-d", from: "2026-07-01", set: { metering: [{ unit: "CHF_m", value: 6.9 }] }, reason: "Metering from the price sheet" }],
  });
  assert.equal(build(root), 0);
  const doc = readJsonFile(published(root, "2026-07-02"));
  assert.deepEqual(doc.prices[0].metering, [{ unit: "CHF_m", value: 6.9 }]);
  assert.deepEqual(doc._meta.corrections, [{ set: ["metering"], reason: "Metering from the price sheet" }]);
  // The stored response stays as the utility sent it.
  assert.ok(!("metering" in readJsonFile(stored(root, "2026-07-02")).prices[0]));
});

test("a correction for an unknown price source blocks the year", () => {
  const root = productRepo();
  writeJsonFile(path.join(root, "curation/2026.json"), {
    year: 2026, prices: [{ prices: "nope", set: { grid: [] }, reason: "x" }],
  });
  assert.ok(build(root) > 0);
  const year = readJsonFile(path.join(root, "data/checks.json")).tariffs[0];
  assert.equal(year.published, false);
  assert.ok(year.issues.some((i: Obj) => i.code === "curation_unknown_prices"));
});

/** A utility with a yearly file whose dynamic grid tariff uses the price source grid-d. */
function productRepo(): string {
  const root = orgRepo();
  const config = readJsonFile(path.join(root, "config/source.json"));
  config.tariffs = [{ name: "muster", file: "curation/2026.source.json" }];
  writeJsonFile(path.join(root, "config/source.json"), config);
  writeJsonFile(path.join(root, "curation/2026.source.json"), ekzLike());
  return root;
}

const PRODUCT = {
  id: "erneuerbar-400d", name: "Energie Erneuerbar + Netz 400D", status: "suggested",
  components: { electricity: "electricity-energie-erneuerbar-ne7", grid: "grid-netz-400d-ne7", metering: "metering-messung-ne7" },
};

test("a dynamic tariff points to the day prices of this project", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  assert.equal(build(root), 0);
  const grid = readJsonFile(path.join(root, "data/tariffs/2026.json")).tariffs.find((t: Obj) => t.id === "grid-netz-400d-ne7");
  assert.deepEqual(grid.prices.dynamic, { url: `https://data.strompreise-schweiz.ch/muster/tariffs/current/${GRID}.json`, sourceUrl: SOURCE_URL });
  // The dynamic electricity tariff has no price source: it keeps its url and is reported.
  const checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.ok(checks.tariffs[0].issues.some((i: Obj) => i.code === "dynamic_without_prices" && i.tariff === "electricity-energie-dynamisch-ne7"));
});

test("a product day has every component per quarter hour", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  writeJsonFile(stored(root, "2026-07-02"), makeDay("2026-07-02", { minutes: 60 }));
  writeJsonFile(path.join(root, "curation/2026.json"), { year: 2026, products: [PRODUCT] });
  assert.equal(build(root), 0);
  const file = path.join(root, "data/products/erneuerbar-400d/2026/2026-07-02.json");
  const doc = readJsonFile(file);
  assert.deepEqual(priceDayIssues("2026-07-02.json", doc as PriceDay), []);
  assert.equal(doc.prices.length, 96);
  assert.deepEqual(doc.prices[0], {
    start_timestamp: "2026-07-02T00:00:00+02:00",
    end_timestamp: "2026-07-02T00:15:00+02:00",
    // From the yearly file: base and summer price of the multilevel electricity tariff.
    electricity: [{ unit: "CHF_m", value: 3 }, { unit: "CHF_kWh", value: 0.09 }],
    // From the API. The API sends the monthly base, so it is not added from the yearly file.
    grid: [{ unit: "CHF_kWh", value: 0.11 }, { unit: "CHF_m", value: 5 }],
    metering: [{ unit: "CHF_m", value: 5 }],
    integrated: [{ unit: "CHF_kWh", value: 0.2 }],
  });
  assert.equal(doc._meta.complete, true);
  assert.ok(existsSync(path.join(root, "data/products/erneuerbar-400d/latest.json")));
  const index = readJsonFile(path.join(root, "data/index.json"));
  assert.deepEqual(index.products.map((p: Obj) => p.id), ["erneuerbar-400d"]);
});

test("a day whose stored response is deleted disappears from prices and products", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  writeJsonFile(stored(root, "2026-07-02"), makeDay("2026-07-02"));
  writeJsonFile(path.join(root, "curation/2026.json"), { year: 2026, products: [PRODUCT] });
  build(root);
  rmSync(stored(root, "2026-07-02"));
  build(root);
  assert.ok(!existsSync(published(root, "2026-07-02")));
  assert.ok(!existsSync(path.join(root, "data/products/erneuerbar-400d/2026/2026-07-02.json")));
});

test("checks.json lists incomplete days", () => {
  const root = productRepo();
  setNow("2026-11-14T10:00:00Z");
  writeJsonFile(stored(root, "2026-11-14"), makeDay("2026-11-14", { withoutKwh: true }));
  build(root);
  const checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.deepEqual(checks.days, [{
    id: "grid-d", tariffs: [`2026/${GRID}`], days: 1,
    incomplete: [{ date: "2026-11-14", issues: ["96 of 96 intervals have no price per kWh"] }], withoutTariff: [],
  }]);
  assert.equal(checks.summary.incompleteDays, 1);
  assert.equal(readJsonFile(published(root, "2026-11-14"))._meta.complete, false);
});

test("a day of a year without a tariff for its API stays in the sources", () => {
  const root = productRepo();
  setNow("2025-12-31T10:00:00Z");
  writeJsonFile(stored(root, "2025-12-31"), makeDay("2025-12-31"));
  writeJsonFile(stored(root, "2026-07-02"), makeDay("2026-07-02"));
  assert.equal(build(root), 0);
  assert.ok(!existsSync(path.join(root, "data/tariffs/2025")));
  assert.ok(existsSync(published(root, "2026-07-02")));
  const checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.deepEqual(checks.days[0].withoutTariff, ["2025-12-31"]);
});

test("a product year has every component and the total per window", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  writeJsonFile(path.join(root, "curation/2026.json"), {
    year: 2026,
    products: [{
      id: "erneuerbar-400st", name: "Energie Erneuerbar + Netz 400ST", status: "suggested", default: true,
      components: { electricity: "electricity-energie-erneuerbar-ne7", grid: "grid-netz-400st-ne7", metering: "metering-messung-ne7" },
    }],
  });
  assert.equal(build(root), 0);
  const doc = readJsonFile(path.join(root, "data/products/erneuerbar-400st/2026.json"));
  assert.deepEqual(schemaIssues(doc, "product"), []);
  assert.equal(doc.default, true);
  assert.deepEqual(doc.missing, ["regional_fees"]);
  assert.deepEqual(Object.keys(doc.components), ["electricity", "grid", "metering"]);
  assert.deepEqual(doc.total.fixed, {
    electricity: [{ unit: "CHF_m", value: 3 }], grid: [{ unit: "CHF_m", value: 0 }], metering: [{ unit: "CHF_m", value: 5 }],
    total: [{ unit: "CHF_m", value: 8 }],
  });
  // Winter and summer of the electricity tariff, plus the constant grid price, over the whole day.
  assert.deepEqual(doc.total.windows, [
    { months: ["Jan", "Feb", "Mar", "Oct", "Nov", "Dec"], weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], from: "00:00", to: "23:59",
      electricity: [{ unit: "CHF_kWh", value: 0.13 }], grid: [{ unit: "CHF_kWh", value: 0.1 }], total: [{ unit: "CHF_kWh", value: 0.23 }] },
    { months: ["Apr", "May", "Jun", "Jul", "Aug", "Sep"], weekdays: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], from: "00:00", to: "23:59",
      electricity: [{ unit: "CHF_kWh", value: 0.09 }], grid: [{ unit: "CHF_kWh", value: 0.1 }], total: [{ unit: "CHF_kWh", value: 0.19 }] },
  ]);
  assert.deepEqual(doc.total.dynamic, []);
  assert.equal(doc._meta.days, null);
  const index = readJsonFile(path.join(root, "data/index.json"));
  assert.deepEqual(index.products[0].default, [2026]);
  const checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.ok(!checks.tariffs[0].issues.some((i: Obj) => i.code === "no_default_product"));
});

test("windows of several components are cut into one set", () => {
  const tariff = (type: string, energy: Obj[]) => ({ id: type, tariffType: type, tariffForm: "multilevel", prices: { energy } }) as unknown as Tariff;
  const { total } = productTotal([
    tariff("electricity", [
      { months: [], weekdays: ["Mo", "Tu", "We", "Th", "Fr"], from: "07:00", to: "20:00", price: 0.2, priceUnit: "CHF/kWh" },
      { months: [], weekdays: ["Mo", "Tu", "We", "Th", "Fr"], from: "20:00", to: "07:00", price: 0.1, priceUnit: "CHF/kWh" },
      { months: [], weekdays: ["Sa", "Su"], from: "00:00", to: "23:59", price: 0.1, priceUnit: "CHF/kWh" },
    ]),
    tariff("grid", [
      { months: [], weekdays: [], from: "06:00", to: "22:00", price: 0.12, priceUnit: "CHF/kWh" },
      { months: [], weekdays: [], from: "22:00", to: "06:00", price: 0.08, priceUnit: "CHF/kWh" },
    ]),
  ]);
  const weekday = total.windows.filter((w) => (w.weekdays as string[]).includes("Mo"));
  assert.deepEqual(weekday.map((w) => [w.from, w.to, (w.total as Obj[])[0].value]), [
    ["00:00", "06:00", 0.18], ["06:00", "07:00", 0.22], ["07:00", "20:00", 0.32], ["20:00", "22:00", 0.22], ["22:00", "23:59", 0.18],
  ]);
  assert.deepEqual(total.windows.filter((w) => (w.weekdays as string[]).includes("Sa")).map((w) => [w.weekdays, w.from, w.to]), [
    [["Sa", "Su"], "00:00", "06:00"], [["Sa", "Su"], "06:00", "22:00"], [["Sa", "Su"], "22:00", "23:59"],
  ]);
});

test("two default products in a year are an error, none is a warning", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  build(root);
  let checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.ok(checks.tariffs[0].issues.some((i: Obj) => i.code === "no_default_product" && i.severity === "warning"));
  writeJsonFile(path.join(root, "curation/2026.json"), { year: 2026, products: [{ ...PRODUCT, default: true }, { ...PRODUCT, id: "zwei", default: true }] });
  assert.ok(build(root) > 0);
  checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.ok(checks.tariffs[0].issues.some((i: Obj) => i.code === "several_default_products"));
});

test("metering options and municipal fees are listed next to the total", () => {
  const root = productRepo();
  setNow("2026-07-02T10:00:00Z");
  const source = ekzLike();
  source.tariffs.push({ ...structuredClone(source.tariffs[5]), tariffName: "Messung Wandler", prices: { base: { price: 25, priceUnit: "CHF/M" } } });
  source.tariffs.push({ ...structuredClone(source.tariffs[6]), tariffName: "Gemeindeabgabe", prices: {
    municipalityTaxes: [{ municipalityNumber: 261, municipalityName: "Zürich", municipalityEnergy: [price(0.012)], municipalityComment: "Cap 24 CHF a year" }] } });
  writeJsonFile(path.join(root, "curation/2026.source.json"), source);
  writeJsonFile(path.join(root, "curation/2026.json"), { year: 2026, products: [{
    id: "standard", name: "Standard", default: true, components: {
      electricity: "electricity-energie-erneuerbar-ne7", grid: "grid-netz-400st-ne7",
      metering: { tariff: "metering-messung-ne7", options: ["metering-messung-wandler-ne7"], howToFind: "On the meter" },
      regional_fees: { tariff: "regional-fees-abgaben-ne7", byMunicipality: { tariffNames: ["Gemeindeabgabe", "Abgaben"] } },
    },
  }] });
  assert.equal(build(root), 0);
  const doc = readJsonFile(path.join(root, "data/products/standard/2026.json"));
  assert.deepEqual(schemaIssues(doc, "product"), []);
  assert.deepEqual(doc.components.metering.options, [{ id: "metering-messung-wandler-ne7", tariffName: "Messung Wandler", comment: "ohne MwSt.",
    fixed: [{ unit: "CHF_m", value: 25 }] }]);
  assert.equal(doc.components.metering.basis, "suggested");
  assert.equal(doc.status, "suggested");
  // The fee tariff in the total has Menzingen too: it is listed with the municipalities, not summed twice.
  assert.deepEqual(doc.municipalities.map((m: Obj) => [m.number, m.name, m.energy[0].value, m.comments ?? []]), [
    [12389, "Menzingen", 0.0049, []],
    [261, "Zürich", 0.012, ["Cap 24 CHF a year"]],
  ]);
  assert.ok(doc._meta.notes.some((n: string) => n.startsWith("the total is without municipal fees")));
});
