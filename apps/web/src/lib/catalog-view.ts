/**
 * What the catalog page shows, on top of the catalog query engine: which facets the rail
 * offers and in what order, the table's columns, and how URL state plus a category page's
 * scope become one engine query. The engine owns filtering, counting and sorting; this
 * module owns presentation only. It is also the one place that reads Variant aggregates
 * (`newPriceCzk`, `used`), so a Bundle format change lands here and nowhere else in the UI.
 */
import { ODOMETER_BANDS, type VariantRow } from "@cca/bundle";
import type {
  Range,
  Sort,
  VariantFacets,
  VariantFilters,
  VariantQuery,
  VariantResult,
  VariantSortKey,
} from "@cca/catalog";
import { BODIES, FUELS, MARKETS, TRANSMISSIONS } from "@cca/vocabulary";
import type { I18n } from "../i18n/i18n.ts";
import type { MessageKey } from "../i18n/messages.ts";
import type { CatalogState } from "./url-state.ts";

export type EnumFacet = keyof VariantFacets["values"];
export type RangeFacet = keyof VariantFacets["ranges"];

/** Facet rail top to bottom. `model` shows only once a make is chosen. */
export const RAIL: ({ kind: "enum"; key: EnumFacet } | { kind: "range"; key: RangeFacet })[] = [
  { kind: "enum", key: "make" },
  { kind: "enum", key: "model" },
  { kind: "enum", key: "body" },
  { kind: "enum", key: "fuel" },
  { kind: "enum", key: "transmission" },
  { kind: "range", key: "year" },
  { kind: "range", key: "powerKw" },
  { kind: "range", key: "newPriceCzk" },
  { kind: "range", key: "usedPriceCzk" },
  { kind: "range", key: "odometerKm" },
  { kind: "range", key: "seats" },
  { kind: "range", key: "consumptionL100km" },
  { kind: "enum", key: "market" },
  { kind: "enum", key: "source" },
];

export const DEFAULT_SORT: Sort<VariantSortKey> = { key: "make", dir: "asc" };
export const PAGE = 100;

/**
 * The engine query for a view. `scope` is the category a page is about (`/make/skoda/`): it
 * always applies and is not part of the URL state.
 */
export function catalogQuery(
  state: CatalogState,
  scope: VariantFilters = {},
  limit = PAGE,
): VariantQuery {
  return { filters: { ...state.filters, ...scope }, sort: state.sort ?? DEFAULT_SORT, limit };
}

/** URL state for a scoped page: facets the scope fixes cannot also come from the URL. */
export function withoutScope(state: CatalogState, scope: VariantFilters = {}): CatalogState {
  const filters: Record<string, unknown> = { ...state.filters };
  for (const key of Object.keys(scope)) delete filters[key];
  return { ...state, filters: filters as VariantFilters };
}

/** Display names for make and model ids, which the facet counts carry bare. */
export type Names = Record<string, string>;

export function namesOf(rows: readonly VariantRow[]): Names {
  const names: Names = {};
  for (const v of rows) {
    names[v.makeId] = v.make;
    names[v.modelId] = v.model;
  }
  return names;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  checked: boolean;
}

const VOCABULARY: Partial<Record<EnumFacet, readonly string[]>> = {
  body: BODIES,
  fuel: FUELS,
  transmission: TRANSMISSIONS,
  market: MARKETS,
};

/**
 * The options one enum facet offers: every value with matches under the other filters, plus
 * chosen values that now have none (so they can be unchosen). Vocabulary facets keep the
 * vocabulary's order and named ones (make, model, source) sort by name, so options do not
 * jump around as counts change.
 */
