/**
 * Normalizer for sources that follow the VSE dynamic-tariff wire format:
 *
 *     {"publication_timestamp": ..., "prices": [
 *         {"start_timestamp": ..., "end_timestamp": ...,
 *          "<tariff_type>": [{"unit": "CHF_kWh"|"CHF_m", "value": ...}, ...], ...}]}
 *
 * Reference: VSE/AES Handbuch HDN 2025, chapters 7.3 and 7.4. No Node APIs.
 */
import { compareText } from "../json.ts";
import { dayBounds, formatTimestamp, inUtc, inZurich, parseTimestamp, zurichDate } from "../time.ts";
import type { ComponentPrice, DayCheck, DynamicDay, DynamicTariffConfig, PriceInterval, SourceConfig } from "../types.ts";

export const NORMALIZED_VERSION = "1.1";
const TIME_KEYS = new Set(["start_timestamp", "end_timestamp"]);
// Handbook 7.4.1 uses tariff_type=dso for what table 3 calls grid.
const DEFAULT_COMPONENT_MAP: Record<string, string> = { dso: "grid" };
const UNIT_ALIASES = new Map([["CHF/kWh", "CHF_kWh"], ["CHF/m", "CHF_m"], ["CHF/M", "CHF_m"]]);

/** What a source sends. Checked while reading, because sources deviate from the standard. */
export interface RawDynamic {
  publication_timestamp?: string | null;
  prices: Record<string, unknown>[];
}

/** The components of an interval, without the timestamps. */
export function components(entry: PriceInterval): [string, ComponentPrice[]][] {
  return Object.entries(entry).filter((pair): pair is [string, ComponentPrice[]] => !TIME_KEYS.has(pair[0]));
}

function valueIn(prices: ComponentPrice[] | undefined, unit: string): number | undefined {
  return prices?.find((price) => price.unit === unit)?.value;
}

function component(entry: PriceInterval, key: string): ComponentPrice[] | undefined {
  const value = entry[key];
  return Array.isArray(value) ? value : undefined;
}

/**
 * All intervals in VSE shape, sorted by instant, with Swiss local timestamps, and the list of
 * additions made to the source data.
 */
