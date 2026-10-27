import type { LandedPrice } from "@cca/pricing";
/**
 * The decoded Bundle documents: what the writer accepts and the reader returns. How they
 * are laid out in files (names, sharding, encoding) is private to this module
 * (docs/adr/0004-bundle-format-and-catalog-query.md), so it can change without touching Publisher or the web.
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
export const BUNDLE_FORMAT = 2;

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
  /** Gearboxes the catalog states; absent when no catalog Source states them. */
  transmissions?: Transmission[];
  drive?: Drive;
  engineCc?: number;
  seats?: number;
  doors?: number;
  euroClass?: number;
  consumptionL100km?: number;
  consumptionKwh100km?: number;
  co2GKm?: number;
  massKg?: number;
  lengthMm?: number;
  newPriceCzk?: NewPrice;
  /** Aggregates over active used listings matched to this Variant; null when none. */
  used: UsedStats | null;
}

/**
 * Gross CZK a Czech buyer pays a dealer for a new car of this Variant, and where it came from:
 * `list` = the current manufacturer list prices (min-max over the Variant's Offers);
 * `dealer` = no current list price, so the landed price of active Czech dealer Listings of new
 * cars (min-max of those the outlier rule keeps). `count` = Offers or Listings behind it.
 */
export interface NewPrice {
  min: number;
  max: number;
  source: "list" | "dealer";
  count: number;
}

export interface UsedStats {
  /** Active used Listings matched to this Variant, outliers included (availability). */
  count: number;
  /**
   * Asking price in CZK over the Listings the outlier rule keeps; null when it keeps fewer
   * than 3, as for model-file cells (ADR 0012). Every statistic below counts only kept
   * Listings; the landed, odometer and per-Market quantiles are each null (or left out)
   * under 3 values of their own.
   */
  priceCzk: Quantiles | null;
  /** Landed CZK (docs: CONTEXT.md "Landed price"); only listings with an estimate count. */
  landedCzk: Quantiles | null;
  odometerKm: Quantiles | null;
  /** Asking price in CZK per Market; a Market with fewer than 3 kept Listings is left out. */
  byMarket: Partial<Record<Market, Quantiles>>;
  years: { min: number; max: number } | null;
  markets: Partial<Record<Market, number>>;
  sources: Record<string, number>;
  /**
   * The same listings split by (market, source), so listing-level filters can be matched
   * together: "DE + Sauto" matches only if one group has both. Sorted by market, source.
   * Built from every active used Listing, so outliers stay findable through filters.
   */
  groups: UsedGroup[];
}

export interface UsedGroup {
  market: Market;
  source: string;
  count: number;
  priceCzk: { min: number; max: number };
  odometerKm: { min: number; max: number } | null;
  years: { min: number; max: number } | null;
}

/** `count` is the sample behind the quantiles; it differs per measure. */
export interface Quantiles {
  count: number;
  p10: number;
  median: number;
  p90: number;
}

/** Everything a model page needs, loaded on demand. */
export interface ModelFile {
  model: { id: ModelId; makeId: MakeId; make: string; name: string };
  generations: { id: string; name: string; from: number; to?: number }[];
  variantIds: VariantId[];
  /** Active Listings plus those gone in the last 30 days, sorted by id. */
  listings: ListingRow[];
  /** Price statistics of the model's active Listings; see PriceCell. */
  stats: PriceCell[];
  /**
   * Weekly median asking price (CZK) of the model's used Listings, one series per Market:
   * a point every Monday plus the publish day, from the Listings active that day. A date
   * without a point had no active Listings (a gap, not zero).
   */
  history: { market: Market; points: { date: IsoDate; count: number; medianCzk: number }[] }[];
}

/**
 * Asking-price statistics (CZK at this Bundle's rates) of one slice of a model's active
 * Listings, over those the outlier rule keeps. `null` in a dimension means "all": each
 * (variant or model) × Market × Condition has its year × band cells and the year-only,
 * band-only and total ones. A missing cell means fewer than 3 Listings, not none; Markets
 * are never pooled. Sorted by variantId, market, condition, year, band (null first).
 */
export interface PriceCell {
  /** Null: the whole model, including Listings resolved only to the model. */
  variantId: VariantId | null;
  market: Market;
  condition: Condition;
  /** As `ListingRow.year`. */
  year: number | null;
  /** Null includes Listings without an odometer reading. */
  band: OdometerBand | null;
  count: number;
  p10: number;
  median: number;
  p90: number;
}

/** Lower bound inclusive, in km. */
export const ODOMETER_BANDS = [
  "0-10k",
  "10-50k",
  "50-100k",
  "100-150k",
  "150-200k",
  "200k+",
] as const;
export type OdometerBand = (typeof ODOMETER_BANDS)[number];

const BAND_LOWER_KM = [0, 10_000, 50_000, 100_000, 150_000, 200_000];

export function odometerBand(km: number): OdometerBand {
  let i = BAND_LOWER_KM.length - 1;
  while (km < (BAND_LOWER_KM[i] as number)) i--;
  return ODOMETER_BANDS[Math.max(i, 0)] as OdometerBand;
}

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
  /** Asking price as shown, without seller extras. */
  price: Money;
  /** Charges the seller invoices on top of `price`; the landed price includes them. */
  sellerExtras?: Money;
  priceCzk: number;
  /** Null when no estimate is possible (missing FX rate, unsupported market). */
  landed: LandedPrice | null;
  seller: Seller;
  location?: string;
  /** The first 3 photos; the rest stay at the Source. */
  photos: string[];
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  gone?: IsoDate;
  daysOnMarket: number;
  /** The outlier rule leaves this Listing out of every statistic. */
  excluded?: true;
  /** Oldest first. `priceCzk` converts at this Bundle's rates, so it shows price moves, not FX moves. */
  priceHistory: { date: IsoDate; price: Money; priceCzk: number }[];
}
