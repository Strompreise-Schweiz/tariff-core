/** Builds everything under data/ from data/sources/ and curation/. See USAGE. */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { composeDay } from "./core/compose.ts";
import { applyCuration, assignIds } from "./core/curation.ts";
import { excludeBrokenTariffs } from "./core/exclusion.ts";
import { compareText, deepEqual, toJson } from "./core/json.ts";
import { checkDay, correctDay, toQuarterHours } from "./core/price-day.ts";
import { applyWaivers, documentIssues } from "./core/rules.ts";
import { repairTariffFile, type RepairedDocument } from "./core/tariff-file.ts";
import { addDays, zurichDate } from "./core/time.ts";
import type { Curation, Issue, PriceDay, PriceInterval, PriceSource, Product, Repair, SourceConfig, SourceRef, Tariff, TariffDocument } from "./core/types.ts";
import engine from "../package.json" with { type: "json" };
import { emptyChecks, writeChecks, type Checks, type IncompleteDay } from "./lib/checks.ts";
import { annotate, NO_UTILITY, parseCli, report } from "./lib/cli.ts";
import { checkBytes } from "./lib/conformance.ts";
import { exists, filesBelow, namesIn, parseJson, readJson, readJsonIfExists, writeDayFile, writeFile, writeJson } from "./lib/files.ts";
import { dayPath, daysIn, loadConfig, now, paths, SCHEMA_BASE, siteUrl, utilityRoots } from "./lib/repo.ts";
import { writeIndex, type IndexedProduct } from "./lib/site-index.ts";
import { storedDay } from "./lib/stored.ts";

const USAGE = `
Builds every published file of a utility from what fetch.ts stored and from curation/. Offline and
repeatable: a run that finds nothing new changes nothing.

Usage, from the root of an org repo, or of the hub repo for every utility in it:

  node ../tariff-core/engine/build.ts

    data/sources/tariffs/  -> repairs (core/tariff-file.ts) -> curation/<year>.json -> checks
                           -> data/tariffs/<year>.json, current.json
    data/sources/prices/   -> curation/<year>.json "prices" -> quarter hours
                           -> data/prices/<id>/<year>/<date>.json, latest.json
    products of curation   -> data/products/<id>/<year>/<date>.json, latest.json
                              (products with a dynamic tariff: every component per quarter hour)
    everything             -> data/checks.json, data/badges/, data/index.json

A year with errors is not published: the previous file stays online and checks.json says why.
Exits with 1 if a year has errors.
`;

// The files of this project follow this version of the VSE definition. Sources may follow any.
const WRITTEN_VSE_VERSION = "1.0.1";
const SCHEMA_VERSION = "2.0";
const GENERATOR = { name: "tariff-core", version: engine.version, url: "https://github.com/Strompreise-Schweiz/tariff-core" };
type RepairedTariff = RepairedDocument["tariffs"][number];

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The same API, regardless of the order of the query parameters. */
export function sameUrl(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    x.searchParams.sort();
    y.searchParams.sort();
    return x.toString() === y.toString();
  } catch {
    return a === b;
  }
}

class Output {
  /** Every file under data/prices/ and data/products/ that this run keeps. The rest is removed. */
  readonly kept = new Set<string>();

  json(file: string, value: unknown): void {
    this.kept.add(file);
    if (!deepEqual(readJsonIfExists(file), value)) writeJson(file, value);
  }

  keep(file: string): void {
    this.kept.add(file);
  }

  day(file: string, value: PriceDay): void {
    this.kept.add(file);
    if (!deepEqual(readJsonIfExists(file), value)) writeDayFile(file, value);
  }

  /** Remove what no source backs any more, such as a day whose source file was deleted. */
  prune(root: string, kind: "prices" | "products"): void {
    for (const file of filesBelow(path.join(paths.data(root), kind))) if (!this.kept.has(file)) rmSync(file);
  }
}

// ---------------------------------------------------------------------------------------------
// Yearly files

interface Collected {
  dsoName: string | null;
  dsoNumber: number | null;
  repairs: Repair[];
  sources: SourceRef[];
  byYear: Map<number, RepairedTariff[]>;
  failures: string[];
}

