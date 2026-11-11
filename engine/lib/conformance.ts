/**
 * data/vse-conformance.json: whether the files of a utility follow the OpenAPI definitions of the VSE,
 * and data/badges/vse-<version>.json for the badges in the README (shields.io endpoint format).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { deepEqual } from "../core/json.ts";
import type { SourceConfig } from "../core/types.ts";
import { VSE_VERSIONS, vseValidator, type Conformance, type OpenApiDocument, type VseVersion } from "../core/vse.ts";
import { exists, namesIn, parseJson, readJsonIfExists, writeJson } from "./files.ts";
import { ENGINE_ROOT, SCHEMA_BASE } from "./repo.ts";

type Results = Record<VseVersion, Conformance>;

export interface ConformanceReport {
  $comment: string;
  definitions: Record<string, string>;
  sources: { name: string; file?: string; url?: string; sha256: string; results: Results }[];
  published: { file: string; results: Results }[];
}

const definitionUrl = (version: VseVersion) => `${SCHEMA_BASE}/vse/ch-electricity-tariffs-openapi-${version}.yaml`;

let validators: Map<VseVersion, (document: unknown) => Conformance> | undefined;

/** Check one parsed document against every VSE version. */
export function checkAllVersions(document: unknown): Results {
  validators ??= new Map(VSE_VERSIONS.map((version) => {
    const spec = parse(readFileSync(path.join(ENGINE_ROOT, "schemas", "vse", `ch-electricity-tariffs-openapi-${version}.yaml`), "utf8")) as OpenApiDocument;
    return [version, vseValidator(spec)];
  }));
  return Object.fromEntries(VSE_VERSIONS.map((version) => [version, validators!.get(version)!(document)])) as Results;
}

function checkBytes(data: Buffer): Results {
  try {
    return checkAllVersions(parseJson(data));
  } catch {
    const invalid = { valid: false, errors: 1, summary: [{ path: "", message: "not valid JSON", count: 1 }] };
    return Object.fromEntries(VSE_VERSIONS.map((version) => [version, invalid])) as Results;
  }
}

/** The file of a source as the utility published it: the stored raw copy, or the file in the repo. */
function sourceFile(root: string, source: SourceConfig["static"]["sources"][number]): string {
  return source.file ? path.join(root, source.file) : path.join(root, "data", "static", "raw", `${source.name}.json`);
}

function badge(version: VseVersion, results: Conformance[]) {
  const valid = results.filter((result) => result.valid).length;
  const [message, color] = results.length === 0 ? ["no source file", "lightgrey"]
    : valid === results.length ? ["valid", "brightgreen"]
    : valid === 0 ? ["invalid", "red"]
    : [`${valid} of ${results.length} valid`, "orange"];
  return { schemaVersion: 1, label: `VSE ${version}`, message, color };
}

function writeIfChanged(file: string, value: unknown): void {
  if (!deepEqual(readJsonIfExists(file), value)) writeJson(file, value);
}

/** Check the source files and the published years of one utility, and write the results. */
export function writeConformance(root: string, org: SourceConfig): ConformanceReport {
  const sources = org.static.sources
    .filter((source) => source.enabled !== false && exists(sourceFile(root, source)))
    .map((source) => {
      const data = readFileSync(sourceFile(root, source));
      return {
        name: source.name,
        ...(source.file ? { file: source.file } : { url: source.url }),
        sha256: createHash("sha256").update(data).digest("hex"),
        results: checkBytes(data),
      };
    });
  const tariffsDir = path.join(root, "data", "tariffs");
  const published = namesIn(tariffsDir, /^\d{4}\.json$/).map((name) => ({
    file: `tariffs/${name}`,
    results: checkBytes(readFileSync(path.join(tariffsDir, name))),
  }));
  const report: ConformanceReport = {
    $comment: "Whether the files follow the OpenAPI definitions of the VSE. sources are the files as the " +
      "utility published them, published the files of this project. Information only: it does not block publication.",
    definitions: Object.fromEntries(VSE_VERSIONS.map((version) => [version, definitionUrl(version)])),
    sources,
    published,
  };
  writeIfChanged(path.join(root, "data", "vse-conformance.json"), report);
  for (const version of VSE_VERSIONS) {
    writeIfChanged(path.join(root, "data", "badges", `vse-${version}.json`), badge(version, sources.map((s) => s.results[version])));
  }
  return report;
}
