/** Publishes static tariffs. See USAGE. */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { applyCuration, assignIds } from "./core/curation.ts";
import { excludeBrokenTariffs } from "./core/exclusion.ts";
import { deepEqual, toJson } from "./core/json.ts";
import { repairStatic, type RepairedDocument } from "./core/normalizers/static-vse.ts";
import { applyWaivers, documentIssues } from "./core/rules.ts";
import { VSE_VERSIONS } from "./core/vse.ts";
import { formatTimestamp, zurichDate } from "./core/time.ts";
import type { Curation, Repair, SourceConfig, StaticSource, Tariff, TariffDocument } from "./core/types.ts";
import engine from "../package.json" with { type: "json" };
import { annotate, NO_UTILITY, parseCli, report } from "./lib/cli.ts";
import { exists, parseJson, readJson, readJsonIfExists, writeFile, writeJson } from "./lib/files.ts";
import { http } from "./lib/http.ts";
import { loadConfig, now, SCHEMA_BASE, utilityRoots } from "./lib/repo.ts";
import { checkAllVersions, writeConformance } from "./lib/conformance.ts";
import { writeIndex } from "./lib/site-index.ts";
import { writeStatus, yearStatus, type YearStatus } from "./lib/status.ts";

const USAGE = `
Static tariffs: fetch, repair, apply curation, validate, publish.

Usage, from the root of an org repo, or of the hub repo to publish every utility in it:

  node ../tariff-core/engine/publish-static.ts [--offline]

  --offline   rebuild from data/static/raw without fetching

    source (url or file) -> data/static/raw/<name>.json   byte-exact
                         -> repairs in core/normalizers/static-vse.ts
                         -> curation/<year>.json          overrides and products
                         -> validate
                         -> data/tariffs/<year>.json + current.json

A source can hold several years (EKZ publishes 2026 and 2027 in one file), so the output is split by
the start year of each tariff. A year with errors is not published: the previous file stays online
and data/tariffs/<year>.report.json explains what is wrong.
`;

type Origin = TariffDocument["_meta"]["source"][number];

// The files of this project follow this version of the VSE definition. Sources may follow any.
const WRITTEN_VSE_VERSION = "1.0.1";
const GENERATOR = { name: "tariff-core", version: engine.version, url: "https://github.com/Strompreise-Schweiz/tariff-core" };
type RepairedTariff = RepairedDocument["tariffs"][number];

