/**
 * Facet engine shared by the Variant and Listing queries: filter evaluation, disjunctive
 * facet counts, range bounds, sort and paging over an in-memory row array. Internal.
 *
 * The first query over a row array reads every row through `defs` once and keeps the result
 * as columns (values, interval ends, identities), so later queries over the same array are
 * flat loops with no per-row allocation: the catalog page runs one on every facet click.
 */
import type { FacetCount, Range, Sort } from "./types.ts";

export interface FacetDefs<Row, E extends string, R extends string, K extends string> {
  /** Values a row has for each enum facet (several for e.g. markets a Variant is sold in). */
  values: Record<E, (row: Row) => readonly string[]>;
  /** The interval a row covers for each range facet; null = unknown (fails an active filter). */
  ranges: Record<R, (row: Row) => readonly [number, number] | null>;
  sort: Record<K, (row: Row) => string | number | undefined>;
  /**
   * Rows sharing an identity are one result (a Variant expanded into one row per listing
   * group): counted once per facet value, returned once (first matching row).
   */
  identity?: (row: Row) => string;
}

export interface EngineResult<Row> {
  rows: Row[];
  total: number;
  facets: {
    values: Record<string, FacetCount[]>;
    ranges: Record<string, { min: number; max: number } | null>;
  };
}

type SortValue = string | number | undefined;

/**
 * A row array read through its defs once. Enum values are interned per facet as integer codes
 * (row i's codes are `code[start[i]]` up to `code[start[i + 1]]`); interval ends are NaN where
 * the span is unknown; sort orders are computed on first use of each key and direction.
 */
interface Columns {
  defs: unknown;
  /** Identity number per row, dense from 0 in order of first appearance. */
  id: Int32Array;
  ids: number;
  /** Row indices with rows of one identity next to each other. */
  grouped: Int32Array;
  values: Record<string, { start: Int32Array; code: Int32Array; labels: string[] }>;
  lo: Record<string, Float64Array>;
  hi: Record<string, Float64Array>;
  orders: Map<string, Int32Array>;
}

const prepared = new WeakMap<readonly unknown[], Columns>();

function columns<Row>(all: readonly Row[], defs: FacetDefs<Row, string, string, string>): Columns {
  const cached = prepared.get(all);
  if (cached && cached.defs === defs) return cached;
  const n = all.length;
  const id = new Int32Array(n);
  const numbers = new Map<string, number>();
  const members: number[][] = [];
  all.forEach((row, i) => {
    const key = defs.identity ? defs.identity(row) : String(i);
    let num = numbers.get(key);
    if (num === undefined) {
      num = members.length;
      numbers.set(key, num);
      members.push([]);
    }
    id[i] = num;
    (members[num] as number[]).push(i);
  });
  const values: Columns["values"] = {};
  for (const key of Object.keys(defs.values)) {
    const of = defs.values[key] as (row: Row) => readonly string[];
    const start = new Int32Array(n + 1);
    const code: number[] = [];
    const labels: string[] = [];
    const codes = new Map<string, number>();
    all.forEach((row, i) => {
      for (const v of of(row)) {
        let c = codes.get(v);
        if (c === undefined) {
          c = labels.length;
          codes.set(v, c);
          labels.push(v);
        }
        code.push(c);
      }
      start[i + 1] = code.length;
    });
    values[key] = { start, code: Int32Array.from(code), labels };
  }
  const lo: Columns["lo"] = {};
  const hi: Columns["hi"] = {};
  for (const key of Object.keys(defs.ranges)) {
    const from = new Float64Array(n).fill(Number.NaN);
    const to = new Float64Array(n).fill(Number.NaN);
    all.forEach((row, i) => {
      const span = (defs.ranges[key] as (row: Row) => readonly [number, number] | null)(row);
      if (span) [from[i], to[i]] = span;
    });
    lo[key] = from;
    hi[key] = to;
  }
  const made: Columns = {
    defs,
    id,
    ids: members.length,
    grouped: Int32Array.from(members.flat()),
    values,
    lo,
    hi,
    orders: new Map(),
  };
  prepared.set(all, made);
  return made;
}

