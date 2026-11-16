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
  /** url: the day prices of this project, tariffs/current/<id>.json. sourceUrl: the API of the utility. */
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

/**
 * Where the choice of a component comes from:
 * - standardBasegroup: the utility marks the tariff as standard (VSE 1.0.1, electricity and grid only)
 * - only: the yearly file has one tariff of this type for the voltage level
 * - curated: a person chose it and checked it against a source (sourceUrl)
 * - suggested: proposed, not checked
 */
export type Basis = "standardBasegroup" | "only" | "curated" | "suggested";

/** Selects tariffs of the yearly file by name, such as the concession fees of every municipality. */
export interface MunicipalitySelection {
  tariffNames?: string[];
}

/** One component of a product, as published in tariffs/<year>.json. */
export interface ProductComponent {
  /** The tariff in the total. Absent for regional fees that exist per municipality only. */
  tariff?: string;
  basis: Basis;
  sourceUrl?: string;
  /** Other tariffs of the same type a customer may have instead, such as transformer metering. */
  options?: string[];
  /** How a customer finds out which option applies. */
  howToFind?: string;
  /** regional_fees only: list the municipal fees of every municipality, by BFS number. */
  byMunicipality?: boolean | MunicipalitySelection;
}

export interface Product extends Open {
  id: string;
  name: string;
  /** verified when no component is suggested. */
  status: "suggested" | "verified";
  /**
   * The standard product of a household in the basic supply: what it gets without choosing
   * anything. At most one per year.
   */
  default?: boolean;
  sourceUrl?: string;
  note?: string;
  components: Partial<Record<TariffType, ProductComponent>>;
  selection?: { kind: string; value: string; howToFind?: string };
}

/**
 * A product as written in curation/<year>.json. A component is a tariff id, or an object whose
 * basis is derived when absent. status "verified" means a person checked every component that is
 * not standard or the only one: those become curated.
 */
export interface CuratedProduct extends Open {
  id: string;
  name: string;
  status?: Product["status"];
  default?: boolean;
  sourceUrl?: string;
  note?: string;
  selection?: Product["selection"];
  components: Partial<Record<TariffType, string | (Omit<ProductComponent, "basis"> & { basis?: Basis })>>;
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
  products?: CuratedProduct[];
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

/** data/tariffs/<year>/<id>/..., tariffs/current/ and data/products/<id>/<year>/...: HDN format with _meta. */
export interface PriceDay {
  $schema?: string;
  publication_timestamp: string | null;
  _meta: { complete: boolean; [key: string]: unknown };
  prices: PriceInterval[];
}

/** A component of a product year: the tariff in the total, and the options. */
export interface ProductYearComponent {
  basis: Basis;
  sourceUrl?: string;
  tariff?: Tariff;
  howToFind?: string;
  /** Each option alone: its monthly prices, and its prices per kWh as one price or per window. */
  options?: { id: string; tariffName: string; comment?: string; fixed: ComponentPrice[]; energy?: ComponentPrice[]; windows?: ProductWindow[] }[];
  byMunicipality?: boolean | MunicipalitySelection;
}

export type ProductComponents = Partial<Record<TariffType, ProductYearComponent>>;

/** The municipal fees of one municipality, added to the total of a product. */
export interface MunicipalityFees {
  number: number;
  name: string;
  tariffs: string[];
  /** Monthly prices, if any. */
  fixed: ComponentPrice[];
  /** The price per kWh if it applies all the time, else windows. */
  energy?: ComponentPrice[];
  windows?: ProductWindow[];
  /** The comments of the utility, such as a cap per year. */
  comments?: string[];
}

/** A time window of a product, with the prices of each component and their total. */
export interface ProductWindow {
  months: Month[];
  weekdays: Weekday[];
  from: string;
  to: string;
  [component: string]: string | string[] | ComponentPrice[];
}

export interface ProductTotal {
  /** Monthly prices of each component and their total. */
  fixed: Record<string, ComponentPrice[]>;
  /** Prices that depend on the time. Without the day prices of the dynamic components. */
  windows: ProductWindow[];
  /** Components whose price per kWh changes every day. */
  dynamic: TariffType[];
}

/** data/products/<id>/<year>.json: what a customer pays in a year. */
export interface ProductDocument {
  $schema?: string;
  id: string;
  name: string;
  year: number;
  status: Product["status"];
  default: boolean;
  selection?: Product["selection"];
  note?: string;
  sourceUrl?: string;
  dsoName: string;
  dsoNumber: number;
  pricesExcludeVat: true;
  total: ProductTotal;
  /** Slots of electricity, grid, metering and regional_fees without a tariff. */
  missing: TariffType[];
  /** The municipal fees per municipality, not in the total. Empty if the product does not list them. */
  municipalities: MunicipalityFees[];
  /** The tariffs of the product, as in tariffs/<year>.json, with where each choice comes from. */
  components: ProductComponents;
  _meta: {
    schemaVersion: string;
    vseVersion: string;
    generator: { name: string; version: string; url: string };
    /** The yearly file the components come from. */
    tariffs: string;
    /** Day prices of a product with a dynamic component, else null. */
    days: { latest: string; archive: string } | null;
    notes: string[];
  };
}
