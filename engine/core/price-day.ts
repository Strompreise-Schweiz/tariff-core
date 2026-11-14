/**
 * Day prices in the format of HDN 2025, chapter 7.4:
 *
 *     {"publication_timestamp": ..., "prices": [
 *         {"start_timestamp": ..., "end_timestamp": ...,
 *          "<component>": [{"unit": "CHF_kWh"|"CHF_m", "value": ...}, ...], ...}]}
 *
 * Reads an API response, checks one Swiss calendar day, splits it into quarter hours and applies
 * the corrections from curation. No Node APIs.
 */
import { compareText } from "./json.ts";
import { dayBounds, formatTimestamp, inZurich, parseTimestamp, zurichDate } from "./time.ts";
import type { ComponentPrice, DayCheck, PriceCorrection, PriceInterval, PriceSource } from "./types.ts";

const TIME_KEYS = new Set(["start_timestamp", "end_timestamp"]);
// Handbook 7.4.1 uses tariff_type=dso for what table 3 calls grid.
const DEFAULT_COMPONENT_MAP: Record<string, string> = { dso: "grid" };
const UNIT_ALIASES = new Map([["CHF/kWh", "CHF_kWh"], ["CHF/m", "CHF_m"], ["CHF/M", "CHF_m"]]);
export const QUARTER_HOUR_MS = 15 * 60_000;

/** What an API sends. Checked while reading, because sources deviate from the standard. */
export interface ApiResponse {
  publication_timestamp?: string | null;
  prices: Record<string, unknown>[];
}

/** The components of an interval, without the timestamps. */
export function components(entry: PriceInterval): [string, ComponentPrice[]][] {
  return Object.entries(entry).filter((pair): pair is [string, ComponentPrice[]] => !TIME_KEYS.has(pair[0]));
}

/**
 * All intervals with Swiss local timestamps, sorted by instant, and the changes made while reading.
 * Component names follow HDN table 3, units are written as in HDN 7.4 (CHF_kWh, CHF_m).
 */
export function readResponse(raw: ApiResponse, source: Pick<PriceSource, "component_map">): { prices: PriceInterval[]; notes: string[] } {
  if (!Array.isArray(raw?.prices)) throw new Error("the response has no prices list");
  const componentMap = { ...DEFAULT_COMPONENT_MAP, ...source.component_map };
  const notes = new Set<string>();
  const byStart = new Map<number, PriceInterval>();
  for (const item of raw.prices) {
    const start = parseTimestamp(String(item.start_timestamp));
    const end = parseTimestamp(String(item.end_timestamp));
    const entry: PriceInterval = {
      start_timestamp: formatTimestamp(inZurich(start.ms)),
      end_timestamp: formatTimestamp(inZurich(end.ms)),
    };
    for (const [key, values] of Object.entries(item)) {
      if (TIME_KEYS.has(key)) continue;
      const target = componentMap[key] ?? key;
      if (target !== key) notes.add(`renamed component ${key} to ${target}`);
      entry[target] = (values as ComponentPrice[]).map((value) => {
        const unit = UNIT_ALIASES.get(value.unit) ?? value.unit;
        if (unit !== value.unit) notes.add(`wrote unit ${value.unit} as ${unit}`);
        return { unit, value: value.value };
      });
    }
    byStart.set(start.ms, entry);
  }
  const prices = [...byStart.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry);
  return { prices, notes: [...notes].sort(compareText) };
}

