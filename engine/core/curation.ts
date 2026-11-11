/** Manual corrections from curation/<year>.json and stable tariff ids. No Node APIs. */
import { shortHash } from "./hash.ts";
import { compareText, deepEqual, slugify } from "./json.ts";
import type { AppliedCuration, Curation, Issue, Tariff, TariffMatch } from "./types.ts";

type Unidentified = Omit<Tariff, "id"> & { id?: string };

function matches(tariff: Unidentified, match: TariffMatch): boolean {
  return Object.entries(match).every(([key, value]) => deepEqual(tariff[key], value));
}

/** Set a value at a dotted path such as prices.energy, creating objects on the way. */
function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  const last = parts.pop()!;
  for (const part of parts) {
    target[part] ??= {};
    target = target[part] as Record<string, unknown>;
  }
  target[last] = value;
}

/**
 * Apply manual corrections. A rule that matches nothing is an error: it means the source changed
 * and the correction no longer does what it was written for.
 */
export function applyCuration<T extends Unidentified>(tariffs: T[], curation: Curation): { tariffs: T[]; applied: AppliedCuration[]; issues: Issue[] } {
  const applied: AppliedCuration[] = [];
  const issues: Issue[] = [];
  const noMatch = (message: string) => issues.push({ severity: "error", code: "curation_no_match", message });
  for (const { match, reason } of curation.removeTariffs ?? []) {
    const kept = tariffs.filter((t) => !matches(t, match));
    if (kept.length === tariffs.length) noMatch(`removeTariffs matches nothing: ${JSON.stringify(match)}`);
    tariffs = kept;
    applied.push({ action: "remove", match, reason });
  }
  for (const { match, set, reason, sourceUrl } of curation.overrides ?? []) {
    const hits = tariffs.filter((t) => matches(t, match));
    if (!hits.length) noMatch(`override matches nothing: ${JSON.stringify(match)}`);
    for (const tariff of hits) for (const [key, value] of Object.entries(set)) setPath(tariff, key, value);
    applied.push({ action: "override", match, set: Object.keys(set).sort(compareText), reason, sourceUrl, count: hits.length });
  }
  for (const { tariff, reason, sourceUrl } of curation.addTariffs ?? []) {
    tariffs.push(structuredClone(tariff) as unknown as T);
    applied.push({ action: "add", tariffName: tariff.tariffName, reason, sourceUrl });
  }
  return { tariffs, applied, issues };
}

/**
 * Give every tariff a stable id from type, name and voltage level. tariffName alone is not unique:
 * EKZ repeats names across voltage levels and customer groups. Where the base id repeats, a short
 * hash of customer group, url and comment tells the tariffs apart, and file order as a last resort.
 */
export function assignIds(tariffs: Unidentified[]): Tariff[] {
  const groups = Map.groupBy(tariffs, (t) => {
    const level = t.customerVoltageLevel === undefined ? "" : `-ne${t.customerVoltageLevel}`;
    return `${slugify(String(t.tariffType))}-${slugify(String(t.tariffName))}${level}`;
  });
  for (const [base, members] of groups) {
    if (members.length === 1) {
      members[0].id = base;
      continue;
    }
    const seen = new Map<string, number>();
    for (const tariff of members) {
      const id = `${base}-${shortHash([tariff.customerType, tariff.url, tariff.comment].map((v) => v ?? "").join("|")).slice(0, 6)}`;
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      tariff.id = count === 1 ? id : `${id}-${count}`;
    }
  }
  return tariffs as Tariff[];
}
