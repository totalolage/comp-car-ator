/**
 * Builds catalog Variants from register vehicles. The register is per vehicle, so this counts:
 * vehicles with the same make, model, type-approval type, body, fuel and power are one
 * candidate; candidates become Variants once enough vehicles back them.
 *
 * - Models: commercial names are cut to their model part per row (catalog-names.ts). A longer
 *   name whose vehicles share the shorter name's type-approval types is the same model with a
 *   trim word ("Octavia Scout" → Octavia); one with types of its own is a model of its own
 *   ("Tiguan Allspace", "Golf Plus").
 * - Generations: one per type-approval type ("5E", "NX"), which changes with each design
 *   cycle. Wikidata names the ones whose production years it knows; types that fall in one
 *   Wikidata generation become one generation.
 * - Noise: a candidate with fewer than `minVehicles` vehicles is dropped (single imports,
 *   typos). Rare but real neighbours stay: an extra Variant makes a listing ambiguous (it
 *   resolves to the Model), a missing one could make it match the wrong Variant.
 *
 * Memory: one fixed-size record per candidate (counts by year, two-slot majority trackers per
 * Spec), so peak memory grows with distinct candidates, not vehicles.
 */
import { type CatalogEntry, slugify, type VariantSpec } from "@cca/vocabulary";
import type { RegisterVehicle } from "./register.ts";
import type { WikidataGeneration } from "./wikidata.ts";

export interface CatalogOptions {
  /** First production year catalogued. */
  minYear: number;
  /** Vehicles needed to back a Variant. */
  minVehicles: number;
  /** The snapshot's year: production still registering then is ongoing. */
  year: number;
}

/** Specs tracked per candidate, with how each is read back. */
const SPECS = [
  "engineCc",
  "seats",
  "euroClass",
  "co2GKm",
  "consumptionL100km",
  "consumptionKwh100km",
  "massKg",
  "lengthMm",
  "drive",
] as const;
type Spec = (typeof SPECS)[number];
const DRIVES = ["fwd", "rwd", "awd"] as const;

interface Candidate {
  count: number;
  /** Vehicles by year, index 0 = minYear. */
  years: Uint32Array;
  /** Per Spec two (value, weight) slots of a Misra-Gries tracker, then the weight stated. */
  specs: Float64Array;
}

export function createCatalog(options: CatalogOptions) {
  const span = options.year - options.minYear + 2;
  const candidates = new Map<string, Candidate>();

  return {
    get candidates(): number {
      return candidates.size;
    },

    add(v: RegisterVehicle): void {
      if (v.year < options.minYear || v.year > options.year + 1) return;
      const key = [v.make, v.model, v.type, v.body, v.fuel, v.powerKw].join("\t");
      let c = candidates.get(key);
      if (!c) {
        c = {
          count: 0,
          years: new Uint32Array(span),
          specs: new Float64Array(SPECS.length * SLOTS),
        };
        candidates.set(key, c);
      }
      c.count++;
      bump(c.years, v.year - options.minYear, 1);
      SPECS.forEach((spec, i) => {
        const value = spec === "drive" ? (v.drive ? DRIVES.indexOf(v.drive) + 1 : 0) : v[spec];
        if (value) state(c.specs, i, value, 1);
      });
    },

    entries(generations: readonly WikidataGeneration[]): CatalogEntry[] {
      const rows = [...candidates].map(([key, c]) => {
        const [make, model, type, body, fuel, kw] = key.split("\t") as string[];
        return { make, model, type, body, fuel, powerKw: Number(kw), c } as Row;
      });
      const merged = mergeModels(rows);
      const entries: CatalogEntry[] = [];
      for (const group of groupBy(merged, (r) => `${r.make}\t${r.model}`).values()) {
        entries.push(...modelEntries(group, generations, options));
      }
      return entries.sort((a, b) => idOf(a).localeCompare(idOf(b)));
    },
  };
}

interface Row {
  make: string;
  model: string;
  type: string;
  body: VariantSpec["body"];
  fuel: VariantSpec["fuel"];
  powerKw: number;
  c: Candidate;
}

/**
 * Folds "Octavia Scout" into "Octavia": vehicles of a longer name whose type the nearest
 * shorter name (a word prefix) also has belong to that model; the rest keep their name.
 */
function mergeModels(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const makeRows of groupBy(rows, (r) => r.make).values()) {
    const types = new Map<string, Set<string>>();
    for (const r of makeRows) {
      const set = types.get(r.model) ?? new Set<string>();
      set.add(r.type);
      types.set(r.model, set);
    }
    const parentOf = (model: string): string | undefined => {
      const words = model.split(" ");
      for (let n = words.length - 1; n >= 1; n--) {
        const prefix = words.slice(0, n).join(" ");
        if (types.has(prefix)) return prefix;
      }
      return undefined;
    };
    const home = (model: string, type: string): string => {
      const parent = parentOf(model);
      return parent && types.get(parent)?.has(type) ? home(parent, type) : model;
    };
    for (const r of makeRows) out.push({ ...r, model: home(r.model, r.type) });
  }
  return out;
}

