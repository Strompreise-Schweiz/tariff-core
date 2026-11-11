/**
 * Validation rules: the schema checks plus the rules JSON Schema cannot express. Issue codes are
 * stable, so curation/<year>.json can accept a specific one with a reason.
 *
 * No Node APIs: this module also runs in the browser, for example to check a file before upload.
 */
import { checkDay } from "./normalizers/generic-vse.ts";
import { schemaIssues } from "./schemas.ts";
import type { DynamicDay, Issue, Month, Severity, SourceConfig, Tariff, TariffDocument, TimePrice, Waiver, Weekday } from "./types.ts";

export { schemaIssues } from "./schemas.ts";

export const MONTHS: Month[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS: Weekday[] = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "So"];
const TIME_FIELDS = ["energy", "power", "reactivePower"] as const;
// Above this a price was probably entered in Rappen instead of francs.
const MAX_PLAUSIBLE_CHF_KWH = 1.5;
const ALLOWED_UNITS: Record<string, string[]> = {
  base: ["CHF/M"],
  energy: ["CHF/kWh"],
  power: ["CHF/kW", "CHF/kW/M"],
  reactivePower: ["CHF/kVarh"],
};
const MINUTES_PER_DAY = 1440;

function issue(severity: Severity, code: string, message: string, tariff?: string): Issue {
  return tariff === undefined ? { severity, code, message } : { severity, code, tariff, message };
}

function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** The minute ranges [from, to) of a window. Equal times mean the whole day, 00:00 as end means midnight. */
function windowRanges(from: string, to: string): [number, number][] {
  const start = minutes(from);
  const end = minutes(to);
  if (start === end) return [[0, MINUTES_PER_DAY]];
  if (end === 0) return [[start, MINUTES_PER_DAY]];
  return start < end ? [[start, end]] : [[start, MINUTES_PER_DAY], [0, end]];
}

/**
 * Check that the time windows of a multilevel tariff cover each month and weekday exactly once.
 * Windows are Swiss wall-clock time, also across a clock change: "high tariff from 07:00" stays
 * 07:00 all year. Returns the month/weekday pairs with gaps and with overlaps, such as "Jan/Mo".
 */
export function coverageProblems(entries: TimePrice[]): { gaps: string[]; overlaps: string[] } {
  const counts = new Map(MONTHS.flatMap((month) => WEEKDAYS.map((day) => [`${month}/${day}`, new Uint16Array(MINUTES_PER_DAY)] as const)));
  for (const entry of entries) {
    const ranges = windowRanges(entry.from, entry.to);
    for (const month of entry.months?.length ? entry.months : MONTHS) {
      for (const day of entry.weekdays.length ? entry.weekdays : WEEKDAYS) {
        const minuteCounts = counts.get(`${month}/${day}`);
        if (!minuteCounts) continue; // an unknown month or weekday is a schema error
        for (const [from, to] of ranges) for (let minute = from; minute < to; minute++) minuteCounts[minute] += 1;
      }
    }
  }
  const pairs = [...counts];
  return {
    gaps: pairs.filter(([, c]) => c.includes(0)).map(([key]) => key),
    overlaps: pairs.filter(([, c]) => c.some((count) => count > 1)).map(([key]) => key),
  };
}

export function tariffIssues(tariff: Tariff, year: number): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string) => issues.push(issue(severity, code, message, tariff.id));
  if (tariff.customerVoltageLevel === undefined) {
    // Required by the OpenAPI, but EKZ omits it where a tariff is not tied to a level.
    // Guessing a level would be inventing data, so this is reported and not blocked.
    add("warning", "missing_voltage_level", "the source states no voltage level");
  }
  const { prices, tariffForm: form } = tariff;
  const energy = prices.energy ?? [];
  for (const [field, allowed] of Object.entries(ALLOWED_UNITS)) {
    const value = prices[field] as TimePrice | TimePrice[] | undefined;
    for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
      if (!allowed.includes(entry.priceUnit)) add("warning", "unexpected_unit", `${field} uses ${entry.priceUnit}`);
      if (field === "energy" && entry.price > MAX_PLAUSIBLE_CHF_KWH) {
        add("error", "implausible_energy_price", `${entry.price} CHF/kWh: was it entered in Rappen?`);
      }
    }
  }
  if (form === "constant") {
    for (const field of TIME_FIELDS) {
      const values = prices[field] ?? [];
      if (values.length > 1) add("error", "constant_with_several_prices", `${field} has ${values.length} entries`);
      for (const value of values) {
        if (value.months?.length || value.weekdays.length || value.from !== value.to) {
          add("error", "constant_with_time_window", `${field} applies only part of the time`);
        }
      }
    }
  } else if (form === "multilevel") {
    if (!TIME_FIELDS.some((field) => (prices[field]?.length ?? 0) > 1)) {
      add("warning", "multilevel_with_single_price", "only one price level: should this be constant?");
    }
  } else if (form === "dynamic" && energy.length) {
    add("warning", "dynamic_with_energy_prices", "dynamic tariff also lists fixed energy prices");
  }
  if (form !== "dynamic" && energy.length) {
    const { gaps, overlaps } = coverageProblems(energy);
    if (gaps.length) add("error", "energy_time_gap", `no price for parts of ${gaps.length} month/weekday pairs, e.g. ${gaps[0]}`);
    if (overlaps.length) add("error", "energy_time_overlap", `several prices for parts of ${overlaps.length} month/weekday pairs, e.g. ${overlaps[0]}`);
  }
  const { startDate: start, endDate: end } = tariff;
  if (start > end) add("error", "start_after_end", `${start} is after ${end}`);
  if (!start.startsWith(String(year))) add("error", "wrong_year", `starts ${start}, document is ${year}`);
  if (Number(end.slice(0, 4)) > year + 1) add("error", "implausible_end_date", `ends ${end}: tariffs are set per year`);
  return issues;
}

