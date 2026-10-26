/**
 * What a model page shows, on top of the catalog query engine's `model(id)` view: the listing
 * rail and table, which price statistics answer the current selection, the price history
 * series and the landed-price breakdown. The engine owns filtering, counting and sorting;
 * this module owns presentation. It is the one place in the UI that reads model-file shapes
 * (`ListingRow`, `PriceCell`, `history`, `LandedPrice`), as `catalog-view.ts` is for Variant
 * aggregates, so a Bundle format change lands here.
 */
import { type ListingRow, ODOMETER_BANDS, type OdometerBand, type VariantRow } from "@cca/bundle";
import type {
  ListingFacets,
  ListingFilters,
  ListingQuery,
  ListingResult,
  ListingSortKey,
  ModelView,
  Range,
  Sort,
} from "@cca/catalog";
import {
  BODIES,
  CONDITIONS,
  type Condition,
  FUELS,
  type FxTable,
  MARKETS,
  type Market,
  TRANSMISSIONS,
} from "@cca/vocabulary";
import { type I18n, MISSING } from "../i18n/i18n.ts";
import type { MessageKey } from "../i18n/messages.ts";
import type { ListingState } from "./url-state.ts";

export type ListingEnumFacet = keyof ListingFacets["values"];
export type ListingRangeFacet = keyof ListingFacets["ranges"];

/** Listing rail top to bottom. An enum facet with a single value and nothing checked is hidden. */
export const LISTING_RAIL: (
  | { kind: "enum"; key: ListingEnumFacet }
  | { kind: "range"; key: ListingRangeFacet }
)[] = [
  { kind: "enum", key: "variant" },
  { kind: "enum", key: "condition" },
  { kind: "enum", key: "market" },
  { kind: "range", key: "year" },
  { kind: "range", key: "odometerKm" },
  { kind: "range", key: "landedCzk" },
  { kind: "range", key: "priceCzk" },
  { kind: "range", key: "powerKw" },
  { kind: "enum", key: "fuel" },
  { kind: "enum", key: "transmission" },
  { kind: "enum", key: "body" },
  { kind: "enum", key: "source" },
];

/** Landed CZK makes Czech and imported cars comparable, so it is the default order. */
export const DEFAULT_LISTING_SORT: Sort<ListingSortKey> = { key: "landedCzk", dir: "asc" };
export const LISTING_PAGE = 50;

export function listingQuery(state: ListingState, limit = LISTING_PAGE): ListingQuery {
  return { filters: state.filters, sort: state.sort ?? DEFAULT_LISTING_SORT, limit };
}

/**
 * A Variant's name on its model page: generation, body, fuel and power. The gearbox is not
 * part of a Variant (listings state their own), and ids are never parsed. Two Variants that
 * would read the same get the end of their id appended.
 */
export function variantNames(variants: readonly VariantRow[], t: I18n): Record<string, string> {
  const label = (v: VariantRow) =>
    [v.generation, t.label("body", v.body), t.label("fuel", v.fuel), t.kw(v.powerKw)].join(" · ");
  const seen = new Map<string, number>();
  for (const v of variants) seen.set(label(v), (seen.get(label(v)) ?? 0) + 1);
  const names: Record<string, string> = {};
  for (const v of variants) {
    const text = label(v);
    names[v.id] = (seen.get(text) ?? 0) > 1 ? `${text} (${v.id.split("/").pop()})` : text;
  }
  return names;
}

export interface ListingOption {
  value: string;
  label: string;
  /** Listings with this value under every other facet's filters. */
  count: number;
  checked: boolean;
}

const VOCABULARY: Partial<Record<ListingEnumFacet, readonly string[]>> = {
  condition: CONDITIONS,
  market: MARKETS,
  body: BODIES,
  fuel: FUELS,
  transmission: TRANSMISSIONS,
};

/**
 * The options one enum facet offers: values with matches under the other filters plus chosen
 * values that now have none. Vocabulary facets keep vocabulary order, Variants the order of
 * `names` (the model's Variant table), sources sort by name. Empty when the facet would offer one value with nothing checked (nothing to choose).
 */
export function listingFacetOptions(
  key: ListingEnumFacet,
  result: ListingResult,
  filters: ListingFilters,
  names: Record<string, string>,
  t: I18n,
): ListingOption[] {
  const selected = new Set<string>(filters[key] ?? []);
  const counts = new Map(result.facets.values[key].map((c) => [c.value, c.count]));
  for (const value of selected) if (!counts.has(value)) counts.set(value, 0);
  if (counts.size < 2 && selected.size === 0) return [];
  const label = (value: string) =>
    key === "variant" ? (names[value] ?? value) : key === "source" ? value : t.label(key, value);
  const options = [...counts].map(([value, count]) => ({
    value,
    label: label(value),
    count,
    checked: selected.has(value),
  }));
  const order = key === "variant" ? Object.keys(names) : VOCABULARY[key];
  return options.sort(
    order
      ? (a, b) => rank(order, a.value) - rank(order, b.value)
      : (a, b) => a.label.localeCompare(b.label, t.lang),
  );
}

