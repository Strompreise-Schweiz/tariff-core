import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { canonicalize as canonicalizeRaw, checkDay, splitByDay, type RawDynamic } from "../engine/core/normalizers/generic-vse.ts";
import { dynamicDayIssues } from "../engine/core/rules.ts";
import { dayBounds, formatTimestamp, formatUtcZ, inUtc, inZurich, parseTimestamp } from "../engine/core/time.ts";
import type { DynamicDay } from "../engine/core/types.ts";
import { main as fetchMain } from "../engine/fetch-and-normalize.ts";
import { http, HttpError } from "../engine/lib/http.ts";
import { readJsonFile, setNow, tempDir, writeJsonFile, type Obj } from "./helpers.ts";

const canonicalize = (raw: Obj, tariff: Obj = {}) => canonicalizeRaw(raw as RawDynamic, tariff);

function makeDay(day: string, { utcStamps = false, dropLast = 0, grid = 0.11 } = {}): Obj {
  const [start, end] = dayBounds(day);
  const stamp = (ms: number) => (utcStamps ? formatUtcZ(ms) : formatTimestamp(inZurich(ms)));
  const prices: Obj[] = [];
  for (let moment = start.ms; moment < end.ms; moment += 15 * 60_000) {
    prices.push({
      start_timestamp: stamp(moment), end_timestamp: stamp(moment + 15 * 60_000),
      grid: [{ unit: "CHF_kWh", value: grid }, { unit: "CHF_m", value: 5.0 }],
      electricity: [{ unit: "CHF_kWh", value: 0.09 }],
    });
  }
  return { publication_timestamp: `${day}T10:00:00Z`, prices: prices.slice(0, prices.length - dropLast) };
}

