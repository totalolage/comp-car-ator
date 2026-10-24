import type { LandedPrice } from "@cca/pricing";
/**
 * The decoded Bundle documents: what the writer accepts and the reader returns. How they
 * are laid out in files (names, sharding, encoding) is private to this module
 * (docs/adr/0004-bundle-format.md), so it can change without touching Publisher or the web.
 */
import type {
  Body,
  Condition,
  Drive,
  Fuel,
  FxTable,
  IsoDate,
  MakeId,
  Market,
  ModelId,
  Money,
  Seller,
  Transmission,
  VariantId,
} from "@cca/vocabulary";

/** Bumped on any change a previous reader cannot read. */
export const BUNDLE_FORMAT = 1;

export interface BundleContent {
  manifest: BundleManifest;
  catalog: CatalogIndex;
  models: ModelFile[];
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  /** ISO timestamp of the publish. */
  generatedAt: string;
  /** Rates used for every CZK figure in this Bundle. */
  fx: FxTable;
  sources: { id: string; lastRunAt: string | null }[];
  counts: { makes: number; models: number; variants: number; listings: number };
}

/** Everything the catalog table and facet rail need, loaded once. */
export interface CatalogIndex {
  makes: { id: MakeId; name: string }[];
  models: { id: ModelId; makeId: MakeId; name: string; listingCount: number }[];
  variants: VariantRow[];
}

export interface VariantRow {
  id: VariantId;
  makeId: MakeId;
  modelId: ModelId;
  generationId: string;
  make: string;
  model: string;
  generation: string;
  years: { from: number; to?: number };
  body: Body;
  fuel: Fuel;
  powerKw: number;
  transmission: Transmission;
  drive?: Drive;
  engineCc?: number;
  seats?: number;
  doors?: number;
  euroClass?: number;
  consumptionL100km?: number;
  consumptionKwh100km?: number;
  co2GKm?: number;
  /** Range of current CZ list prices across trims, gross CZK. */
  newPriceCzk?: { min: number; max: number };
  /** Aggregates over active used listings matched to this Variant; null when none. */
  used: UsedStats | null;
}

export interface UsedStats {
  count: number;
  priceCzk: Quantiles;
  /** Landed CZK (docs: CONTEXT.md "Landed price"); only listings with an estimate count. */
  landedCzk: Quantiles | null;
  odometerKm: Quantiles | null;
  years: { min: number; max: number } | null;
  markets: Partial<Record<Market, number>>;
  sources: Record<string, number>;
}

export interface Quantiles {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

/** Everything a model page needs, loaded on demand. */
export interface ModelFile {
  model: { id: ModelId; makeId: MakeId; make: string; name: string };
  generations: { id: string; name: string; from: number; to?: number }[];
  variantIds: VariantId[];
  listings: ListingRow[];
  stats: {
    byYear: { year: number; count: number; medianCzk: number }[];
    byOdometerBand: { band: OdometerBand; count: number; medianCzk: number }[];
  };
  /** Daily median asking price (CZK) of the model's active used listings. */
  history: { date: IsoDate; count: number; medianCzk: number }[];
}

export const ODOMETER_BANDS = ["0-50k", "50-100k", "100-150k", "150-200k", "200k+"] as const;
export type OdometerBand = (typeof ODOMETER_BANDS)[number];

export interface ListingRow {
  /** `<source>:<ref>`, unique across the Bundle. */
  id: string;
  source: string;
  url: string;
  market: Market;
  condition: Condition;
  /** Null when the Resolver matched only the model. */
  variantId: VariantId | null;
  /** Source's own make/model/trim text. */
  title: string;
  year?: number;
  month?: number;
  odometerKm?: number;
  body?: Body;
  fuel?: Fuel;
  powerKw?: number;
  transmission?: Transmission;
  price: Money;
  priceCzk: number;
  /** Null when no estimate is possible (missing FX rate, unsupported market). */
  landed: LandedPrice | null;
  seller: Seller;
  location?: string;
  photos: string[];
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  gone?: IsoDate;
  daysOnMarket: number;
  priceHistory: { date: IsoDate; amount: number }[];
}
