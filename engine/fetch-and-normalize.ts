/** Fetches and archives dynamic tariffs. See USAGE. Node built-ins only. */
import path from "node:path";

import { deepEqual, toJson } from "./core/json.ts";
import { DYNAMIC_NORMALIZERS, type DynamicNormalizer } from "./core/normalizers/index.ts";
import type { RawDynamic } from "./core/normalizers/generic-vse.ts";
import { addDays, dayBounds, formatTimestamp, formatUtcZ, inZurich, zurichDate, zurichHour, type Moment } from "./core/time.ts";
import type { DynamicDay, DynamicTariffConfig, PriceInterval, SourceConfig } from "./core/types.ts";
import { annotate, NO_UTILITY, parseCli } from "./lib/cli.ts";
import { exists, parseJson, readJsonIfExists, writeDayFile, writeFile, writeJson } from "./lib/files.ts";
import { http, HttpError } from "./lib/http.ts";
import { dynamicDir, loadConfig, now, rawUrl, SCHEMA_BASE, utilityRoots } from "./lib/repo.ts";
import { writeIndex } from "./lib/site-index.ts";

const USAGE = `
Dynamic tariffs: fetch, check, archive and publish the stable latest.json.

Usage, from the root of an org repo:  node ../tariff-core/engine/fetch-and-normalize.ts

Safe to run several times a day: a day is only rewritten when its prices changed, so the fallback
cron runs create no noise. Writes, per tariff, under data/dynamic/<id>/:

    raw/<year>/<date>.json          byte-exact source response
    vse/<year>/<date>.json          VSE format, Swiss local time with offset
    normalized/<year>/<date>.json   cross-organization schema, UTC
    latest.json                     today + tomorrow, stable URL
`;

const DEFAULT_BACKFILL_DAYS = 3;
// After this local hour a missing day for tomorrow fails the run. The handbook recommends
// publishing between 12:00 and about 18:00 on the day before.
const DEFAULT_ALERT_AFTER_HOUR = 21;
// Sources that do not support a time window answer with one of these.
const NO_WINDOW_SUPPORT = new Set([400, 404, 422]);

type StoreResult = "new" | "changed" | "unchanged";

interface TariffRun {
  root: string;
  org: SourceConfig;
  tariff: DynamicTariffConfig;
  normalizer: DynamicNormalizer;
  base: string;
  label: string;
  retrievedAt: string;
}

export function buildUrl(tariff: DynamicTariffConfig, day?: string): string {
  const url = new URL(tariff.api_url);
  for (const [key, value] of Object.entries(tariff.query ?? {})) url.searchParams.append(key, String(value));
  if (day) {
    // UTC keeps the URL free of a "+" in the offset. Handbook 7.4.1 allows any timezone.
    const [start, end] = dayBounds(day);
    url.searchParams.append("start_timestamp", formatUtcZ(start.ms));
    url.searchParams.append("end_timestamp", formatUtcZ(end.ms));
  }
  return url.toString();
}

/** Ask for one day. Sources without window support get a second, plain request. */
async function fetchDay(tariff: DynamicTariffConfig, day: string): Promise<Buffer> {
  try {
    return await http.fetchBytes(buildUrl(tariff, day));
  } catch (error) {
    if (error instanceof HttpError && NO_WINDOW_SUPPORT.has(error.status)) return http.fetchBytes(buildUrl(tariff));
    throw error;
  }
}

const dayPath = (base: string, kind: "raw" | "vse" | "normalized", day: string) => path.join(base, kind, day.slice(0, 4), `${day}.json`);
const isComplete = (doc: DynamicDay) => doc._meta?.complete !== false;

function storeDay(run: TariffRun, day: string, prices: PriceInterval[], rawBytes: Buffer, raw: RawDynamic, notes: string[]): StoreResult {
  const { org, tariff, normalizer, base, label, retrievedAt } = run;
  const vsePath = dayPath(base, "vse", day);
  const existing = readJsonIfExists<DynamicDay>(vsePath);
  const check = normalizer.checkDay(day, prices);
  if (existing) {
    if (deepEqual(existing.prices, prices)) return "unchanged";
    if (isComplete(existing) && !check.complete) {
      annotate("warning", `${label} ${day}: kept complete archive, new response is partial`);
      return "unchanged";
    }
  }
  const doc: DynamicDay = {
    $schema: `${SCHEMA_BASE}/dynamic-day/v1.schema.json`,
    publication_timestamp: raw.publication_timestamp ?? null,
    _meta: {
      date: day,
      complete: check.complete,
      issues: check.issues,
      resolution_minutes: check.resolution_minutes,
      day_length_hours: check.day_length_hours,
      retrieved_at: retrievedAt,
      additions: notes,
      source_url: tariff.api_url,
    },
    prices,
  };
  writeFile(dayPath(base, "raw", day), rawBytes);
  writeDayFile(vsePath, doc);
  writeJson(dayPath(base, "normalized", day), normalizer.normalize(doc, { org, tariff, date: day, retrievedAt, check }));
  if (!check.complete) annotate("warning", `${label} ${day} incomplete: ${check.issues.join("; ")}`);
  return existing ? "changed" : "new";
}

