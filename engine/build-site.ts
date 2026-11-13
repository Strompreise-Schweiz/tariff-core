/** Builds the folder GitHub Pages serves. See USAGE. Node built-ins only. */
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { compareText } from "./core/json.ts";
import { zurichDate } from "./core/time.ts";
import { annotate, NO_UTILITY, parseCli } from "./lib/cli.ts";
import { filesBelow, isDirectory, readJsonIfExists, writeJson } from "./lib/files.ts";
import { ENGINE_ROOT, inHub, loadConfig, now, ORG, repositoryUrl, SITE_BASE, siteUrl, utilityRoots } from "./lib/repo.ts";

const USAGE = `
Builds the folder that GitHub Pages serves. Run from the root of an org repo or the hub repo.

Usage:  node ../tariff-core/engine/build-site.ts [--out _site]

    org repo:  data/                    -> <out>/            served as /<slug>/
    hub repo:  utilities/<slug>/data/   -> <out>/<slug>/     served as /<slug>/
               every utility            -> <out>/index.json  served as /index.json
               status page              -> <out>/status.html served as /status.html

The hub repo is the organization site, an org repo a project site below it, so a utility has the
same URL in both places. A Pages site is limited to 1 GB, so the dynamic archive is served for the
current year only. Older years stay in git and on raw.githubusercontent.com.
`;

const ARCHIVE_DIRS = new Set(["raw", "vse", "normalized"]);
// Warn well before the 1 GB limit of a Pages site.
const WARN_BYTES = 800 * 1024 * 1024;
const MB = 1024 * 1024;

/** True for dynamic/<id>/(raw|vse|normalized)/<year>/... with a past year. */
export function isOldArchive(relative: string, currentYear: number): boolean {
  const parts = relative.split(path.sep);
  if (parts[0] !== "dynamic") return false;
  const archive = parts.findIndex((part, i) => ARCHIVE_DIRS.has(part) && /^\d{4}$/.test(parts[i + 1] ?? ""));
  return archive >= 0 && Number(parts[archive + 1]) < currentYear;
}

/** Copy one utility's data/ folder. Returns the bytes copied. */
function copyData(data: string, target: string, currentYear: number): number {
  let copied = 0;
  for (const file of filesBelow(data)) {
    const relative = path.relative(data, file);
    if (isOldArchive(relative, currentYear)) continue;
    const destination = path.join(target, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    copied += statSync(file).size;
  }
  return copied;
}

interface ListedRepository {
  slug: string;
  name: string;
  vse_id?: string;
  elcom_id?: number;
}

/** All utilities, in the hub and in own repos from repositories.json. Schema: schemas/overall-index/. */
function overallIndex(cwd: string, roots: string[]) {
  const hubEntries = roots.map((root) => {
    const { slug, name, vse_id, elcom_id } = loadConfig(root);
    return {
      slug, name, vse_id, elcom_id: elcom_id ?? null, maintained_in: "hub",
      repository: repositoryUrl(root, slug), index: siteUrl(slug, "data/index.json"),
    };
  });
  const listed = readJsonIfExists<{ repositories: ListedRepository[] }>(path.join(cwd, "repositories.json"))?.repositories ?? [];
  const ownEntries = listed.map(({ slug, name, vse_id, elcom_id }) => ({
    slug, name, vse_id: vse_id ?? null, elcom_id: elcom_id ?? null, maintained_in: "own_repository",
    repository: `https://github.com/${ORG}/${slug}`, index: siteUrl(slug, "data/index.json"),
  }));
  return {
    $comment: "Every utility of Strompreise Schweiz. Follow index for its tariffs.",
    site: `${SITE_BASE}/`,
    utilities: [...hubEntries, ...ownEntries].sort((a, b) => compareText(a.slug, b.slug)),
  };
}

export function buildSite(cwd: string, out: string): number {
  const roots = utilityRoots(cwd);
  if (!roots.length) {
    annotate("error", NO_UTILITY);
    return 1;
  }
  const currentYear = Number(zurichDate(now().ms).slice(0, 4));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const hub = inHub(roots[0]);
  let total = 0;
  for (const root of roots) {
    const data = path.join(root, "data");
    if (isDirectory(data)) total += copyData(data, hub ? path.join(out, path.basename(root)) : out, currentYear);
  }
  if (hub) {
    const index = overallIndex(cwd, roots);
    const slugs = index.utilities.map((entry) => entry.slug);
    const duplicates = [...new Set(slugs.filter((slug, i) => slugs.indexOf(slug) !== i))].sort(compareText);
    if (duplicates.length) {
      annotate("error", `in the hub and in repositories.json at the same time: ${duplicates.join(", ")}`);
      return 1;
    }
    writeJson(path.join(out, "index.json"), index);
    // The status page reads every utility's status.json from this domain.
    copyFileSync(path.join(ENGINE_ROOT, "site", "status.html"), path.join(out, "status.html"));
  }
  if (total > WARN_BYTES) annotate("warning", `site is ${Math.round(total / MB)} MB, GitHub Pages allows 1 GB`);
  console.log(`site built in ${out}: ${(total / MB).toFixed(1)} MB`);
  return 0;
}

export function main(args = process.argv.slice(2), cwd = process.cwd()): number {
  const { values } = parseCli(USAGE, { out: { type: "string", default: "_site" } }, args);
  return buildSite(cwd, path.resolve(cwd, values.out));
}

if (import.meta.main) process.exitCode = main();
