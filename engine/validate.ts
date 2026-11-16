/** Validates an org repo or the hub repo. The rules are in core/rules.ts. */
import path from "node:path";

import { applyWaivers, documentIssues, hubIssues, priceDayIssues, schemaIssues } from "./core/rules.ts";
import type { Curation, PriceDay, SourceConfig, TariffDocument } from "./core/types.ts";
import { exists, namesIn, readJson, readJsonIfExists } from "./lib/files.ts";
import { annotate, NO_UTILITY, parseCli, report } from "./lib/cli.ts";
import { configPath, datesIn, dayPath, daysIn, inHub, paths, utilityRoots } from "./lib/repo.ts";

const USAGE = `
Validates an org repo or the hub repo: schema checks plus the rules JSON Schema cannot express.
Issue codes are stable, so curation/<year>.json can accept a specific one with a reason.

Usage, from the root of the repo:  node ../tariff-core/engine/validate.ts [--all-days]

  --all-days   check every day file, not only the newest ones
`;

/** The newest day files of a folder, sorted by date. */
function newest(files: string[], allDays: boolean): string[] {
  return allDays ? files : files.slice(-3);
}

/** Day files and files with today and tomorrow, under tariffs/ and products/. */
function dayFiles(root: string, allDays: boolean): string[] {
  const tariffsDir = paths.tariffs(root);
  const files: string[] = [];
  for (const year of namesIn(tariffsDir, /^\d{4}$/)) {
    for (const tariff of namesIn(path.join(tariffsDir, year), /./)) {
      const dir = path.join(tariffsDir, year, tariff);
      files.push(...newest(datesIn(dir).map((day) => path.join(dir, `${day}.json`)), allDays));
    }
  }
  files.push(...namesIn(path.join(tariffsDir, "current"), /\.json$/).map((name) => path.join(tariffsDir, "current", name)));
  const productsDir = path.join(paths.data(root), "products");
  for (const id of namesIn(productsDir, /./)) {
    const dir = path.join(productsDir, id);
    files.push(...newest(daysIn(dir).map((day) => dayPath(dir, day)), allDays));
    if (exists(path.join(dir, "latest.json"))) files.push(path.join(dir, "latest.json"));
  }
  return files;
}

/** The yearly files of the products. */
function productFiles(root: string): string[] {
  const productsDir = path.join(paths.data(root), "products");
  return namesIn(productsDir, /./).flatMap((id) => namesIn(path.join(productsDir, id), /^\d{4}\.json$/).map((name) => path.join(productsDir, id, name)));
}

export function validateUtility(root: string, cwd: string, allDays = false): number {
  const label = (file: string) => path.relative(cwd, file);
  const config = readJson<SourceConfig>(configPath(root));
  let errors = report(schemaIssues(config, "source-config"), label(configPath(root)));
  if (inHub(root) && errors === 0) errors += report(hubIssues(path.basename(root), config), label(root));

  const supplier = path.join(paths.data(root), "supplier.json");
  if (exists(supplier)) errors += report(schemaIssues(readJson(supplier), "supplier"), label(supplier));

  const curationDir = path.join(root, "curation");
  for (const name of namesIn(curationDir, /^\d{4}\.json$/)) {
    const file = path.join(curationDir, name);
    errors += report(schemaIssues(readJson(file), "curation"), label(file));
  }

  const tariffsDir = paths.tariffs(root);
  for (const name of namesIn(tariffsDir, /^\d{4}\.json$/)) {
    const file = path.join(tariffsDir, name);
    const waivers = readJsonIfExists<Curation>(path.join(curationDir, name))?.acceptIssues;
    const issues = documentIssues(readJson<TariffDocument>(file), Number(name.slice(0, 4)), config.vse_id);
    errors += report(applyWaivers(issues, waivers), label(file));
  }

  for (const file of productFiles(root)) errors += report(schemaIssues(readJson(file), "product"), label(file));
  for (const file of dayFiles(root, allDays)) errors += report(priceDayIssues(path.basename(file), readJson<PriceDay>(file)), label(file));
  return errors;
}

export function main(args = process.argv.slice(2), cwd = process.cwd()): number {
  const { values } = parseCli(USAGE, { "all-days": { type: "boolean" } }, args);
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  const errors = roots.reduce((sum, root) => sum + validateUtility(root, cwd, values["all-days"]), 0);
  console.log(`validation finished: ${errors} error(s)`);
  return errors ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
