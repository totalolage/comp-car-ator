/**
 * The Bundle's compact encoding for long lists of similar rows (catalog Variants, a model's
 * Listings and price cells): column-oriented, with strings dictionary-coded and absent fields
 * stored sparsely. Lossless for JSON values: a decoded row equals the encoded one, absent
 * fields stay absent and nulls stay null (key order may differ). Private to Bundle.
 */

/**
 * One column of values. `p` lists the rows that have a value, delta-coded (omitted when all
 * do); the payload holds only those values:
 * `n` numbers; `t` strings; `s` + `i` dictionary-coded strings (-1 = null); `o` + `c`
 * objects as nested columns over `c` values, `z` the null ones (delta-coded); `a` + `l`
 * arrays as one column of all items, `l` their lengths (-1 = null); `j` anything else.
 */
export type Column = { p?: number[] } & (
  | { n: (number | null)[] }
  | { t: (string | null)[] }
  | { s: string[]; i: number[] }
  | { o: Record<string, Column>; c: number; z?: number[] }
  | { a: Column; l: number[] }
  | { j: unknown[] }
);

/** A list of rows as one object column. */
export type Table = Column & { o: Record<string, Column>; c: number };

export function encodeTable<T extends object>(rows: readonly T[]): Table {
  return rows.length ? (encodeColumn(rows) as Table) : { o: {}, c: 0 };
}

export function decodeTable<T>(table: Table): T[] {
  return decodeColumn(table, table.c) as T[];
}

/** `values[i] === undefined` means row i has no value. */
function encodeColumn(values: readonly unknown[]): Column {
  const present: unknown[] = [];
  const rows: number[] = [];
  values.forEach((value, row) => {
    if (value === undefined) return;
    present.push(value);
    rows.push(row);
  });
  const p = present.length === values.length ? {} : { p: deltas(rows) };

  switch (kindOf(present)) {
    case "number":
      return { ...p, n: present as (number | null)[] };
    case "string": {
      const dictionary = new Map<string, number>();
      for (const value of present) {
        if (value !== null && !dictionary.has(value as string)) {
          dictionary.set(value as string, dictionary.size);
        }
      }
      // Mostly distinct strings (ids, URLs) are cheaper stored as they are.
      if (dictionary.size * 2 > present.length) return { ...p, t: present as (string | null)[] };
      return {
        ...p,
        s: [...dictionary.keys()],
        i: present.map((value) => (value === null ? -1 : (dictionary.get(value as string) ?? -1))),
      };
    }
    case "object": {
      const keys = new Set<string>();
      const nulls: number[] = [];
      present.forEach((value, i) => {
        if (value === null) nulls.push(i);
        else for (const key of Object.keys(value as object)) keys.add(key);
      });
      const o: Record<string, Column> = {};
      for (const key of keys) {
        o[key] = encodeColumn(
          present.map((value) =>
            value === null ? undefined : (value as Record<string, unknown>)[key],
          ),
        );
      }
      return { ...p, o, c: present.length, ...(nulls.length ? { z: deltas(nulls) } : {}) };
    }
    case "array":
      return {
        ...p,
        a: encodeColumn((present as (unknown[] | null)[]).flatMap((value) => value ?? [])),
        l: (present as (unknown[] | null)[]).map((value) => (value === null ? -1 : value.length)),
      };
    default:
      return { ...p, j: present };
  }
}

/** Inverse of encodeColumn for a column over `count` rows. */
function decodeColumn(column: Column, count: number): unknown[] {
  const present = decodePresent(column, column.p ? column.p.length : count);
  if (!column.p) return present;
  const values = new Array<unknown>(count).fill(undefined);
  undeltas(column.p).forEach((row, i) => {
    values[row] = present[i];
  });
  return values;
}

function decodePresent(column: Column, count: number): unknown[] {
  if ("n" in column) return column.n;
  if ("t" in column) return column.t;
  if ("s" in column) return column.i.map((i) => (i < 0 ? null : column.s[i]));
  if ("j" in column) return column.j;
  if ("a" in column) {
    const items = decodeColumn(
      column.a,
      column.l.reduce((n, length) => n + Math.max(length, 0), 0),
    );
    let next = 0;
    return column.l.map((length) => {
      if (length < 0) return null;
      next += length;
      return items.slice(next - length, next);
    });
  }
  const rows: (Record<string, unknown> | null)[] = Array.from({ length: count }, () => ({}));
  for (const [key, field] of Object.entries(column.o)) {
    decodeColumn(field, count).forEach((value, i) => {
      if (value !== undefined) (rows[i] as Record<string, unknown>)[key] = value;
    });
  }
  if (column.z) for (const i of undeltas(column.z)) rows[i] = null;
  return rows;
}

type Kind = "number" | "string" | "object" | "array" | "other";

function kindOf(values: readonly unknown[]): Kind {
  let kind: Kind | undefined;
  for (const value of values) {
    if (value === null) continue;
    const k: Kind =
      typeof value === "number"
        ? "number"
        : typeof value === "string"
          ? "string"
          : Array.isArray(value)
            ? "array"
            : typeof value === "object"
              ? "object"
              : "other";
    if (kind === undefined) kind = k;
    else if (kind !== k) return "other";
  }
  return kind ?? "number";
}

function deltas(ascending: number[]): number[] {
  return ascending.map((value, i) => value - (i === 0 ? 0 : (ascending[i - 1] as number)));
}

function undeltas(deltaCoded: number[]): number[] {
  let sum = 0;
  return deltaCoded.map((delta) => {
    sum += delta;
    return sum;
  });
}