/** Read and repair every enabled yearly file, and sort the tariffs by start year. */
function collectTariffs(root: string, org: SourceConfig, checks: Checks, currentYear: number): Collected {
  const result: Collected = { dsoName: null, dsoNumber: null, repairs: [], sources: [], byYear: new Map(), failures: [] };
  for (const source of org.tariffs.filter((s) => s.enabled !== false)) {
    const file = source.file ? path.join(root, source.file) : paths.tariffSource(root, source.name);
    if (!exists(file)) {
      result.failures.push(`tariffs ${source.name}: ${path.relative(root, file)} does not exist, run fetch.ts first`);
      continue;
    }
    const data = readFileSync(file);
    const ref: SourceRef = { name: source.name, ...(source.file ? { file: source.file } : { url: source.url }), sha256: sha256(data) };
    checks.sources.tariffs.push({ ...ref, vse: checkBytes(data) });
    let repaired: ReturnType<typeof repairTariffFile>;
    try {
      repaired = repairTariffFile(parseJson(data));
    } catch (error) {
      result.failures.push(`tariffs ${source.name}: ${(error as Error).message}`);
      continue;
    }
    result.failures.push(...repaired.problems.map((problem) => `tariffs ${source.name}: ${problem}`));
    result.sources.push(ref);
    result.repairs.push(...repaired.repairs);
    result.dsoName ??= repaired.document.dsoName;
    result.dsoNumber ??= repaired.document.dsoNumber;
    for (const tariff of repaired.document.tariffs) {
      const year = /^\d{4}/.test(String(tariff.startDate)) ? Number(String(tariff.startDate).slice(0, 4)) : currentYear;
      result.byYear.set(year, [...(result.byYear.get(year) ?? []), tariff]);
    }
  }
  return result;
}

/**
 * Point each dynamic tariff to the day prices of this project. The price source is the one whose
 * url is the url the utility gives in prices.dynamic.url.
 */
function linkPrices(tariffs: Tariff[], org: SourceConfig): Issue[] {
  const issues: Issue[] = [];
  for (const tariff of tariffs.filter((t) => t.tariffForm === "dynamic" && t.prices.dynamic?.url)) {
    const sourceUrl = tariff.prices.dynamic!.sourceUrl ?? tariff.prices.dynamic!.url;
    const source = org.prices.find((s) => sameUrl(s.url, sourceUrl));
    if (source) {
      tariff.prices.dynamic = { url: siteUrl(org.slug, `prices/${source.id}/latest.json`), sourceUrl };
    } else {
      issues.push({ severity: "warning", code: "dynamic_without_prices", tariff: tariff.id,
        message: `no entry in prices of config/source.json has the url ${sourceUrl}` });
    }
  }
  return issues;
}

function readCuration(root: string, year: number): Curation {
  return readJsonIfExists<Curation>(path.join(root, "curation", `${year}.json`)) ?? {};
}

