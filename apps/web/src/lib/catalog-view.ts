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
import { type CatalogState, readCatalogState, writeCatalogState } from "./url-state.ts";

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

/**
 * One checkbox in an enum facet. `count` is how many Variants have the value under every
 * other facet's filters, the conventional per-value count: it does not change when other
 * values of the same facet are checked or unchecked. `adds` marks a count the rail shows as
 * "+N" because checking the value adds exactly that many Variants to the list.
 */
export interface FacetOption {
  value: string;
  label: string;
  count: number;
  checked: boolean;
  adds: boolean;
}

/**
 * Facets where each Variant has exactly one value, so checking another value adds exactly
 * its count. A Variant can be listed in several countries and sources, so their counts
 * overlap and checking one more adds at most its count; those show the plain count.
 */
const SINGLE_VALUED: ReadonlySet<EnumFacet> = new Set([
  "make",
  "model",
  "body",
  "fuel",
  "transmission",
]);

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
  const additive = selected.size > 0 && SINGLE_VALUED.has(key);
  const options = [...counts].map(([value, count]) => ({
    value,
    label: label(value),
    count,
    checked: selected.has(value),
    adds: additive && !selected.has(value),
  }));
  const order = VOCABULARY[key];
  return options.sort(
    order
      ? (a, b) => order.indexOf(a.value) - order.indexOf(b.value)
      : (a, b) => a.label.localeCompare(b.label, t.lang),
  );
}

/** Filters after clicking one enum facet checkbox: the value joins or leaves the facet. */
export function toggleValue(
  filters: VariantFilters,
  key: EnumFacet,
  value: string,
): VariantFilters {
  const selected = new Set<string>(filters[key] ?? []);
  if (selected.has(value)) selected.delete(value);
  else selected.add(value);
  const next: Record<string, unknown> = { ...filters, [key]: [...selected] };
  if (selected.size === 0) {
    delete next[key];
    // Models belong to makes: dropping the last make drops the model choice too.
    if (key === "make") delete next.model;
  }
  return next as VariantFilters;
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

/**
 * The range two typed fields make: undefined when both are empty, null while the text is not
 * a range yet (not a number, "from" above "to", or a number the URL cannot carry). Commas
 * are decimal points and spaces are ignored, so "1,5" and "300 000" work. Only ranges that
 * survive a round trip through the URL are made, so a shared link reproduces the view.
 */
export function rangeFromText(minText: string, maxText: string): Range | undefined | null {
  const parse = (input: string) => {
    const clean = input.replace(/[\s\u00a0]/g, "").replace(",", ".");
    return clean === "" ? undefined : Number(clean);
  };
  const min = parse(minText);
  const max = parse(maxText);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) return null;
  const range: Range = {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
  // Every range field is written the same way; `year` stands in for all of them.
  const back = readCatalogState(writeCatalogState({ filters: { year: range } })).filters.year;
  return back?.min === range.min && back?.max === range.max ? range : null;
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
