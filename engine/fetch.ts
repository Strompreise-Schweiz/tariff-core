/** Downloads the files of the utilities into data/sources/. See USAGE. Node built-ins only. */
import { readFileSync } from "node:fs";

import { deepEqual } from "./core/json.ts";
import { readResponse, splitByDay, type ApiResponse } from "./core/price-day.ts";
import { addDays, dayBounds, formatTimestamp, formatUtcZ, inZurich, zurichDate, zurichHour, type Moment } from "./core/time.ts";
import type { PriceSource, SourceConfig } from "./core/types.ts";
import { annotate, NO_UTILITY, parseCli } from "./lib/cli.ts";
import { exists, parseJson, writeFile } from "./lib/files.ts";
import { http, HttpError } from "./lib/http.ts";
import { dayPath, loadConfig, now, paths, utilityRoots } from "./lib/repo.ts";
import { dayOf, storedDay } from "./lib/stored.ts";

const USAGE = `
Downloads what the utility publishes, unchanged, into data/sources/. Nothing else is written:
build.ts makes the published files from it.

Usage, from the root of an org repo, or of the hub repo for every utility in it:

  node ../tariff-core/engine/fetch.ts [--tariffs] [--prices]

  --tariffs   only the yearly files       -> data/sources/<name>.json
  --prices    only the day prices         -> data/sources/days/<id>/<year>/<date>.json
              (default: both)

Day prices are fetched for the last days, today and tomorrow. Safe to run several times a day: a
day is only written again when its prices changed, and a complete day is never replaced by a
partial one. After alert_after_hour a missing tomorrow fails the run.
`;

const DEFAULT_BACKFILL_DAYS = 3;
// The handbook recommends publishing between 12:00 and about 18:00 on the day before.
const DEFAULT_ALERT_AFTER_HOUR = 21;
// Sources that do not support a time window answer with one of these.
const NO_WINDOW_SUPPORT = new Set([400, 404, 422]);

/** The URL for one day. Without a day, the URL as configured. */
export function buildUrl(source: PriceSource, day?: string): string {
  const url = new URL(source.url);
  if (day) {
    // UTC keeps the URL free of a "+" in the offset. Handbook 7.4.1 allows any timezone.
    const [start, end] = dayBounds(day);
    url.searchParams.set("start_timestamp", formatUtcZ(start.ms));
    url.searchParams.set("end_timestamp", formatUtcZ(end.ms));
  }
  return url.toString();
}

/** Ask for one day. Sources without window support get a second, plain request. */
async function fetchDay(source: PriceSource, day: string): Promise<Buffer> {
  try {
    return await http.fetchBytes(buildUrl(source, day));
  } catch (error) {
    if (error instanceof HttpError && NO_WINDOW_SUPPORT.has(error.status)) return http.fetchBytes(buildUrl(source));
    throw error;
  }
}

/** Download the yearly files. Returns the failures. */
export async function fetchTariffs(root: string, org: SourceConfig): Promise<string[]> {
  const failures: string[] = [];
  for (const source of org.tariffs.filter((s) => s.enabled !== false && s.url)) {
    try {
      const bytes = await http.fetchBytes(source.url!);
      const file = paths.tariffSource(root, source.name);
      const changed = !exists(file) || !readFileSync(file).equals(bytes);
      if (changed) writeFile(file, bytes);
      console.log(`[${org.slug}] tariffs ${source.name}: ${changed ? "changed" : "unchanged"}`);
    } catch (error) {
      failures.push(`${org.slug} tariffs ${source.name}: ${(error as Error).message}`);
    }
  }
  return failures;
}

/** Store the response for each day it holds, unless that would replace better data. */
function storeResponse(root: string, source: PriceSource, bytes: Buffer, lastDay: string, label: string): void {
  const days = splitByDay(readResponse(parseJson<ApiResponse>(bytes), source).prices);
  for (const day of days.keys()) {
    if (day > lastDay || (source.valid_from && day < source.valid_from) || (source.valid_to && day > source.valid_to)) continue;
    const before = storedDay(root, source, day);
    const fresh = dayOf(bytes, source, day);
    if (before && deepEqual(before.prices, fresh.prices)) {
      console.log(`[${label}] ${day}: unchanged`);
      continue;
    }
    if (before?.check.complete && !fresh.check.complete) {
      annotate("warning", `${label} ${day}: kept the complete day, the new response is partial`);
      continue;
    }
    writeFile(dayPath(paths.daySources(root, source.id), day), bytes);
    console.log(`[${label}] ${day}: ${before ? "changed" : "new"}${fresh.check.complete ? "" : ` (incomplete: ${fresh.check.issues.join("; ")})`}`);
  }
}

/** Download the day prices of one source. Returns the failures. */
export async function fetchPrices(root: string, org: SourceConfig, source: PriceSource, moment: Moment): Promise<string[]> {
  const label = `${org.slug}/${source.id}`;
  const today = zurichDate(moment.ms);
  const tomorrow = addDays(today, 1);
  const firstDay = source.valid_from ?? "0000-00-00";
  const lastDay = source.valid_to ?? "9999-12-31";
  const isValid = (day: string) => firstDay <= day && day <= lastDay;
  if (tomorrow < firstDay || today > lastDay) {
    console.log(`[${label}] outside its validity ${firstDay} to ${lastDay}, skipped`);
    return [];
  }
  const backfill = source.backfill_days ?? DEFAULT_BACKFILL_DAYS;
  const targets = [...Array.from({ length: backfill + 1 }, (_, i) => addDays(today, i - backfill)), tomorrow].filter(isValid);
  for (const target of targets) {
    if (target < today && storedDay(root, source, target)?.check.complete) continue;
    try {
      storeResponse(root, source, await fetchDay(source, target), tomorrow, label);
    } catch (error) { // one failing day must not stop the others
      annotate("warning", `${label} ${target}: ${(error as Error).message}`);
    }
  }
  const expected = zurichHour(moment.ms) >= (source.alert_after_hour ?? DEFAULT_ALERT_AFTER_HOUR) ? tomorrow : today;
  if (isValid(expected) && !storedDay(root, source, expected)?.check.complete) {
    return [`${label}: no complete prices for ${expected} at ${formatTimestamp(inZurich(moment.ms), "minutes")}`];
  }
  return [];
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const { values } = parseCli(USAGE, { tariffs: { type: "boolean" }, prices: { type: "boolean" } }, args);
  const both = !values.tariffs && !values.prices;
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  const moment = now();
  const failures: string[] = [];
  for (const root of roots) {
    const org = loadConfig(root);
    if (both || values.tariffs) failures.push(...await fetchTariffs(root, org));
    if (both || values.prices) {
      for (const source of org.prices.filter((s) => s.enabled !== false)) failures.push(...await fetchPrices(root, org, source, moment));
    }
  }
  failures.forEach((failure) => annotate("error", failure));
  return failures.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