/** Build, check and write the yearly files. Returns the number of errors. */
function buildTariffs(root: string, org: SourceConfig, checks: Checks, currentYear: number): number {
  const collected = collectTariffs(root, org, checks, currentYear);
  collected.failures.forEach((failure) => annotate("error", `${org.slug} ${failure}`));
  let errors = collected.failures.length;
  const tariffsDir = paths.tariffs(root);
  for (const year of [...collected.byYear.keys()].sort((a, b) => a - b)) {
    const curation = readCuration(root, year);
    const curated = applyCuration(collected.byYear.get(year)!, curation);
    const tariffs = assignIds(curated.tariffs);
    const linkIssues = linkPrices(tariffs, org);
    const unknown = (curation.prices ?? []).filter((c) => !org.prices.some((s) => s.id === c.prices))
      .map((c): Issue => ({ severity: "error", code: "curation_unknown_prices", message: `prices "${c.prices}" is not in config/source.json` }));
    const built: TariffDocument = toJson({
      $schema: `${SCHEMA_BASE}/tariff-document/v1.schema.json`,
      dsoName: collected.dsoName!,
      dsoNumber: collected.dsoNumber!,
      _meta: {
        schemaVersion: SCHEMA_VERSION,
        vseVersion: WRITTEN_VSE_VERSION,
        generator: GENERATOR,
        year,
        pricesExcludeVat: true,
        source: collected.sources,
        repairs: collected.repairs,
        corrections: curated.applied,
      },
      tariffs,
      products: curation.products ?? [],
    });
    const checkYear = (doc: TariffDocument) =>
      applyWaivers([...curated.issues, ...unknown, ...linkIssues, ...documentIssues(doc, year, org.vse_id)], curation.acceptIssues);
    // A tariff with an error of its own is left out and listed, so it does not block the rest of the year.
    const { document, excluded, issues } = excludeBrokenTariffs(built, checkYear);
    const yearErrors = report(issues, `${org.slug} ${year}`);
    for (const tariff of excluded) annotate("warning", `${org.slug} ${year}: left out ${tariff.id}: ${tariff.problems.join("; ")}`);
    const output = path.join(tariffsDir, `${year}.json`);
    if (!yearErrors && !deepEqual(readJsonIfExists(output), document)) writeJson(output, document);
    errors += yearErrors;
    checks.tariffs.push({
      year, published: yearErrors === 0, online: exists(output), repairs: collected.repairs, issues, excluded,
      ...(exists(output) ? { vse: checkBytes(readFileSync(output)) } : {}),
    });
    console.log(`[${org.slug}] tariffs ${year}: ${yearErrors ? `not published, ${yearErrors} errors` : `${document.tariffs.length} tariffs, ${document.products.length} products`}`);
  }
  const current = path.join(tariffsDir, `${currentYear}.json`);
  const alias = path.join(tariffsDir, "current.json");
  if (exists(current) && !deepEqual(readJsonIfExists(alias), readJson(current))) writeFile(alias, readFileSync(current));
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Day prices

/** The days from a list of day documents: today and tomorrow, as far as there are. */
function latestOf(days: { date: string; doc: PriceDay }[], meta: Record<string, unknown>): PriceDay | undefined {
  const prices = days.flatMap(({ doc }) => doc.prices);
  if (!prices.length) return undefined;
  return toJson({
    $schema: `${SCHEMA_BASE}/price-day/v1.schema.json`,
    publication_timestamp: days.map(({ doc }) => doc.publication_timestamp).filter(Boolean).at(-1) ?? null,
    _meta: {
      ...meta,
      complete: days.every(({ doc }) => doc._meta.complete),
      days: days.map(({ date, doc }) => ({ date, complete: doc._meta.complete })),
      valid_from: prices[0].start_timestamp,
      valid_to: prices[prices.length - 1].end_timestamp,
    },
    prices,
  });
}

function writeLatest(out: Output, dir: string, today: string, meta: Record<string, unknown>): void {
  const days = [today, addDays(today, 1)]
    .map((date) => ({ date, doc: readJsonIfExists<PriceDay>(dayPath(dir, date)) }))
    .filter((day): day is { date: string; doc: PriceDay } => day.doc !== undefined);
  const latest = latestOf(days, meta);
  const file = path.join(dir, "latest.json");
  // Without prices for today or tomorrow the previous file stays online: its _meta.days says which days it holds.
  if (latest) out.day(file, latest);
  else out.keep(file);
}

/** Build data/prices/<id>/ from the stored responses and the corrections of curation. */
function buildPrices(root: string, org: SourceConfig, source: PriceSource, out: Output, checks: Checks, today: string): void {
  const days = daysIn(paths.priceSources(root, source.id));
  const incomplete: IncompleteDay[] = [];
  const dir = paths.prices(root, source.id);
  const corrections = new Map<string, Curation["prices"]>();
  for (const day of days) {
    const year = day.slice(0, 4);
    if (!corrections.has(year)) corrections.set(year, (readCuration(root, Number(year)).prices ?? []).filter((c) => c.prices === source.id));
    let stored;
    try {
      stored = storedDay(root, source, day)!;
    } catch (error) {
      incomplete.push({ date: day, issues: [`stored response cannot be read: ${(error as Error).message}`] });
      continue;
    }
    if (!stored.prices.length) {
      incomplete.push({ date: day, issues: ["the stored response has no intervals for this day"] });
      continue;
    }
    const corrected = correctDay(day, stored.prices, corrections.get(year)!);
    const prices = toQuarterHours(corrected.prices);
    const check = checkDay(day, prices);
    if (!check.complete) incomplete.push({ date: day, issues: check.issues });
    out.day(dayPath(dir, day), toJson({
      $schema: `${SCHEMA_BASE}/price-day/v1.schema.json`,
      publication_timestamp: stored.publication_timestamp,
      _meta: {
        prices: source.id,
        name: source.name,
        date: day,
        complete: check.complete,
        issues: check.issues,
        source: {
          url: source.url,
          file: `sources/prices/${source.id}/${year}/${day}.json`,
          resolution_minutes: stored.check.resolution_minutes,
          notes: stored.notes,
        },
        corrections: corrected.applied,
        pricesExcludeVat: true,
      },
      prices,
    }));
  }
  writeLatest(out, dir, today, { prices: source.id, name: source.name, license: org.data_license ?? null });
  checks.sources.prices.push({ id: source.id, url: source.url, enabled: source.enabled !== false, days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null });
  checks.prices.push({ id: source.id, days: days.length, incomplete });
  console.log(`[${org.slug}] prices ${source.id}: ${days.length} days, ${incomplete.length} incomplete`);
}

// ---------------------------------------------------------------------------------------------
// Products

/** Build data/products/<id>/ for each product with a dynamic tariff, in every published year. */
function buildProducts(root: string, org: SourceConfig, out: Output, checks: Checks, today: string): IndexedProduct[] {
  const listed = new Map<string, IndexedProduct>();
  for (const name of namesIn(paths.tariffs(root), /^\d{4}\.json$/)) {
    const document = readJson<TariffDocument>(path.join(paths.tariffs(root), name));
    const year = document._meta.year;
    const tariffs = new Map(document.tariffs.map((tariff) => [tariff.id, tariff]));
    for (const product of document.products) {
      const used = Object.values(product.components).map((id) => tariffs.get(id!)).filter((t): t is Tariff => t !== undefined);
      const dynamic = used.filter((t) => t.tariffForm === "dynamic");
      if (!dynamic.length) continue;
      const notes = new Set<string>();
      // Which published price source holds the day prices of each dynamic tariff.
      const sourceOf = new Map<string, string>();
      for (const tariff of dynamic) {
        const source = org.prices.find((s) => tariff.prices.dynamic?.sourceUrl && sameUrl(s.url, tariff.prices.dynamic.sourceUrl));
        if (source) sourceOf.set(tariff.id, source.id);
        else notes.add(`${tariff.id}: no price source, so no days`);
      }
      const first = [`${year}-01-01`, ...used.map((t) => t.startDate)].sort(compareText).at(-1)!;
      const last = [`${year}-12-31`, ...used.map((t) => t.endDate)].sort(compareText)[0];
      const candidates = sourceOf.size === dynamic.length
        ? [...new Set([...sourceOf.values()].flatMap((id) => daysIn(paths.prices(root, id))))].sort(compareText)
            .filter((day) => first <= day && day <= last)
        : [];
      const incomplete: IncompleteDay[] = [];
      const dir = paths.products(root, product.id);
      let written = 0;
      for (const day of candidates) {
        const inputs = [...sourceOf].map(([tariffId, sourceId]) => ({ tariffId, sourceId, doc: readJsonIfExists<PriceDay>(dayPath(paths.prices(root, sourceId), day)) }));
        const missing = inputs.filter((input) => !input.doc).map((input) => input.sourceId);
        if (missing.length) {
          incomplete.push({ date: day, issues: [`no day prices of ${missing.join(", ")}`] });
          continue;
        }
        const dayPrices = new Map<string, PriceInterval[]>(inputs.map((input) => [input.tariffId, input.doc!.prices]));
        const composed = composeDay(day, product, tariffs, dayPrices);
        composed.notes.forEach((note) => notes.add(note));
        const partial = inputs.filter((input) => !input.doc!._meta.complete).map((input) => input.sourceId);
        if (partial.length) incomplete.push({ date: day, issues: [`incomplete day prices of ${partial.join(", ")}`] });
        out.day(dayPath(dir, day), toJson({
          $schema: `${SCHEMA_BASE}/price-day/v1.schema.json`,
          publication_timestamp: inputs.map((input) => input.doc!.publication_timestamp).filter((t): t is string => Boolean(t)).sort(compareText).at(-1) ?? null,
          _meta: productMeta(product, year, day, partial.length === 0, [...sourceOf.values()], composed.notes),
          prices: composed.prices,
        }));
        written += 1;
      }
      if (written) listed.set(product.id, { id: product.id, name: product.name });
      checks.products.push({ id: product.id, year, days: written, incomplete, notes: [...notes].sort(compareText) });
      console.log(`[${org.slug}] product ${product.id} ${year}: ${written} days`);
    }
  }
  for (const product of listed.values()) {
    writeLatest(out, paths.products(root, product.id), today, { product: product.id, name: product.name, license: org.data_license ?? null });
  }
  return [...listed.values()];
}

function productMeta(product: Product, year: number, day: string, complete: boolean, prices: string[], notes: string[]) {
  return {
    product: product.id,
    name: product.name,
    status: product.status,
    date: day,
    complete,
    components: product.components,
    tariffs: `tariffs/${year}.json`,
    prices,
    notes,
    pricesExcludeVat: true,
    integrated: "sum of the prices per kWh of electricity, grid and regional_fees",
  };
}

// ---------------------------------------------------------------------------------------------

/** Build one utility. Returns the number of errors. */
export function build(root: string): number {
  const org = loadConfig(root);
  const today = zurichDate(now().ms);
  const currentYear = Number(today.slice(0, 4));
  const checks = emptyChecks(org.name, org.slug);
  const out = new Output();
  const errors = buildTariffs(root, org, checks, currentYear);
  for (const source of org.prices) buildPrices(root, org, source, out, checks, today);
  out.prune(root, "prices"); // before the products, which read data/prices/
  const products = buildProducts(root, org, out, checks, today);
  out.prune(root, "products");
  writeChecks(root, checks);
  writeIndex(root, org, products);
  return errors;
}

export function main(args = process.argv.slice(2), cwd = process.cwd()): number {
  parseCli(USAGE, {}, args);
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  // Build every utility, also after a failure: one broken source must not block the others.
  const errors = roots.reduce((sum, root) => sum + build(root), 0);
  return errors ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
