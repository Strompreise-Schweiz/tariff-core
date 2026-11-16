/** Where things are: utility roots, their config, and the public URLs of their files. */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseTimestamp, inUtc, type Moment } from "../core/time.ts";
import type { SourceConfig } from "../core/types.ts";
import { exists, namesIn, readJson } from "./files.ts";

export const ORG = "Strompreise-Schweiz";
export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA_BASE = `https://raw.githubusercontent.com/${ORG}/tariff-core/main/schemas`;
// Own domain in front of GitHub Pages. The hub repo is the organization site, so every
// utility has the same URL whether it lives in the hub or in its own repo.
export const SITE_BASE = "https://data.strompreise-schweiz.ch";
// Utilities without dynamic tariffs live in this repo, one folder each under HUB_DIR.
export const HUB_REPO = "strompreise-schweiz.github.io";
export const HUB_DIR = "utilities";

/** Current time. TARIFF_ETL_NOW pins it for tests and reproductions. */
export function now(): Moment {
  const pinned = process.env.TARIFF_ETL_NOW;
  return inUtc(pinned ? parseTimestamp(pinned).ms : Date.now());
}

export function configPath(root: string): string {
  return path.join(root, "config", "source.json");
}

export function loadConfig(root: string): SourceConfig {
  return readJson<SourceConfig>(configPath(root));
}

/**
 * The utility roots to process from cwd. An own repo is one utility; the hub repo holds one
 * utility per folder under utilities/.
 */
export function utilityRoots(cwd: string): string[] {
  if (exists(configPath(cwd))) return [cwd];
  const hub = path.join(cwd, HUB_DIR);
  return namesIn(hub, /./).map((name) => path.join(hub, name)).filter((dir) => exists(configPath(dir)));
}

export function inHub(root: string): boolean {
  return path.basename(path.dirname(path.resolve(root))) === HUB_DIR;
}

/**
 * The layout of data/, the same in every utility:
 *
 *     sources/<name>.json                       yearly file of the utility, unchanged
 *     sources/days/<id>/<year>/<date>.json      response of a day price API, unchanged
 *     tariffs/<year>.json, current.json         yearly file, repaired and corrected
 *     tariffs/<year>/<tariff>/<date>.json       day prices of a dynamic tariff of <year>.json, corrected
 *     tariffs/current/<tariff>.json             today and tomorrow of a dynamic tariff
 *     products/<id>/<year>.json                 what a customer pays: every component and the total
 *     products/<id>/<year>/<date>.json          a product with a dynamic tariff: every component per quarter hour
 *     products/<id>/latest.json                 today and tomorrow of such a product
 *     checks.json                               what is wrong with all of the above
 */
export const paths = {
  data: (root: string) => path.join(root, "data"),
  tariffSource: (root: string, name: string) => path.join(root, "data", "sources", `${name}.json`),
  daySources: (root: string, id: string) => path.join(root, "data", "sources", "days", id),
  tariffs: (root: string) => path.join(root, "data", "tariffs"),
  /** The day prices of one dynamic tariff in the yearly file of a year. */
  tariffDays: (root: string, year: number | string, tariff: string) => path.join(root, "data", "tariffs", String(year), tariff),
  tariffDay: (root: string, tariff: string, day: string) => path.join(root, "data", "tariffs", day.slice(0, 4), tariff, `${day}.json`),
  tariffLatest: (root: string, tariff: string) => path.join(root, "data", "tariffs", "current", `${tariff}.json`),
  products: (root: string, id: string) => path.join(root, "data", "products", id),
  productYear: (root: string, id: string, year: number) => path.join(root, "data", "products", id, `${year}.json`),
  checks: (root: string) => path.join(root, "data", "checks.json"),
};

/** <dir>/<year>/<date>.json */
export function dayPath(dir: string, day: string): string {
  return path.join(dir, day.slice(0, 4), `${day}.json`);
}

/** The dates of the day files below a folder of year folders, sorted. */
export function daysIn(dir: string): string[] {
  return namesIn(dir, /^\d{4}$/).flatMap((year) => datesIn(path.join(dir, year)));
}

/** The dates of the day files directly in a folder, sorted. */
export function datesIn(dir: string): string[] {
  return namesIn(dir, /^\d{4}-\d{2}-\d{2}\.json$/).map((name) => name.slice(0, 10));
}

/** URL of a file in git, relative to the utility root. Works without the own domain. */
export function rawUrl(root: string, slug: string, relative: string): string {
  return inHub(root)
    ? `https://raw.githubusercontent.com/${ORG}/${HUB_REPO}/main/${HUB_DIR}/${slug}/${relative}`
    : `https://raw.githubusercontent.com/${ORG}/${slug}/main/${relative}`;
}

/** URL on the own domain. The site serves the utility's data/ folder under /<slug>/. */
export function siteUrl(slug: string, relative: string): string {
  return `${SITE_BASE}/${slug}/${relative.replace(/^data\//, "")}`;
}

export function repositoryUrl(root: string, slug: string): string {
  return inHub(root) ? `https://github.com/${ORG}/${HUB_REPO}/tree/main/${HUB_DIR}/${slug}` : `https://github.com/${ORG}/${slug}`;
}