/** The source bytes and where they came from. */
async function readSource(root: string, source: StaticSource, offline: boolean): Promise<{ data: Buffer; origin: Origin }> {
  const rawPath = path.join(root, "data", "static", "raw", `${source.name}.json`);
  let data: Buffer;
  if (source.file) data = readFileSync(path.join(root, source.file));
  else if (source.url) data = offline ? readFileSync(rawPath) : await http.fetchBytes(source.url);
  else throw new Error("the source needs url or file");
  if (!offline) writeFile(rawPath, data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  let conformsTo: string[] = [];
  try {
    const results = checkAllVersions(parseJson(data));
    conformsTo = VSE_VERSIONS.filter((version) => results[version].valid);
  } catch { // not JSON: reported when the source is repaired
  }
  const origin = source.file
    ? { name: source.name, file: source.file, sha256, conformsTo }
    : { name: source.name, url: source.url, sha256, conformsTo };
  return { data, origin };
}

interface Collected {
  dsoName: string | null;
  dsoNumber: number | null;
  repairs: Repair[];
  origins: Origin[];
  byYear: Map<number, RepairedTariff[]>;
  failures: number;
}

/** Read and repair every enabled source, and sort the tariffs by start year. */
async function collect(root: string, org: SourceConfig, offline: boolean, currentYear: number): Promise<Collected> {
  const result: Collected = { dsoName: null, dsoNumber: null, repairs: [], origins: [], byYear: new Map(), failures: 0 };
  for (const source of org.static.sources.filter((s) => s.enabled !== false)) {
    const fail = (message: string) => {
      annotate("error", `${org.slug} source ${source.name}: ${message}`);
      result.failures += 1;
    };
    let repaired: ReturnType<typeof repairStatic>;
    let origin: Origin;
    try {
      const read = await readSource(root, source, offline);
      origin = read.origin;
      repaired = repairStatic(parseJson(read.data));
    } catch (error) { // report it and keep the online version
      fail((error as Error).message);
      continue;
    }
    repaired.problems.forEach(fail);
    result.origins.push(origin);
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

/** Publish one utility. Returns 1 if a source or a year failed. */
export async function publish(root: string, offline = false): Promise<number> {
  const org = loadConfig(root);
  const moment = now();
  const generatedAt = formatTimestamp(moment);
  const currentYear = Number(zurichDate(moment.ms).slice(0, 4));
  const collected = await collect(root, org, offline, currentYear);
  let failures = collected.failures;
  const tariffsDir = path.join(root, "data", "tariffs");
  const years: YearStatus[] = [];

  for (const year of [...collected.byYear.keys()].sort((a, b) => a - b)) {
    const curation = readJsonIfExists<Curation>(path.join(root, "curation", `${year}.json`)) ?? {};
    const curated = applyCuration(collected.byYear.get(year)!, curation);
    const built: TariffDocument = toJson({
      $schema: `${SCHEMA_BASE}/tariff-document/v1.schema.json`,
      dsoName: collected.dsoName!,
      dsoNumber: collected.dsoNumber!,
      _meta: {
        schemaVersion: "1.0",
        vseVersion: WRITTEN_VSE_VERSION,
        generator: GENERATOR,
        year,
        generatedAt,
        source: collected.origins,
        pricesExcludeVat: true,
        repairs: collected.repairs,
        overrides: curated.applied,
        issues: [],
        excluded: [],
      },
      tariffs: assignIds(curated.tariffs) as Tariff[],
      products: curation.products ?? [],
    });
    const checkYear = (doc: TariffDocument) =>
      applyWaivers([...curated.issues, ...documentIssues(doc, year, org.vse_id)], curation.acceptIssues);
    // A tariff with an error of its own is left out and listed, so it does not block the rest of the year.
    const { document, excluded, issues } = excludeBrokenTariffs(built, checkYear);
    document._meta.excluded = excluded;
    document._meta.issues = issues.filter((issue) => issue.severity !== "error");
    if (excluded.length) {
      annotate("warning", `${org.slug} ${year}: left out ${excluded.length} tariffs with errors, see _meta.excluded`);
      for (const tariff of excluded) console.log(`  left out ${tariff.id}: ${tariff.problems.join("; ")}`);
    }
    const errors = report(issues, `${org.slug} ${year}`);
    const reportPath = path.join(tariffsDir, `${year}.report.json`);
    years.push(yearStatus(year, issues, errors === 0 || exists(path.join(tariffsDir, `${year}.json`)), excluded.length));
    if (errors) {
      failures += errors;
      writeJson(reportPath, { year, published: false, issues });
      continue;
    }
    rmSync(reportPath, { force: true });
    const output = path.join(tariffsDir, `${year}.json`);
    const previous = readJsonIfExists<TariffDocument>(output);
    if (previous && deepEqual({ ...previous, _meta: { ...previous._meta, generatedAt } }, document)) {
      console.log(`[${org.slug}] ${year}: unchanged`);
      continue;
    }
    writeJson(output, document);
    const left = excluded.length ? `, ${excluded.length} left out` : "";
    console.log(`[${org.slug}] ${year}: published ${document.tariffs.length} tariffs${left}, ${document.products.length} products`);
  }

  const current = path.join(tariffsDir, `${currentYear}.json`);
  const alias = path.join(tariffsDir, "current.json");
  if (exists(current) && !deepEqual(readJsonIfExists(alias), readJson(current))) writeFile(alias, readFileSync(current));
  writeStatus(root, org, years, writeConformance(root, org));
  writeIndex(root, org);
  return failures ? 1 : 0;
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const { values } = parseCli(USAGE, { offline: { type: "boolean" } }, args);
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  // Publish every utility, also after a failure: one broken source must not block the others.
  let failed = false;
  for (const root of roots) failed = (await publish(root, values.offline)) !== 0 || failed;
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
