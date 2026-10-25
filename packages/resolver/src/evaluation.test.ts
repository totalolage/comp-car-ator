import {
  type Body,
  type CatalogVariant,
  type Fuel,
  generationIdOf,
  makeIdOf,
  modelIdOf,
  type Transmission,
  type VariantSpec,
  variantIdOf,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { createResolver, type Resolution } from "./index.ts";
import catalogFile from "./fixtures/evaluation-catalog.json" with { type: "json" };
import listingsFile from "./fixtures/evaluation-listings.json" with { type: "json" };

/**
 * Accuracy on real listings: 95 Sauto and AutoScout24 descriptors, hand-labelled against a
 * hand-built catalog (fixtures/evaluation-*.json).
 * - precision: matched listings whose Variant is the labelled one / matched listings
 * - coverage: listings matched to their labelled Variant / listings labelled with a Variant
 * Raise the floors when the Resolver improves; never lower them to pass.
 */
const PRECISION_FLOOR = 1;
const COVERAGE_FLOOR = 37 / 45;

type Generation = [slug: string, name: string, from: number, to: number | null, rows: string[]];

function expand(): CatalogVariant[] {
  const makes = catalogFile.makes as unknown as Record<string, Record<string, Generation[]>>;
  return Object.entries(makes).flatMap(([make, models]) =>
    Object.entries(models).flatMap(([model, generations]) =>
      generations.flatMap(([slug, name, from, to, rows]) =>
        rows.flatMap((row) => {
          const [bodies, fuel, powers, transmissions, years] = row.split(" ") as [
            string,
            Fuel,
            string,
            string,
            string | undefined,
          ];
          const [yearFrom, yearTo] = (years ?? `${from}-${to ?? ""}`).split("-");
          return bodies.split(",").flatMap((body) =>
            powers.split(",").flatMap((power) =>
              transmissions.split(",").map((transmission) => {
                const spec: VariantSpec = {
                  make,
                  model,
                  generation: { slug, name, from, ...(to === null ? {} : { to }) },
                  body: body as Body,
                  fuel,
                  powerKw: Number(power),
                  transmission: transmission as Transmission,
                  years: { from: Number(yearFrom), ...(yearTo ? { to: Number(yearTo) } : {}) },
                };
                return {
                  ...spec,
                  id: variantIdOf(spec),
                  makeId: makeIdOf(make),
                  modelId: modelIdOf(make, model),
                  generationId: generationIdOf(spec),
                };
              }),
            ),
          );
        }),
      ),
    ),
  );
}

interface Labelled {
  ref: string;
  expect: string;
  vehicle: VehicleDescriptor;
}

/** Whether a Resolution agrees with the label; a Variant label demands exactly that Variant. */
function agrees(label: string, resolution: Resolution): boolean {
  if (label === "unmatched") return resolution.status === "unmatched";
  if (label.startsWith("model:")) {
    return resolution.status === "model" && resolution.modelId === label.slice("model:".length);
  }
  return resolution.status === "matched" && resolution.variantId === label;
}

describe("Resolver evaluation set", () => {
  const catalog = expand();
  const resolver = createResolver(catalog);
  const listings = listingsFile.listings as unknown as Labelled[];
  const results = listings.map((listing) => ({
    ...listing,
    resolution: resolver.resolve(listing.vehicle, listing.ref.split(":")[0]),
  }));

  it("is a catalog of unique Variants and labels that exist in it", () => {
    const ids = new Set(catalog.map((v) => v.id));
    expect(ids.size).toBe(catalog.length);
    const modelIds = new Set(catalog.map((v) => v.modelId));
    for (const { expect: label } of listings) {
      if (label.startsWith("model:")) expect(modelIds).toContain(label.slice("model:".length));
      else if (label !== "unmatched") expect(ids).toContain(label);
    }
    expect(listings.length).toBeGreaterThanOrEqual(50);
  });

  it("never matches a listing to the wrong Variant", () => {
    const matched = results.filter((r) => r.resolution.status === "matched");
    const wrong = matched.filter((r) => !agrees(r.expect, r.resolution));
    expect(wrong.map((r) => r.ref)).toEqual([]);
    expect((matched.length - wrong.length) / matched.length).toBeGreaterThanOrEqual(PRECISION_FLOOR);
  });

  it("matches enough labelled Variants", () => {
    const labelled = results.filter((r) => r.expect !== "unmatched" && !r.expect.startsWith("model:"));
    const hits = labelled.filter((r) => agrees(r.expect, r.resolution));
    expect(hits.length / labelled.length).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
  });

  it("puts every other listing on its labelled Model, or reports it unknown", () => {
    const rest = results.filter((r) => r.expect === "unmatched" || r.expect.startsWith("model:"));
    expect(rest.filter((r) => !agrees(r.expect, r.resolution)).map((r) => r.ref)).toEqual([]);
  });
});
