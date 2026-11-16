/**
 * One day of a product in quarter hours, with every component a customer pays: the day prices of
 * its dynamic tariffs and, from the yearly file, everything else (base prices, metering, fees, and
 * fixed energy or grid prices). The result is the HDN format of chapter 7.4. No Node APIs.
 *
 * Rules:
 * - A dynamic tariff contributes what its API sends. A price of the yearly file is added only for a
 *   unit the API does not send: EKZ sends the monthly base in the API, so it is not counted twice.
 * - Units are written as in HDN 7.4: CHF_kWh, CHF_m, and for power CHF_kW_m or CHF_kW_y.
 * - integrated is the sum of the prices per kWh of electricity, grid and regional_fees.
 * - Regional fees that differ by municipality are left out, because the product does not say which
 *   municipality applies. A note says so.
 */
import { compareText } from "./json.ts";
import { components, QUARTER_HOUR_MS } from "./price-day.ts";
import { MONTHS, WEEKDAYS, windowRanges } from "./rules.ts";
import { dayBounds, formatTimestamp, inZurich, parseTimestamp, zurichWall } from "./time.ts";
import type { ComponentPrice, PriceInterval, Product, RegionalTax, SimplePrice, Tariff, TimePrice } from "./types.ts";

const UNITS: Record<string, string> = {
  "CHF/kWh": "CHF_kWh", "CHF/M": "CHF_m", "CHF/kW/M": "CHF_kW_m", "CHF/kW/Y": "CHF_kW_y", "CHF/kW": "CHF_kW",
};
export const SUMMED_IN_INTEGRATED = ["electricity", "grid", "regional_fees"];
export const ORDER = ["electricity", "grid", "regional_fees", "metering", "feed_in", "integrated"];

export type Wall = ReturnType<typeof zurichWall>;
/** component -> unit -> value */
export type Parts = Map<string, Map<string, number>>;

function add(parts: Parts, component: string, unit: string, value: number): void {
  const units = parts.get(component) ?? new Map<string, number>();
  units.set(unit, (units.get(unit) ?? 0) + value);
  parts.set(component, units);
}

/** The entry of a time-based price list that applies at a wall-clock time, if any. */
export function priceAt(entries: TimePrice[] | undefined, wall: Wall): TimePrice | undefined {
  return entries?.find((entry) => (!entry.months?.length || entry.months.includes(MONTHS[wall.month]))
    && (!entry.weekdays?.length || entry.weekdays.includes(WEEKDAYS[wall.weekday]))
    && windowRanges(entry.from, entry.to).some(([from, to]) => from <= wall.minute && wall.minute < to));
}

function addSimple(parts: Parts, component: string, price: SimplePrice | undefined, notes: Set<string>, what: string): void {
  if (!price) return;
  const unit = UNITS[price.priceUnit];
  if (unit) add(parts, component, unit, price.price);
  else notes.add(`${what}: unit ${price.priceUnit} left out`);
}

function addTimed(parts: Parts, component: string, entries: TimePrice[] | undefined, wall: Wall, notes: Set<string>, what: string): void {
  const entry = priceAt(entries, wall);
  if (entry) addSimple(parts, component, entry, notes, what);
}

/** The one entry that applies, or undefined with a note if the entries differ. */
function single(entries: RegionalTax[] | undefined, notes: Set<string>, what: string): RegionalTax | undefined {
  if (!entries?.length) return undefined;
  const values = new Set(entries.map(({ municipalityNumber: _n, municipalityName: _m, cantonName: _c, ...prices }) => JSON.stringify(prices)));
  if (values.size === 1) return entries[0];
  notes.add(`${what}: ${entries.length} entries with different values, left out because they depend on the location`);
  return undefined;
}

/** What a tariff of the yearly file charges at a wall-clock time, without its day prices. */
export function yearlyParts(tariff: Tariff, wall: Wall, notes: Set<string>): Parts {
  const parts: Parts = new Map();
  const { prices } = tariff;
  const slot = tariff.tariffType;
  addSimple(parts, slot, prices.base, notes, tariff.id);
  if (tariff.tariffForm !== "dynamic") addTimed(parts, slot, prices.energy, wall, notes, tariff.id);
  addTimed(parts, slot, prices.power, wall, notes, tariff.id);
  if (prices.reactivePower?.length) notes.add(`${tariff.id}: reactive power is not included`);
  const municipality = single(prices.municipalityTaxes, notes, `${tariff.id} municipality taxes`);
  addSimple(parts, "regional_fees", municipality?.municipalityBase, notes, tariff.id);
  addTimed(parts, "regional_fees", municipality?.municipalityEnergy, wall, notes, tariff.id);
  const canton = single(prices.cantonalTaxes, notes, `${tariff.id} cantonal taxes`);
  addSimple(parts, "regional_fees", canton?.cantonBase, notes, tariff.id);
  addTimed(parts, "regional_fees", canton?.cantonEnergy, wall, notes, tariff.id);
  return parts;
}

const round = (value: number) => Number(value.toFixed(6));

/**
 * Compose one day of a product. dayPrices holds the quarter hours of each dynamic tariff, by tariff
 * id, as published under data/tariffs/<year>/<tariff>/. Returns the intervals and notes on what was left out.
 */
export function composeDay(day: string, product: Product, tariffs: Map<string, Tariff>, dayPrices: Map<string, PriceInterval[]>):
  { prices: PriceInterval[]; notes: string[] } {
  const notes = new Set<string>();
  const used = Object.values(product.components).map((c) => (c.tariff ? tariffs.get(c.tariff) : undefined)).filter((t): t is Tariff => t !== undefined);
  const byStart = new Map([...dayPrices].map(([id, prices]) => [id, new Map(prices.map((p) => [parseTimestamp(p.start_timestamp).ms, p]))]));
  const [start, end] = dayBounds(day);
  const prices: PriceInterval[] = [];
  for (let ms = start.ms; ms < end.ms; ms += QUARTER_HOUR_MS) {
    const wall = zurichWall(ms);
    const parts: Parts = new Map();
    for (const tariff of used) {
      const fromApi: Parts = new Map();
      const interval = byStart.get(tariff.id)?.get(ms);
      for (const [component, values] of interval ? components(interval) : []) {
        if (component === "integrated") continue; // recomputed below from all components
        for (const { unit, value } of values) add(fromApi, component, unit, value);
      }
      for (const [component, units] of fromApi) for (const [unit, value] of units) add(parts, component, unit, value);
      for (const [component, units] of yearlyParts(tariff, wall, notes)) {
        for (const [unit, value] of units) if (!fromApi.get(component)?.has(unit)) add(parts, component, unit, value);
      }
    }
    const perKwh = SUMMED_IN_INTEGRATED.map((c) => parts.get(c)?.get("CHF_kWh")).filter((v): v is number => v !== undefined);
    if (perKwh.length) parts.set("integrated", new Map([["CHF_kWh", perKwh.reduce((a, b) => a + b, 0)]]));
    const entry: PriceInterval = {
      start_timestamp: formatTimestamp(inZurich(ms)),
      end_timestamp: formatTimestamp(inZurich(ms + QUARTER_HOUR_MS)),
    };
    const rank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);
    for (const component of [...parts.keys()].sort((a, b) => rank(a) - rank(b) || compareText(a, b))) {
      entry[component] = [...parts.get(component)!].map(([unit, value]): ComponentPrice => ({ unit, value: round(value) }));
    }
    prices.push(entry);
  }
  return { prices, notes: [...notes].sort(compareText) };
}
