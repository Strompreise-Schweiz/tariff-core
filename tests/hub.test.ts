import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildSite } from "../engine/build-site.ts";
import { hubIssues } from "../engine/core/rules.ts";
import { schemaIssues } from "../engine/core/schemas.ts";
import type { SourceConfig } from "../engine/core/types.ts";
import { rawUrl, siteUrl, utilityRoots } from "../engine/lib/repo.ts";
import { build, main as buildMain } from "../engine/build.ts";
import { main as validateMain } from "../engine/validate.ts";
import { ekzLike, readJsonFile, setNow, tempDir, writeJsonFile, type Obj } from "./helpers.ts";

function addUtility(
  hub: string, slug: string, { folder, prices, elcomId }: { folder?: string; prices?: Obj[]; elcomId?: number } = {},
): string {
  const root = path.join(hub, "utilities", folder ?? slug);
  writeJsonFile(path.join(root, "curation/source.json"), ekzLike());
  writeJsonFile(path.join(root, "config/source.json"), {
    slug, name: slug[0].toUpperCase() + slug.slice(1), vse_id: "CH10000000001", prices: prices ?? [],
    ...(elcomId ? { elcom_id: elcomId } : {}),
    tariffs: [{ name: "main", file: "curation/source.json" }],
  });
  return root;
}

function makeHub(): string {
  setNow("2026-11-02T10:00:00Z");
  return tempDir();
}

test("an org repo is one root", () => {
  const root = tempDir();
  writeJsonFile(path.join(root, "config/source.json"), {});
  assert.deepEqual(utilityRoots(root), [root]);
});

test("the hub lists each utility", () => {
  const hub = makeHub();
  addUtility(hub, "beta");
  addUtility(hub, "alpha");
  mkdirSync(path.join(hub, "utilities", "notes"));
  assert.deepEqual(utilityRoots(hub).map((p) => path.basename(p)), ["alpha", "beta"]);
  assert.deepEqual(utilityRoots(path.join(hub, "utilities", "notes")), []);
});

test("URLs depend on where a utility lives", () => {
  const hub = makeHub();
  const root = addUtility(hub, "alpha");
  assert.equal(rawUrl(root, "alpha", "data/index.json"),
    "https://raw.githubusercontent.com/Strompreise-Schweiz/strompreise-schweiz.github.io/main/utilities/alpha/data/index.json");
  assert.equal(rawUrl(hub, "ekz", "data/index.json"), "https://raw.githubusercontent.com/Strompreise-Schweiz/ekz/main/data/index.json");
  // The site URL is the same in both cases, so a utility can move without breaking consumers.
  assert.equal(siteUrl("alpha", "data/tariffs/current.json"), "https://data.strompreise-schweiz.ch/alpha/tariffs/current.json");
});

test("the hub publishes every utility", () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  addUtility(hub, "beta");
  for (const root of utilityRoots(hub)) {
    const name = path.basename(root);
    assert.equal(build(root), 0);
    const index = readJsonFile(path.join(root, "data/index.json"));
    assert.equal(index.site, `https://data.strompreise-schweiz.ch/${name}/`);
    assert.ok(index.repository.endsWith(`/strompreise-schweiz.github.io/tree/main/utilities/${name}`));
    assert.equal(index.tariffs.current, `https://data.strompreise-schweiz.ch/${name}/tariffs/current.json`);
  }
});

test("the hub continues after a failing utility", () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  const broken = addUtility(hub, "beta");
  writeJsonFile(path.join(broken, "curation/source.json"), "not json");
  assert.equal(buildMain([], hub), 1);
  assert.ok(existsSync(path.join(hub, "utilities/alpha/data/tariffs/2026.json")));
});

const hubCases: [string | undefined, Obj[] | undefined, string][] = [
  ["other-name", undefined, "slug_mismatch"],
  [undefined, [{ id: "d", name: "D", url: "https://api.example.ch/v1/tariffs" }], "prices_in_hub"],
];
for (const [folder, prices, code] of hubCases) {
  test(`hub rule ${code}`, () => {
    const root = addUtility(makeHub(), "alpha", { folder, prices });
    const config = readJsonFile(path.join(root, "config/source.json"));
    assert.ok(hubIssues(path.basename(root), config as SourceConfig).some((i) => i.code === code));
  });
}