/** Rolling window of today and, once published, tomorrow. The URL never changes. */
function writeLatest(run: TariffRun, today: string): void {
  const { root, org, tariff, base, label, retrievedAt } = run;
  const days = [today, addDays(today, 1)]
    .map((date) => ({ date, doc: readJsonIfExists<DynamicDay>(dayPath(base, "vse", date)) }))
    .filter((day): day is { date: string; doc: DynamicDay } => day.doc !== undefined);
  const prices = days.flatMap(({ doc }) => doc.prices);
  if (!prices.length) {
    annotate("warning", `${label}: no data for today or tomorrow, latest.json left as is`);
    return;
  }
  const latest: DynamicDay = toJson({
    $schema: `${SCHEMA_BASE}/dynamic-day/v1.schema.json`,
    publication_timestamp: days.map(({ doc }) => doc.publication_timestamp).filter(Boolean).at(-1) ?? null,
    _meta: {
      organization: org.name,
      tariff_id: tariff.id,
      tariff_name: tariff.name,
      url: rawUrl(root, org.slug, `data/dynamic/${tariff.id}/latest.json`),
      generated_at: retrievedAt,
      valid_from: prices[0].start_timestamp,
      valid_to: prices[prices.length - 1].end_timestamp,
      days: days.map(({ date, doc }) => ({ date, complete: isComplete(doc) })),
      license: org.data_license ?? null,
      attribution: `Data sourced from ${org.name} (${org.website ?? "no website"}), republished by Strompreise-Schweiz.`,
    },
    prices,
  });
  const file = path.join(base, "latest.json");
  const previous = readJsonIfExists<DynamicDay>(file);
  if (previous && deepEqual({ ...previous, _meta: { ...previous._meta, generated_at: retrievedAt } }, latest)) return;
  writeDayFile(file, latest);
}

/** Process one tariff. Returns the failures that should fail the workflow. */
export async function runTariff(root: string, org: SourceConfig, tariff: DynamicTariffConfig, moment: Moment): Promise<string[]> {
  const label = `${org.slug}/${tariff.id}`;
  const normalizer = DYNAMIC_NORMALIZERS[tariff.normalizer ?? "generic_vse"];
  if (!normalizer) return [`${label}: unknown normalizer ${tariff.normalizer}`];
  const run: TariffRun = { root, org, tariff, normalizer, base: dynamicDir(root, tariff), label, retrievedAt: formatTimestamp(moment) };
  const today = zurichDate(moment.ms);
  const tomorrow = addDays(today, 1);
  const firstDay = tariff.valid_from ?? "0000-00-00";
  const lastDay = tariff.valid_to ?? "9999-12-31";
  const isValid = (day: string) => firstDay <= day && day <= lastDay;
  if (tomorrow < firstDay || today > lastDay) {
    console.log(`[${label}] outside its validity ${firstDay} to ${lastDay}, skipped`);
    return [];
  }
  const backfill = tariff.backfill_days ?? DEFAULT_BACKFILL_DAYS;
  const targets = [...Array.from({ length: backfill + 1 }, (_, i) => addDays(today, i - backfill)), tomorrow].filter(isValid);
  const errors: string[] = [];
  for (const target of targets) {
    const known = readJsonIfExists<DynamicDay>(dayPath(run.base, "vse", target));
    if (known && isComplete(known) && target < today) continue;
    let rawBytes: Buffer, raw: RawDynamic, canonical: ReturnType<DynamicNormalizer["canonicalize"]>;
    try {
      rawBytes = await fetchDay(tariff, target);
      raw = parseJson<RawDynamic>(rawBytes);
      canonical = normalizer.canonicalize(raw, tariff);
    } catch (error) { // one failing day must not stop the others
      errors.push(`${target}: ${(error as Error).message}`);
      continue;
    }
    for (const [day, prices] of normalizer.splitByDay(canonical.prices)) {
      if (day > tomorrow) continue;
      console.log(`[${label}] ${day}: ${storeDay(run, day, prices, rawBytes, raw, canonical.notes)}`);
    }
  }
  writeLatest(run, today);

  for (const message of errors) annotate("warning", `${label} ${message}`);
  const expected = zurichHour(moment.ms) >= (tariff.alert_after_hour ?? DEFAULT_ALERT_AFTER_HOUR) ? tomorrow : today;
  if (isValid(expected) && !exists(dayPath(run.base, "vse", expected))) {
    return [`${label}: no data for ${expected} at ${formatTimestamp(inZurich(moment.ms), "minutes")}`];
  }
  return [];
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  parseCli(USAGE, {}, args);
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  const moment = now();
  const failures: string[] = [];
  for (const root of roots) {
    const org = loadConfig(root);
    for (const tariff of org.dynamic.filter((t) => t.enabled !== false)) failures.push(...await runTariff(root, org, tariff, moment));
    writeIndex(root, org);
  }
  failures.forEach((failure) => annotate("error", failure));
  return failures.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
