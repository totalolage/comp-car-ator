/**
 * Builds catalog Variants from register vehicles. The register is per vehicle, so this counts:
 * vehicles with the same make, model, type-approval type, body, fuel and power are one
 * candidate; candidates become Variants once enough vehicles back them.
 *
 * - Models: commercial names are cut to their model part per row (catalog-names.ts). Of names
 *   that extend one another, the one that holds most of a type-approval type's vehicles takes
 *   them all: a longer name on the shorter name's types is a trim word ("Octavia Scout" →
 *   Octavia), one with types of its own is a model of its own ("Range Rover Sport", "Golf
 *   Plus"), and the shorter name's few rows of such a type join it.
 * - Generations: the type-approval type ("5E", "NX") changes with most design cycles, so a
 *   type Wikidata does not date is one Generation, keyed by its code. A type that starts as a
 *   dated Wikidata generation is that generation, keyed by Wikidata's word for it (mk7, b6),
 *   and types that start as one generation are one. A type kept for the next generation too
 *   (Golf 1K: V and VI) is split by production year; years the dates do not settle (an overlap,
 *   past the last dated generation) are left out rather than guessed.
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
  const omitted = { vehicles: 0 };

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

    /** Vehicles left out of the last `entries`: years no single Generation holds. */
    get omittedVehicles(): number {
      return omitted.vehicles;
    },

    entries(generations: readonly WikidataGeneration[]): CatalogEntry[] {
      omitted.vehicles = 0;
      const rows = [...candidates].map(([key, c]) => {
        const [make, model, type, body, fuel, kw] = key.split("\t") as string[];
        return { make, model, type, body, fuel, powerKw: Number(kw), c } as Row;
      });
      const merged = mergeModels(rows);
      const entries: CatalogEntry[] = [];
      for (const group of groupBy(merged, (r) => `${r.make}\t${r.model}`).values()) {
        entries.push(...modelEntries(group, generations, options, omitted));
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
 * Folds "Octavia Scout" into "Octavia": names that extend one another by words ("Range
 * Rover", "Range Rover Sport") are one family, and a type's vehicles in a family belong to
 * the name that holds most of them. A few "RANGE ROVER" rows of the Sport's type so join
 * the Sport instead of pulling it into the Range Rover; a model of its own keeps its name.
 */
function mergeModels(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const makeRows of groupBy(rows, (r) => r.make).values()) {
    const names = new Set(makeRows.map((r) => r.model));
    const rootOf = (model: string): string => {
      const words = model.split(" ");
      for (let n = 1; n < words.length; n++) {
        const prefix = words.slice(0, n).join(" ");
        if (names.has(prefix)) return prefix;
      }
      return model;
    };
    const holders = new Map<string, { model: string; count: number }>();
    for (const [key, group] of groupBy(makeRows, (r) => `${rootOf(r.model)}\t${r.type}`)) {
      const counts = [...groupBy(group, (r) => r.model)].map(([model, modelRows]) => ({
        model,
        count: sum(modelRows.map((r) => r.c.count)),
      }));
      // Ties go to the shorter name, then the first in order, so the pick does not flip.
      counts.sort(
        (a, b) =>
          b.count - a.count || a.model.length - b.model.length || a.model.localeCompare(b.model),
      );
      holders.set(key, counts[0] as { model: string; count: number });
    }
    for (const r of makeRows) {
      const holder = holders.get(`${rootOf(r.model)}\t${r.type}`);
      out.push({ ...r, model: holder?.model ?? r.model });
    }
  }
  return out;
}

/** A Generation the register's evidence identifies: a dated Wikidata one, or a type's own. */
interface Generation {
  slug: string;
  wikidata?: WikidataGeneration;
  /** The type that is its own Generation (Wikidata does not date its start). */
  type?: string;
}

/** A chain member's production years, open-ended where unknown. */
interface Span {
  gen: Generation;
  from: number;
  to: number;
}

function modelEntries(
  modelRows: Row[],
  wikidata: readonly WikidataGeneration[],
  options: CatalogOptions,
  omitted: { vehicles: number },
): CatalogEntry[] {
  const { make, model } = modelRows[0] as Row;
  const modelKey = slugify(`${make} ${model}`);
  // A dated generation's slug is its first word ("Mk7" → mk7, "W205", "B6"): Wikidata's, not
  // the register's counts, so it stays put from run to run. Two with one slug name neither.
  const slugOf = (g: WikidataGeneration) => slugify(g.words[0] ?? "");
  const ofModel = wikidata.filter((g) => g.modelKey === modelKey && slugOf(g));
  const known = ofModel.filter((g) => ofModel.filter((o) => slugOf(o) === slugOf(g)).length === 1);
  const slugs = new Map(known.map((g) => [g, slugOf(g)]));
  const dated = new Set(ofModel.map(slugOf));

  // Body letters on a numbered type are one type ("346L" sedan and "346C" coupé are the E46),
  // and type codes with variant codes glued on ("BWYD6BA", "211U016F0") belong to the type
  // they start with ("BWY", "211"): the shortest such type of the model, whatever the counts,
  // so the folding does not change as vehicles register.
  let rows = modelRows.map((r) => ({
    ...r,
    type: r.type.replace(/^([A-Z0-9]*\d[A-Z0-9]*?\d)[A-Z]$/, "$1"),
  }));
  const types = [...new Set(rows.map((r) => r.type))].sort((a, b) => a.length - b.length);
  const fold = (type: string) =>
    types.find((t) => t.length >= 2 && t.length < type.length && type.startsWith(t)) ?? type;
  rows = rows.map((r) => ({ ...r, type: fold(r.type) }));

  // Types → Generations by production year.
  const byType = [...groupBy(rows, (r) => r.type)].map(([type, typeRows]) => {
    const years = addYears(typeRows.map((r) => r.c.years));
    return { type, years, core: percentiles(years, 0.1, 0.9, options.minYear) };
  });
  const starts = new Map(
    byType.map((t) => [t.type, t.core && startGeneration(t.years, t.core, known, options)]),
  );
  const claimed = new Set([...starts.values()].filter((g) => g !== undefined));
  const generationOf = new Map(
    byType.map((t) => {
      const start = starts.get(t.type);
      const first: Generation = start
        ? { slug: slugs.get(start) as string, wikidata: start }
        : { slug: slugify(t.type), type: t.type };
      // A type whose code is a dated generation's word ("B6") would take its key: left out.
      const chain =
        t.core && !(first.type && dated.has(first.slug))
          ? chainOf(first, t.core, known, claimed, slugs)
          : [];
      return [t.type, (year: number) => onlyMember(chain, ofModel, year)];
    }),
  );

  // Each candidate's vehicles go to the Generation of their year; years no single Generation
  // claims (overlaps, past the last dated one) are left out. Specs are tracked per candidate,
  // not per year, so a candidate split across Generations states none.
  const placed: (Row & { gen: Generation })[] = [];
  for (const r of rows) {
    const of = generationOf.get(r.type) as (year: number) => Generation | undefined;
    const parts = new Map<Generation, Uint32Array>();
    r.c.years.forEach((n, i) => {
      if (n === 0) return;
      const gen = of(options.minYear + i);
      if (!gen) {
        omitted.vehicles += n;
        return;
      }
      const years = parts.get(gen) ?? new Uint32Array(r.c.years.length);
      years[i] = n;
      parts.set(gen, years);
    });
    const whole = parts.size === 1 && sum(parts.values().next().value as Uint32Array) === r.c.count;
    for (const [gen, years] of parts) {
      const c = whole
        ? r.c
        : { count: sum(years), years, specs: new Float64Array(r.c.specs.length) };
      placed.push({ ...r, c, gen });
    }
  }

  const entries: CatalogEntry[] = [];
  for (const genRows of groupBy(placed, (r) => r.gen.slug).values()) {
    const gen = (genRows[0] as (typeof genRows)[number]).gen;
    // The name lists the generation's main types (≥5% of its vehicles), as listings may cite them.
    const typeCounts = [...groupBy(genRows, (r) => r.type)]
      .map(([type, typeRows]) => ({ type, count: sum(typeRows.map((r) => r.c.count)) }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const total = sum(typeCounts.map((t) => t.count));
    const main = typeCounts.filter((t, i) => i === 0 || t.count >= total * 0.05).slice(0, 3);
    // Mercedes-Benz types are model series (205); listings write the chassis code (W205).
    const codes = main.map((t) =>
      make === "Mercedes-Benz" && /^\d{3}$/.test(t.type) ? `W${t.type}` : t.type,
    );
    const wd = gen.wikidata;
    const label = wd?.numeral ?? wd?.words[0];
    const extra = wd
      ? [...new Set([...(wd.numeral ? wd.words : wd.words.slice(1)), ...codes])].filter(
          (w) => w !== label,
        )
      : [];
    const name = label
      ? `${model} ${label}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`
      : `${model} ${codes.join("/")}`;

    const variants = [
      ...groupBy(genRows, (r) => `${r.body}\t${r.fuel}\t${r.powerKw}`).values(),
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
            slug: gen.slug,
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
 * The Wikidata generation a type starts as: the one whose start is at most two years before
 * or one year after the type's first core year (10th percentile of its vehicles: registrations
 * lag production), and no other generation starts as near or spans the type's core years.
 * Generations overlap (Octavia I was built until 2010 next to the II), so the start decides.
 * A type with many vehicles from `minYear` began before it; its start is unknown, so the
 * latest generation begun before it that the type does not outlast fits.
 */
function startGeneration(
  years: Uint32Array,
  core: { from: number; to: number },
  known: readonly WikidataGeneration[],
  options: CatalogOptions,
): WikidataGeneration | undefined {
  const earlier = at0(years, 0) >= sum(years) * 0.05;
  const gap = (g: WikidataGeneration) => (earlier ? 0 : Math.abs(g.from - core.from));
  const near = (g: WikidataGeneration) => core.from - g.from <= 2 && g.from - core.from <= 1;
  const fits = known
    .filter((g) =>
      earlier ? g.from < options.minYear && (g.to === undefined || core.to <= g.to + 1) : near(g),
    )
    .sort((a, b) => gap(a) - gap(b) || b.from - a.from);
  const [best, next] = fits;
  if (!best || (next && gap(next) <= gap(best) && !earlier)) return undefined;
  // The run-out of the previous generation (Passat B5 registered until 2005) is not the next.
  // A generation without an end is not taken to span a later one's years.
  const covers = (g: WikidataGeneration) =>
    g.from <= core.from && g.to !== undefined && g.to >= core.to;
  return known.some((g) => g !== best && covers(g)) ? undefined : best;
}

/**
 * The Generations a type was built as, in order. VW kept type 1K for Golf V and VI: a
 * type that outlasts its generation continues as the dated generation starting within a year
 * of that end, unless another type starts as that generation (then this type's later years
 * are the run-out). A type Wikidata does not date is its own Generation until a dated one
 * no other type claims starts inside its core years.
 */
function chainOf(
  first: Generation,
  core: { from: number; to: number },
  known: readonly WikidataGeneration[],
  claimed: ReadonlySet<WikidataGeneration>,
  slugs: ReadonlyMap<WikidataGeneration, string>,
): Span[] {
  const spans: Span[] = [{ gen: first, from: -Infinity, to: first.wikidata?.to ?? Infinity }];
  for (;;) {
    const last = spans[spans.length - 1] as Span;
    const next = known.filter(
      (g) =>
        !claimed.has(g) &&
        !spans.some((s) => s.gen.wikidata === g) &&
        (last.gen.wikidata
          ? last.to < core.to && Math.abs(g.from - last.to) <= 1
          : g.from > core.from + 1 && g.from <= core.to),
    );
    if (next.length !== 1) break;
    const g = next[0] as WikidataGeneration;
    if (!last.gen.wikidata) last.to = g.from - 1;
    spans.push({
      gen: { slug: slugs.get(g) as string, wikidata: g },
      from: g.from,
      to: g.to ?? Infinity,
    });
  }
  // The last Generation's run-out: registrations a year past its end.
  (spans[spans.length - 1] as Span).to += 1;
  return spans;
}

/**
 * The one Generation whose years hold `year`; none in an overlap or outside them all. A dated
 * Generation also yields a year to any other dated generation of the model whose dates hold it
 * (a successor another type claims): a year in both is left out. A generation Wikidata gives no
 * end holds every year from its start, but against a later one only the later start is known,
 * so it contests none of that one's years.
 */
function onlyMember(
  spans: readonly Span[],
  dated: readonly WikidataGeneration[],
  year: number,
): Generation | undefined {
  const holding = spans.filter((s) => s.from <= year && year <= s.to);
  const gen = holding.length === 1 ? (holding[0] as Span).gen : undefined;
  if (!gen?.wikidata) return gen;
  const own = gen.wikidata;
  const contested = dated.some(
    (g) => g !== own && g.from <= year && (g.to === undefined ? g.from > own.from : year <= g.to),
  );
  return contested ? undefined : gen;
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