function modelEntries(
  modelRows: Row[],
  wikidata: readonly WikidataGeneration[],
  options: CatalogOptions,
): CatalogEntry[] {
  let rows = modelRows;
  const { make, model } = rows[0] as Row;
  const modelKey = slugify(`${make} ${model}`);
  const known = wikidata.filter((g) => g.modelKey === modelKey);

  // Body letters on a numbered type are one type ("346L" sedan and "346C" coupé are the E46),
  // and type codes with variant codes glued on ("BWYD6BA", "211U016F0") belong to the more
  // common type they start with ("BWY", "211").
  rows = rows.map((r) => ({
    ...r,
    type: r.type.replace(/^([A-Z0-9]*\d[A-Z0-9]*?\d)[A-Z]$/, "$1"),
  }));
  const counts = [...groupBy(rows, (r) => r.type)]
    .map(([type, typeRows]) => ({ type, count: sum(typeRows.map((r) => r.c.count)) }))
    .sort((a, b) => b.count - a.count);
  const canonical = new Map<string, string>();
  for (const [i, t] of counts.entries()) {
    const base = counts.slice(0, i).find((p) => t.type.startsWith(p.type));
    canonical.set(t.type, base ? (canonical.get(base.type) as string) : t.type);
  }
  rows = rows.map((r) => ({ ...r, type: canonical.get(r.type) as string }));

  // Types → generations.
  const byType = [...groupBy(rows, (r) => r.type)].map(([type, typeRows]) => ({
    type,
    count: sum(typeRows.map((r) => r.c.count)),
    years: addYears(typeRows.map((r) => r.c.years)),
  }));
  const named = new Map<string, { gen?: WikidataGeneration; types: typeof byType }>();
  for (const t of byType.sort((a, b) => b.count - a.count)) {
    const gen = bestGeneration(t.years, known, options);
    const key = gen ? `wd:${known.indexOf(gen)}` : `type:${t.type}`;
    const group = named.get(key) ?? { gen, types: [] };
    group.types.push(t);
    named.set(key, group);
  }

  const entries: CatalogEntry[] = [];
  for (const { gen, types } of named.values()) {
    const typeSet = new Set(types.map((t) => t.type));
    const slug = slugify((types[0] as (typeof types)[number]).type);
    // The name lists the generation's main types (≥5% of its vehicles), as listings may cite them.
    const total = sum(types.map((t) => t.count));
    const main = types.filter((t, i) => i === 0 || t.count >= total * 0.05).slice(0, 3);
    // Mercedes-Benz types are model series (205); listings write the chassis code (W205).
    const codes = main.map((t) =>
      make === "Mercedes-Benz" && /^\d{3}$/.test(t.type) ? `W${t.type}` : t.type,
    );
    const label = gen?.numeral ?? gen?.words[0];
    const extra = gen
      ? [...new Set([...(gen.numeral ? gen.words : gen.words.slice(1)), ...codes])].filter(
          (w) => w !== label,
        )
      : [];
    const name = label
      ? `${model} ${label}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`
      : `${model} ${codes.join("/")}`;

    const variants = [
      ...groupBy(
        rows.filter((r) => typeSet.has(r.type)),
        (r) => `${r.body}\t${r.fuel}\t${r.powerKw}`,
      ).values(),
    ].map((vRows) => ({ ...(vRows[0] as Row), c: combine(vRows.map((r) => r.c)) }));
    const kept = variants.filter((v) => v.c.count >= options.minVehicles);
    if (kept.length === 0) continue;

    const genYears = yearsOf(addYears(kept.map((v) => v.c.years)), options);
    if (!genYears) continue;
    for (const v of kept) {
      const years = yearsOf(v.c.years, options);
      if (!years) continue;
      entries.push({
        kind: "CatalogEntry",
        variant: {
          make,
          model,
          generation: {
            slug,
            name,
            from: genYears.from,
            ...(genYears.to ? { to: genYears.to } : {}),
          },
          body: v.body,
          fuel: v.fuel,
          powerKw: v.powerKw,
          years,
          ...specsOf(v.c),
        },
      });
    }
  }
  return entries;
}

/**
 * The Wikidata generation this type is: the one whose start is at most two years before or
 * one year after the type's first core year (10th percentile of its vehicles: registrations
 * lag production), which the type does not outlast by more than a year, and no other
 * generation fits as well or spans the type's core years. Generations overlap (Octavia I was built until 2010 next to the
 * II), so the start decides. A type with many vehicles from `minYear` began before it; its
 * start is unknown, so only generations begun before it fit.
 * Wikidata often lacks end dates, so a missing end is not "still in production".
 */
