import {
  type CatalogVariant,
  generationIdOf,
  makeIdOf,
  modelIdOf,
  type VariantSpec,
  variantIdOf,
} from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { createResolver } from "./index.ts";

function variant(
  spec: Omit<VariantSpec, "years"> & { years?: VariantSpec["years"] },
): CatalogVariant {
  const full = { years: { from: spec.generation.from }, ...spec } as VariantSpec;
  return {
    ...full,
    id: variantIdOf(full),
    makeId: makeIdOf(full.make),
    modelId: modelIdOf(full.make, full.model),
    generationId: generationIdOf(full),
  };
}

const mk8 = { slug: "mk8", name: "Golf VIII", from: 2020 };
const catalog = [
  variant({
    make: "Volkswagen",
    model: "Golf",
    generation: mk8,
    body: "hatchback",
    fuel: "petrol",
    powerKw: 110,
    transmission: "automatic",
  }),
  variant({
    make: "Volkswagen",
    model: "Golf",
    generation: mk8,
    body: "hatchback",
    fuel: "diesel",
    powerKw: 85,
    transmission: "manual",
  }),
  variant({
    make: "Volkswagen",
    model: "Golf",
    generation: mk8,
    body: "wagon",
    fuel: "diesel",
    powerKw: 110,
    transmission: "automatic",
  }),
];
const resolver = createResolver(catalog);

describe("Resolver", () => {
  it("matches a fully described listing, with make aliases and model suffixes", () => {
    expect(
      resolver.resolve({
        make: "VW",
        model: "Golf Variant",
        fuel: "diesel",
        powerKw: 110,
        transmission: "automatic",
      }),
    ).toEqual({
      status: "matched",
      makeId: "volkswagen",
      modelId: "volkswagen/golf",
      variantId: "volkswagen/golf/mk8/wagon-diesel-110kw-automatic",
    });
  });

  it("tolerates small power differences (kW/PS rounding)", () => {
    expect(
      resolver.resolve({ make: "Volkswagen", model: "Golf", fuel: "diesel", powerKw: 86 }).status,
    ).toBe("matched");
  });

  it("falls back to the model when several Variants fit", () => {
    expect(resolver.resolve({ make: "Volkswagen", model: "Golf", fuel: "diesel" })).toEqual({
      status: "model",
      makeId: "volkswagen",
      modelId: "volkswagen/golf",
      reason: "ambiguous",
    });
  });

  it("falls back to the model when no Variant fits", () => {
    expect(
      resolver.resolve({ make: "Volkswagen", model: "Golf", fuel: "petrol", powerKw: 180 }),
    ).toMatchObject({
      status: "model",
      reason: "no-variant",
    });
  });

  it("reports unknown makes and models", () => {
    expect(resolver.resolve({ make: "Lada", model: "Niva" })).toEqual({
      status: "unmatched",
      reason: "unknown-make",
    });
    expect(resolver.resolve({ make: "VW", model: "Polo" })).toEqual({
      status: "unmatched",
      reason: "unknown-model",
    });
  });

  it("ignores Variants outside the listing's year", () => {
    expect(
      resolver.resolve({
        make: "VW",
        model: "Golf",
        fuel: "diesel",
        powerKw: 85,
        firstRegistration: { year: 2015 },
      }).status,
    ).toBe("model");
  });
});
