/**
 * One year of a product: every component a customer pays, as the tariffs of the yearly file, and
 * their sum. This is the file to read to know what a household pays. No Node APIs.
 *
 * - fixed: the monthly prices (CHF_m) of all components and their total.
 * - windows: the prices that depend on the time, per Swiss wall-clock window. The windows of all
 *   components are cut into one set, so each window has one price per component and a total.
 *   Written as in VSE 1.0.1: the day ends at 23:59, a window across midnight is split in two.
 * - dynamic: the components whose price per kWh changes every day. Their day prices are not in the
 *   windows: see the day files of the product.
 */
import { ORDER, yearlyParts, type Parts } from "./compose.ts";
import { candidates } from "./product-spec.ts";
import { compareText } from "./json.ts";
import { MONTHS, WEEKDAYS, windowRanges } from "./rules.ts";
import type { ComponentPrice, MunicipalityFees, Product, ProductComponents, ProductTotal, ProductWindow, Tariff, TariffType, TimePrice } from "./types.ts";

export const SLOTS: TariffType[] = ["electricity", "grid", "metering", "regional_fees"];
const MINUTES_PER_DAY = 1440;
const FIXED_UNIT = "CHF_m";

const round = (value: number) => Number(value.toFixed(6));
const rank = (component: string) => (ORDER.includes(component) ? ORDER.indexOf(component) : ORDER.length);

function merge(target: Parts, source: Parts, keep: (unit: string) => boolean): void {
  for (const [component, units] of source) {
    for (const [unit, value] of units) {
      if (!keep(unit)) continue;
      const into = target.get(component) ?? new Map<string, number>();
      into.set(unit, (into.get(unit) ?? 0) + value);
      target.set(component, into);
    }
  }
}

/** Parts as written in a file: each component with its prices, then the total per unit. */
function written(parts: Parts): Record<string, ComponentPrice[]> {
  const result: Record<string, ComponentPrice[]> = {};
  const total = new Map<string, number>();
  for (const component of [...parts.keys()].sort((a, b) => rank(a) - rank(b) || compareText(a, b))) {
    const units = [...parts.get(component)!].sort(([a], [b]) => compareText(a, b));
    if (!units.length) continue;
    result[component] = units.map(([unit, value]) => ({ unit, value: round(value) }));
    for (const [unit, value] of units) total.set(unit, (total.get(unit) ?? 0) + value);
  }
  result.total = [...total].sort(([a], [b]) => compareText(a, b)).map(([unit, value]) => ({ unit, value: round(value) }));
  return result;
}

/** Every time-based price list of a tariff, including the regional fees. */
function timeLists(tariff: Tariff): TimePrice[][] {
  const { prices } = tariff;
  return [
    prices.energy, prices.power,
    ...(prices.municipalityTaxes ?? []).map((tax) => tax.municipalityEnergy),
    ...(prices.cantonalTaxes ?? []).map((tax) => tax.cantonEnergy),
  ].filter((list): list is TimePrice[] => Array.isArray(list));
}

function applies(entry: TimePrice, month: number, weekday: number): boolean {
  return (!entry.months?.length || entry.months.includes(MONTHS[month]))
    && (!entry.weekdays?.length || entry.weekdays.includes(WEEKDAYS[weekday]));
}

interface Segment {
  from: number;
  to: number;
  key: string;
  parts: Parts;
}

const keyOf = (parts: Parts) => JSON.stringify([...parts].sort(([a], [b]) => compareText(a, b))
  .map(([component, units]) => [component, [...units].sort(([a], [b]) => compareText(a, b))]));

