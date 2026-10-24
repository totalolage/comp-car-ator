/**
 * Facet engine shared by the Variant and Listing queries: filter evaluation, disjunctive
 * facet counts, range bounds, sort and paging over an in-memory row array. Internal.
 */
import type { FacetCount, Range, Sort } from "./types.ts";

export interface FacetDefs<Row, E extends string, R extends string, K extends string> {
  /** Values a row has for each enum facet (several for e.g. markets a Variant is sold in). */
  values: Record<E, (row: Row) => readonly string[]>;
  /** The interval a row covers for each range facet; null = unknown (fails an active filter). */
  ranges: Record<R, (row: Row) => readonly [number, number] | null>;
  sort: Record<K, (row: Row) => string | number | undefined>;
}

export interface EngineResult<Row> {
  rows: Row[];
  total: number;
  facets: {
    values: Record<string, FacetCount[]>;
    ranges: Record<string, { min: number; max: number } | null>;
  };
}

export function runQuery<Row, E extends string, R extends string, K extends string>(
  all: readonly Row[],
  defs: FacetDefs<Row, E, R, K>,
  filters: Partial<Record<E, readonly string[]>> & Partial<Record<R, Range>>,
  sort: Sort<K> | undefined,
  offset = 0,
  limit = 50,
): EngineResult<Row> {
  const enumKeys = (Object.keys(defs.values) as E[]).filter((k) => {
    const selected = filters[k] as readonly string[] | undefined;
    return selected !== undefined && selected.length > 0;
  });
  const rangeKeys = (Object.keys(defs.ranges) as R[]).filter((k) => {
    const range = filters[k] as Range | undefined;
    return range !== undefined && (range.min !== undefined || range.max !== undefined);
  });

  // For every row, the active filters it fails. A row counts towards facet F when it fails
  // nothing, or fails only F (disjunctive faceting).
  const failures = all.map((row) => {
    const failed: string[] = [];
    for (const key of enumKeys) {
      const selected = filters[key] as readonly string[];
      if (!defs.values[key](row).some((v) => selected.includes(v))) failed.push(key);
    }
    for (const key of rangeKeys) {
      const { min = -Infinity, max = Infinity } = filters[key] as Range;
      const span = defs.ranges[key](row);
      if (!span || span[1] < min || span[0] > max) failed.push(key);
    }
    return failed;
  });
  const countsFor = (key: string, i: number) => {
    const failed = failures[i] as string[];
    return failed.length === 0 || (failed.length === 1 && failed[0] === key);
  };

  const values: Record<string, FacetCount[]> = {};
  for (const key of Object.keys(defs.values) as E[]) {
    const counts = new Map<string, number>();
    all.forEach((row, i) => {
      if (!countsFor(key, i)) return;
      for (const v of new Set(defs.values[key](row))) counts.set(v, (counts.get(v) ?? 0) + 1);
    });
    values[key] = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  const ranges: Record<string, { min: number; max: number } | null> = {};
  for (const key of Object.keys(defs.ranges) as R[]) {
    let min = Infinity;
    let max = -Infinity;
    all.forEach((row, i) => {
      if (!countsFor(key, i)) return;
      const span = defs.ranges[key](row);
      if (!span) return;
      min = Math.min(min, span[0]);
      max = Math.max(max, span[1]);
    });
    ranges[key] = min <= max ? { min, max } : null;
  }

  const matched = all.filter((_, i) => (failures[i] as string[]).length === 0);
  if (sort) {
    const key = defs.sort[sort.key];
    const dir = sort.dir === "asc" ? 1 : -1;
    matched.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === undefined) return y === undefined ? 0 : 1; // unknowns last either way
      if (y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }
  return {
    rows: matched.slice(offset, offset + limit),
    total: matched.length,
    facets: { values, ranges },
  };
}

export function point(value: number | undefined): readonly [number, number] | null {
  return value === undefined ? null : [value, value];
}
