/** Types of the files this project reads and writes. The JSON schemas in schemas/ are binding. */

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

export interface Prices extends Open {
  base?: SimplePrice;
  energy?: TimePrice[];
  power?: TimePrice[];
  reactivePower?: TimePrice[];
  refundStorage?: SimplePrice;
  dynamic?: { url: string };
  municipalityTaxes?: Open[];
  cantonalTaxes?: Open[];
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

export interface TariffDocument {
  $schema?: string;
  dsoName: string;
  dsoNumber: number;
  _meta: {
    schemaVersion: string;
    year: number;
    generatedAt?: string;
    source: { name: string; url?: string; file?: string; sha256: string }[];
    pricesExcludeVat?: boolean;
    repairs: Repair[];
    overrides: AppliedCuration[];
    issues?: Issue[];
  };
  tariffs: Tariff[];
  products: Product[];
}

export type TariffMatch = Partial<Pick<Tariff, "tariffName" | "tariffType" | "customerVoltageLevel" | "customerType">>;

export interface Curation {
  year?: number;
  overrides?: { match: TariffMatch; set: Record<string, unknown>; reason: string; sourceUrl?: string }[];
  removeTariffs?: { match: TariffMatch; reason: string }[];
  addTariffs?: { tariff: Tariff; reason: string; sourceUrl?: string }[];
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

export interface AddedComponent {
  tariff_type: string;
  unit: string;
  value: number;
  reason: string;
  valid_from?: string;
  valid_to?: string;
}

export interface DynamicTariffConfig {
  id: string;
  name: string;
  enabled?: boolean;
  api_url: string;
  query?: Record<string, string | number | boolean>;
  components?: string[];
  normalizer?: string;
  component_map?: Record<string, string>;
  add_components?: AddedComponent[];
  backfill_days?: number;
  alert_after_hour?: number;
  valid_from?: string;
  valid_to?: string;
}

export interface StaticSource {
  name: string;
  url?: string;
  file?: string;
  enabled?: boolean;
}

export interface SourceConfig {
  slug: string;
  name: string;
  country?: string;
  website?: string;
  vse_id: string;
  data_license?: string;
  dynamic: DynamicTariffConfig[];
  static: { sources: StaticSource[] };
}

export interface ComponentPrice {
  unit: string;
  value: number;
}

/** One interval of a dynamic tariff. Every key besides the timestamps is a component such as grid. */
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
  expected_interval_count: number | null;
  day_length_hours: number;
}

/** A VSE day file in vse/<year>/<date>.json or latest.json. Files archived before 2.0 have no _meta. */
export interface DynamicDay {
  $schema?: string;
  publication_timestamp: string | null;
  _meta?: { complete?: boolean; [key: string]: unknown };
  prices: PriceInterval[];
}
