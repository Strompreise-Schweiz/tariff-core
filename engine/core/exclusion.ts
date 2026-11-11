/**
 * Leaves out tariffs that cannot be published, instead of blocking the whole year. A tariff with an
 * error of its own, such as "#N/A" as municipality number at BKW, is removed from the document and
 * listed in _meta.excluded with the reason. Errors of the document as a whole still block the year,
 * and so does a year in which every tariff has an error. No Node APIs.
 */
import type { Issue, Tariff, TariffDocument } from "./types.ts";

export interface ExcludedTariff {
  id: string;
  tariffName: string;
  tariffType: string;
  customerType: string;
  customerVoltageLevel?: number;
  /** What is wrong, one entry per error. */
  problems: string[];
}

// Each round can reveal errors that the previous one hid: documentIssues stops at schema errors.
const MAX_ROUNDS = 5;

/** The index of the tariff an error belongs to, or undefined if it belongs to the document. */
function tariffIndex(issue: Issue, tariffs: Tariff[]): number | undefined {
  const fromPath = /^tariffs\/(\d+)(\/|$)/.exec(issue.path ?? "");
  if (fromPath) return Number(fromPath[1]);
  if (issue.tariff === undefined) return undefined;
  const index = tariffs.findIndex((tariff) => tariff.id === issue.tariff);
  return index >= 0 ? index : undefined; // a product id: the document, not a tariff
}

/** The value at a path such as prices/municipalityTaxes/0/municipalityNumber. */
function valueAt(tariff: Tariff, where: string): unknown {
  return where.split("/").reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), tariff);
}

/** What is wrong, with the value the source has, such as: municipalityNumber: must be integer, is "#N/A". */
function problem(issue: Issue, tariff: Tariff): string {
  const where = issue.path?.replace(/^tariffs\/\d+\/?/, "");
  if (!where) return `[${issue.code}] ${issue.message}`;
  const value = valueAt(tariff, where);
  const shown = value === undefined ? "" : `, is ${JSON.stringify(value).slice(0, 80)}`;
  return `${where}: ${issue.message}${shown}`;
}

/**
 * Remove the tariffs with errors of their own. check runs every rule on a document and returns the
 * issues after waivers. Returns the document to publish, the removed tariffs and the remaining issues.
 */
export function excludeBrokenTariffs(document: TariffDocument, check: (document: TariffDocument) => Issue[]):
  { document: TariffDocument; excluded: ExcludedTariff[]; issues: Issue[] } {
  const excluded: ExcludedTariff[] = [];
  let current = document;
  let issues = check(current);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const broken = new Map<number, string[]>();
    for (const issue of issues.filter((i) => i.severity === "error")) {
      const index = tariffIndex(issue, current.tariffs);
      if (index !== undefined) broken.set(index, [...(broken.get(index) ?? []), problem(issue, current.tariffs[index])]);
    }
    if (broken.size === 0 || broken.size === current.tariffs.length) break;
    for (const [index, problems] of broken) {
      const { id, tariffName, tariffType, customerType, customerVoltageLevel } = current.tariffs[index];
      excluded.push({ id, tariffName, tariffType, customerType, ...(customerVoltageLevel === undefined ? {} : { customerVoltageLevel }), problems });
    }
    current = { ...current, tariffs: current.tariffs.filter((_, index) => !broken.has(index)) };
    issues = check(current);
  }
  return { document: current, excluded, issues };
}