export function canonicalize(raw: RawDynamic, tariff: Partial<DynamicTariffConfig>): { prices: PriceInterval[]; notes: string[] } {
  const componentMap = { ...DEFAULT_COMPONENT_MAP, ...tariff.component_map };
  const notes = new Set<string>();
  const byStart = new Map<number, PriceInterval>();
  for (const source of raw.prices) {
    const start = parseTimestamp(String(source.start_timestamp));
    const end = parseTimestamp(String(source.end_timestamp));
    const entry: PriceInterval = {
      start_timestamp: formatTimestamp(inZurich(start.ms)),
      end_timestamp: formatTimestamp(inZurich(end.ms)),
    };
    for (const [key, values] of Object.entries(source)) {
      if (TIME_KEYS.has(key)) continue;
      const target = componentMap[key] ?? key;
      if (target !== key) notes.add(`renamed component ${key} to ${target}`);
      entry[target] = (values as ComponentPrice[]).map((item) => ({ ...item, unit: UNIT_ALIASES.get(item.unit) ?? item.unit }));
    }
    const localDay = zurichDate(start.ms);
    for (const extra of tariff.add_components ?? []) {
      const inRange = (extra.valid_from ?? "0000") <= localDay && localDay <= (extra.valid_to ?? "9999");
      if (inRange && !(extra.tariff_type in entry)) {
        entry[extra.tariff_type] = [{ unit: extra.unit, value: extra.value }];
        notes.add(`added ${extra.tariff_type} from config: ${extra.reason}`);
      }
    }
    const grid = valueIn(component(entry, "grid"), "CHF_kWh");
    const electricity = valueIn(component(entry, "electricity"), "CHF_kWh");
    if (!("integrated" in entry) && grid !== undefined && electricity !== undefined) {
      entry.integrated = [{ unit: "CHF_kWh", value: Number((grid + electricity).toFixed(6)) }];
      notes.add("derived integrated = grid + electricity");
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
 * Check that the intervals cover exactly one Swiss calendar day. The day has 92 quarter hours in
 * March and 100 in October, so counts are derived from the calendar and never hardcoded to 96.
 */
export function checkDay(day: string, prices: PriceInterval[]): DayCheck {
  const [start, end] = dayBounds(day);
  const issues: string[] = [];
  const dayMinutes = (end.ms - start.ms) / 60_000;
  if (prices.length === 0) {
    return { complete: false, issues: ["no intervals"], resolution_minutes: null, interval_count: 0,
      expected_interval_count: null, day_length_hours: dayMinutes / 60 };
  }
  const first = parseTimestamp(prices[0].start_timestamp);
  const last = parseTimestamp(prices[prices.length - 1].end_timestamp);
  if (first.ms !== start.ms) issues.push(`starts at ${formatTimestamp(first)}, expected ${formatTimestamp(start)}`);
  if (last.ms !== end.ms) issues.push(`ends at ${formatTimestamp(last)}, expected ${formatTimestamp(end)}`);
  prices.slice(1).forEach((entry, i) => {
    if (prices[i].end_timestamp !== entry.start_timestamp) issues.push(`gap or overlap at ${prices[i].end_timestamp}`);
  });
  const durations = new Set(prices.map((e) => (parseTimestamp(e.end_timestamp).ms - parseTimestamp(e.start_timestamp).ms) / 60_000));
  const resolution = durations.size === 1 ? [...durations][0] : null;
  if (resolution === null) issues.push("intervals have different lengths");
  return {
    complete: issues.length === 0,
    issues,
    resolution_minutes: resolution,
    interval_count: prices.length,
    expected_interval_count: resolution ? Math.trunc(dayMinutes / resolution) : null,
    day_length_hours: dayMinutes / 60,
  };
}

export interface NormalizeContext {
  org: SourceConfig;
  tariff: DynamicTariffConfig;
  date: string;
  retrievedAt: string;
  check: DayCheck;
}

/** Cross-organization schema with UTC timestamps. See SCHEMA.md. */
export function normalize(doc: DynamicDay, { org, tariff, date, retrievedAt, check }: NormalizeContext) {
  const keys = [...new Set(doc.prices.flatMap((entry) => components(entry).map(([key]) => key)))].sort(compareText);
  const fixedCharges: Record<string, { chf_per_month: number }> = {};
  const intervals = doc.prices.map((entry) => {
    const perKwh: Record<string, { chf_per_kwh: number }> = {};
    for (const key of keys) {
      const kwh = valueIn(component(entry, key), "CHF_kWh");
      const month = valueIn(component(entry, key), "CHF_m");
      if (kwh !== undefined) perKwh[key] = { chf_per_kwh: kwh };
      if (month !== undefined) fixedCharges[key] = { chf_per_month: month };
    }
    return {
      start: formatTimestamp(inUtc(parseTimestamp(entry.start_timestamp).ms)),
      end: formatTimestamp(inUtc(parseTimestamp(entry.end_timestamp).ms)),
      components: perKwh,
      total_chf_per_kwh: (perKwh.integrated ?? perKwh.feed_in)?.chf_per_kwh ?? null,
    };
  });
  const website = org.website ?? "no website";
  return {
    schema_version: NORMALIZED_VERSION,
    source: {
      organization: org.name,
      organization_slug: org.slug,
      tariff_id: tariff.id,
      country: org.country ?? "CH",
      api_url: tariff.api_url,
      website: org.website ?? null,
      publication_timestamp: doc.publication_timestamp ?? null,
      attribution: `Data sourced from ${org.name} (${website}), archived by ` +
        `Strompreise-Schweiz (https://github.com/Strompreise-Schweiz/${org.slug}).`,
    },
    retrieved_at: retrievedAt,
    date,
    complete: check.complete,
    tariff_type: keys.every((key) => key === "feed_in") ? "feed_in" : "consumption",
    timezone: "UTC",
    currency: "CHF",
    resolution_minutes: check.resolution_minutes,
    fixed_charges: fixedCharges,
    intervals,
  };
}
