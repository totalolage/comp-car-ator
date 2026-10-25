/**
 * Shareable URL state: every filter, the sort and the compare list live in the query string,
 * so a copied URL reopens the same view. `read*` accepts anything a person or an old link
 * might put in the URL and drops what it cannot use; `write*` emits one canonical form
 * (fixed parameter order, sorted lists, defaults omitted), so equal states give equal URLs.
 *
 *   ?make=skoda,volkswagen&fuel=diesel&year=2015-2020&power=-110&sort=-usedPrice&cmp=a,b
 *
 * Lists are comma-separated, ranges are `min-max` with either end optional, a sort key with
 * a leading `-` is descending. Parameter names are short aliases of the query engine's
 * filter keys; the engine's own types stay the source of truth for what a filter means.
 */
import type {
  ListingFilters,
  ListingSortKey,
  Range,
  Sort,
  VariantFilters,
  VariantSortKey,
} from "@cca/catalog";
import { BODIES, CONDITIONS, FUELS, MARKETS, TRANSMISSIONS, type VariantId } from "@cca/vocabulary";

/** The compare tray holds at most this many Variants. */
export const COMPARE_MAX = 4;

/** State of the catalog page: Variant filters, sort and the compare list. */
export interface CatalogState {
  filters: VariantFilters;
  sort?: Sort<VariantSortKey>;
  compare: VariantId[];
}

/** State of a model page's listing table. */
export interface ListingState {
  filters: ListingFilters;
  sort?: Sort<ListingSortKey>;
}

export function readCatalogState(search: string | URLSearchParams): CatalogState {
  const params = toParams(search);
  return {
    filters: readFields(params, VARIANT_FIELDS) as VariantFilters,
    ...optionalSort(params, VARIANT_SORT),
    compare: readList(params.get("cmp"), null).slice(0, COMPARE_MAX),
  };
}

