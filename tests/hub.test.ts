import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildSite } from "../engine/build-site.ts";
import { hubIssues } from "../engine/core/rules.ts";
import type { SourceConfig } from "../engine/core/types.ts";
import { rawUrl, siteUrl, utilityRoots } from "../engine/lib/repo.ts";
import { main as publishMain, publish } from "../engine/publish-static.ts";
import { main as validateMain } from "../engine/validate.ts";
import { ekzLike, readJsonFile, setNow, tempDir, writeJsonFile, type Obj } from "./helpers.ts";

function addUtility(hub: string, slug: string, { folder, dynamic }: { folder?: string; dynamic?: Obj[] } = {}): string {
  const root = path.join(hub, "utilities", folder ?? slug);
  writeJsonFile(path.join(root, "curation/source.json"), ekzLike());
  writeJsonFile(path.join(root, "config/source.json"), {
    slug, name: slug[0].toUpperCase() + slug.slice(1), vse_id: "CH10000000001", dynamic: dynamic ?? [],
    static: { sources: [{ name: "main", file: "curation/source.json" }] },
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

test("the hub publishes every utility", async () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  addUtility(hub, "beta");
  for (const root of utilityRoots(hub)) {
    const name = path.basename(root);
    assert.equal(await publish(root), 0);
    const index = readJsonFile(path.join(root, "data/index.json"));
    assert.equal(index.site, `https://data.strompreise-schweiz.ch/${name}/`);
    assert.ok(index.repository.endsWith(`/strompreise-schweiz.github.io/tree/main/utilities/${name}`));
    assert.ok(index.static.current.includes(`/utilities/${name}/data/tariffs/current.json`));
  }
});

test("the hub continues after a failing utility", async () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  const broken = addUtility(hub, "beta");
  writeJsonFile(path.join(broken, "curation/source.json"), "not json");
  assert.equal(await publishMain([], hub), 1);
  assert.ok(existsSync(path.join(hub, "utilities/alpha/data/tariffs/2026.json")));
});

const hubCases: [string | undefined, Obj[] | undefined, string][] = [
  ["other-name", undefined, "slug_mismatch"],
  [undefined, [{ id: "d", name: "D", api_url: "https://api.example.ch/v1/tariffs" }], "dynamic_in_hub"],
];
for (const [folder, dynamic, code] of hubCases) {
  test(`hub rule ${code}`, () => {
    const root = addUtility(makeHub(), "alpha", { folder, dynamic });
    const config = readJsonFile(path.join(root, "config/source.json"));
    assert.ok(hubIssues(path.basename(root), config as SourceConfig).some((i) => i.code === code));
  });
}

test("a disabled dynamic tariff is allowed in the hub", () => {
  const root = addUtility(makeHub(), "alpha", { dynamic: [{ id: "d", name: "D", enabled: false, api_url: "https://api.example.ch/v1/tariffs" }] });
  assert.deepEqual(hubIssues(path.basename(root), readJsonFile(path.join(root, "config/source.json")) as SourceConfig), []);
});

test("the hub validates cleanly", async () => {
  const hub = makeHub();
  for (const root of [addUtility(hub, "alpha"), addUtility(hub, "beta")]) await publish(root);
  assert.equal(validateMain([], hub), 0);
});

test("the site of the hub has one folder per utility and an overall index", async () => {
  const hub = makeHub();
  for (const root of [addUtility(hub, "alpha"), addUtility(hub, "beta")]) await publish(root);
  writeJsonFile(path.join(hub, "repositories.json"), { repositories: [{ slug: "ekz", name: "EKZ" }] });
  assert.equal(buildSite(hub, path.join(hub, "_site")), 0);
  assert.ok(existsSync(path.join(hub, "_site/alpha/tariffs/current.json")));
  assert.ok(existsSync(path.join(hub, "_site/beta/index.json")));
  const index = readJsonFile(path.join(hub, "_site/index.json"));
  assert.deepEqual(index.utilities.map((u: Obj) => [u.slug, u.maintained_in]), [["alpha", "hub"], ["beta", "hub"], ["ekz", "own repository"]]);
  assert.equal(index.utilities[2].index, "https://data.strompreise-schweiz.ch/ekz/index.json");
});

test("a utility in the hub and in an own repo is an error", () => {
  const hub = makeHub();
  addUtility(hub, "alpha");
  writeJsonFile(path.join(hub, "repositories.json"), { repositories: [{ slug: "alpha", name: "Alpha" }] });
  assert.equal(buildSite(hub, path.join(hub, "_site")), 1);
});

test("the site of an org repo serves the current archive year only", () => {
  setNow("2027-01-05T10:00:00Z");
  const root = tempDir();
  writeJsonFile(path.join(root, "config/source.json"), { slug: "ekz", name: "EKZ", dynamic: [], static: { sources: [] } });
  for (const relative of ["dynamic/grid-d/vse/2026/2026-12-31.json", "dynamic/grid-d/vse/2027/2027-01-05.json",
    "dynamic/grid-d/raw/2026/2026-12-31.json", "dynamic/vse/2026/2026-08-25.json",
    "dynamic/grid-d/latest.json", "tariffs/2026.json", "index.json"]) {
    writeJsonFile(path.join(root, "data", relative), {});
  }
  assert.equal(buildSite(root, path.join(root, "_site")), 0);
  const site = path.join(root, "_site");
  const served = readdirSync(site, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.relative(site, path.join(e.parentPath, e.name))).sort();
  assert.deepEqual(served, ["dynamic/grid-d/latest.json", "dynamic/grid-d/vse/2027/2027-01-05.json", "index.json", "tariffs/2026.json"]);
});
