/** Whether a file follows the OpenAPI definitions of the VSE, and the badges for a README. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { VSE_VERSIONS, vseValidator, type Conformance, type OpenApiDocument, type VseVersion } from "../core/vse.ts";
import { parseJson } from "./files.ts";
import { ENGINE_ROOT, SCHEMA_BASE } from "./repo.ts";

export type VseResults = Record<VseVersion, Conformance>;

export const definitionUrl = (version: VseVersion) => `${SCHEMA_BASE}/vse/ch-electricity-tariffs-openapi-${version}.yaml`;

let validators: Map<VseVersion, (document: unknown) => Conformance> | undefined;

/** Check one parsed document against every VSE version. */
export function checkAllVersions(document: unknown): VseResults {
  validators ??= new Map(VSE_VERSIONS.map((version) => {
    const spec = parse(readFileSync(path.join(ENGINE_ROOT, "schemas", "vse", `ch-electricity-tariffs-openapi-${version}.yaml`), "utf8")) as OpenApiDocument;
    return [version, vseValidator(spec)];
  }));
  return Object.fromEntries(VSE_VERSIONS.map((version) => [version, validators!.get(version)!(document)])) as VseResults;
}

/** Check the bytes of a file. A file that is not JSON fails every version. */
export function checkBytes(data: Buffer): VseResults {
  try {
    return checkAllVersions(parseJson(data));
  } catch {
    const invalid = { valid: false, errors: 1, summary: [{ path: "", message: "not valid JSON", count: 1 }] };
    return Object.fromEntries(VSE_VERSIONS.map((version) => [version, invalid])) as VseResults;
  }
}

/** shields.io endpoint format, for the files of the utility. */
export function badge(version: VseVersion, results: Conformance[]) {
  const valid = results.filter((result) => result.valid).length;
  const [message, color] = results.length === 0 ? ["no source file", "lightgrey"]
    : valid === results.length ? ["valid", "brightgreen"]
    : valid === 0 ? ["invalid", "red"]
    : [`${valid} of ${results.length} valid`, "orange"];
  return { schemaVersion: 1, label: `VSE ${version}`, message, color };
}
