/** Builds everything under data/ from data/sources/ and curation/. See USAGE. */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { composeDay } from "./core/compose.ts";
import { applyCuration, assignIds } from "./core/curation.ts";
import { excludeBrokenTariffs } from "./core/exclusion.ts";
import { compareText, deepEqual, toJson } from "./core/json.ts";
import { checkDay, correctDay, toQuarterHours } from "./core/price-day.ts";
import { productYear, type ProductYear } from "./core/product-year.ts";
import { resolveProducts } from "./core/product-spec.ts";
import { applyWaivers, documentIssues } from "./core/rules.ts";
import { repairTariffFile, type RepairedDocument } from "./core/tariff-file.ts";
import { addDays, zurichDate } from "./core/time.ts";
import type {
  Curation, Issue, PriceDay, PriceInterval, PriceSource, Product, ProductDocument, Repair, SourceConfig, SourceRef, Tariff, TariffDocument,
} from "./core/types.ts";
import engine from "../package.json" with { type: "json" };
import { emptyChecks, writeChecks, type Checks, type IncompleteDay } from "./lib/checks.ts";
import { annotate, NO_UTILITY, parseCli, report } from "./lib/cli.ts";
import { checkBytes } from "./lib/conformance.ts";
import { exists, filesBelow, namesIn, parseJson, readJson, readJsonIfExists, writeDayFile, writeFile, writeJson, writeReadableJson } from "./lib/files.ts";
import { datesIn, dayPath, daysIn, loadConfig, now, paths, rawUrl, SCHEMA_BASE, siteUrl, utilityRoots } from "./lib/repo.ts";
import { writeIndex, type IndexedProduct } from "./lib/site-index.ts";
import { storedDay } from "./lib/stored.ts";