/** The segments of one month and weekday with the same prices, from 00:00 to the end of the day. */
function dayProfile(tariffs: Tariff[], month: number, weekday: number, notes: Set<string>): Segment[] {
  const cuts = new Set([0, MINUTES_PER_DAY]);
  for (const tariff of tariffs) {
    for (const list of timeLists(tariff)) {
      for (const entry of list.filter((e) => applies(e, month, weekday))) {
        for (const [from, to] of windowRanges(entry.from, entry.to)) cuts.add(from).add(to);
      }
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const parts: Parts = new Map();
    for (const tariff of tariffs) {
      merge(parts, yearlyParts(tariff, { date: "", month, weekday, minute: sorted[i] }, notes), (unit) => unit !== FIXED_UNIT);
    }
    const key = keyOf(parts);
    const previous = segments.at(-1);
    if (previous && previous.key === key) previous.to = sorted[i + 1];
    else segments.push({ from: sorted[i], to: sorted[i + 1], key, parts });
  }
  return segments;
}

const clock = (minute: number) => (minute >= MINUTES_PER_DAY ? "23:59"
  : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);

/**
 * The windows of a year. Months and weekdays with the same prices over the day are grouped, so a
 * tariff with summer and winter prices gives two groups, not 84.
 */
function windows(tariffs: Tariff[], notes: Set<string>): ProductWindow[] {
  const profiles = MONTHS.map((_, month) => WEEKDAYS.map((_, weekday) => dayProfile(tariffs, month, weekday, notes)));
  const profileKey = (segments: Segment[]) => segments.map((s) => `${s.from}-${s.to}:${s.key}`).join("|");
  // Per month: weekdays grouped by their profile. Then months grouped by that grouping.
  const monthGroups = new Map<string, { months: number[]; weekdays: number[][]; profiles: Segment[][] }>();
  profiles.forEach((days, month) => {
    const byProfile = new Map<string, number[]>();
    days.forEach((segments, weekday) => byProfile.set(profileKey(segments), [...(byProfile.get(profileKey(segments)) ?? []), weekday]));
    const signature = JSON.stringify([...byProfile]);
    const group = monthGroups.get(signature) ?? { months: [], weekdays: [...byProfile.values()], profiles: [...byProfile.values()].map((w) => days[w[0]]) };
    group.months.push(month);
    monthGroups.set(signature, group);
  });
  const result: ProductWindow[] = [];
  for (const group of monthGroups.values()) {
    group.weekdays.forEach((weekdays, i) => {
      for (const segment of group.profiles[i]) {
        if (!segment.parts.size) continue;
        result.push({
          months: group.months.map((m) => MONTHS[m]),
          weekdays: weekdays.map((w) => WEEKDAYS[w]),
          from: clock(segment.from),
          to: clock(segment.to),
          ...written(segment.parts),
        });
      }
    });
  }
  return result;
}

/** The total of the tariffs of a product: fixed monthly prices, prices per window, dynamic components. */
export function productTotal(tariffs: Tariff[]): { total: ProductTotal; notes: string[] } {
  const notes = new Set<string>();
  const fixed: Parts = new Map();
  for (const tariff of tariffs) merge(fixed, yearlyParts(tariff, { date: "", month: 0, weekday: 0, minute: 0 }, notes), (unit) => unit === FIXED_UNIT);
  return {
    total: {
      fixed: written(fixed),
      windows: windows(tariffs, notes),
      dynamic: tariffs.filter((t) => t.tariffForm === "dynamic").map((t) => t.tariffType),
    },
    notes: [...notes].sort(compareText),
  };
}

const ALL_MONTHS = MONTHS.length;
const ALL_WEEKDAYS = WEEKDAYS.length;

/** The total of one tariff or municipality alone, as short as possible: one price if it applies all the time. */
function alone(tariffs: Tariff[], notes: Set<string>): { fixed: ComponentPrice[]; energy?: ComponentPrice[]; windows?: ProductWindow[] } {
  const { total, notes: own } = productTotal(tariffs);
  own.forEach((note) => notes.add(note));
  const windows = total.windows.map(({ months, weekdays, from, to, total: sum }) => ({ months, weekdays, from, to, total: sum }));
  const fixed = (total.fixed.total ?? []).filter((price) => price.value !== 0);
  const [only] = windows;
  if (windows.length === 1 && only.months.length === ALL_MONTHS && only.weekdays.length === ALL_WEEKDAYS && only.from === "00:00" && only.to === "23:59") {
    return { fixed, energy: only.total as ComponentPrice[] };
  }
  return { fixed, ...(windows.length ? { windows } : {}) };
}

/** The municipal fees of each municipality, from the regional fee tariffs the product selects. */
function municipalities(selected: Tariff[], notes: Set<string>): MunicipalityFees[] {
  const byNumber = new Map<number, { name: string; tariffs: Tariff[]; comments: Set<string> }>();
  for (const tariff of selected) {
    for (const tax of tariff.prices.municipalityTaxes ?? []) {
      if (typeof tax.municipalityNumber !== "number") continue;
      const entry = byNumber.get(tax.municipalityNumber) ?? { name: tax.municipalityName ?? "", tariffs: [], comments: new Set<string>() };
      // The tariff with this one municipality only, so it is counted for this municipality alone.
      entry.tariffs.push({ ...tariff, prices: { municipalityTaxes: [tax] } });
      if (typeof tax.municipalityComment === "string" && tax.municipalityComment.trim()) entry.comments.add(tax.municipalityComment.trim());
      byNumber.set(tax.municipalityNumber, entry);
    }
  }
  return [...byNumber].map(([number, entry]): MunicipalityFees => ({
    number,
    name: entry.name,
    tariffs: [...new Set(entry.tariffs.map((t) => t.id))].sort(compareText),
    ...alone(entry.tariffs, notes),
    ...(entry.comments.size ? { comments: [...entry.comments].sort(compareText) } : {}),
  })).sort((a, b) => compareText(a.name, b.name) || a.number - b.number);
}

export interface ProductYear {
  components: ProductComponents;
  missing: TariffType[];
  municipalities: MunicipalityFees[];
  total: ProductTotal;
  notes: string[];
}

/** A product of a year: its components with options, the total, and the municipal fees. */
export function productYear(product: Product, tariffs: Tariff[]): ProductYear {
  const byId = new Map(tariffs.map((t) => [t.id, t]));
  const notes = new Set<string>();
  const level = product.components.grid?.tariff ? byId.get(product.components.grid.tariff)?.customerVoltageLevel : undefined;
  const components: ProductComponents = {};
  const missing: TariffType[] = [];
  const inTotal: Tariff[] = [];
  let listed: MunicipalityFees[] = [];
  for (const slot of SLOTS) {
    const spec = product.components[slot];
    const tariff = spec?.tariff ? byId.get(spec.tariff) : undefined;
    if (!spec || (!tariff && !spec.byMunicipality)) {
      missing.push(slot);
      continue;
    }
    // Municipal fees listed per municipality are not in the total, also those of the tariff in the total.
    const perMunicipality = slot === "regional_fees" && spec.byMunicipality;
    if (tariff) inTotal.push(perMunicipality ? { ...tariff, prices: { ...tariff.prices, municipalityTaxes: undefined } } : tariff);
    const options = (spec.options ?? []).map((id) => byId.get(id)).filter((t): t is Tariff => t !== undefined).map((option) => {
      const { fixed, energy, windows: own } = alone([option], notes);
      return { id: option.id, tariffName: option.tariffName, ...(option.comment ? { comment: option.comment } : {}), fixed, ...(energy ? { energy } : {}), ...(own ? { windows: own } : {}) };
    });
    components[slot] = {
      basis: spec.basis,
      sourceUrl: spec.sourceUrl,
      tariff,
      howToFind: spec.howToFind,
      ...(options.length ? { options } : {}),
      byMunicipality: spec.byMunicipality,
    };
    if (slot === "regional_fees" && spec.byMunicipality) {
      const names = typeof spec.byMunicipality === "object" ? spec.byMunicipality.tariffNames : undefined;
      const fees = candidates(tariffs, "regional_fees", level);
      const selected = fees.filter((t) => t.prices.municipalityTaxes?.length && (!names || names.includes(t.tariffName)));
      listed = municipalities(selected, notes);
      const left = Map.groupBy(fees.filter((t) => !selected.includes(t) && t.id !== tariff?.id), (t) => t.tariffName);
      const named = [...left].sort(([a], [b]) => compareText(a, b)).map(([name, group]) => (group.length > 1 ? `${name} (${group.length} tariffs)` : group[0].id));
      if (named.length) notes.add(`regional fees in neither the total nor the municipalities: ${named.join("; ")}`);
    }
  }
  const { total, notes: totalNotes } = productTotal(inTotal);
  totalNotes.forEach((note) => notes.add(note));
  if (listed.length) notes.add(`the total is without municipal fees: add those of your municipality from municipalities`);
  return { components, missing, municipalities: listed, total, notes: [...notes].sort(compareText) };
}
