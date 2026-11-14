/** Types of the files this project reads and writes. The JSON schemas in schemas/ are binding. */
import type { ExcludedTariff } from "./exclusion.ts";

export type { ExcludedTariff };

export type Month = "Jan" | "Feb" | "Mar" | "Apr" | "May" | "Jun" | "Jul" | "Aug" | "Sep" | "Oct" | "Nov" | "Dec";
export type Weekday = "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su";
export type TariffType = "electricity" | "grid" | "metering" | "regional_fees";
export type TariffForm = "constant" | "multilevel" | "dynamic";

// VSE objects allow additional properties, and sources use them (standardBasegroup, url at EKZ).
// They are kept, so every object type accepts unknown extra fields.
interface Open {
  [extra: string]: unknown;
}

export interface SimplePrice extends Open {
  price: number;
  priceUnit: string;
}

export interface TimePrice extends SimplePrice {
  months?: Month[] | null;
  weekdays?: Weekday[] | null;
  from: string;
  to: string;
}

export interface RegionalTax extends Open {
  municipalityNumber?: number;
  municipalityName?: string;
  municipalityBase?: SimplePrice;
  municipalityEnergy?: TimePrice[];
  cantonName?: string;
  cantonBase?: SimplePrice;
  cantonEnergy?: TimePrice[];
}

export interface Prices extends Open {
  base?: SimplePrice;
  energy?: TimePrice[];
  power?: TimePrice[];
  reactivePower?: TimePrice[];
  refundStorage?: SimplePrice;
  /** url: the published day prices of this project. sourceUrl: the API of the utility. */
  dynamic?: { url: string; sourceUrl?: string };
  municipalityTaxes?: RegionalTax[];
  cantonalTaxes?: RegionalTax[];
}

export interface Tariff extends Open {
  id: string;
  tariffName: string;
  tariffType: TariffType;
  tariffForm: TariffForm;
  /** Required for grid tariffs since VSE 1.0.1. */
  customerVoltageLevel?: number;
  /** The standard tariff of the basic customer group, at most one per electricity and grid. VSE 1.0.1. */
  standardBasegroup?: boolean;
  customerType: string;
  startDate: string;
  endDate: string;
  comment?: string;
  url?: string;
  prices: Prices;
}

export interface Product extends Open {
  id: string;
  name: string;
  status: "suggested" | "verified";
  sourceUrl?: string;
  note?: string;
  components: Partial<Record<TariffType, string>>;
  selection?: { kind: string; value: string; howToFind?: string };
}

export interface Repair {
  code: string;
  detail: string;
  count: number;
}

export type Severity = "error" | "warning" | "accepted";

export interface Issue {
  severity: Severity;
  code: string;
  tariff?: string;
  path?: string;
  message: string;
  acceptReason?: string;
}

/** A file of a utility, as stored in data/sources/. */
export interface SourceRef {
  name: string;
  url?: string;
  file?: string;
  sha256: string;
}

/** data/tariffs/<year>.json: a VSE file with additions. */
export interface TariffDocument {
  $schema?: string;
  dsoName: string;
  dsoNumber: number;
  _meta: {
    /** Version of the format of this project. */
    schemaVersion: string;
    /** Version of the VSE OpenAPI definition the file follows. */
    vseVersion: string;
    /** The engine that wrote the file, such as tariff-core 4.0.0. */
    generator: { name: string; version: string; url: string };
    year: number;
    pricesExcludeVat: true;
    /** The files of the utility this file was built from. */
    source: SourceRef[];
    /** Automatic repairs of deviations from the VSE format. */
    repairs: Repair[];
    /** The corrections from curation/<year>.json. */
    corrections: AppliedCuration[];
  };
  tariffs: Tariff[];
  products: Product[];
}

export type TariffMatch = Partial<Pick<Tariff, "tariffName" | "tariffType" | "customerVoltageLevel" | "customerType">>;

/** A correction of day prices: replaces components of every interval in the date range. */
export interface PriceCorrection {
  /** Id of the price source in config/source.json. */
  prices: string;
  from?: string;
  to?: string;
  set: Record<string, ComponentPrice[]>;
  reason: string;
  sourceUrl?: string;
}

/** curation/<year>.json: everything a person changes, each with a reason. */
export interface Curation {
  year?: number;
  overrides?: { match: TariffMatch; set: Record<string, unknown>; reason: string; sourceUrl?: string }[];
  removeTariffs?: { match: TariffMatch; reason: string }[];
  addTariffs?: { tariff: Tariff; reason: string; sourceUrl?: string }[];
  prices?: PriceCorrection[];
  products?: Product[];
  acceptIssues?: Waiver[];
}

export interface Waiver {
  code: string;
  tariff?: string;
  reason: string;
}

export type AppliedCuration =
  | { action: "remove"; match: TariffMatch; reason: string }
  | { action: "override"; match: TariffMatch; set: string[]; reason: string; sourceUrl?: string; count: number }
  | { action: "add"; tariffName: string; reason: string; sourceUrl?: string };

/** A yearly tariff file of the utility. */
export interface TariffSource {
  name: string;
  url?: string;
  /** A hand-written file in the repo, for a utility without usable JSON. */
  file?: string;
  enabled?: boolean;
  note?: string;
}

/** An API with day prices, in the format of HDN 2025 chapter 7.4. */
export interface PriceSource {
  id: string;
  name: string;
  /** As in prices.dynamic.url of the yearly file, with tariff_name. The day window is added. */
  url: string;
  enabled?: boolean;
  valid_from?: string;
  valid_to?: string;
  /** Component names the API uses, mapped to those of HDN table 3, such as {"dso": "grid"}. */
  component_map?: Record<string, string>;
  backfill_days?: number;
  alert_after_hour?: number;
  note?: string;
}

/** config/source.json: where the data comes from. */
export interface SourceConfig {
  slug: string;
  name: string;
  country?: string;
  website?: string;
  vse_id: string;
  elcom_id?: number;
  data_license?: string;
  tariffs: TariffSource[];
  prices: PriceSource[];
}

export interface ComponentPrice {
  unit: string;
  value: number;
}

/** One interval. Every key besides the timestamps is a component such as grid. */
export interface PriceInterval {
  start_timestamp: string;
  end_timestamp: string;
  [component: string]: string | ComponentPrice[];
}

export interface DayCheck {
  complete: boolean;
  issues: string[];
  resolution_minutes: number | null;
  interval_count: number;
  day_length_hours: number;
}

/** data/prices/<id>/... and data/products/<id>/...: HDN format with _meta. */
export interface PriceDay {
  $schema?: string;
  publication_timestamp: string | null;
  _meta: { complete: boolean; [key: string]: unknown };
  prices: PriceInterval[];
}