test("a disabled price source is allowed in the hub", () => {
  const root = addUtility(makeHub(), "alpha", { prices: [{ id: "d", name: "D", enabled: false, url: "https://api.example.ch/v1/tariffs" }] });
  assert.deepEqual(hubIssues(path.basename(root), readJsonFile(path.join(root, "config/source.json")) as SourceConfig), []);
});

test("the hub validates cleanly", () => {
  const hub = makeHub();
  for (const root of [addUtility(hub, "alpha"), addUtility(hub, "beta")]) build(root);
  assert.equal(validateMain([], hub), 0);
});

test("the site of the hub has one folder per utility and an overall index", () => {
  const hub = makeHub();
  for (const root of [addUtility(hub, "alpha", { elcomId: 101 }), addUtility(hub, "beta")]) build(root);
  writeJsonFile(path.join(hub, "repositories.json"), {
    repositories: [{ slug: "ekz", name: "EKZ", vse_id: "CH10153012345", elcom_id: 486 }],
  });
  assert.equal(buildSite(hub, path.join(hub, "_site")), 0);
  assert.ok(existsSync(path.join(hub, "_site/alpha/tariffs/current.json")));
  assert.ok(existsSync(path.join(hub, "_site/beta/index.json")));
  const index = readJsonFile(path.join(hub, "_site/index.json"));
  assert.deepEqual(schemaIssues(index, "overall-index"), []);
  assert.deepEqual(
    index.utilities.map((u: Obj) => [u.slug, u.maintained_in, u.elcom_id]),
    [["alpha", "hub", 101], ["beta", "hub", null], ["ekz", "own_repository", 486]],
  );
  assert.equal(index.utilities[2].index, "https://data.strompreise-schweiz.ch/ekz/index.json");
  assert.equal(readJsonFile(path.join(hub, "_site/alpha/index.json")).elcom_id, 101);
});

test("a utility in the hub and in an own repo is an error", () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  writeJsonFile(path.join(hub, "repositories.json"), { repositories: [{ slug: "alpha", name: "Alpha" }] });
  assert.equal(buildSite(hub, path.join(hub, "_site")), 1);
});

test("the site of an org repo serves the day files of the current year only", () => {
  setNow("2027-01-05T10:00:00Z");
  const root = tempDir();
  writeJsonFile(path.join(root, "config/source.json"), { slug: "ekz", name: "EKZ", prices: [], tariffs: [] });
  for (const relative of ["tariffs/2026/grid-d/2026-12-31.json", "tariffs/2027/grid-d/2027-01-05.json",
    "sources/days/grid-d/2026/2026-12-31.json", "products/p/2026/2026-08-25.json", "products/p/2026.json",
    "tariffs/current/grid-d.json", "tariffs/2026.json", "index.json"]) {
    writeJsonFile(path.join(root, "data", relative), {});
  }
  assert.equal(buildSite(root, path.join(root, "_site")), 0);
  const site = path.join(root, "_site");
  const served = readdirSync(site, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.relative(site, path.join(e.parentPath, e.name))).sort();
  assert.deepEqual(served, ["index.json", "products/p/2026.json", "tariffs/2026.json", "tariffs/2027/grid-d/2027-01-05.json", "tariffs/current/grid-d.json"]);
});

test("the hub site has the status page, and each utility a checks.json", () => {
  const hub = makeHub();
  const root = addUtility(hub, "alpha");
  build(root);
  const checks = readJsonFile(path.join(root, "data/checks.json"));
  assert.deepEqual(checks.tariffs.map((y: Obj) => [y.year, y.published, y.online]), [[2026, true, true]]);
  assert.equal(checks.summary.errors, 0);
  assert.equal(buildSite(hub, path.join(hub, "_site")), 0);
  assert.ok(existsSync(path.join(hub, "_site/status.html")));
  assert.ok(existsSync(path.join(hub, "_site/alpha/checks.json")));
});