export function documentIssues(document: TariffDocument, year: number, vseId?: string): Issue[] {
  const issues = schemaIssues(document, "tariff-document");
  if (issues.length) return issues;
  const byId = new Map(document.tariffs.map((tariff) => [tariff.id, tariff]));
  issues.push(...document.tariffs.flatMap((tariff) => tariffIssues(tariff, year)));
  if (vseId && vseId !== `CH${document.dsoNumber}`) {
    issues.push(issue("error", "dso_number_mismatch", `file has ${document.dsoNumber}, config has ${vseId}`));
  }
  const groups = Map.groupBy(document.tariffs, (t) =>
    [t.tariffType, t.tariffName, t.customerVoltageLevel ?? "no voltage level", t.customerType, t.startDate].join(" / "));
  for (const [key, members] of groups) {
    if (members.length > 1) issues.push(issue("warning", "indistinguishable_tariffs", `${members.length} tariffs share ${key}`));
  }
  if (byId.size !== document.tariffs.length) issues.push(issue("error", "duplicate_tariff_id", "tariff ids are not unique"));
  for (const product of document.products) {
    const add = (code: string, message: string) => issues.push(issue("error", code, message, product.id));
    const levels = new Set<number>();
    for (const [slot, reference] of Object.entries(product.components)) {
      const target = byId.get(reference);
      if (!target) add("product_unknown_tariff", `${slot} refers to ${reference}`);
      else if (target.tariffType !== slot) add("product_wrong_slot", `${slot} refers to a ${target.tariffType} tariff`);
      if (target?.customerVoltageLevel !== undefined) levels.add(target.customerVoltageLevel);
    }
    if (product.status === "verified" && !product.sourceUrl) add("verified_without_source", "a verified product needs sourceUrl");
    if (levels.size > 1) add("product_mixed_voltage", `voltage levels ${[...levels].sort((a, b) => a - b).join(", ")}`);
  }
  return issues;
}

/** Downgrade accepted issues. They stay visible in the published _meta. */
export function applyWaivers(issues: Issue[], waivers: Waiver[] = []): Issue[] {
  return issues.map((item) => {
    const waiver = waivers.find((w) => w.code === item.code && (w.tariff === undefined || w.tariff === item.tariff));
    return waiver ? { ...item, severity: "accepted", acceptReason: waiver.reason } : item;
  });
}

/** Issues of a dynamic day file or latest.json. fileName is the file name, such as 2026-07-02.json. */
export function dynamicDayIssues(fileName: string, document: DynamicDay): Issue[] {
  if (!document._meta) return []; // archived before version 2.0, kept as it was published
  const issues = schemaIssues(document, "dynamic-day");
  if (issues.length || fileName === "latest.json") return issues;
  const check = checkDay(fileName.replace(/\.json$/, ""), document.prices);
  if (check.complete !== document._meta.complete) {
    issues.push(issue("error", "complete_flag_wrong", `${fileName}: ${check.issues.join("; ") || "the day is complete"}`));
  }
  return issues;
}

/**
 * Rules for a utility in the hub repo. Dynamic tariffs commit every day and grow the archive, so
 * they belong in an own repo. The folder name is part of the public URL.
 */
export function hubIssues(folder: string, config: SourceConfig): Issue[] {
  const issues: Issue[] = [];
  if (config.dynamic.some((tariff) => tariff.enabled !== false)) {
    issues.push(issue("error", "dynamic_in_hub", "a utility with dynamic tariffs needs its own repo"));
  }
  if (config.slug !== folder) issues.push(issue("error", "slug_mismatch", `folder is ${folder}, slug is ${config.slug}`));
  return issues;
}