/** Position in `order`; values it lacks go last. */
function rank(order: readonly string[], value: string): number {
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

/** Filters after clicking one enum checkbox: the value joins or leaves its facet. */
export function toggleListingValue(
  filters: ListingFilters,
  key: ListingEnumFacet,
  value: string,
): ListingFilters {
  const selected = new Set<string>(filters[key] ?? []);
  if (selected.has(value)) selected.delete(value);
  else selected.add(value);
  const next: Record<string, unknown> = { ...filters, [key]: [...selected] };
  if (selected.size === 0) delete next[key];
  return next as ListingFilters;
}

/** Filters with one range set, or removed when `range` is empty. */
export function withRange(
  filters: ListingFilters,
  key: ListingRangeFacet,
  range: Range | undefined,
): ListingFilters {
  const next: Record<string, unknown> = { ...filters };
  if (range && (range.min !== undefined || range.max !== undefined)) next[key] = range;
  else delete next[key];
  return next as ListingFilters;
}

const BAND_LOWER_KM = ODOMETER_BANDS.map(
  (band) => Number(band.split(/[-+]/)[0]?.replace("k", "")) * 1000,
);

/**
 * Odometer quick picks, one per published band. Ranges are inclusive and bands are not
 * (100,000 km is in 100-150k), so each pick ends 1 km below the next band: a pick selects
 * exactly the band's Listings and its statistics come straight from the published cell.
 */
export function listingBands(): { band: OdometerBand; label: string; range: Range }[] {
  return ODOMETER_BANDS.map((band, i) => {
    const min = BAND_LOWER_KM[i] as number;
    const next = BAND_LOWER_KM[i + 1];
    return {
      band,
      label: band.replaceAll("-", "–"),
      range: { ...(min ? { min } : {}), ...(next === undefined ? {} : { max: next - 1 }) },
    };
  });
}

/** Next sort after clicking a column header: flip the current one, else the column's natural order. */
export function nextListingSort(
  current: Sort<ListingSortKey>,
  key: ListingSortKey,
): Sort<ListingSortKey> {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "year" || key === "firstSeen" ? "desc" : "asc" };
}

// --- price statistics -----------------------------------------------------------------

export interface StatRow {
  market: Market;
  condition: Condition;
  /** Listings behind the quantiles (active, kept by the outlier rule). */
  count: number;
  /** Null under 3 Listings, as the Publisher leaves such cells out. */
  quantiles: { p10: number; median: number; p90: number } | null;
  /** Median days on market of the same Listings. */
  days: number | null;
  /** "cell": the Publisher's precomputed cell; "listings": recomputed here. */
  from: "cell" | "listings";
}

/** Fewer Listings than this give no quantiles (ADR 0012). */
const MIN_CELL = 3;

/**
 * Asking-price statistics (CZK) for the listing table's current selection, one row per Market
 * and Condition that has active Listings (Markets are never pooled). A selection the Publisher
 * precomputed (at most one Variant, one year, one odometer band pick, any Markets and
 * Conditions, nothing else) reads its cell; anything else is recomputed from the model file's
 * Listings by the same rules (ADR 0012), so both paths give the same numbers; a cell whose
 * count disagrees with the matching Listings is not used. Gone Listings never count, whatever
 * the table shows.
 */
export function priceStats(view: ModelView, state: ListingState): StatRow[] {
  const { includeGone: _, ...filters } = state.filters;
  const all = view.listings({ filters, limit: Number.MAX_SAFE_INTEGER }).rows;
  const shape = cellShape(filters);
  const rows: StatRow[] = [];
  for (const market of MARKETS) {
    for (const condition of CONDITIONS) {
      const group = all.filter((l) => l.market === market && l.condition === condition);
      if (group.length === 0) continue;
      const kept = group.filter((l) => !l.excluded);
      const days = median(kept.map((l) => l.daysOnMarket));
      const cell =
        shape &&
        view.stats.find(
          (c) =>
            c.variantId === shape.variantId &&
            c.market === market &&
            c.condition === condition &&
            c.year === shape.year &&
            c.band === shape.band,
        );
      // The cell must describe the same Listings the table holds; a reading the band picks
      // cannot express (a fractional odometer) or any drift falls back to recomputing.
      if (cell && cell.count === kept.length) {
        const { p10, median, p90, count } = cell;
        rows.push({
          market,
          condition,
          count,
          quantiles: { p10, median, p90 },
          days,
          from: "cell",
        });
      } else {
        const prices = kept.map((l) => l.priceCzk);
        rows.push({
          market,
          condition,
          count: prices.length,
          quantiles: prices.length >= MIN_CELL ? quantiles(prices) : null,
          days,
          from: "listings",
        });
      }
    }
  }
  return rows;
}

