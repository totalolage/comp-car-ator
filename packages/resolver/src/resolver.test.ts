import {
  type CatalogVariant,
  generationIdOf,
  makeIdOf,
  modelIdOf,
  type VariantSpec,
  type VehicleDescriptor,
  variantIdOf,
} from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { createResolver } from "./index.ts";

type Gen = VariantSpec["generation"];
type Row = Pick<VariantSpec, "body" | "fuel" | "powerKw" | "transmission"> & {
  years?: VariantSpec["years"];
};

function variants(make: string, model: string, generation: Gen, rows: Row[]): CatalogVariant[] {
  return rows.map((row) => {
    const spec: VariantSpec = {
      make,
      model,
      generation,
      years: { from: generation.from, to: generation.to },
      ...row,
    };
    return {
      ...spec,
      id: variantIdOf(spec),
      makeId: makeIdOf(make),
      modelId: modelIdOf(make, model),
      generationId: generationIdOf(spec),
    };
  });
}

const octavia3 = { slug: "mk3", name: "Octavia III", from: 2013, to: 2020 };
const octavia4 = { slug: "mk4", name: "Octavia IV", from: 2020 };
const golf7 = { slug: "mk7", name: "Golf VII", from: 2012, to: 2020 };
const golf8 = { slug: "mk8", name: "Golf VIII", from: 2020 };

const catalog = [
  ...variants("Škoda", "Octavia", octavia3, [
    { body: "wagon", fuel: "diesel", powerKw: 110, transmission: "automatic" },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmission: "automatic" },
    { body: "wagon", fuel: "diesel", powerKw: 135, transmission: "automatic" },
  ]),
  ...variants("Škoda", "Octavia", octavia4, [
    { body: "wagon", fuel: "diesel", powerKw: 110, transmission: "automatic" },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmission: "automatic" },
    { body: "wagon", fuel: "diesel", powerKw: 147, transmission: "automatic" },
    { body: "wagon", fuel: "phev", powerKw: 150, transmission: "automatic" },
  ]),
  ...variants("Škoda", "Kodiaq", { slug: "mk1", name: "Kodiaq I", from: 2016, to: 2024 }, [
    { body: "suv", fuel: "diesel", powerKw: 140, transmission: "automatic" },
    { body: "suv", fuel: "diesel", powerKw: 110, transmission: "manual" },
    { body: "suv", fuel: "diesel", powerKw: 110, transmission: "automatic" },
  ]),
  ...variants("Volkswagen", "Golf", golf7, [
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmission: "manual" },
  ]),
  ...variants("Volkswagen", "Golf", golf8, [
    { body: "hatchback", fuel: "diesel", powerKw: 85, transmission: "manual" },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmission: "manual" },
    { body: "wagon", fuel: "diesel", powerKw: 110, transmission: "automatic" },
    { body: "hatchback", fuel: "petrol", powerKw: 110, transmission: "automatic" },
    { body: "hatchback", fuel: "petrol", powerKw: 113, transmission: "automatic" },
  ]),
  ...variants("Volkswagen", "Tiguan", { slug: "mk2", name: "Tiguan II", from: 2016, to: 2024 }, [
    { body: "suv", fuel: "petrol", powerKw: 140, transmission: "automatic" },
  ]),
  ...variants("Mercedes-Benz", "C-Klasse", { slug: "w206", name: "W206", from: 2021 }, [
    { body: "sedan", fuel: "diesel", powerKw: 147, transmission: "automatic" },
  ]),
  ...variants("BMW", "Řada 3", { slug: "g20", name: "G20", from: 2019 }, [
    { body: "sedan", fuel: "diesel", powerKw: 140, transmission: "automatic" },
  ]),
  ...variants("Land Rover", "Range Rover", { slug: "l405", name: "L405", from: 2012, to: 2021 }, [
    { body: "suv", fuel: "diesel", powerKw: 225, transmission: "automatic" },
  ]),
];
const resolver = createResolver(catalog);
const resolve = (vehicle: VehicleDescriptor) => resolver.resolve(vehicle);
const variantOf = (vehicle: VehicleDescriptor) => {
  const r = resolve(vehicle);
  return r.status === "matched" ? r.variantId : r;
};

const kodiaq = {
  make: "Škoda",
  model: "Kodiaq",
  fuel: "diesel",
  transmission: "automatic",
} as const;

