/**
 * One model's Listings over its listing index: the listing facet defs and the view both
 * `openModel` (a model page) and `Catalog.model` return. Kept apart from the catalog index's
 * Variant engine so a model page loads none of it.
 */
import {
  type BundleManifest,
  type ListingEntry,
  type Loader,
  type ModelIndex,
  openBundle,
} from "@cca/bundle";
import type { ModelId } from "@cca/vocabulary";
import { type FacetDefs, point, runQuery } from "./engine.ts";
import type { ListingFacets, ListingResult, ListingSortKey, ModelListings } from "./types.ts";

/**
 * Opens one model's Listings without the catalog index, as a model page needs them: loads
 * the manifest and the model's listing index. Null for an unknown model.
 */
export async function openModel(loader: Loader, id: ModelId): Promise<ModelListings | null> {
  const bundle = await openBundle(loader);
  const file = await bundle.model(id);
  return file && modelListings(file, bundle.manifest);
}

export function modelListings(file: ModelIndex, manifest: BundleManifest): ModelListings {
  const listings = file.listings;
  // Built once, so the engine reads each array into columns only once.
  const active = listings.filter((l) => !l.gone);
  return {
    model: file.model,
    generations: file.generations,
    stats: file.stats,
    history: file.history,
    fx: manifest.fx,
    listings(query = {}) {
      const { filters = {}, sort, offset, limit } = query;
      const { includeGone = false, ...rest } = filters;
      const rows = includeGone ? listings : active;
      return runQuery(rows, listingDefs, rest, sort, offset, limit) as ListingResult;
    },
    rows: (entries) => file.rows(entries),
  };
}

type ListingEnum = keyof ListingFacets["values"];
type ListingRange = keyof ListingFacets["ranges"];

const listingDefs: FacetDefs<ListingEntry, ListingEnum, ListingRange, ListingSortKey> = {
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
    landedCzk: (l) => point(l.landedCzk),
    powerKw: (l) => point(l.powerKw),
  },
  sort: {
    priceCzk: (l) => l.priceCzk,
    landedCzk: (l) => l.landedCzk,
    year: (l) => l.year,
    odometerKm: (l) => l.odometerKm,
    daysOnMarket: (l) => l.daysOnMarket,
    firstSeen: (l) => l.firstSeen,
  },
};
