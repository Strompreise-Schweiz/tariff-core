/** Validates an org repo or the hub repo. The rules are in core/rules.ts. */
import path from "node:path";

import { applyWaivers, documentIssues, dynamicDayIssues, hubIssues, schemaIssues } from "./core/rules.ts";
import type { Curation, DynamicDay, SourceConfig, TariffDocument } from "./core/types.ts";
import { exists, filesBelow, namesIn, readJson, readJsonIfExists } from "./lib/files.ts";
import { annotate, NO_UTILITY, parseCli, report } from "./lib/cli.ts";
import { configPath, dynamicDir, inHub, utilityRoots } from "./lib/repo.ts";

const USAGE = `
Validates an org repo or the hub repo: schema checks plus the rules JSON Schema cannot express.
Issue codes are stable, so curation/<year>.json can accept a specific one with a reason.

Usage, from the root of the repo:  node ../tariff-core/engine/validate.ts [--all-days]

  --all-days   check the whole dynamic archive, not only the newest days
`;

export function validateUtility(root: string, cwd: string, allDays = false): number {
  const label = (file: string) => path.relative(cwd, file);
  const config = readJson<SourceConfig>(configPath(root));
  let errors = report(schemaIssues(config, "source-config"), label(configPath(root)));
  if (inHub(root)) errors += report(hubIssues(path.basename(root), config), label(root));

  const supplier = path.join(root, "data", "supplier.json");
  if (exists(supplier)) errors += report(schemaIssues(readJson(supplier), "supplier"), label(supplier));

  const curationDir = path.join(root, "curation");
  for (const name of namesIn(curationDir, /^\d{4}\.json$/)) {
    const file = path.join(curationDir, name);
    errors += report(schemaIssues(readJson(file), "curation"), label(file));
  }

  const tariffsDir = path.join(root, "data", "tariffs");
  for (const name of namesIn(tariffsDir, /^\d{4}\.json$/)) {
    const file = path.join(tariffsDir, name);
    const waivers = readJsonIfExists<Curation>(path.join(curationDir, name))?.acceptIssues;
    const issues = documentIssues(readJson<TariffDocument>(file), Number(name.slice(0, 4)), config.vse_id);
    errors += report(applyWaivers(issues, waivers), label(file));
  }

  for (const tariff of config.dynamic ?? []) {
    const base = dynamicDir(root, tariff);
    const days = filesBelow(path.join(base, "vse")).filter((file) => file.endsWith(".json"));
    const latest = path.join(base, "latest.json");
    for (const file of [...(allDays ? days : days.slice(-3)), ...(exists(latest) ? [latest] : [])]) {
      errors += report(dynamicDayIssues(path.basename(file), readJson<DynamicDay>(file)), label(file));
    }
  }
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