/** Intervals grouped by Swiss calendar day, in the order the days first appear. */
export function splitByDay(prices: PriceInterval[]): Map<string, PriceInterval[]> {
  const days = new Map<string, PriceInterval[]>();
  for (const entry of prices) {
    const day = zurichDate(parseTimestamp(entry.start_timestamp).ms);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return days;
}

/**
 * Check that the intervals cover exactly one Swiss calendar day and that every interval has a price
 * per kWh. The day has 92 quarter hours in March and 100 in October, so counts are derived from the
 * calendar and never hardcoded to 96. An API that sends only the monthly base before it publishes
 * the day, as EKZ does, yields a day without prices per kWh: that day is not complete.
 */
export function checkDay(day: string, prices: PriceInterval[]): DayCheck {
  const [start, end] = dayBounds(day);
  const issues: string[] = [];
  const dayMinutes = (end.ms - start.ms) / 60_000;
  if (prices.length === 0) {
    return { complete: false, issues: ["no intervals"], resolution_minutes: null, interval_count: 0, day_length_hours: dayMinutes / 60 };
  }
  const first = parseTimestamp(prices[0].start_timestamp);
  const last = parseTimestamp(prices[prices.length - 1].end_timestamp);
  if (first.ms !== start.ms) issues.push(`starts at ${formatTimestamp(first)}, expected ${formatTimestamp(start)}`);
  if (last.ms !== end.ms) issues.push(`ends at ${formatTimestamp(last)}, expected ${formatTimestamp(end)}`);
  prices.slice(1).forEach((entry, i) => {
    if (parseTimestamp(prices[i].end_timestamp).ms !== parseTimestamp(entry.start_timestamp).ms) {
      issues.push(`gap or overlap at ${prices[i].end_timestamp}`);
    }
  });
  const durations = new Set(prices.map((e) => (parseTimestamp(e.end_timestamp).ms - parseTimestamp(e.start_timestamp).ms) / 60_000));
  const resolution = durations.size === 1 ? [...durations][0] : null;
  if (resolution === null) issues.push("intervals have different lengths");
  const withoutKwh = prices.filter((entry) => !components(entry).some(([, values]) => values.some((v) => v.unit === "CHF_kWh"))).length;
  if (withoutKwh) issues.push(`${withoutKwh} of ${prices.length} intervals have no price per kWh`);
  return { complete: issues.length === 0, issues, resolution_minutes: resolution, interval_count: prices.length, day_length_hours: dayMinutes / 60 };
}

/**
 * The same prices in quarter hours. An hourly value becomes four equal quarter-hour values, as
 * HDN 5.3 (6) describes. An interval that is not a multiple of 15 minutes stays as it is.
 */
export function toQuarterHours(prices: PriceInterval[]): PriceInterval[] {
  return prices.flatMap((entry) => {
    const start = parseTimestamp(entry.start_timestamp).ms;
    const end = parseTimestamp(entry.end_timestamp).ms;
    const count = (end - start) / QUARTER_HOUR_MS;
    if (count <= 1 || !Number.isInteger(count)) return [entry];
    return Array.from({ length: count }, (_, i) => ({
      ...entry,
      start_timestamp: formatTimestamp(inZurich(start + i * QUARTER_HOUR_MS)),
      end_timestamp: formatTimestamp(inZurich(start + (i + 1) * QUARTER_HOUR_MS)),
    }));
  });
}

export interface AppliedPriceCorrection {
  set: string[];
  reason: string;
  sourceUrl?: string;
}

/** Apply the corrections of curation that cover this day: each replaces whole components. */
export function correctDay(day: string, prices: PriceInterval[], corrections: PriceCorrection[]): { prices: PriceInterval[]; applied: AppliedPriceCorrection[] } {
  const active = corrections.filter((c) => (c.from ?? "0000-00-00") <= day && day <= (c.to ?? "9999-12-31"));
  if (!active.length) return { prices, applied: [] };
  const corrected = prices.map((entry) => {
    const copy = { ...entry };
    for (const correction of active) Object.assign(copy, structuredClone(correction.set));
    return copy;
  });
  const applied = active.map(({ set, reason, sourceUrl }) => ({ set: Object.keys(set).sort(compareText), reason, ...(sourceUrl ? { sourceUrl } : {}) }));
  return { prices: corrected, applied };
}
