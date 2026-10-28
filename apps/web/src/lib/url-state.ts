/**
 * Shareable URL state: every filter, the sort and the compare list live in the query string,
 * so a copied URL reopens the same view. `read*` accepts anything a person or an old link
 * might put in the URL and drops what it cannot use; `write*` emits one canonical form
 * (fixed parameter order, sorted lists, defaults omitted), so equal states give equal URLs.
 *
 *   ?make=skoda,volkswagen&fuel=diesel&year=2015-2020&power=-110&sort=-usedPrice&cmp=a,b
 *
 * Lists are comma-separated (a comma inside a value is percent-encoded and survives), ranges
 * are `min-max` with either end optional, a sort key with a leading `-` is descending.
 * Parameter names are short aliases of the query engine's filter keys; the engine's own
 * types stay the source of truth for what a filter means.
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
  /**
   * The compare list this view carries. Undefined when the URL has none (the tray then shows
   * the remembered list); `[]` when the URL says "nothing to compare" (`cmp=`).
   */
  compare?: VariantId[];
}

/** State of a model page's listing table. */
export interface ListingState {
  filters: ListingFilters;
  sort?: Sort<ListingSortKey>;
}

/** Reads `location.search` (or any query string, with or without the leading `?`). */
export function readCatalogState(search: string): CatalogState {
  const params = parseQuery(search);
  const cmp = params.get("cmp");
  return {
    filters: readFields(params, VARIANT_FIELDS) as VariantFilters,
    ...optionalSort(params, VARIANT_SORT),
    ...(cmp === undefined ? {} : { compare: readList(cmp, null).slice(0, COMPARE_MAX) }),
  };
}

/** Canonical query string with a leading `?`, or "" when the state is empty. */
export function writeCatalogState(state: Partial<CatalogState>): string {
  const parts = writeFields(state.filters ?? {}, VARIANT_FIELDS);
  if (state.sort) parts.push(writeSort(state.sort, VARIANT_SORT));
  // Compare order is the order the person added them in; keep it.
  if (state.compare) {
    const compare = [...new Set(state.compare)].slice(0, COMPARE_MAX);
    parts.push(`cmp=${compare.map(encodeValue).join(",")}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function readListingState(search: string): ListingState {
  const params = parseQuery(search);
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

/**
 * Parameter name → raw (still percent-encoded) value; the first occurrence wins. Values stay
 * encoded so list splitting sees only the literal commas the writer put there.
 */
function parseQuery(search: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = decode(eq < 0 ? pair : pair.slice(0, eq));
    if (name !== null && !params.has(name)) params.set(name, eq < 0 ? "" : pair.slice(eq + 1));
  }
  return params;
}

/** Form-style decoding; null for malformed escapes. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return null;
  }
}

function readFields(params: Map<string, string>, fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = params.get(field.param);
    if (raw === undefined) continue;
    if (field.kind === "list") {
      const values = readList(raw, field.values);
      if (values.length) out[field.key] = values;
    } else if (field.kind === "range") {
      const parsed = readRange(decode(raw) ?? "");
      if (parsed) out[field.key] = parsed;
    } else if (decode(raw) === "1") {
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

/** Splits a raw comma list, dropping blanks, duplicates and values outside `allowed`. */
function readList(raw: string, allowed: readonly string[] | null): string[] {
  const items = raw
    .split(",")
    .map((s) => decode(s)?.trim() ?? "")
    .filter((s) => s !== "" && (allowed === null || allowed.includes(s)));
  return [...new Set(items)];
}

/**
 * `min-max`, `min-`, `-max`; non-negative numbers only. Swapped ends are put in order. A range
 * with an end the writer could not write back (see `isEnd`) is dropped whole.
 */
function readRange(raw: string): Range | null {
  const match = /^\s*(\d+(?:\.\d+)?)?\s*-\s*(\d+(?:\.\d+)?)?\s*$/.exec(raw);
  if (!match) return null;
  let min = match[1] === undefined ? undefined : Number(match[1]);
  let max = match[2] === undefined ? undefined : Number(match[2]);
  if (min === undefined && max === undefined) return null;
  if ((min !== undefined && !isEnd(min)) || (max !== undefined && !isEnd(max))) return null;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}

function writeRange(r: Range): string | null {
  const ok = (n: number | undefined): n is number => n !== undefined && isEnd(n);
  if (!ok(r.min) && !ok(r.max)) return null;
  return `${ok(r.min) ? r.min : ""}-${ok(r.max) ? r.max : ""}`;
}

/**
 * A range end both sides agree on: a non-negative safe-sized number that prints as plain
 * digits, so what is written reads back unchanged. Excludes Infinity (a 400-digit endpoint),
 * NaN, negatives and anything JavaScript prints in exponent form (1e21, 1e-7).
 */
function isEnd(n: number): boolean {
  return n <= Number.MAX_SAFE_INTEGER && /^\d+(?:\.\d+)?$/.test(String(n));
}

function optionalSort<K extends string>(
  params: Map<string, string>,
  aliases: Record<string, K>,
): { sort?: Sort<K> } {
  const raw = decode(params.get("sort") ?? "");
  if (!raw) return {};
  const desc = raw.startsWith("-");
  const alias = desc ? raw.slice(1) : raw;
  // Own keys only: `?sort=constructor` must not reach the engine.
  const key = Object.hasOwn(aliases, alias) ? aliases[alias] : undefined;
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
