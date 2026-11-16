/** data/index.json: one stable entry point per utility that lists every URL. */
import path from "node:path";

import { compareText, deepEqual, toJson } from "../core/json.ts";
import type { SourceConfig, TariffDocument } from "../core/types.ts";
import { exists, readJsonIfExists, writeJson } from "./files.ts";
import { datesIn, paths, rawUrl, repositoryUrl, siteUrl } from "./repo.ts";

export interface IndexedProduct {
  id: string;
  name: string;
  /** The years in which this product is the standard product. */
  default: number[];
  years: number[];
  dynamic: boolean;
}

export function writeIndex(root: string, org: SourceConfig, years: Map<number, TariffDocument>, products: IndexedProduct[]): void {
  const { slug } = org;
  const tariffsDir = paths.tariffs(root);
  const sorted = [...years.keys()].sort((a, b) => a - b);
  // Each dynamic tariff with day prices, once, with the years it has days in.
  const dynamic = new Map<string, { name: string; years: number[] }>();
  for (const year of sorted) {
    for (const tariff of years.get(year)!.tariffs.filter((t) => t.tariffForm === "dynamic")) {
      if (!datesIn(paths.tariffDays(root, year, tariff.id)).length) continue;
      const entry = dynamic.get(tariff.id) ?? { name: tariff.tariffName, years: [] };
      entry.years.push(year);
      dynamic.set(tariff.id, entry);
    }
  }
  const byDefault = (p: IndexedProduct) => (p.default.length ? 0 : 1);
  const index = toJson({
    $comment: "Stable entry point for this utility. Every path under data/ is also served under site. " +
      "Start with products: the default product is what a household pays without choosing anything.",
    organization: org.name,
    slug,
    vse_id: org.vse_id,
    elcom_id: org.elcom_id ?? null,
    website: org.website ?? null,
    license: org.data_license ?? null,
    repository: repositoryUrl(root, slug),
    site: siteUrl(slug, ""),
    checks: siteUrl(slug, "checks.json"),
    products: [...products].sort((a, b) => byDefault(a) - byDefault(b) || compareText(a.id, b.id)).map((product) => ({
      id: product.id,
      name: product.name,
      default: product.default,
      years: Object.fromEntries(product.years.map((year) => [year, siteUrl(slug, `products/${product.id}/${year}.json`)])),
      days: product.dynamic && exists(path.join(paths.products(root, product.id), "latest.json"))
        ? { latest: siteUrl(slug, `products/${product.id}/latest.json`), archive: rawUrl(root, slug, `data/products/${product.id}/{year}/{date}.json`) }
        : null,
    })),
    tariffs: {
      current: exists(path.join(tariffsDir, "current.json")) ? siteUrl(slug, "tariffs/current.json") : null,
      years: Object.fromEntries(sorted.map((year) => [year, siteUrl(slug, `tariffs/${year}.json`)])),
      days: [...dynamic].map(([id, entry]) => ({
        tariff: id,
        name: entry.name,
        years: entry.years,
        latest: exists(paths.tariffLatest(root, id)) ? siteUrl(slug, `tariffs/current/${id}.json`) : null,
        // The site serves the current year, git every year.
        archive: rawUrl(root, slug, `data/tariffs/{year}/${id}/{date}.json`),
      })),
    },
  });
  const file = path.join(paths.data(root), "index.json");
  if (!deepEqual(readJsonIfExists(file), index)) writeJson(file, index);
}
