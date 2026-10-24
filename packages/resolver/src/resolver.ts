import {
  type CatalogVariant,
  type MakeId,
  type ModelId,
  slugify,
  type VariantId,
  type VehicleDescriptor,
} from "@cca/vocabulary";

/**
 * Where a raw vehicle descriptor lands in the catalog.
 * - matched: exactly one Variant fits.
 * - model: the model is known but zero or several Variants fit; the listing still belongs
 *   on the model page.
 * - unmatched: make or model unknown to the catalog.
 */
export type Resolution =
  | { status: "matched"; makeId: MakeId; modelId: ModelId; variantId: VariantId }
  | { status: "model"; makeId: MakeId; modelId: ModelId; reason: "ambiguous" | "no-variant" }
  | { status: "unmatched"; reason: "unknown-make" | "unknown-model" };

/**
 * The Resolver's interface: build once per catalog, then resolve many descriptors.
 * Pure and deterministic for a given catalog.
 */
export interface Resolver {
  /**
   * `source` is the SourceId the descriptor came from; it namespaces
   * `vehicle.sourceTaxonomy` ids (Sauto's make id 93 means nothing to AutoScout24).
   */
  resolve(vehicle: VehicleDescriptor, source?: string): Resolution;
}

/**
 * Wave 0 implementation: slug + alias match on make, longest-prefix match on model,
 * generation by year, then narrowing by fuel, transmission, body and power (±3 kW).
 * TODO(wave1-stream11): per-source taxonomy aliases, trim parsing, fuzzy matching, scoring.
 */
export function createResolver(catalog: readonly CatalogVariant[]): Resolver {
  const byModel = new Map<ModelId, CatalogVariant[]>();
  const modelsByMake = new Map<MakeId, ModelId[]>();
  for (const variant of catalog) {
    const list = byModel.get(variant.modelId);
    if (list) list.push(variant);
    else {
      byModel.set(variant.modelId, [variant]);
      modelsByMake.set(variant.makeId, [
        ...(modelsByMake.get(variant.makeId) ?? []),
        variant.modelId,
      ]);
    }
  }

  return {
    resolve(vehicle) {
      const makeId = MAKE_ALIASES[slugify(vehicle.make)] ?? slugify(vehicle.make);
      const models = modelsByMake.get(makeId);
      if (!models) return { status: "unmatched", reason: "unknown-make" };

      const modelSlug = slugify(vehicle.model);
      const modelId = models
        .filter((id) => {
          const slug = id.slice(makeId.length + 1);
          return modelSlug === slug || modelSlug.startsWith(`${slug}-`);
        })
        .sort((a, b) => b.length - a.length)[0];
      if (!modelId) return { status: "unmatched", reason: "unknown-model" };

      const year = vehicle.firstRegistration?.year ?? vehicle.manufactureYear ?? vehicle.modelYear;
      const candidates = (byModel.get(modelId) ?? []).filter(
        (v) =>
          (year === undefined || (v.years.from <= year && (v.years.to ?? year) >= year)) &&
          (vehicle.fuel === undefined || v.fuel === vehicle.fuel) &&
          (vehicle.transmission === undefined || v.transmission === vehicle.transmission) &&
          (vehicle.body === undefined || v.body === vehicle.body) &&
          (vehicle.powerKw === undefined || Math.abs(v.powerKw - vehicle.powerKw) <= 3),
      );
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only) return { status: "matched", makeId, modelId, variantId: only.id };
      return {
        status: "model",
        makeId,
        modelId,
        reason: candidates.length === 0 ? "no-variant" : "ambiguous",
      };
    },
  };
}

const MAKE_ALIASES: Record<string, MakeId> = {
  vw: "volkswagen",
  mercedes: "mercedes-benz",
  "mercedes-benz": "mercedes-benz",
  mb: "mercedes-benz",
};