function orgRepo(): string {
  const root = tempDir();
  writeJsonFile(path.join(root, "config/source.json"), {
    slug: "muster", name: "Muster AG", vse_id: "CH10000000001", website: "https://example.ch",
    dynamic: [{ id: "grid-d", name: "Dyn", api_url: "https://api.example.ch/v1/tariffs", query: { tariff_name: "grid_d" } }],
    static: { sources: [] },
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

const run = (root: string) => fetchMain([], root);

for (const [day, hours, count] of [["2026-03-29", 23, 92], ["2026-07-01", 24, 96], ["2026-10-25", 25, 100]] as const) {
  test(`day length follows the clock change on ${day}`, () => {
    const { prices } = canonicalize(makeDay(day));
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
  const { prices } = canonicalize(makeDay("2026-10-25", { dropLast: 4 }));
  const check = checkDay("2026-10-25", prices);
  assert.ok(!check.complete);
  assert.ok(check.issues[0].includes("ends at 2026-10-25T23:00:00+01:00"));
});

test("a UTC source lands on the Swiss day", () => {
  const { prices } = canonicalize(makeDay("2026-07-02", { utcStamps: true }));
  assert.deepEqual([...splitByDay(prices).keys()], ["2026-07-02"]);
  assert.equal(prices[0].start_timestamp, "2026-07-02T00:00:00+02:00");
});

test("a naive timestamp is rejected", () => {
  assert.throws(() => parseTimestamp("2026-10-25T02:30:00"), /without UTC offset/);
});

test("integrated is derived and logged", () => {
  const { prices, notes } = canonicalize(makeDay("2026-07-02"));
  assert.deepEqual(prices[0].integrated, [{ unit: "CHF_kWh", value: 0.2 }]);
  assert.ok(notes.some((note) => note.includes("derived integrated")));
});

test("a missing component is added from config", () => {
  const tariff = { add_components: [{ tariff_type: "regional_fees", unit: "CHF_kWh", value: 0.0016, reason: "Kanton ZH" }] };
  const { prices, notes } = canonicalize(makeDay("2026-07-02"), tariff);
  assert.deepEqual(prices[0].regional_fees, [{ unit: "CHF_kWh", value: 0.0016 }]);
  assert.ok(notes.some((note) => note.includes("Kanton ZH")));
});

test("a component is renamed", () => {
  const raw = makeDay("2026-07-02");
  for (const entry of raw.prices) {
    entry.dso = entry.grid;
    delete entry.grid;
  }
  const { prices } = canonicalize(raw);
  assert.ok("grid" in prices[0] && !("dso" in prices[0]));
});

test("latest has today and tomorrow", async () => {
  const root = orgRepo();
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-01": makeDay("2026-07-01"), "2026-07-02": makeDay("2026-07-02") });
  assert.equal(await run(root), 0);
  const latest = readJsonFile(path.join(root, "data/dynamic/grid-d/latest.json"));
  assert.equal(latest.prices.length, 192);
  assert.equal(latest._meta.valid_to, "2026-07-03T00:00:00+02:00");
  assert.ok(latest._meta.url.endsWith("/muster/main/data/dynamic/grid-d/latest.json"));
  assert.deepEqual(dynamicDayIssues("latest.json", latest as DynamicDay), []);
  assert.deepEqual(dynamicDayIssues("2026-07-02.json", readJsonFile(path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-02.json")) as DynamicDay), []);
});

test("a late run after midnight loses no day", async () => {
  // Real archive: a run delayed past midnight lost the day before. Backfill recovers it.
  const root = orgRepo();
  serve(Object.fromEntries(["2026-07-01", "2026-07-02", "2026-07-03"].map((d) => [d, makeDay(d)])));
  setNow("2026-07-01T17:00:00Z");
  await run(root);
  setNow("2026-07-02T23:30:00Z"); // 01:30 on 3 July in Zurich
  assert.equal(await run(root), 0);
  assert.ok(existsSync(path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-03.json")));
  assert.ok(existsSync(path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-02.json")));
});

function snapshot(root: string): Map<string, Buffer> {
  const files = (readdirSync(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(e.parentPath, e.name));
  return new Map(files.sort().map((file) => [file, readFileSync(file)]));
}

test("a repeated run changes nothing", async () => {
  const root = orgRepo();
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-01": makeDay("2026-07-01"), "2026-07-02": makeDay("2026-07-02") });
  await run(root);
  const before = snapshot(root);
  setNow("2026-07-01T19:00:00Z");
  await run(root);
  assert.deepEqual(snapshot(root), before);
});

test("a correction overwrites, a partial response does not", async () => {
  const root = orgRepo();
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-02": makeDay("2026-07-02") });
  await run(root);
  const file = path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-02.json");
  serve({ "2026-07-02": makeDay("2026-07-02", { dropLast: 8 }) });
  await run(root);
  assert.equal(readJsonFile(file).prices.length, 96);
  serve({ "2026-07-02": makeDay("2026-07-02", { grid: 0.2 }) });
  await run(root);
  assert.equal(readJsonFile(file).prices[0].grid[0].value, 0.2);
});

test("a missing tomorrow fails only after the alert hour", async () => {
  const root = orgRepo();
  serve({ "2026-07-01": makeDay("2026-07-01") });
  setNow("2026-07-01T17:00:00Z"); // 19:00
  assert.equal(await run(root), 0);
  setNow("2026-07-01T20:00:00Z"); // 22:00
  assert.equal(await run(root), 1);
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
  await run(root);
  assert.ok(existsSync(path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-02.json")));
  assert.ok(calls.some((c) => c.includes("tariff_name=grid_d") && !c.includes("start_timestamp")));
});

test("an archive from before 2.0 is usable", async () => {
  // Files written by the old engine have no _meta.
  const root = orgRepo();
  const old = path.join(root, "data/dynamic/grid-d/vse/2026/2026-07-01.json");
  writeJsonFile(old, { publication_timestamp: null, prices: canonicalize(makeDay("2026-07-01")).prices });
  setNow("2026-07-01T17:00:00Z");
  serve({ "2026-07-02": makeDay("2026-07-02") });
  assert.equal(await run(root), 0);
  const latest = readJsonFile(path.join(root, "data/dynamic/grid-d/latest.json"));
  assert.deepEqual(latest._meta.days.map((d: Obj) => d.date), ["2026-07-01", "2026-07-02"]);
  assert.deepEqual(dynamicDayIssues("2026-07-01.json", readJsonFile(old) as DynamicDay), []);
});

test("a tariff starts on its first day and stops after its last", async () => {
  const root = orgRepo();
  const config = readJsonFile(path.join(root, "config/source.json"));
  Object.assign(config.dynamic[0], { valid_from: "2027-01-01", valid_to: "2027-12-31" });
  writeJsonFile(path.join(root, "config/source.json"), config);
  serve({ "2027-01-01": makeDay("2027-01-01") });
  setNow("2026-12-30T20:00:00Z");
  assert.equal(await run(root), 0);
  assert.ok(!existsSync(path.join(root, "data/dynamic/grid-d")));
  setNow("2026-12-31T20:30:00Z");
  assert.equal(await run(root), 0);
  assert.ok(existsSync(path.join(root, "data/dynamic/grid-d/vse/2027/2027-01-01.json")));
  assert.ok(!existsSync(path.join(root, "data/dynamic/grid-d/vse/2026")));
  setNow("2028-01-02T20:30:00Z");
  assert.equal(await run(root), 0);
});