/** The PriceCell coordinates a selection maps to, or null when it needs recomputing. */
function cellShape(filters: Omit<ListingFilters, "includeGone">) {
  let variantId: string | null = null;
  let year: number | null = null;
  let band: OdometerBand | null = null;
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (key === "market" || key === "condition") continue;
    if (key === "variant" && Array.isArray(value) && value.length <= 1) {
      variantId = value[0] ?? null;
    } else if (key === "year") {
      const r = value as Range;
      if (r.min === undefined || r.min !== r.max) return null;
      year = r.min;
    } else if (key === "odometerKm") {
      const r = value as Range;
      const pick = listingBands().find((b) => b.range.min === r.min && b.range.max === r.max);
      if (!pick) return null;
      band = pick.band;
    } else {
      return null;
    }
  }
  return { variantId, year, band };
}

/** p10, median and p90 by linear interpolation, rounded to whole units (as the Publisher). */
function quantiles(values: number[]) {
  const sorted = Float64Array.from(values).sort();
  return {
    p10: Math.round(quantile(sorted, 0.1)),
    median: Math.round(quantile(sorted, 0.5)),
    p90: Math.round(quantile(sorted, 0.9)),
  };
}

function median(values: number[]): number | null {
  return values.length ? Math.round(quantile(Float64Array.from(values).sort(), 0.5)) : null;
}

function quantile(sorted: Float64Array, p: number): number {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const a = sorted[lo] as number;
  return a + ((sorted[hi] as number) - a) * (i - lo);
}

/**
 * Asking price (CZK) per Variant and Market over its active used Listings, from the
 * published cells; a missing entry had fewer than 3 Listings.
 */
export function variantMedians(view: ModelView): Record<string, Partial<Record<Market, number>>> {
  const out: Record<string, Partial<Record<Market, number>>> = {};
  for (const c of view.stats) {
    if (c.variantId === null || c.condition !== "used" || c.year !== null || c.band !== null)
      continue;
    out[c.variantId] ??= {};
    (out[c.variantId] as Partial<Record<Market, number>>)[c.market] = c.median;
  }
  return out;
}

// --- price history --------------------------------------------------------------------

export interface HistorySeries {
  market: Market;
  points: { date: string; count: number; medianCzk: number }[];
}

/**
 * The weekly median asking price of the model's used Listings, one series per Market, limited
 * to the Markets the listing filter chose. Always the whole model: the model file drops
 * Listings gone over 30 days ago, so other selections cannot be rebuilt for past weeks.
 */
export function historySeries(view: Pick<ModelView, "history">, state: ListingState) {
  const chosen = state.filters.market;
  return MARKETS.flatMap((market): HistorySeries[] => {
    if (chosen?.length && !chosen.includes(market)) return [];
    const series = view.history.find((h) => h.market === market);
    return series?.points.length ? [{ market, points: series.points }] : [];
  });
}

// --- one listing ----------------------------------------------------------------------

/** Price move from the first recorded price to the current one, in the listing's currency. */
export function priceChange(l: ListingRow): { amount: number; percent: number } | null {
  const first = l.priceHistory[0]?.price.amount;
  const amount = l.price.amount;
  if (first === undefined || first === amount || first === 0) return null;
  return { amount: amount - first, percent: Math.round(((amount - first) / first) * 100) };
}

export interface LandedBreakdown {
  total: string;
  /** Additive lines that sum to the total. */
  lines: { label: string; value: string }[];
  /** Simplifications the estimate made, one sentence each. */
  notes: string[];
  /** "1 EUR = 24,335 Kč (ČNB 23. 10. 2026)", null for CZK listings. */
  rate: string | null;
}

/** The landed-price breakdown as the page prints it; null when there is no estimate. */
export function landedBreakdown(l: ListingRow, fx: FxTable, t: I18n): LandedBreakdown | null {
  if (!l.landed) return null;
  const currency = l.price.currency;
  const rate = fx[currency]?.czkPerUnit;
  return {
    total: t.czk(l.landed.totalCzk),
    lines: l.landed.lines.map((line) => ({
      label: t.t(`landed.${line.code}` as MessageKey),
      value: t.czk(line.czk),
    })),
    notes: l.landed.flags.map((flag) => t.t(`landedFlag.${flag}` as MessageKey)),
    rate:
      currency === "CZK" || rate === undefined
        ? null
        : t.t("landed.rate", {
            currency,
            rate: t.number(rate, 3),
            date: t.date(l.landed.fxDate ?? fx[currency]?.validFor),
          }),
  };
}

/** The breakdown as one line of text, for the landed cell's hover tooltip. */
export function landedSummary(b: LandedBreakdown | null): string {
  if (!b) return MISSING;
  return b.lines.map((line) => `${line.label}: ${line.value}`).join("\n");
}

/**
 * A listing cut to what the first paint needs, so the island's serialized props stay small:
 * photos are shown only in an expanded row, after the island has the full rows.
 */
export function firstPaintListing(l: ListingRow): ListingRow {
  return l.photos.length ? { ...l, photos: [] } : l;
}