/** Canonical query string with a leading `?`, or "" when the state is empty. */
export function writeCatalogState(state: Partial<CatalogState>): string {
  const parts = writeFields(state.filters ?? {}, VARIANT_FIELDS);
  if (state.sort) parts.push(writeSort(state.sort, VARIANT_SORT));
  // Compare order is the order the person added them in; keep it.
  const compare = [...new Set(state.compare ?? [])].slice(0, COMPARE_MAX);
  if (compare.length) parts.push(`cmp=${compare.map(encodeValue).join(",")}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function readListingState(search: string | URLSearchParams): ListingState {
  const params = toParams(search);
  return {
    filters: readFields(params, LISTING_FIELDS) as ListingFilters,
    ...optionalSort(params, LISTING_SORT),
  };
}

export function writeListingState(state: Partial<ListingState>): string {
  const parts = writeFields(state.filters ?? {}, LISTING_FIELDS);
  if (state.sort) parts.push(writeSort(state.sort, LISTING_SORT));
  return parts.length ? `?${parts.join("&")}` : "";
}

// --- field tables ---------------------------------------------------------------------

type Field =
  | { key: string; param: string; kind: "list"; values: readonly string[] | null }
  | { key: string; param: string; kind: "range" }
  | { key: string; param: string; kind: "flag" };

const list = (key: string, values: readonly string[] | null, param = key): Field => ({
  key,
  param,
  kind: "list",
  values,
});
const range = (key: string, param = key): Field => ({ key, param, kind: "range" });

/** Order here is the order parameters appear in written URLs. */
const VARIANT_FIELDS: Field[] = [
  list("make", null),
  list("model", null),
  list("body", BODIES),
  list("fuel", FUELS),
  list("transmission", TRANSMISSIONS, "gearbox"),
  list("market", MARKETS),
  list("source", null),
  range("year"),
  range("powerKw", "power"),
  range("seats"),
  range("consumptionL100km", "consumption"),
  range("newPriceCzk", "newPrice"),
  range("usedPriceCzk", "usedPrice"),
  range("odometerKm", "km"),
];

const LISTING_FIELDS: Field[] = [
  list("variant", null),
  list("condition", CONDITIONS),
  list("body", BODIES),
  list("fuel", FUELS),
  list("transmission", TRANSMISSIONS, "gearbox"),
  list("market", MARKETS),
  list("source", null),
  range("year"),
  range("powerKw", "power"),
  range("priceCzk", "price"),
  range("landedCzk", "landed"),
  range("odometerKm", "km"),
  { key: "includeGone", param: "gone", kind: "flag" },
];

/** URL alias → engine sort key. */
const VARIANT_SORT: Record<string, VariantSortKey> = {
  make: "make",
  model: "model",
  year: "year",
  power: "powerKw",
  newPrice: "newPriceCzk",
  usedPrice: "usedPriceCzk",
  listings: "usedCount",
  consumption: "consumptionL100km",
};

const LISTING_SORT: Record<string, ListingSortKey> = {
  price: "priceCzk",
  landed: "landedCzk",
  year: "year",
  km: "odometerKm",
  days: "daysOnMarket",
  firstSeen: "firstSeen",
};

// --- codec ----------------------------------------------------------------------------

function toParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === "string" ? new URLSearchParams(search) : search;
}

function readFields(params: URLSearchParams, fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = params.get(field.param);
    if (raw === null) continue;
    if (field.kind === "list") {
      const values = readList(raw, field.values);
      if (values.length) out[field.key] = values;
    } else if (field.kind === "range") {
      const parsed = readRange(raw);
      if (parsed) out[field.key] = parsed;
    } else if (raw === "1") {
      out[field.key] = true;
    }
  }
  return out;
}

function writeFields(filters: object, fields: Field[]): string[] {
  const values = filters as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    let written: string | null = null;
    if (field.kind === "list") {
      const items = [...new Set(value as string[])].sort();
      written = items.length ? items.map(encodeValue).join(",") : null;
    } else if (field.kind === "range") {
      written = writeRange(value as Range);
    } else if (value === true) {
      written = "1";
    }
    if (written !== null) parts.push(`${field.param}=${written}`);
  }
  return parts;
}

/** Splits a comma list, dropping blanks, duplicates and values outside `allowed`. */
function readList(raw: string | null, allowed: readonly string[] | null): string[] {
  if (!raw) return [];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && (allowed === null || allowed.includes(s)));
  return [...new Set(items)];
}

/** `min-max`, `min-`, `-max`; non-negative numbers only. Swapped ends are put in order. */
function readRange(raw: string): Range | null {
  const match = /^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/.exec(raw);
  if (!match) return null;
  let min = match[1] === undefined ? undefined : Number(match[1]);
  let max = match[2] === undefined ? undefined : Number(match[2]);
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

function writeRange(r: Range): string | null {
  const ok = (n: number | undefined): n is number =>
    n !== undefined && Number.isFinite(n) && n >= 0;
  if (!ok(r.min) && !ok(r.max)) return null;
  return `${ok(r.min) ? r.min : ""}-${ok(r.max) ? r.max : ""}`;
}

function optionalSort<K extends string>(
  params: URLSearchParams,
  aliases: Record<string, K>,
): { sort?: Sort<K> } {
  const raw = params.get("sort");
  if (!raw) return {};
  const desc = raw.startsWith("-");
  const key = aliases[desc ? raw.slice(1) : raw];
  return key ? { sort: { key, dir: desc ? "desc" : "asc" } } : {};
}

function writeSort<K extends string>(sort: Sort<K>, aliases: Record<string, K>): string {
  const alias = Object.keys(aliases).find((a) => aliases[a] === sort.key) ?? sort.key;
  return `sort=${sort.dir === "desc" ? "-" : ""}${alias}`;
}

/** Percent-encodes a value but keeps `/` readable (Variant and model ids contain it). */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}
