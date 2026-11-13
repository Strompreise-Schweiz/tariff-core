/** data/index.json: one stable entry point per utility that lists every URL. */
import path from "node:path";

import { deepEqual, toJson } from "../core/json.ts";
import type { SourceConfig } from "../core/types.ts";
import { exists, namesIn, readJsonIfExists, writeJson } from "./files.ts";
import { dynamicDir, rawUrl, repositoryUrl, siteUrl } from "./repo.ts";

export function writeIndex(root: string, org: SourceConfig): void {
  const { slug } = org;
  const tariffsDir = path.join(root, "data", "tariffs");
  const years = namesIn(tariffsDir, /^\d{4}\.json$/).map((name) => name.slice(0, 4));
  const dynamic = org.dynamic
    .filter((tariff) => tariff.enabled !== false && exists(path.join(dynamicDir(root, tariff), "latest.json")))
    .map((tariff) => ({
      id: tariff.id,
      name: tariff.name,
      components: tariff.components ?? [],
      valid_from: tariff.valid_from ?? null,
      valid_to: tariff.valid_to ?? null,
      latest: rawUrl(root, slug, `data/dynamic/${tariff.id}/latest.json`),
      archive: rawUrl(root, slug, `data/dynamic/${tariff.id}/vse/{year}/{date}.json`),
      source: tariff.api_url,
    }));
  const index = toJson({
    $comment: "Stable entry point for this organization. All URLs below stay valid. " +
      "Every path under data/ is also served under site.",
    organization: org.name,
    slug,
    vse_id: org.vse_id,
    elcom_id: org.elcom_id ?? null,
    website: org.website ?? null,
    license: org.data_license ?? null,
    repository: repositoryUrl(root, slug),
    site: siteUrl(slug, ""),
    static: {
      current: exists(path.join(tariffsDir, "current.json")) ? rawUrl(root, slug, "data/tariffs/current.json") : null,
      years: Object.fromEntries(years.map((year) => [year, rawUrl(root, slug, `data/tariffs/${year}.json`)])),
    },
    vse_conformance: exists(path.join(root, "data", "vse-conformance.json")) ? rawUrl(root, slug, "data/vse-conformance.json") : null,
    status: exists(path.join(root, "data", "status.json")) ? rawUrl(root, slug, "data/status.json") : null,
    dynamic,
  });
  const file = path.join(root, "data", "index.json");
  if (!deepEqual(readJsonIfExists(file), index)) writeJson(file, index);
}
