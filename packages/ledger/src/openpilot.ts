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
 * A Variant whose production began this many years or more before a row's first model year
 * is an earlier car the register files under the same Generation (one type approval can span
 * two designs), not the one the list rates.
 */
const EARLIER_CAR_YEARS = 4;

/**
 * Places openpilot list rows on the catalog, precision first: a car wrongly shown as
 * supported is worse than one not shown. A row lands on one Generation of its model, the one
 * its model years fall in clearly, and on that Generation's Variants whose fuel and production
 * years fit the row. Rows for markets other than Europe are not placed.
 */
export function matchOpenpilot(
  rows: Row[],
  variants: CatalogVariant[],
  resolver: Resolver,
): OpenpilotMatch[] {
  const generationsOf = new Map<string, Generation[]>();
  const modelNames = new Map<string, string>();
  for (const variant of variants) {
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

  return rows.map(({ source, ...row }) => {
    const unplaced = { ...row, modelId: null, generationIds: [], variantIds: [] };
    const modelId = row.europe === false ? null : modelOf(row, source, resolver);
    if (modelId === null) return unplaced;
    const placedOnModel = { ...unplaced, modelId };
    if (!namesSameCar(row.model, modelNames.get(modelId) ?? "")) return placedOnModel;
    const generation = generationFor(row.years, generationsOf.get(modelId) ?? []);
    if (!generation) return placedOnModel;

    const first = row.years[0] as number;
    // Electrified versions are listed under their own names ("Kona Electric", "Kuga
    // Plug-in Hybrid"), so a row that names no fuel is the combustion car, unless the
    // model has no engine at all (Ioniq 5). A hybrid-only Generation (the European
    // Corolla) is not the plain row's car: its hybrid is listed on its own.
    const engineless = generation.variants.every((v) => NO_ENGINE.has(v.fuel));
    const fits = generation.variants.filter((v) => {
      const to = v.years.to ?? Number.POSITIVE_INFINITY;
      // Two shared years at least (or all of a one-year row or Variant): a Variant that
      // ends or starts in a row's boundary year is usually the design before or after.
      const shared = row.years.filter((y) => y >= v.years.from && y <= to).length;
      return (
        (row.fuel ? v.fuel === row.fuel : engineless || COMBUSTION.has(v.fuel)) &&
        shared >= Math.min(2, row.years.length, to - v.years.from + 1) &&
        v.years.from > first - EARLIER_CAR_YEARS
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
 * The Generation a row's model years fall in: the one holding most of them, when it holds
 * more than any other, more than half of them, and at least two (or the row's only year).
 * Model years run ahead of production years, so a year shared with the next Generation
 * decides nothing, and a row mostly outside the Generation the catalog has ("Golf GTI
 * 2015-21" on a catalog with only the Golf VIII) belongs to one it lacks. Generations that
 * each hold every year of a row of two or more are one register type nested in a wider one
 * ("Octavia 5E" in "Octavia SE"): the narrowest is taken.
 */
function generationFor(years: number[], generations: Generation[]): Generation | null {
  const scored = generations
    .map((g) => ({ g, overlap: years.filter((y) => y >= g.from && y <= g.to).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.g.to - a.g.from - (b.g.to - b.g.from));
  const [best, second] = scored;
  if (!best || best.overlap < Math.min(2, years.length) || best.overlap * 2 <= years.length) {
    return null;
  }
  if (!second || second.overlap < best.overlap) return best.g;
  const nested = years.length >= 2 && best.overlap === years.length;
  const narrower = best.g.to - best.g.from < second.g.to - second.g.from;
  return nested && narrower ? best.g : null;
}
