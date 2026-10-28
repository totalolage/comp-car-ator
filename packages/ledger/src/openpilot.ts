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

  const placed = rows.map((row) => {
    const { source, ...rest } = row;
    const modelId = row.europe === false ? null : modelOf(row, source, resolver);
    const sameCar = modelId !== null && namesSameCar(row.model, modelNames.get(modelId) ?? "");
    const generations = sameCar ? generationsFor(row.years, generationsOf.get(modelId) ?? []) : [];
    return { match: { ...rest, modelId, generationIds: [], variantIds: [] }, generations };
  });

  // A row that names no fuel ("Kona") leaves out the fuels its siblings on the same
  // Generation name ("Kona Electric"): those are listed, and supported, on their own.
  const namedFuels = new Map<string, Set<Fuel>>();
  for (const { match, generations } of placed) {
    if (!match.fuel) continue;
    for (const g of generations) {
      const key = `${match.modelId} ${g.id}`;
      namedFuels.set(key, (namedFuels.get(key) ?? new Set()).add(match.fuel));
    }
  }

  return placed.map(({ match, generations }) => {
    const first = match.years[0] as number;
    const last = match.years[match.years.length - 1] as number;
    const generationIds: string[] = [];
    const variantIds: string[] = [];
    for (const g of generations) {
      const excluded = namedFuels.get(`${match.modelId} ${g.id}`);
      const fits = g.variants.filter(
        (v) =>
          (match.fuel ? v.fuel === match.fuel : !excluded?.has(v.fuel)) &&
          v.years.from <= last &&
          (v.years.to ?? Number.POSITIVE_INFINITY) >= first,
      );
      if (fits.length === 0) continue;
      generationIds.push(g.id);
      variantIds.push(...fits.map((v) => v.id).sort());
    }
    return { ...match, generationIds, variantIds };
  });
}

function modelOf(row: Row, source: string, resolver: Resolver): string | null {
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
 * 2015-21" on a catalog with only the Golf VIII) belongs to one it lacks.
 */
function generationsFor(years: number[], generations: Generation[]): Generation[] {
  const scored = generations
    .map((g) => ({ g, overlap: years.filter((y) => y >= g.from && y <= g.to).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  const [best, second] = scored;
  if (!best || best.overlap < Math.min(2, years.length) || best.overlap * 2 <= years.length) {
    return [];
  }
  if (second && second.overlap === best.overlap) return [];
  return [best.g];
}