/** Every row index in sort order: stable (ties keep row order), unknown values last. */
function order<Row>(
  cols: Columns,
  all: readonly Row[],
  key: (row: Row) => SortValue,
  sort: Sort<string>,
) {
  const name = `${sort.dir} ${sort.key}`;
  let made = cols.orders.get(name);
  if (!made) {
    const keys = all.map(key);
    const dir = sort.dir === "asc" ? 1 : -1;
    made = Int32Array.from(all.keys()).sort((a, b) => {
      const x = keys[a];
      const y = keys[b];
      if (x === undefined) return y === undefined ? a - b : 1;
      if (y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a - b;
    });
    cols.orders.set(name, made);
  }
  return made;
}

export function runQuery<Row, E extends string, R extends string, K extends string>(
  all: readonly Row[],
  defs: FacetDefs<Row, E, R, K>,
  filters: Partial<Record<E, readonly string[]>> & Partial<Record<R, Range>>,
  sort: Sort<K> | undefined,
  offset = 0,
  limit = 50,
): EngineResult<Row> {
  const cols = columns(all, defs as FacetDefs<Row, string, string, string>);
  const n = all.length;
  const enumKeys = Object.keys(defs.values) as E[];
  const rangeKeys = Object.keys(defs.ranges) as R[];

  // For every row, how many active filters it fails and (when one) which. A row counts towards
  // facet F when it fails nothing, or fails only F (disjunctive faceting).
  const failCount = new Uint8Array(n);
  const failedOnly = new Int16Array(n).fill(-1);
  const own = new Map<string, number>();
  const fail = (i: number, f: number) => {
    failCount[i] = (failCount[i] as number) + 1;
    failedOnly[i] = f;
  };
  for (const key of enumKeys) {
    const selected = filters[key] as readonly string[] | undefined;
    if (!selected?.length) continue;
    const f = own.size;
    own.set(key, f);
    const { start, code, labels } = cols.values[key] as Columns["values"][string];
    const chosen = new Uint8Array(labels.length);
    labels.forEach((label, c) => {
      if (selected.includes(label)) chosen[c] = 1;
    });
    for (let i = 0; i < n; i++) {
      let hit = false;
      for (let j = start[i] as number; j < (start[i + 1] as number); j++) {
        if (chosen[code[j] as number]) {
          hit = true;
          break;
        }
      }
      if (!hit) fail(i, f);
    }
  }
  for (const key of rangeKeys) {
    const range = filters[key] as Range | undefined;
    if (!range || (range.min === undefined && range.max === undefined)) continue;
    const f = own.size;
    own.set(key, f);
    const { min = -Infinity, max = Infinity } = range;
    const lo = cols.lo[key] as Float64Array;
    const hi = cols.hi[key] as Float64Array;
    // NaN ends (unknown span) make both comparisons false, so the row fails.
    for (let i = 0; i < n; i++)
      if (!((hi[i] as number) >= min && (lo[i] as number) <= max)) fail(i, f);
  }
  const counts = (i: number, f: number) => {
    const c = failCount[i] as number;
    return c === 0 || (c === 1 && failedOnly[i] === f);
  };

  const values: Record<string, FacetCount[]> = {};
  for (const key of enumKeys) {
    const f = own.get(key) ?? -2;
    const { start, code, labels } = cols.values[key] as Columns["values"][string];
    const tally = new Int32Array(labels.length);
    // Rows of one identity are adjacent in `grouped`, so "last identity counted" dedupes.
    const last = new Int32Array(labels.length).fill(-1);
    for (const i of cols.grouped) {
      if (!counts(i, f)) continue;
      const id = cols.id[i] as number;
      for (let j = start[i] as number; j < (start[i + 1] as number); j++) {
        const c = code[j] as number;
        if (last[c] !== id) {
          last[c] = id;
          tally[c] = (tally[c] as number) + 1;
        }
      }
    }
    const list: FacetCount[] = [];
    labels.forEach((value, c) => {
      if (tally[c]) list.push({ value, count: tally[c] as number });
    });
    values[key] = list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  const ranges: Record<string, { min: number; max: number } | null> = {};
  for (const key of rangeKeys) {
    const f = own.get(key) ?? -2;
    const lo = cols.lo[key] as Float64Array;
    const hi = cols.hi[key] as Float64Array;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(lo[i]) || !counts(i, f)) continue;
      if ((lo[i] as number) < min) min = lo[i] as number;
      if ((hi[i] as number) > max) max = hi[i] as number;
    }
    ranges[key] = min <= max ? { min, max } : null;
  }

  // A result is the first matching row of its identity.
  const seen = new Uint8Array(cols.ids);
  const result = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const id = cols.id[i] as number;
    if (failCount[i] !== 0 || seen[id]) continue;
    seen[id] = 1;
    result[i] = 1;
    total++;
  }
  const rows: Row[] = [];
  const end = offset + limit;
  const sequence = sort ? order(cols, all, defs.sort[sort.key], sort) : null;
  let rank = 0;
  for (let k = 0; k < n && rank < end; k++) {
    const i = sequence ? (sequence[k] as number) : k;
    if (!result[i]) continue;
    if (rank >= offset) rows.push(all[i] as Row);
    rank++;
  }
  return { rows, total, facets: { values, ranges } };
}

export function point(value: number | undefined): readonly [number, number] | null {
  return value === undefined ? null : [value, value];
}