export function facetOptions(
  key: EnumFacet,
  result: VariantResult,
  filters: VariantFilters,
  names: Names,
  t: I18n,
): FacetOption[] {
  const selected = new Set<string>(filters[key] ?? []);
  const counts = new Map(result.facets.values[key].map((c) => [c.value, c.count]));
  for (const value of selected) if (!counts.has(value)) counts.set(value, 0);
  const label = (value: string) =>
    key === "make" || key === "model" ? (names[value] ?? value) : t.label(key, value);
  const options = [...counts].map(([value, count]) => ({
    value,
    label: label(value),
    count,
    checked: selected.has(value),
  }));
  const order = VOCABULARY[key];
  return options.sort(
    order
      ? (a, b) => order.indexOf(a.value) - order.indexOf(b.value)
      : (a, b) => a.label.localeCompare(b.label, t.lang),
  );
}

/** Quick picks under the odometer range, one per published odometer band. */
export function odometerBands(): { label: string; range: Range }[] {
  return ODOMETER_BANDS.map((band) => {
    const [from = "", to = ""] = band.replace("+", "-").split("-");
    const km = (s: string) => (s === "" ? undefined : Number(s.replace("k", "")) * 1000);
    const min = km(from);
    const max = km(to);
    return {
      label: band.replaceAll("-", "–"),
      range: { ...(min ? { min } : {}), ...(max === undefined ? {} : { max }) },
    };
  });
}

export interface Column {
  id: string;
  label: MessageKey;
  /** Clicking the header sorts by this engine key. */
  sort?: VariantSortKey;
  num?: boolean;
  cell(v: VariantRow, t: I18n): string;
}

/** Table columns after the row header (make and model, sorted by `make`). */
export const COLUMNS: Column[] = [
  { id: "generation", label: "col.generation", cell: (v) => v.generation },
  {
    id: "years",
    label: "col.years",
    sort: "year",
    num: true,
    cell: (v) => `${v.years.from}–${v.years.to ?? ""}`,
  },
  { id: "body", label: "col.body", cell: (v, t) => t.label("body", v.body) },
  { id: "fuel", label: "col.fuel", cell: (v, t) => t.label("fuel", v.fuel) },
  { id: "power", label: "col.power", sort: "powerKw", num: true, cell: (v, t) => t.kw(v.powerKw) },
  {
    id: "transmission",
    label: "col.transmission",
    cell: (v, t) => t.label("transmission", v.transmission),
  },
  {
    id: "consumption",
    label: "col.consumption",
    sort: "consumptionL100km",
    num: true,
    cell: (v, t) => t.l100(v.consumptionL100km),
  },
  { id: "seats", label: "col.seats", num: true, cell: (v, t) => t.number(v.seats) },
  {
    id: "newPrice",
    label: "col.newPrice",
    sort: "newPriceCzk",
    num: true,
    cell: (v, t) => t.czk(v.newPriceCzk?.min),
  },
  {
    id: "usedPrice",
    label: "col.usedPrice",
    sort: "usedPriceCzk",
    num: true,
    cell: (v, t) => t.czk(v.used?.priceCzk.median),
  },
  // Landed CZK covers imports; for Czech Listings it is the asking price plus seller extras.
  {
    id: "landed",
    label: "col.landedMedian",
    num: true,
    cell: (v, t) => t.czk(v.used?.landedCzk?.median),
  },
  {
    id: "markets",
    label: "col.markets",
    cell: (v) => MARKETS.filter((m) => v.used?.markets[m]).join(" "),
  },
  {
    id: "listings",
    label: "col.listings",
    sort: "usedCount",
    num: true,
    cell: (v, t) => t.number(v.used?.count ?? 0),
  },
];

/** Next sort after clicking a column header: flip the current one, else start ascending. */
export function nextSort(current: Sort<VariantSortKey>, key: VariantSortKey) {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" } as const;
  return { key, dir: key === "usedCount" ? "desc" : "asc" } as const;
}

/**
 * A Variant cut to what the first paint shows, so the island's serialized props stay small
 * (listing groups and per-source counts are only needed by the engine in the browser).
 */
export function firstPaintRow(v: VariantRow): VariantRow {
  if (!v.used) return v;
  return { ...v, used: { ...v.used, sources: {}, groups: [] } };
}
