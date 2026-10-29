import type { Resolver } from "@cca/resolver";
import { type CatalogVariant, type Fuel, type OpenpilotSupport, slugify } from "@cca/vocabulary";
import type { OpenpilotMatch } from "./types.ts";

type Row = Omit<OpenpilotSupport, "kind" | "ref"> & { source: string; row: string };

/**
 * Words a listed model name may add to the catalog's name of the same car: trims, fuels and
 * bodies ("Golf GTI", "Kona Electric", "Corolla Hatchback"). Any other word may name another
 * car the catalog lacks ("Corolla Cross", "Golf Cabriolet"), which the Resolver would still
 * place on the shorter name, so such a row is not placed.
 */
const SAME_CAR_WORDS = new Set([
  "alltrack",
  "awd",
  "diesel",
  "e",
  "electric",
  "ev",
  "gtd",
  "gte",
  "gti",
  "hatchback",
  "hybrid",
  "in",
  "phev",
  "plug",
  "prime",
  "r",
  "rs",
  "scout",
  "sedan",
]);

interface Generation {
  id: string;
  from: number;
  to: number;
  variants: CatalogVariant[];
}

/** Fuels a row that names none can mean: the combustion cars the list's model name stands for. */
const COMBUSTION: ReadonlySet<Fuel> = new Set(["petrol", "diesel", "lpg", "cng"]);
/** Fuels of a model without a combustion engine, whose rows name none (Ioniq 5, ID.4, Nexo). */
const NO_ENGINE: ReadonlySet<Fuel> = new Set(["bev", "hydrogen"]);

/**
 * One design rarely runs longer than this; a Generation that does, up to a platform's last
 * year, is a register type spanning designs (Tiguan 5N 2008-2024, Mazda 3 BL 2009-2018). Its
 * Variants that began EARLIER_CAR_YEARS or more before the platform's first model year are
 * the earlier car, not the one the list rates, or run across both. Such a type marks no
 * changeover either.
 */
const ONE_DESIGN_YEARS = 8;
const EARLIER_CAR_YEARS = 2;

/**
 * Register types that span designs whose Variants the rules above cannot tell apart, checked
 * against the real catalog (ADR 0016): no row is placed on them. The Civic FK files the
 * Civic VIII, IX and X hatchbacks (2006-2021) under one type, often at one power.
 */
const SPANS_DESIGNS: ReadonlySet<string> = new Set(["honda/civic/fk"]);

/**
 * Places openpilot list rows on the catalog, precision first: a car wrongly shown as
 * supported is worse than one not shown. A row lands on one Generation of its model, the one
 * its platform's model years fall in clearly, when at least one of the row's own years is
 * clear of a changeover to another Generation; and on that Generation's Variants whose fuel
 * and production years fit the row. Rows without a platform, and rows for markets other than
 * Europe, are not placed on a Generation.
 */
export function matchOpenpilot(
  rows: Row[],
  variants: CatalogVariant[],
  resolver: Resolver,
): OpenpilotMatch[] {
  const generationsOf = new Map<string, Generation[]>();
  // The catalog's latest year stands for "now": how long an open Generation has run.
  let latest = 0;
  const modelNames = new Map<string, string>();
  for (const variant of variants) {
    latest = Math.max(latest, variant.years.from, variant.years.to ?? 0);
    modelNames.set(variant.modelId, variant.model);
    const generations = generationsOf.get(variant.modelId) ?? [];
    generationsOf.set(variant.modelId, generations);
    let generation = generations.find((g) => g.id === variant.generationId);
    if (!generation) {
      generation = {
        id: variant.generationId,
        from: variant.generation.from,
        to: variant.generation.to ?? Number.POSITIVE_INFINITY,
        variants: [],
      };
      generations.push(generation);
    }
    generation.variants.push(variant);
  }

  // A platform is one car to comma: every row on it, under the same model, shares its
  // Generation, so the Generation is read from all their years together.
  const placedRows = rows.map(({ source, ...row }) => {
    const modelId = row.europe === false ? null : modelOf(row, source, resolver);
    const sameCar = modelId !== null && namesSameCar(row.model, modelNames.get(modelId) ?? "");
    return { row, modelId, sameCar };
  });
  const platformYears = new Map<string, Set<number>>();
  for (const { row, modelId, sameCar } of placedRows) {
    if (!sameCar || !row.platform) continue;
    const key = `${modelId}|${row.platform}`;
    const years = platformYears.get(key) ?? new Set();
    platformYears.set(key, years);
    for (const year of row.years) years.add(year);
  }

  return placedRows.map(({ row, modelId, sameCar }) => {
    const unplaced = { ...row, modelId: null, generationIds: [], variantIds: [] };
    if (modelId === null) return unplaced;
    const placedOnModel = { ...unplaced, modelId };
    if (!sameCar || !row.platform) return placedOnModel;
    const years = [...(platformYears.get(`${modelId}|${row.platform}`) ?? [])].sort(
      (a, b) => a - b,
    );
    const generations = generationsOf.get(modelId) ?? [];
    const generation = generationFor(years, generations);
    if (!generation || SPANS_DESIGNS.has(generation.id)) return placedOnModel;
    // A year within a year of another Generation could be either car (the US Tucson 2021 is
    // the old one though the register's new one starts in 2021): only the row's other years
    // say it is this one.
    const changeover = changeoverNear(generation, generations, latest);
    const clear = (y: number) => y >= generation.from && y <= generation.to && !changeover(y);
    if (!row.years.some(clear)) return placedOnModel;

    const first = years[0] as number;
    const last = years[years.length - 1] as number;
    // Electrified versions are listed under their own names ("Kona Electric", "Kuga
    // Plug-in Hybrid"), so a row that names no fuel is the combustion car, unless the
    // model has no engine at all (Ioniq 5). A hybrid-only Generation (the European
    // Corolla) is not the plain row's car: its hybrid is listed on its own.
    const engineless = generation.variants.every((v) => NO_ENGINE.has(v.fuel));
    const spansDesigns = Math.min(generation.to, last) - generation.from > ONE_DESIGN_YEARS;
    const fits = generation.variants.filter((v) => {
      const to = v.years.to ?? Number.POSITIVE_INFINITY;
      // Two shared years at least (or all of a one-year row or Variant): a Variant that
      // ends or starts in a row's boundary year is usually the design before or after. One
      // registered more than a year before its Generation began is an earlier engine filed
      // under it (an Audi A3 8P under the 8V).
      const shared = row.years.filter((y) => y >= v.years.from && y <= to).length;
      return (
        (row.fuel ? v.fuel === row.fuel : engineless || COMBUSTION.has(v.fuel)) &&
        shared >= Math.min(2, row.years.length, to - v.years.from + 1) &&
        v.years.from >= generation.from - 1 &&
        (!spansDesigns || v.years.from > first - EARLIER_CAR_YEARS)
      );
    });
    if (fits.length === 0) return placedOnModel;
    return {
      ...placedOnModel,
      generationIds: [generation.id],
      variantIds: fits.map((v) => v.id).sort(),
    };
  });
}

