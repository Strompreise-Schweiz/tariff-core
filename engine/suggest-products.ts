/** Prints product proposals. The matching is in core/products.ts. */
import path from "node:path";

import { suggestProducts } from "./core/products.ts";
import type { TariffDocument } from "./core/types.ts";
import { parseCli } from "./lib/cli.ts";
import { readJson } from "./lib/files.ts";

const USAGE = `
Proposes which tariffs form a product, because the VSE format has no link between electricity,
grid, metering and regional_fees. It matches on voltage level and customer group and prints
candidates with status "suggested".

A person checks them against the price sheet, sets "verified" plus sourceUrl and copies them to
curation/<year>.json.

Usage, from the root of an org repo (in the hub: from utilities/<slug>/):

  node ../tariff-core/engine/suggest-products.ts <year>
`;

export function main(args = process.argv.slice(2), cwd = process.cwd()): number {
  const { positionals: [year] } = parseCli(USAGE, {}, args);
  if (!/^\d{4}$/.test(year ?? "")) {
    console.error(USAGE.trim());
    return 2;
  }
  const document = readJson<TariffDocument>(path.join(cwd, "data", "tariffs", `${year}.json`));
  console.log(JSON.stringify({ year: Number(year), products: suggestProducts(document) }, null, 2));
  return 0;
}

if (import.meta.main) process.exitCode = main();
