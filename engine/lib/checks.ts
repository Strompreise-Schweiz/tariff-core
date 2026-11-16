/**
 * data/checks.json: everything that is wrong with the data of a utility, in one place. The files of
 * the utility against the VSE definitions, each year of the yearly file with its issues, each day
 * price API with the tariffs it serves and its incomplete days, and each product with what it lacks.
 * Also the badges for the README.
 *
 * Written without timestamps, so a run that finds nothing new changes nothing.
 */
import path from "node:path";

import { deepEqual } from "../core/json.ts";
import type { ExcludedTariff, Issue, Repair } from "../core/types.ts";
import { VSE_VERSIONS } from "../core/vse.ts";
import { badge, definitionUrl, type VseResults } from "./conformance.ts";
import { readJsonIfExists, writeJson } from "./files.ts";
import { paths } from "./repo.ts";

export interface IncompleteDay {
  date: string;
  issues: string[];
}

export interface Checks {
  $comment: string;
  utility: string;
  slug: string;
  summary: { errors: number; warnings: number; accepted: number; incompleteDays: number };
  vseDefinitions: Record<string, string>;
  sources: {
    tariffs: { name: string; url?: string; file?: string; sha256: string; vse: VseResults }[];
    days: { id: string; url: string; enabled: boolean; days: number; first: string | null; last: string | null }[];
  };
  tariffs: {
    year: number;
    /** This run published the year. */
    published: boolean;
    /** A file for the year is online: the new one, or the previous one if this run found errors. */
    online: boolean;
    repairs: Repair[];
    issues: Issue[];
    /** Tariffs of the source left out because of errors of their own. */
    excluded: ExcludedTariff[];
    vse?: VseResults;
  }[];
  /** Per day price API: the dynamic tariffs it serves as <year>/<tariff>, and its days. */
  days: {
    id: string;
    tariffs: string[];
    days: number;
    incomplete: IncompleteDay[];
    /** Stored days of a year whose yearly file has no tariff with this API. Not published. */
    withoutTariff: string[];
  }[];
  products: {
    id: string;
    year: number;
    default: boolean;
    status: string;
    /** Slots of electricity, grid, metering and regional_fees without a tariff. */
    missing: string[];
    dynamic: string[];
    days: number;
    incomplete: IncompleteDay[];
    notes: string[];
  }[];
}

export function emptyChecks(utility: string, slug: string): Checks {
  return {
    $comment: "What is wrong with the data of this utility. Errors block a year, warnings and accepted issues do not. " +
      "Information on the VSE conformance does not block anything.",
    utility,
    slug,
    summary: { errors: 0, warnings: 0, accepted: 0, incompleteDays: 0 },
    vseDefinitions: Object.fromEntries(VSE_VERSIONS.map((version) => [version, definitionUrl(version)])),
    sources: { tariffs: [], days: [] },
    tariffs: [],
    days: [],
    products: [],
  };
}

/** Fill in the summary, write checks.json and the badges if they changed. */
export function writeChecks(root: string, checks: Checks): void {
  const issues = checks.tariffs.flatMap((year) => year.issues);
  const count = (severity: Issue["severity"]) => issues.filter((issue) => issue.severity === severity).length;
  checks.summary = {
    errors: count("error"),
    warnings: count("warning"),
    accepted: count("accepted"),
    incompleteDays: checks.days.reduce((sum, source) => sum + source.incomplete.length, 0),
  };
  const writeIfChanged = (file: string, value: unknown) => {
    if (!deepEqual(readJsonIfExists(file), value)) writeJson(file, value);
  };
  writeIfChanged(paths.checks(root), checks);
  for (const version of VSE_VERSIONS) {
    const results = checks.sources.tariffs.map((source) => source.vse[version]);
    writeIfChanged(path.join(paths.data(root), "badges", `vse-${version}.json`), badge(version, results));
  }
}
