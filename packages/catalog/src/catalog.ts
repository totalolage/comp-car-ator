import { type ListingRow, type Loader, openBundle, type VariantRow } from "@cca/bundle";
import { type FacetDefs, point, runQuery } from "./engine.ts";
import type {
  Catalog,
  ListingFacets,
  ListingResult,
  ListingSortKey,
  ModelView,
  VariantFacets,
  VariantResult,
  VariantSortKey,
} from "./types.ts";

/** Opens the catalog query engine over a Bundle. Loads the manifest and catalog index. */
export async function openCatalog(loader: Loader): Promise<Catalog> {
  const bundle = await openBundle(loader);
  const index = await bundle.catalog();
  const thisYear = new Date(bundle.manifest.generatedAt).getUTCFullYear();
  const variantDefs = variantFacetDefs(thisYear);
  const byId = new Map(index.variants.map((v) => [v.id, v]));
  const views = new Map<string, Promise<ModelView | null>>();

  return {
    manifest: bundle.manifest,
    query(query = {}) {
      const { filters = {}, sort, offset, limit } = query;
      return runQuery(index.variants, variantDefs, filters, sort, offset, limit) as VariantResult;
    },
    model(id) {
      let view = views.get(id);
      if (!view) {
        view = bundle.model(id).then((file) => {
          if (!file) return null;
          const listings = file.listings;
          return {
            model: file.model,
            generations: file.generations,
            variants: file.variantIds.flatMap((v) => byId.get(v) ?? []),
            stats: file.stats,
            history: file.history,
            listings(query = {}) {
              const { filters = {}, sort, offset, limit } = query;
              const { includeGone = false, ...rest } = filters;
              const rows = includeGone ? listings : listings.filter((l) => !l.gone);
              return runQuery(rows, listingDefs, rest, sort, offset, limit) as ListingResult;
            },
          };
        });
        views.set(id, view);
      }
      return view;
    },
  };
}

type VariantEnum = keyof VariantFacets["values"];
type VariantRange = keyof VariantFacets["ranges"];

function variantFacetDefs(
  thisYear: number,
): FacetDefs<VariantRow, VariantEnum, VariantRange, VariantSortKey> {
  return {
    values: {
      make: (v) => [v.makeId],
      model: (v) => [v.modelId],
      body: (v) => [v.body],
      fuel: (v) => [v.fuel],
      transmission: (v) => [v.transmission],
      market: (v) => Object.keys(v.used?.markets ?? {}),
      source: (v) => Object.keys(v.used?.sources ?? {}),
    },
    ranges: {
      year: (v) => [v.years.from, v.years.to ?? thisYear],
      powerKw: (v) => point(v.powerKw),
      seats: (v) => point(v.seats),
      consumptionL100km: (v) => point(v.consumptionL100km),
      newPriceCzk: (v) => (v.newPriceCzk ? [v.newPriceCzk.min, v.newPriceCzk.max] : null),
      usedPriceCzk: (v) => point(v.used?.priceCzk.median),
    },
    sort: {
      make: (v) => `${v.make} ${v.model}`,
      model: (v) => v.model,
      year: (v) => v.years.from,
      powerKw: (v) => v.powerKw,
      newPriceCzk: (v) => v.newPriceCzk?.min,
      usedPriceCzk: (v) => v.used?.priceCzk.median,
      usedCount: (v) => v.used?.count ?? 0,
      consumptionL100km: (v) => v.consumptionL100km,
    },
  };
}

type ListingEnum = keyof ListingFacets["values"];
type ListingRange = keyof ListingFacets["ranges"];

const listingDefs: FacetDefs<ListingRow, ListingEnum, ListingRange, ListingSortKey> = {
  values: {
    variant: (l) => (l.variantId ? [l.variantId] : []),
    market: (l) => [l.market],
    source: (l) => [l.source],
    condition: (l) => [l.condition],
    body: (l) => (l.body ? [l.body] : []),
    fuel: (l) => (l.fuel ? [l.fuel] : []),
    transmission: (l) => (l.transmission ? [l.transmission] : []),
  },
  ranges: {
    year: (l) => point(l.year),
    odometerKm: (l) => point(l.odometerKm),
    priceCzk: (l) => point(l.priceCzk),
    landedCzk: (l) => point(l.landed?.totalCzk),
    powerKw: (l) => point(l.powerKw),
  },
  sort: {
    priceCzk: (l) => l.priceCzk,
    landedCzk: (l) => l.landed?.totalCzk,
    year: (l) => l.year,
    odometerKm: (l) => l.odometerKm,
    daysOnMarket: (l) => l.daysOnMarket,
    firstSeen: (l) => l.firstSeen,
  },
};