const USAGE = `
Builds every published file of a utility from what fetch.ts stored and from curation/. Offline and
repeatable: a run that finds nothing new changes nothing.

Usage, from the root of an org repo, or of the hub repo for every utility in it:

  node ../tariff-core/engine/build.ts

    data/sources/<name>.json -> repairs (core/tariff-file.ts) -> curation/<year>.json -> checks
                             -> data/tariffs/<year>.json, current.json
    data/sources/days/<id>/  -> curation/<year>.json "prices" -> quarter hours
                             -> data/tariffs/<year>/<tariff>/<date>.json for each dynamic tariff
                                of <year>.json whose prices.dynamic.url is this API
                             -> data/tariffs/current/<tariff>.json
    products of curation     -> data/products/<id>/<year>.json (every component and the total)
                             -> data/products/<id>/<year>/<date>.json, latest.json
                                (products with a dynamic tariff: every component per quarter hour)
    everything               -> data/checks.json, data/badges/, data/index.json

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
  /** Every day file and product file that this run keeps. The rest is removed. */
  readonly kept = new Set<string>();

  json(file: string, value: unknown): void {
    this.kept.add(file);
    if (!deepEqual(readJsonIfExists(file), value)) writeReadableJson(file, value);
  }

  keep(file: string): void {
    this.kept.add(file);
  }

  day(file: string, value: PriceDay): void {
    this.kept.add(file);
    if (!deepEqual(readJsonIfExists(file), value)) writeDayFile(file, value);
  }

  /**
   * Remove what no source backs any more, such as a day whose source file was deleted. Below
   * data/tariffs/ only the day files: the yearly files are written by buildTariffs.
   */
  prune(root: string, kind: "tariffs" | "products"): void {
    const dir = path.join(paths.data(root), kind);
    for (const file of filesBelow(dir)) {
      if (kind === "tariffs" && path.dirname(file) === dir) continue;
      if (!this.kept.has(file)) rmSync(file);
    }
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
      tariff.prices.dynamic = { url: siteUrl(org.slug, `tariffs/current/${tariff.id}.json`), sourceUrl };
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
    const resolved = resolveProducts(curation.products ?? [], tariffs);
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
      products: resolved.products,
    });
    const checkYear = (doc: TariffDocument) =>
      applyWaivers([...curated.issues, ...unknown, ...linkIssues, ...resolved.issues, ...documentIssues(doc, year, org.vse_id)], curation.acceptIssues);
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
// Day prices of the dynamic tariffs

/** The yearly files that are online, by year. */
function onlineYears(root: string): Map<number, TariffDocument> {
  return new Map(namesIn(paths.tariffs(root), /^\d{4}\.json$/)
    .map((name) => [Number(name.slice(0, 4)), readJson<TariffDocument>(path.join(paths.tariffs(root), name))] as const));
}

/** The dynamic tariffs of a year whose day prices come from a price source. */
function tariffsOf(document: TariffDocument | undefined, source: PriceSource): Tariff[] {
  return (document?.tariffs ?? []).filter((t) => t.tariffForm === "dynamic" && t.prices.dynamic?.sourceUrl && sameUrl(t.prices.dynamic.sourceUrl, source.url));
}

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

/** Write today and tomorrow to file. dayFile gives the day file of a date. */
function writeLatest(out: Output, file: string, dayFile: (date: string) => string, today: string, meta: Record<string, unknown>): void {
  const days = [today, addDays(today, 1)]
    .map((date) => ({ date, doc: readJsonIfExists<PriceDay>(dayFile(date)) }))
    .filter((day): day is { date: string; doc: PriceDay } => day.doc !== undefined);
  const latest = latestOf(days, meta);
  // Without prices for today or tomorrow the previous file stays online: its _meta.days says which days it holds.
  if (latest) out.day(file, latest);
  else if (exists(file)) out.keep(file);
}

/**
 * Build the day files of every dynamic tariff that uses this price source, from the stored
 * responses and the corrections of curation. A day lands next to the yearly file of its year, under
 * the id of the tariff: data/tariffs/<year>/<tariff>/<date>.json. A day of a year whose yearly file
 * has no tariff with this API stays in data/sources/ only, and checks.json lists it.
 */
function buildDays(root: string, org: SourceConfig, source: PriceSource, years: Map<number, TariffDocument>, out: Output, checks: Checks): Set<string> {
  const days = daysIn(paths.daySources(root, source.id));
  const incomplete: IncompleteDay[] = [];
  const withoutTariff: string[] = [];
  const published = new Set<string>();
  const corrections = new Map<string, Curation["prices"]>();
  for (const day of days) {
    const year = day.slice(0, 4);
    const tariffs = tariffsOf(years.get(Number(year)), source);
    if (!tariffs.length) {
      withoutTariff.push(day);
      continue;
    }
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
    for (const tariff of tariffs) {
      published.add(tariff.id);
      out.day(paths.tariffDay(root, tariff.id, day), toJson({
        $schema: `${SCHEMA_BASE}/price-day/v1.schema.json`,
        publication_timestamp: stored.publication_timestamp,
        _meta: {
          tariff: tariff.id,
          name: tariff.tariffName,
          tariffs: `tariffs/${year}.json`,
          date: day,
          complete: check.complete,
          issues: check.issues,
          source: {
            prices: source.id,
            url: source.url,
            file: `sources/days/${source.id}/${year}/${day}.json`,
            resolution_minutes: stored.check.resolution_minutes,
            notes: stored.notes,
          },
          corrections: corrected.applied,
          pricesExcludeVat: true,
        },
        prices,
      }));
    }
  }
  const linked = [...years].flatMap(([year, document]) => tariffsOf(document, source).map((t) => `${year}/${t.id}`));
  checks.sources.days.push({ id: source.id, url: source.url, enabled: source.enabled !== false, days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null });
  checks.days.push({ id: source.id, tariffs: linked, days: days.length, incomplete, withoutTariff });
  console.log(`[${org.slug}] days ${source.id}: ${days.length} days for ${linked.join(", ") || "no tariff"}, ${incomplete.length} incomplete, ${withoutTariff.length} without tariff`);
  return published;
}

// ---------------------------------------------------------------------------------------------
// Products

/** Build data/products/<id>/ for each product of every published year. */
function buildProducts(root: string, org: SourceConfig, years: Map<number, TariffDocument>, out: Output, checks: Checks, today: string): IndexedProduct[] {
  const listed = new Map<string, IndexedProduct>();
  const dynamicProducts = new Map<string, string>();
  for (const [year, document] of years) {
    const tariffs = new Map(document.tariffs.map((tariff) => [tariff.id, tariff]));
    for (const product of document.products) {
      const resolved = productYear(product, document.tariffs);
      const { total, missing } = resolved;
      const used = Object.values(resolved.components).map((c) => c.tariff).filter((t): t is Tariff => t !== undefined);
      const dynamic = used.filter((t) => t.tariffForm === "dynamic");
      const notes = new Set<string>(resolved.notes);
      const dir = paths.products(root, product.id);
      const incomplete: IncompleteDay[] = [];
      let written = 0;
      if (dynamic.length) {
        const first = [`${year}-01-01`, ...used.map((t) => t.startDate)].sort(compareText).at(-1)!;
        const last = [`${year}-12-31`, ...used.map((t) => t.endDate)].sort(compareText)[0];
        const candidates = [...new Set(dynamic.flatMap((t) => datesIn(paths.tariffDays(root, year, t.id))))].sort(compareText)
          .filter((day) => first <= day && day <= last);
        for (const tariff of dynamic) if (!datesIn(paths.tariffDays(root, year, tariff.id)).length) notes.add(`${tariff.id}: no day prices`);
        for (const day of candidates) {
          const inputs = dynamic.map((tariff) => ({ tariffId: tariff.id, doc: readJsonIfExists<PriceDay>(paths.tariffDay(root, tariff.id, day)) }));
          const missingDays = inputs.filter((input) => !input.doc).map((input) => input.tariffId);
          if (missingDays.length) {
            incomplete.push({ date: day, issues: [`no day prices of ${missingDays.join(", ")}`] });
            continue;
          }
          const dayPrices = new Map<string, PriceInterval[]>(inputs.map((input) => [input.tariffId, input.doc!.prices]));
          const composed = composeDay(day, product, tariffs, dayPrices);
          composed.notes.forEach((note) => notes.add(note));
          const partial = inputs.filter((input) => !input.doc!._meta.complete).map((input) => input.tariffId);
          if (partial.length) incomplete.push({ date: day, issues: [`incomplete day prices of ${partial.join(", ")}`] });
          out.day(dayPath(dir, day), toJson({
            $schema: `${SCHEMA_BASE}/price-day/v1.schema.json`,
            publication_timestamp: inputs.map((input) => input.doc!.publication_timestamp).filter((t): t is string => Boolean(t)).sort(compareText).at(-1) ?? null,
            _meta: productDayMeta(product, year, day, partial.length === 0, composed.notes),
            prices: composed.prices,
          }));
          written += 1;
        }
        dynamicProducts.set(product.id, product.name);
      }
      const days = dynamic.length
        ? { latest: siteUrl(org.slug, `products/${product.id}/latest.json`), archive: rawUrl(root, org.slug, `data/products/${product.id}/{year}/{date}.json`) }
        : null;
      out.json(paths.productYear(root, product.id, year), productDocument(document, product, year, resolved, days, [...notes].sort(compareText)));
      const entry = listed.get(product.id) ?? { id: product.id, name: product.name, default: [], years: [], dynamic: false };
      entry.name = product.name;
      entry.years.push(year);
      if (product.default) entry.default.push(year);
      entry.dynamic ||= dynamic.length > 0;
      listed.set(product.id, entry);
      checks.products.push({
        id: product.id, year, default: product.default === true, status: product.status, missing,
        dynamic: total.dynamic, days: written, incomplete, notes: [...notes].sort(compareText),
      });
      console.log(`[${org.slug}] product ${product.id} ${year}${product.default ? " (default)" : ""}${dynamic.length ? `: ${written} days` : ""}`);
    }
  }
  for (const [id, name] of dynamicProducts) {
    const dir = paths.products(root, id);
    writeLatest(out, path.join(dir, "latest.json"), (date) => dayPath(dir, date), today, { product: id, name, license: org.data_license ?? null });
  }
  return [...listed.values()];
}

function productDocument(document: TariffDocument, product: Product, year: number, resolved: ProductYear,
  days: ProductDocument["_meta"]["days"], notes: string[]): ProductDocument {
  return toJson({
    $schema: `${SCHEMA_BASE}/product/v1.schema.json`,
    id: product.id,
    name: product.name,
    year,
    status: product.status,
    default: product.default === true,
    selection: product.selection,
    note: product.note,
    sourceUrl: product.sourceUrl,
    dsoName: document.dsoName,
    dsoNumber: document.dsoNumber,
    pricesExcludeVat: true,
    total: resolved.total,
    missing: resolved.missing,
    municipalities: resolved.municipalities,
    components: resolved.components,
    _meta: {
      schemaVersion: SCHEMA_VERSION,
      vseVersion: WRITTEN_VSE_VERSION,
      generator: GENERATOR,
      tariffs: `tariffs/${year}.json`,
      days,
      notes,
    },
  });
}

function productDayMeta(product: Product, year: number, day: string, complete: boolean, notes: string[]) {
  return {
    product: product.id,
    name: product.name,
    status: product.status,
    default: product.default === true,
    date: day,
    complete,
    components: Object.fromEntries(Object.entries(product.components).filter(([, c]) => c.tariff).map(([slot, c]) => [slot, c.tariff])),
    tariffs: `tariffs/${year}.json`,
    year: `products/${product.id}/${year}.json`,
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
  const years = onlineYears(root);
  const dynamicTariffs = new Set<string>();
  for (const source of org.prices) for (const id of buildDays(root, org, source, years, out, checks)) dynamicTariffs.add(id);
  for (const id of dynamicTariffs) {
    const tariff = [...years.values()].flatMap((d) => d.tariffs).find((t) => t.id === id)!;
    writeLatest(out, paths.tariffLatest(root, id), (date) => paths.tariffDay(root, id, date), today,
      { tariff: id, name: tariff.tariffName, license: org.data_license ?? null });
  }
  out.prune(root, "tariffs"); // before the products, which read the day files of the tariffs
  const products = buildProducts(root, org, years, out, checks, today);
  out.prune(root, "products");
  writeChecks(root, checks);
  writeIndex(root, org, years, products);
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
