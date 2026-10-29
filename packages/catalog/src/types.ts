import type {
  BundleManifest,
  ListingEntry,
  ListingRow,
  Loader,
  ModelFile,
  VariantRow,
} from "@cca/bundle";
import type {
  Body,
  Condition,
  Fuel,
  FxTable,
  Market,
  ModelId,
  OpenpilotLevel,
  Transmission,
} from "@cca/vocabulary";

export type { Loader };

/** Inclusive numeric range; either end optional. */
export interface Range {
  min?: number;
  max?: number;
}

/**
 * Filters over catalog Variants. Values inside one facet are OR-ed, facets are AND-ed.
 * Listing-derived filters (market, source, usedPriceCzk, odometerKm) must all hold for one
 * (market, source) group of the Variant's active used listings; price and odometer compare
 * against that group's min-max range. Exact per-listing filtering is `model(id).listings`.
 */
export interface VariantFilters {
  make?: string[];
  model?: string[];
  body?: Body[];
  fuel?: Fuel[];
  transmission?: Transmission[];
  market?: Market[];
  source?: string[];
  /** The Variant's best openpilot support level; `unlisted` when no list row matched it. */
  openpilot?: OpenpilotFacet[];
  /** Overlap with the Variant's production years. */
  year?: Range;
  powerKw?: Range;
  seats?: Range;
  consumptionL100km?: Range;
  /** Overlap with the Variant's new-price range. */
  newPriceCzk?: Range;
  /** Overlap with the asking-price range of a matching listing group. */
  usedPriceCzk?: Range;
  /** Overlap with the odometer range of a matching listing group. */
  odometerKm?: Range;
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

export type OpenpilotFacet = OpenpilotLevel | "unlisted";

export type VariantFacets = Facets<
  "make" | "model" | "body" | "fuel" | "transmission" | "market" | "source" | "openpilot",
  "year" | "powerKw" | "seats" | "consumptionL100km" | "newPriceCzk" | "usedPriceCzk" | "odometerKm"
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
export type ListingResult = Result<ListingEntry, ListingFacets>;

/**
 * The catalog query engine's interface. `openCatalog` loads the manifest and catalog index
 * once; `query` is then synchronous and cheap enough to run on every keystroke. `model`
 * loads a model's listing index on first use and caches it.
 */
export interface Catalog {
  readonly manifest: BundleManifest;
  query(query?: VariantQuery): VariantResult;
  model(id: ModelId): Promise<ModelView | null>;
}

/**
 * One model's Listings, from `openModel` without the catalog index (a model page in the
 * browser) or from `Catalog.model`. `listings` is synchronous over the model's listing
 * index, so filtering, counting, sorting and statistics need no further file; its rows are
 * index entries, and `rows` loads the full rows a table shows for some of them.
 */
export interface ModelListings {
  model: ModelFile["model"];
  generations: ModelFile["generations"];
  stats: ModelFile["stats"];
  history: ModelFile["history"];
  /** openpilot list rows matched to the model, best level first; empty when none. */
  openpilot: NonNullable<ModelFile["openpilot"]>;
  /** The Bundle's FX rates, which every CZK figure was converted at. */
  fx: FxTable;
  listings(query?: ListingQuery): ListingResult;
  /** Full rows of entries a `listings` result returned, in the same order. */
  rows(entries: readonly ListingEntry[]): Promise<ListingRow[]>;
}

export interface ModelView extends ModelListings {
  variants: VariantRow[];
}