function modelOf(row: Omit<Row, "source">, source: string, resolver: Resolver): string | null {
  const resolution = resolver.resolve(
    { make: row.make, model: row.model, ...(row.fuel ? { fuel: row.fuel } : {}) },
    source,
  );
  return resolution.status === "unmatched" ? null : resolution.modelId;
}

function namesSameCar(listed: string, catalog: string): boolean {
  const own = new Set(slugify(catalog).split("-"));
  return slugify(listed)
    .split("-")
    .every((word) => own.has(word) || SAME_CAR_WORDS.has(word));
}

/**
 * The Generation a platform's model years fall in: the one holding most of them, when it
 * holds more than any other, more than half of them, and at least two (or the only year).
 * Model years run ahead of production years, so a year shared with the next Generation
 * decides nothing, and a platform mostly outside the Generation the catalog has ("Golf GTI
 * 2015-21" on a catalog with only the Golf VIII) belongs to one it lacks. When several hold
 * every year of two or more, the register has filed one type inside a wider one
 * ("Octavia 5E" 2013-2020 inside "Octavia SE" 2000-2019): the one inside all the others,
 * give or take a year at either end (register years are percentiles, ADR 0011), is taken if
 * it is the only one; otherwise none.
 */
/**
 * Whether a model year lies on a changeover between `generation` and another of the model's
 * Generations: within a year of the other's production years. Model years run a year ahead
 * of production, and the US often keeps the old car a year after Europe has the new one: the
 * US Tucson 2021 is the old car, though the register's Tucson NX4 starts in 2021. Types
 * nested with `generation` and types longer than one design mark no changeover.
 */
function changeoverNear(
  generation: Generation,
  generations: Generation[],
  latest: number,
): (year: number) => boolean {
  const others = generations.filter(
    (other) =>
      other !== generation &&
      !nested(other, generation) &&
      !nested(generation, other) &&
      Math.min(other.to, latest) - other.from <= ONE_DESIGN_YEARS,
  );
  return (year) => others.some((other) => year >= other.from - 1 && year <= other.to + 1);
}

function generationFor(years: number[], generations: Generation[]): Generation | null {
  const scored = generations
    .map((g) => ({ g, overlap: years.filter((y) => y >= g.from && y <= g.to).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  const [best, second] = scored;
  if (!best || best.overlap < Math.min(2, years.length) || best.overlap * 2 <= years.length) {
    return null;
  }
  if (!second || second.overlap < best.overlap) return best.g;
  if (years.length < 2 || best.overlap < years.length) return null;
  const tied = scored.filter((s) => s.overlap === best.overlap).map((s) => s.g);
  const innermost = tied.filter((g) => tied.every((other) => other === g || nested(g, other)));
  return innermost.length === 1 ? (innermost[0] as Generation) : null;
}

/** `a` lies inside `b`, give or take a year at either end, and is not `b`'s span. */
function nested(a: Generation, b: Generation): boolean {
  return a.from >= b.from - 1 && a.to <= b.to + 1 && (a.from > b.from || a.to < b.to);
}
