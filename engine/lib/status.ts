/**
 * data/status.json: a short summary of the checks of one utility, for the status page of the site
 * (site/status.html). Written when static tariffs are published. The details stay in the tariff
 * files, data/tariffs/<year>.report.json and data/vse-conformance.json.
 */
import path from "node:path";

import { deepEqual } from "../core/json.ts";
import type { Issue, SourceConfig } from "../core/types.ts";
import { VSE_VERSIONS } from "../core/vse.ts";
import type { ConformanceReport } from "./conformance.ts";
import { readJsonIfExists, writeJson } from "./files.ts";

export interface YearStatus {
  year: number;
  /** The checks found errors, so this run did not publish the year. */
  blocked: boolean;
  /** A file for the year is online: the new one, or the previous one if blocked. */
  online: boolean;
  errors: number;
  warnings: number;
  accepted: number;
  /** Number of issues per code, errors and warnings. */
  codes: Record<string, number>;
}

export function yearStatus(year: number, issues: Issue[], online: boolean): YearStatus {
  const count = (severity: Issue["severity"]) => issues.filter((issue) => issue.severity === severity).length;
  const codes: Record<string, number> = {};
  for (const issue of issues.filter((i) => i.severity !== "accepted")) codes[issue.code] = (codes[issue.code] ?? 0) + 1;
  return { year, blocked: count("error") > 0, online, errors: count("error"), warnings: count("warning"), accepted: count("accepted"), codes };
}

export function writeStatus(root: string, org: SourceConfig, years: YearStatus[], conformance: ConformanceReport): void {
  const brief = (results: ConformanceReport["sources"][number]["results"]) =>
    Object.fromEntries(VSE_VERSIONS.map((version) => [version, { valid: results[version].valid, errors: results[version].errors }]));
  const status = {
    $comment: "Summary of the checks of this utility, for https://data.strompreise-schweiz.ch/status.html.",
    utility: org.name,
    slug: org.slug,
    years,
    vse: {
      sources: conformance.sources.map((source) => ({ name: source.name, ...brief(source.results) })),
      published: conformance.published.map((file) => ({ file: file.file, ...brief(file.results) })),
    },
  };
  const file = path.join(root, "data", "status.json");
  if (!deepEqual(readJsonIfExists(file), status)) writeJson(file, status);
}