describe("Resolver", () => {
  it("matches a fully described listing", () => {
    expect(resolve({ ...kodiaq, powerKw: 140, firstRegistration: { year: 2018 } })).toEqual({
      status: "matched",
      makeId: "skoda",
      modelId: "skoda/kodiaq",
      variantId: "skoda/kodiaq/mk1/suv-diesel-140kw-automatic",
    });
  });

  it("reads make and model through diacritics, case and aliases", () => {
    const tiguan = "volkswagen/tiguan/mk2/suv-petrol-140kw-automatic";
    const petrol = { fuel: "petrol", powerKw: 140, transmission: "automatic" } as const;
    expect(variantOf({ make: "VW", model: "TIGUAN", ...petrol })).toBe(tiguan);
    expect(variantOf({ make: "volkswagen", model: "tiguan", ...petrol })).toBe(tiguan);
    expect(variantOf({ make: "SKODA", model: "kodiaq", ...kodiaq, powerKw: 140 })).toBe(
      "skoda/kodiaq/mk1/suv-diesel-140kw-automatic",
    );
    // Sauto's Czech class names, AutoScout24's engine badges, English names: one Model each.
    const c = { fuel: "diesel", powerKw: 147, transmission: "automatic" } as const;
    for (const model of ["Třídy C", "C 220", "C-Class", "C-Klasse", "c220d"]) {
      expect(variantOf({ make: "Mercedes", model, ...c })).toBe(
        "mercedes-benz/c-klasse/w206/sedan-diesel-147kw-automatic",
      );
    }
    const bmw = { fuel: "diesel", powerKw: 140, transmission: "automatic" } as const;
    for (const model of ["320", "320d", "3er", "3 Series", "Řada 3"]) {
      expect(variantOf({ make: "BMW", model, ...bmw })).toBe(
        "bmw/rada-3/g20/sedan-diesel-140kw-automatic",
      );
    }
  });

  it("reads power, gearbox, body and generation from trim noise", () => {
    expect(
      variantOf({
        make: "Škoda",
        model: "Octavia Combi",
        trim: "2,0 TDI 147kW DSG RS",
        fuel: "diesel",
        firstRegistration: { year: 2022 },
      }),
    ).toBe("skoda/octavia/mk4/wagon-diesel-147kw-automatic");
    expect(
      variantOf({ make: "VW", model: "Golf", trim: "VIII 2.0 TDI 115 PS", fuel: "diesel" }),
    ).toBe("volkswagen/golf/mk8/hatchback-diesel-85kw-manual");
    expect(
      variantOf({ make: "VW", model: "Golf Variant", trim: "Style 7-DSG 110 kW", fuel: "diesel" }),
    ).toBe("volkswagen/golf/mk8/wagon-diesel-110kw-automatic");
  });

  it("lets stated fields win over trim text", () => {
    expect(
      variantOf({ ...kodiaq, transmission: "manual", trim: "2.0 TDI 110 kW DSG", powerKw: 110 }),
    ).toBe("skoda/kodiaq/mk1/suv-diesel-110kw-manual");
  });

  it("drops a hint the text states two conflicting ways", () => {
    expect(resolve({ ...kodiaq, trim: "110 kW, dříve 140 kW" })).toMatchObject({
      status: "model",
      reason: "ambiguous",
    });
  });

  it("does not read door counts as diesel or climate control as a gearbox", () => {
    // The only 110 kW manual Golf is a diesel, but "5D" is five doors, not a diesel badge.
    expect(
      resolve({ make: "VW", model: "Golf", trim: "1.5 5D", powerKw: 110, transmission: "manual" }),
    ).toMatchObject({ status: "model", reason: "ambiguous" });
    expect(
      variantOf({
        make: "VW",
        model: "Golf",
        trim: "2.0d 5D",
        powerKw: 110,
        transmission: "manual",
        firstRegistration: { year: 2022 },
      }),
    ).toBe("volkswagen/golf/mk8/hatchback-diesel-110kw-manual");
    const kodiaq110 = { ...kodiaq, transmission: undefined, powerKw: 110 };
    for (const trim of [
      "Automatická klimatizace",
      "Automatische Klimaanlage",
      "Aut. klima",
      "Aut.klima",
    ]) {
      expect(resolve({ ...kodiaq110, trim })).toMatchObject({ reason: "ambiguous" });
    }
    for (const trim of ["Automatik, Klima", "2,0 TDI Aut. Navi", "Automat"]) {
      expect(variantOf({ ...kodiaq110, trim })).toBe("skoda/kodiaq/mk1/suv-diesel-110kw-automatic");
    }
  });

  it("tolerates power within 3 kW and no more", () => {
    expect(variantOf({ ...kodiaq, powerKw: 137 })).toBe(
      "skoda/kodiaq/mk1/suv-diesel-140kw-automatic",
    );
    expect(resolve({ ...kodiaq, powerKw: 136 })).toMatchObject({ reason: "no-variant" });
  });

  it("never picks between Variants that both fit, even if one is closer", () => {
    // 110 kW and 113 kW petrol Golfs are both within tolerance of 111.
    expect(
      resolve({
        make: "VW",
        model: "Golf",
        fuel: "petrol",
        powerKw: 111,
        transmission: "automatic",
      }),
    ).toEqual({
      status: "model",
      makeId: "volkswagen",
      modelId: "volkswagen/golf",
      reason: "ambiguous",
    });
  });

  it("needs fuel and power before matching, even when one Variant is left", () => {
    // Only one Tiguan in the catalog, but the listing does not say which engine it has.
    expect(resolve({ make: "VW", model: "Tiguan", fuel: "petrol" })).toMatchObject({
      status: "model",
      reason: "ambiguous",
    });
    expect(resolve({ make: "VW", model: "Tiguan", powerKw: 140 })).toMatchObject({
      status: "model",
      reason: "ambiguous",
    });
  });

  describe("generation boundary years", () => {
    const octavia = {
      make: "Škoda",
      model: "Octavia Combi",
      fuel: "diesel",
      powerKw: 110,
      transmission: "automatic",
    } as const;

    it("matches by year away from the boundary", () => {
      expect(variantOf({ ...octavia, firstRegistration: { year: 2017 } })).toBe(
        "skoda/octavia/mk3/wagon-diesel-110kw-automatic",
      );
      expect(variantOf({ ...octavia, firstRegistration: { year: 2022 } })).toBe(
        "skoda/octavia/mk4/wagon-diesel-110kw-automatic",
      );
    });

    it("gives registration a year either side, so boundary years stay ambiguous", () => {
      for (const year of [2019, 2020, 2021]) {
        expect(resolve({ ...octavia, firstRegistration: { year } })).toMatchObject({
          reason: "ambiguous",
        });
      }
    });

    it("holds manufacture year to the production years", () => {
      expect(variantOf({ ...octavia, manufactureYear: 2021 })).toBe(
        "skoda/octavia/mk4/wagon-diesel-110kw-automatic",
      );
    });

    it("settles a boundary year with a generation named in the text", () => {
      const year = { firstRegistration: { year: 2020 } };
      expect(variantOf({ ...octavia, ...year, trim: "IV 2.0 TDI" })).toBe(
        "skoda/octavia/mk4/wagon-diesel-110kw-automatic",
      );
      expect(variantOf({ ...octavia, ...year, trim: "Mk3 2.0 TDI" })).toBe(
        "skoda/octavia/mk3/wagon-diesel-110kw-automatic",
      );
    });

    it("does not read Škoda's iV plug-in badge or engine numbers as a generation", () => {
      expect(
        variantOf({ ...octavia, fuel: "phev", powerKw: 150, trim: "iV 1.4 TSI", modelYear: 2021 }),
      ).toBe("skoda/octavia/mk4/wagon-phev-150kw-automatic");
      expect(
        resolve({ ...octavia, firstRegistration: { year: 2020 }, trim: "3 4 2.0" }),
      ).toMatchObject({ reason: "ambiguous" });
    });

    it("does not match when the text names a generation the catalog lacks, or two", () => {
      // The catalog has Kodiaq I only; "Kodiaq II" is no evidence for it.
      expect(resolve({ ...kodiaq, powerKw: 140, trim: "II 2.0 TDI" })).toMatchObject({
        status: "model",
        reason: "ambiguous",
      });
      expect(resolve({ ...kodiaq, powerKw: 140, trim: "Mk2 2.0 TDI" })).toMatchObject({
        status: "model",
      });
      expect(variantOf({ ...kodiaq, powerKw: 140, trim: "2.0 TDI Euro VI" })).toBe(
        "skoda/kodiaq/mk1/suv-diesel-140kw-automatic",
      );
      expect(
        resolve({ ...octavia, firstRegistration: { year: 2022 }, trim: "Mk3 IV" }),
      ).toMatchObject({ status: "model", reason: "ambiguous" });
    });

    it("finds no Variant when the named generation contradicts the year", () => {
      expect(resolve({ ...octavia, firstRegistration: { year: 2023 }, trim: "III" })).toMatchObject(
        {
          status: "model",
          reason: "no-variant",
        },
      );
    });
  });

  it("resolves the same car from Sauto and AutoScout24 to the same Variant", () => {
    const sauto: VehicleDescriptor = {
      make: "Škoda",
      model: "Kodiaq",
      trim: "2,0 TDI 140kW DSG 4x4 CZ Style",
      sourceTaxonomy: { make: "70", model: "705" },
      firstRegistration: { year: 2017, month: 9 },
      manufactureYear: 2017,
      fuel: "diesel",
      transmission: "automatic",
    };
    const autoscout: VehicleDescriptor = {
      make: "Skoda",
      model: "Kodiaq",
      trim: "2.0 TDI 4x4 Style DSG *AHK*NAVI*",
      sourceTaxonomy: { make: "65", model: "21197" },
      firstRegistration: { year: 2017, month: 9 },
      fuel: "diesel",
      powerKw: 140,
      transmission: "automatic",
    };
    expect(resolver.resolve(sauto, "sauto")).toEqual(resolver.resolve(autoscout, "autoscout24-de"));
    expect(variantOf(sauto)).toBe("skoda/kodiaq/mk1/suv-diesel-140kw-automatic");
  });

  it("reports unknown makes and models without falling back to a shorter model", () => {
    expect(resolve({ make: "Lada", model: "Niva" })).toEqual({
      status: "unmatched",
      reason: "unknown-make",
    });
    expect(resolve({ make: "VW", model: "Polo" })).toEqual({
      status: "unmatched",
      reason: "unknown-model",
    });
    // "Range Rover Sport" shares engines with the Range Rover but is another Model.
    for (const model of ["RangeRover Sport", "Range-Rover Sport", "Range Rover SPORT HSE"]) {
      expect(
        resolve({
          make: "Land Rover",
          model,
          fuel: "diesel",
          powerKw: 225,
          transmission: "automatic",
        }),
      ).toEqual({ status: "unmatched", reason: "unknown-model" });
    }
    expect(
      resolve({
        make: "Land Rover",
        model: "Range Rover Sport",
        fuel: "diesel",
        powerKw: 225,
        transmission: "automatic",
      }),
    ).toEqual({ status: "unmatched", reason: "unknown-model" });
  });

  it("does not depend on catalog order", () => {
    const reversed = createResolver([...catalog].reverse());
    const listing = {
      make: "Mercedes-Benz",
      model: "C 220 d",
      fuel: "diesel",
      powerKw: 147,
    } as const;
    expect(reversed.resolve(listing)).toEqual(resolver.resolve(listing));
    expect(reversed.resolve({ make: "VW", model: "Golf" })).toEqual(
      resolver.resolve({ make: "VW", model: "Golf" }),
    );
  });

  it("picks the same Model id when two catalog spellings share an alias group", () => {
    const w206 = { slug: "w206", name: "W206", from: 2021 };
    const spellings = [
      ...variants("Mercedes-Benz", "Třída C", w206, [
        { body: "wagon", fuel: "diesel", powerKw: 147, transmission: "automatic" },
      ]),
      ...variants("Mercedes-Benz", "C-Klasse", w206, [
        { body: "sedan", fuel: "diesel", powerKw: 147, transmission: "automatic" },
      ]),
    ];
    const listing = { make: "Mercedes", model: "C 220 d", fuel: "diesel", powerKw: 147 } as const;
    const expected = {
      status: "model",
      makeId: "mercedes-benz",
      modelId: "mercedes-benz/c-klasse",
      reason: "ambiguous",
    };
    expect(createResolver(spellings).resolve(listing)).toEqual(expected);
    expect(createResolver([...spellings].reverse()).resolve(listing)).toEqual(expected);
    // Both spellings name their generation W206: one generation, not two.
    expect(
      createResolver(spellings).resolve({ ...listing, body: "sedan", trim: "W206 AMG Line" }),
    ).toMatchObject({
      status: "matched",
      variantId: "mercedes-benz/c-klasse/w206/sedan-diesel-147kw-automatic",
    });
  });
});
