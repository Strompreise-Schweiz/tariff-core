/** data/index.json: one stable entry point per utility that lists every URL. */
import path from "node:path";

import { deepEqual, toJson } from "../core/json.ts";
import type { SourceConfig } from "../core/types.ts";
import { exists, namesIn, readJsonIfExists, writeJson } from "./files.ts";
import { daysIn, paths, rawUrl, repositoryUrl, siteUrl } from "./repo.ts";

export interface IndexedProduct {
  id: string;
  name: string;
}

export function writeIndex(root: string, org: SourceConfig, products: IndexedProduct[]): void {
  const { slug } = org;
  const tariffsDir = paths.tariffs(root);
  const years = namesIn(tariffsDir, /^\d{4}\.json$/).map((name) => name.slice(0, 4));
  const daily = (kind: "prices" | "products", id: string) => ({
    latest: exists(path.join(paths.data(root), kind, id, "latest.json")) ? siteUrl(slug, `${kind}/${id}/latest.json`) : null,
    // The site serves the current year, git every year.
    archive: rawUrl(root, slug, `data/${kind}/${id}/{year}/{date}.json`),
  });
  const index = toJson({
    $comment: "Stable entry point for this utility. Every path under data/ is also served under site.",
    organization: org.name,
    slug,
    vse_id: org.vse_id,
    elcom_id: org.elcom_id ?? null,
    website: org.website ?? null,
    license: org.data_license ?? null,
    repository: repositoryUrl(root, slug),
    site: siteUrl(slug, ""),
    checks: siteUrl(slug, "checks.json"),
    tariffs: {
      current: exists(path.join(tariffsDir, "current.json")) ? siteUrl(slug, "tariffs/current.json") : null,
      years: Object.fromEntries(years.map((year) => [year, siteUrl(slug, `tariffs/${year}.json`)])),
    },
    prices: org.prices
      .filter((source) => daysIn(paths.prices(root, source.id)).length > 0)
      .map((source) => ({ id: source.id, name: source.name, ...daily("prices", source.id), source: source.url })),
    products: products.map((product) => ({ id: product.id, name: product.name, ...daily("products", product.id) })),
  });
  const file = path.join(paths.data(root), "index.json");
  if (!deepEqual(readJsonIfExists(file), index)) writeJson(file, index);
}
