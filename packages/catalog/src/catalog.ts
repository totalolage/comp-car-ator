import { type Loader, openBundle, type UsedGroup, type VariantRow } from "@cca/bundle";
import { type FacetDefs, point, runQuery } from "./engine.ts";
import { modelListings } from "./model.ts";
import type { Catalog, ModelView, VariantFacets, VariantResult, VariantSortKey } from "./types.ts";

/** Opens the catalog query engine over a Bundle. Loads the manifest and catalog index. */
export async function openCatalog(loader: Loader): Promise<Catalog> {
  const bundle = await openBundle(loader);
  const index = await bundle.catalog();
  const thisYear = new Date(bundle.manifest.generatedAt).getUTCFullYear();
  const variantDefs = variantFacetDefs(thisYear);
  // One row per (Variant, listing group) so market, source, price and odometer filters must
  // hold for the same group; Variants without listings get one row with no group.
  const variantRows: VariantGroupRow[] = index.variants.flatMap<VariantGroupRow>((variant) =>
    variant.used?.groups.length
      ? variant.used.groups.map((group) => ({ variant, group }))
      : [{ variant, group: null }],
  );
  const byId = new Map(index.variants.map((v) => [v.id, v]));
  const views = new Map<string, Promise<ModelView | null>>();

  return {
    manifest: bundle.manifest,
    query(query = {}) {
      const { filters = {}, sort, offset, limit } = query;
      const result = runQuery(variantRows, variantDefs, filters, sort, offset, limit);
      return { ...result, rows: result.rows.map((r) => r.variant) } as VariantResult;
    },
    model(id) {
      let view = views.get(id);
      if (!view) {
        view = bundle.model(id).then((file) =>
          file
            ? {
                ...modelListings(file, bundle.manifest),
                variants: file.variantIds.flatMap((v) => byId.get(v) ?? []),
              }
            : null,
        );
        views.set(id, view);
      }
      return view;
    },
  };
}

interface VariantGroupRow {
  variant: VariantRow;
  group: UsedGroup | null;
}

type VariantEnum = keyof VariantFacets["values"];
type VariantRange = keyof VariantFacets["ranges"];

function variantFacetDefs(
  thisYear: number,
): FacetDefs<VariantGroupRow, VariantEnum, VariantRange, VariantSortKey> {
  return {
    identity: (r) => r.variant.id,
    values: {
      make: (r) => [r.variant.makeId],
      model: (r) => [r.variant.modelId],
      body: (r) => [r.variant.body],
      fuel: (r) => [r.variant.fuel],
      transmission: (r) => r.variant.transmissions ?? [],
      market: (r) => (r.group ? [r.group.market] : []),
      source: (r) => (r.group ? [r.group.source] : []),
      openpilot: (r) => [r.variant.openpilot?.level ?? "unlisted"],
    },
    ranges: {
      year: (r) => [r.variant.years.from, r.variant.years.to ?? thisYear],
      powerKw: (r) => point(r.variant.powerKw),
      seats: (r) => point(r.variant.seats),
      consumptionL100km: (r) => point(r.variant.consumptionL100km),
      newPriceCzk: (r) =>
        r.variant.newPriceCzk ? [r.variant.newPriceCzk.min, r.variant.newPriceCzk.max] : null,
      usedPriceCzk: (r) => (r.group ? [r.group.priceCzk.min, r.group.priceCzk.max] : null),
      odometerKm: (r) =>
        r.group?.odometerKm ? [r.group.odometerKm.min, r.group.odometerKm.max] : null,
    },
    sort: {
      make: (r) => `${r.variant.make} ${r.variant.model}`,
      model: (r) => r.variant.model,
      year: (r) => r.variant.years.from,
      powerKw: (r) => r.variant.powerKw,
      newPriceCzk: (r) => r.variant.newPriceCzk?.min,
      usedPriceCzk: (r) => r.variant.used?.priceCzk?.median,
      usedCount: (r) => r.variant.used?.count ?? 0,
      consumptionL100km: (r) => r.variant.consumptionL100km,
    },
  };
}
