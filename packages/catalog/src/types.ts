import type { BundleManifest, ListingRow, Loader, ModelFile, VariantRow } from "@cca/bundle";
import type { Body, Condition, Fuel, Market, ModelId, Transmission } from "@cca/vocabulary";

export type { Loader };

/** Inclusive numeric range; either end optional. */
export interface Range {
  min?: number;
  max?: number;
}

/**
 * Filters over catalog Variants. Values inside one facet are OR-ed, facets are AND-ed.
 * Listing-derived facets (market, source, usedPriceCzk) match Variants that have at least
 * one active used listing satisfying them, judged on the Variant's aggregates.
 */
export interface VariantFilters {
  make?: string[];
  model?: string[];
  body?: Body[];
  fuel?: Fuel[];
  transmission?: Transmission[];
  market?: Market[];
  source?: string[];
  /** Overlap with the Variant's production years. */
  year?: Range;
  powerKw?: Range;
  seats?: Range;
  consumptionL100km?: Range;
  /** Overlap with the Variant's new-price range. */
  newPriceCzk?: Range;
  /** Median used price. */
  usedPriceCzk?: Range;
}

/** Filters over one model's listings. Same OR/AND rule as VariantFilters. */
export interface ListingFilters {
  variant?: string[];
  market?: Market[];
  source?: string[];
  condition?: Condition[];
  body?: Body[];
  fuel?: Fuel[];
  transmission?: Transmission[];
  year?: Range;
  odometerKm?: Range;
  priceCzk?: Range;
  landedCzk?: Range;
  powerKw?: Range;
  /** Include listings that are gone. Default false. */
  includeGone?: boolean;
}

export type VariantSortKey =
  | "make"
  | "model"
  | "year"
  | "powerKw"
  | "newPriceCzk"
  | "usedPriceCzk"
  | "usedCount"
  | "consumptionL100km";

export type ListingSortKey =
  | "priceCzk"
  | "landedCzk"
  | "year"
  | "odometerKm"
  | "daysOnMarket"
  | "firstSeen";

export interface Sort<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

export interface Query<F, K extends string> {
  filters?: F;
  sort?: Sort<K>;
  offset?: number;
  /** Default 50. */
  limit?: number;
}

export type VariantQuery = Query<VariantFilters, VariantSortKey>;
export type ListingQuery = Query<ListingFilters, ListingSortKey>;

/** One facet value and how many rows would match if it were the only value chosen. */
export interface FacetCount {
  value: string;
  count: number;
}

/**
 * Facet counts are disjunctive: each facet's counts apply every active filter except that
 * facet's own, so choosing another value of the same facet never shows zero by itself.
 * Ranges are the min/max over rows matching all other filters (null when none).
 */
export interface Facets<E extends string, R extends string> {
  values: Record<E, FacetCount[]>;
  ranges: Record<R, { min: number; max: number } | null>;
}

export type VariantFacets = Facets<
  "make" | "model" | "body" | "fuel" | "transmission" | "market" | "source",
  "year" | "powerKw" | "seats" | "consumptionL100km" | "newPriceCzk" | "usedPriceCzk"
>;

export type ListingFacets = Facets<
  "variant" | "market" | "source" | "condition" | "body" | "fuel" | "transmission",
  "year" | "odometerKm" | "priceCzk" | "landedCzk" | "powerKw"
>;

export interface Result<Row, F> {
  rows: Row[];
  /** Rows matching the filters before offset/limit. */
  total: number;
  facets: F;
}

export type VariantResult = Result<VariantRow, VariantFacets>;
export type ListingResult = Result<ListingRow, ListingFacets>;

/**
 * The catalog query engine's interface. `openCatalog` loads the manifest and catalog index
 * once; `query` is then synchronous and cheap enough to run on every keystroke. `model`
 * loads a model file on first use and caches it.
 */
export interface Catalog {
  readonly manifest: BundleManifest;
  query(query?: VariantQuery): VariantResult;
  model(id: ModelId): Promise<ModelView | null>;
}

export interface ModelView {
  model: ModelFile["model"];
  generations: ModelFile["generations"];
  variants: VariantRow[];
  stats: ModelFile["stats"];
  history: ModelFile["history"];
  listings(query?: ListingQuery): ListingResult;
}