function bestGeneration(
  years: Uint32Array,
  known: readonly WikidataGeneration[],
  options: CatalogOptions,
): WikidataGeneration | undefined {
  const core = percentiles(years, 0.1, 0.9, options.minYear);
  if (!core) return undefined;
  const earlier = at0(years, 0) >= sum(years) * 0.05;
  const gap = (g: WikidataGeneration) => (earlier ? 0 : Math.abs(g.from - core.from));
  const near = (g: WikidataGeneration) => core.from - g.from <= 2 && g.from - core.from <= 1;
  const fits = known
    .filter(
      (g) =>
        (earlier ? g.from < options.minYear : near(g)) &&
        (g.to === undefined || core.to <= g.to + 1),
    )
    .sort((a, b) => gap(a) - gap(b) || b.from - a.from);
  const [best, next] = fits;
  if (!best || (next && gap(next) <= gap(best) && !earlier)) return undefined;
  // The run-out of the previous generation (Passat B5 registered until 2005) is not the next.
  const covers = (g: WikidataGeneration) =>
    g.from <= core.from && (g.to ?? options.year) >= core.to;
  return known.some((g) => g !== best && covers(g)) ? undefined : best;
}

/** Production years: 2nd to 98th percentile of registrations; open while still registering. */
function yearsOf(
  years: Uint32Array,
  options: CatalogOptions,
): { from: number; to?: number } | undefined {
  const range = percentiles(years, 0.02, 0.98, options.minYear);
  if (!range) return undefined;
  const total = sum(years);
  const current =
    (years[options.year - options.minYear] ?? 0) + (years[options.year + 1 - options.minYear] ?? 0);
  const ongoing = current >= Math.max(1, total * 0.02);
  return ongoing ? { from: range.from } : { from: range.from, to: range.to };
}

function percentiles(years: Uint32Array, low: number, high: number, minYear: number) {
  const total = sum(years);
  if (total === 0) return undefined;
  let seen = 0;
  let from: number | undefined;
  let to = minYear;
  years.forEach((n, i) => {
    if (n === 0) return;
    seen += n;
    if (from === undefined && seen >= total * low) from = minYear + i;
    if (seen - n < total * high) to = minYear + i;
  });
  return { from: from as number, to: Math.max(to, from as number) };
}

function specsOf(c: Candidate): Partial<VariantSpec> {
  const specs: Partial<Record<Spec, unknown>> = {};
  SPECS.forEach((spec, i) => {
    const value = majority(c.specs, i);
    if (value === undefined) return;
    specs[spec] = spec === "drive" ? DRIVES[value - 1] : value;
  });
  return specs as Partial<VariantSpec>;
}

const SLOTS = 5;

/** Records that `weight` vehicles state `value` for a Spec. */
function state(slots: Float64Array, field: number, value: number, weight: number): void {
  bump(slots, field * SLOTS + 4, weight);
  track(slots, field, value, weight);
}

/**
 * Misra-Gries with two counters: a value held by more than a third of the weight survives,
 * its counter short of its true weight by at most a third of the total.
 */
function track(slots: Float64Array, field: number, value: number, weight: number): void {
  const at = field * SLOTS;
  for (const s of [at, at + 2]) {
    if (slots[s] === value && at0(slots, s + 1) > 0) {
      bump(slots, s + 1, weight);
      return;
    }
  }
  for (const s of [at, at + 2]) {
    if (at0(slots, s + 1) <= 0) {
      slots[s] = value;
      slots[s + 1] = weight;
      return;
    }
  }
  const cut = Math.min(weight, at0(slots, at + 1), at0(slots, at + 3));
  bump(slots, at + 1, -cut);
  bump(slots, at + 3, -cut);
  if (weight > cut) track(slots, field, value, weight - cut);
}

/**
 * The value more than half the stating vehicles share for sure (counter > half the weight);
 * none when they disagree (a Kodiaq Variant with 5 and 7 seats states no seat count).
 */
function majority(slots: Float64Array, field: number): number | undefined {
  const at = field * SLOTS;
  const first = at0(slots, at + 1) >= at0(slots, at + 3) ? at : at + 2;
  const stated = at0(slots, at + 4);
  return at0(slots, first + 1) * 2 > stated ? at0(slots, first) : undefined;
}

function combine(cs: Candidate[]): Candidate {
  if (cs.length === 1) return cs[0] as Candidate;
  const out: Candidate = {
    count: sum(cs.map((c) => c.count)),
    years: addYears(cs.map((c) => c.years)),
    specs: new Float64Array((cs[0] as Candidate).specs.length),
  };
  for (const c of cs) {
    for (let field = 0; field < SPECS.length; field++) {
      bump(out.specs, field * SLOTS + 4, at0(c.specs, field * SLOTS + 4));
      for (const s of [0, 2]) {
        const weight = at0(c.specs, field * SLOTS + s + 1);
        if (weight > 0) track(out.specs, field, at0(c.specs, field * SLOTS + s), weight);
      }
    }
  }
  return out;
}

function addYears(all: Uint32Array[]): Uint32Array {
  const out = new Uint32Array((all[0] as Uint32Array).length);
  for (const years of all) {
    for (let i = 0; i < years.length; i++) bump(out, i, at0(years, i));
  }
  return out;
}

function at0(array: Uint32Array | Float64Array, i: number): number {
  return array[i] ?? 0;
}

function bump(array: Uint32Array | Float64Array, i: number, by: number): void {
  array[i] = at0(array, i) + by;
}

function groupBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function idOf(entry: CatalogEntry): string {
  const v = entry.variant;
  return `${v.make}/${v.model}/${v.generation.slug}/${v.body}-${v.fuel}-${v.powerKw}`;
}
