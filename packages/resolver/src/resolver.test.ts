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
type Row = Pick<VariantSpec, "body" | "fuel" | "powerKw" | "transmissions"> & {
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
    { body: "wagon", fuel: "diesel", powerKw: 110, transmissions: ["automatic"] },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmissions: ["automatic"] },
    { body: "wagon", fuel: "diesel", powerKw: 135, transmissions: ["automatic"] },
  ]),
  ...variants("Škoda", "Octavia", octavia4, [
    { body: "wagon", fuel: "diesel", powerKw: 110, transmissions: ["automatic"] },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmissions: ["automatic"] },
    { body: "wagon", fuel: "diesel", powerKw: 147, transmissions: ["automatic"] },
    { body: "wagon", fuel: "phev", powerKw: 150, transmissions: ["automatic"] },
  ]),
  ...variants("Škoda", "Kodiaq", { slug: "mk1", name: "Kodiaq I", from: 2016, to: 2024 }, [
    { body: "suv", fuel: "diesel", powerKw: 140, transmissions: ["automatic"] },
    { body: "suv", fuel: "diesel", powerKw: 110, transmissions: ["manual"] },
  ]),
  ...variants("Volkswagen", "Golf", golf7, [
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmissions: ["manual"] },
  ]),
  ...variants("Volkswagen", "Golf", golf8, [
    { body: "hatchback", fuel: "diesel", powerKw: 85, transmissions: ["manual"] },
    { body: "hatchback", fuel: "diesel", powerKw: 110, transmissions: ["manual"] },
    { body: "wagon", fuel: "diesel", powerKw: 110, transmissions: ["automatic"] },
    { body: "hatchback", fuel: "petrol", powerKw: 110, transmissions: ["automatic"] },
    { body: "hatchback", fuel: "petrol", powerKw: 113, transmissions: ["automatic"] },
  ]),
  ...variants("Volkswagen", "Tiguan", { slug: "mk2", name: "Tiguan II", from: 2016, to: 2024 }, [
    { body: "suv", fuel: "petrol", powerKw: 140, transmissions: ["automatic"] },
  ]),
  ...variants("Mercedes-Benz", "C-Klasse", { slug: "w206", name: "W206", from: 2021 }, [
    { body: "sedan", fuel: "diesel", powerKw: 147, transmissions: ["automatic"] },
  ]),
  ...variants("BMW", "Řada 3", { slug: "g20", name: "G20", from: 2019 }, [
    { body: "sedan", fuel: "diesel", powerKw: 140, transmissions: ["automatic"] },
  ]),
  ...variants("Land Rover", "Range Rover", { slug: "l405", name: "L405", from: 2012, to: 2021 }, [
    { body: "suv", fuel: "diesel", powerKw: 225, transmissions: ["automatic"] },
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
      variantId: "skoda/kodiaq/mk1/suv-diesel-140kw",
    });
  });

  it("reads make and model through diacritics, case and aliases", () => {
    const tiguan = "volkswagen/tiguan/mk2/suv-petrol-140kw";
    const petrol = { fuel: "petrol", powerKw: 140, transmission: "automatic" } as const;
    expect(variantOf({ make: "VW", model: "TIGUAN", ...petrol })).toBe(tiguan);
    expect(variantOf({ make: "volkswagen", model: "tiguan", ...petrol })).toBe(tiguan);
    expect(variantOf({ ...kodiaq, make: "SKODA", model: "kodiaq", powerKw: 140 })).toBe(
      "skoda/kodiaq/mk1/suv-diesel-140kw",
    );
    // Sauto's Czech class names, AutoScout24's engine badges, English names: one Model each.
    const c = { fuel: "diesel", powerKw: 147, transmission: "automatic" } as const;
    for (const model of ["Třídy C", "C 220", "C-Class", "C-Klasse", "c220d"]) {
      expect(variantOf({ make: "Mercedes", model, ...c })).toBe(
        "mercedes-benz/c-klasse/w206/sedan-diesel-147kw",
      );
    }
    const bmw = { fuel: "diesel", powerKw: 140, transmission: "automatic" } as const;
    for (const model of ["320", "320d", "3er", "3 Series", "Řada 3"]) {
      expect(variantOf({ make: "BMW", model, ...bmw })).toBe("bmw/rada-3/g20/sedan-diesel-140kw");
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
    ).toBe("skoda/octavia/mk4/wagon-diesel-147kw");
    expect(
      variantOf({ make: "VW", model: "Golf", trim: "VIII 2.0 TDI 115 PS", fuel: "diesel" }),
    ).toBe("volkswagen/golf/mk8/hatchback-diesel-85kw");
    expect(
      variantOf({ make: "VW", model: "Golf Variant", trim: "Style 7-DSG 110 kW", fuel: "diesel" }),
    ).toBe("volkswagen/golf/mk8/wagon-diesel-110kw");
  });

  it("lets stated fields win over trim text", () => {
    expect(
      variantOf({ ...kodiaq, transmission: "manual", trim: "2.0 TDI 110 kW DSG", powerKw: 110 }),
    ).toBe("skoda/kodiaq/mk1/suv-diesel-110kw");
  });

  it("filters by the Variant's stated gearboxes, never splitting a Variant by gearbox", () => {
    const superbs = createResolver([
      ...variants("Škoda", "Superb", { slug: "mk3", name: "Superb III", from: 2015, to: 2023 }, [
        { body: "wagon", fuel: "diesel", powerKw: 110 },
        { body: "wagon", fuel: "diesel", powerKw: 140, transmissions: ["manual", "automatic"] },
      ]),
    ]);
    const superb = { make: "Škoda", model: "Superb Combi", fuel: "diesel" } as const;
    for (const transmission of ["manual", "automatic", undefined] as const) {
      expect(superbs.resolve({ ...superb, powerKw: 110, transmission })).toMatchObject({
        status: "matched",
        variantId: "skoda/superb/mk3/wagon-diesel-110kw",
      });
      expect(superbs.resolve({ ...superb, powerKw: 140, transmission })).toMatchObject({
        status: "matched",
        variantId: "skoda/superb/mk3/wagon-diesel-140kw",
      });
    }
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
    ).toBe("volkswagen/golf/mk8/hatchback-diesel-110kw");
    const kodiaq110 = { ...kodiaq, transmission: undefined, powerKw: 110 };
    // The 110 kW Kodiaq is offered with a manual gearbox only.
    for (const trim of [
      "Automatická klimatizace",
      "Automatische Klimaanlage",
      "Aut. klima",
      "Aut.klima",
    ]) {
      expect(variantOf({ ...kodiaq110, trim })).toBe("skoda/kodiaq/mk1/suv-diesel-110kw");
    }
    for (const trim of ["Automatik, Klima", "2,0 TDI Aut. Navi", "Automat"]) {
      expect(resolve({ ...kodiaq110, trim })).toMatchObject({ reason: "no-variant" });
    }
  });

  it("tolerates power within 3 kW and no more", () => {
    expect(variantOf({ ...kodiaq, powerKw: 137 })).toBe("skoda/kodiaq/mk1/suv-diesel-140kw");
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

  describe("register bodies standing in for the stated body", () => {
    // The register files by EU body code: SUVs outside the off-road category as wagons or
    // MPVs, liftbacks as sedans, every Golf VIII as a wagon.
    const nx = { slug: "nx", name: "Octavia NX", from: 2020 };
    const register = createResolver([
      ...variants("Škoda", "Karoq", { slug: "nu", name: "Karoq NU", from: 2017 }, [
        { body: "wagon", fuel: "diesel", powerKw: 110 },
      ]),
      ...variants("Škoda", "Kodiaq", { slug: "ns", name: "Kodiaq NS", from: 2016, to: 2024 }, [
        { body: "suv", fuel: "diesel", powerKw: 140 },
        { body: "wagon", fuel: "diesel", powerKw: 140 },
        { body: "wagon", fuel: "diesel", powerKw: 110 },
      ]),
      ...variants("Škoda", "Octavia", nx, [
        { body: "sedan", fuel: "petrol", powerKw: 110 },
        { body: "wagon", fuel: "petrol", powerKw: 110 },
        { body: "wagon", fuel: "diesel", powerKw: 147 },
      ]),
      ...variants("Škoda", "Octavia", { slug: "5e", name: "Octavia 5E", from: 2013, to: 2020 }, [
        // Liftbacks of one generation filed under both codes.
        { body: "sedan", fuel: "diesel", powerKw: 110 },
        { body: "hatchback", fuel: "diesel", powerKw: 85 },
      ]),
      ...variants("Volkswagen", "Golf", golf8, [
        { body: "wagon", fuel: "petrol", powerKw: 110 },
        { body: "wagon", fuel: "petrol", powerKw: 239, years: { from: 2026 } },
        { body: "wagon", fuel: "phev", powerKw: 110 },
      ]),
      ...variants("Volkswagen", "Golf", golf7, [
        // Real hatchbacks and estates in one generation.
        { body: "hatchback", fuel: "diesel", powerKw: 110 },
        { body: "wagon", fuel: "diesel", powerKw: 135 },
      ]),
      ...variants("Volkswagen", "Golf", { slug: "mk6", name: "Golf VI", from: 2009, to: 2013 }, [
        // Only the estate's register type is catalogued.
        { body: "wagon", fuel: "petrol", powerKw: 90 },
      ]),
      ...variants("Volkswagen", "ID.3", { slug: "e1", name: "ID.3 E1", from: 2020 }, [
        { body: "hatchback", fuel: "bev", powerKw: 150, years: { from: 2020, to: 2020 } },
        { body: "wagon", fuel: "bev", powerKw: 150, years: { from: 2020, to: 2024 } },
        { body: "wagon", fuel: "bev", powerKw: 125, years: { from: 2023 } },
      ]),
      ...variants("Volkswagen", "Golf", { slug: "mk5", name: "Golf V", from: 2004, to: 2008 }, [
        { body: "wagon", fuel: "diesel", powerKw: 77 },
        { body: "mpv", fuel: "diesel", powerKw: 103 },
      ]),
      ...variants("Mazda", "3", { slug: "bp", name: "Mazda3 BP", from: 2019 }, [
        { body: "sedan", fuel: "petrol", powerKw: 110 },
        { body: "hatchback", fuel: "diesel", powerKw: 85 },
      ]),
      ...variants("Ford", "S-Max", { slug: "wa6", name: "S-Max WA6", from: 2015, to: 2023 }, [
        { body: "wagon", fuel: "diesel", powerKw: 132 },
      ]),
      ...variants("Hyundai", "Tucson", { slug: "tl", name: "Tucson TL", from: 2015, to: 2020 }, [
        { body: "mpv", fuel: "diesel", powerKw: 104 },
        { body: "wagon", fuel: "diesel", powerKw: 104 },
      ]),
      ...variants("Audi", "A6", { slug: "f2", name: "A6 C8", from: 2018 }, [
        { body: "sedan", fuel: "diesel", powerKw: 170 },
        { body: "wagon", fuel: "diesel", powerKw: 170 },
      ]),
      ...variants("Mercedes-Benz", "A-Class", { slug: "w177", name: "A-Class W177", from: 2018 }, [
        // The register files the hatchback as a wagon and the V177 saloon as a sedan.
        { body: "sedan", fuel: "diesel", powerKw: 110 },
        { body: "wagon", fuel: "petrol", powerKw: 120 },
      ]),
      ...variants("Ford", "Transit Custom", { slug: "nxn", name: "Transit Custom", from: 2024 }, [
        { body: "mpv", fuel: "diesel", powerKw: 100 },
      ]),
      ...variants("Alfa Romeo", "159", { slug: "939", name: "159", from: 2005, to: 2011 }, [
        { body: "sedan", fuel: "diesel", powerKw: 147 },
      ]),
    ]);
    const at = (vehicle: VehicleDescriptor) => {
      const r = register.resolve({ firstRegistration: { year: 2022 }, ...vehicle });
      return r.status === "matched" ? r.variantId : r;
    };
    const diesel = { fuel: "diesel", body: "suv" } as const;

    it("matches an SUV the register files as a wagon, preferring the stated body", () => {
      expect(at({ make: "Škoda", model: "Karoq", powerKw: 110, ...diesel })).toBe(
        "skoda/karoq/nu/wagon-diesel-110kw",
      );
      expect(at({ make: "Škoda", model: "Kodiaq", powerKw: 140, ...diesel })).toBe(
        "skoda/kodiaq/ns/suv-diesel-140kw",
      );
      expect(at({ make: "Škoda", model: "Kodiaq", powerKw: 110, ...diesel })).toBe(
        "skoda/kodiaq/ns/wagon-diesel-110kw",
      );
    });

    it("matches a liftback as the register's sedan, never as its Combi", () => {
      const octavia = { make: "Škoda", model: "Octavia", body: "hatchback" } as const;
      expect(at({ ...octavia, fuel: "petrol", powerKw: 110 })).toBe(
        "skoda/octavia/nx/sedan-petrol-110kw",
      );
      expect(at({ ...octavia, fuel: "diesel", powerKw: 147 })).toMatchObject({
        reason: "no-variant",
      });
    });

    it("takes another code only where the generation lacks the stated body", () => {
      // The register files this MPV as a wagon only.
      expect(at({ make: "Ford", model: "S-Max", fuel: "diesel", powerKw: 132, body: "mpv" })).toBe(
        "ford/s-max/wa6/wagon-diesel-132kw",
      );
      // Mazda 3 has real sedans and hatchbacks: a diesel sedan is not the diesel hatchback.
      expect(
        at({ make: "Mazda", model: "3", fuel: "diesel", powerKw: 85, body: "sedan" }),
      ).toMatchObject({ reason: "no-variant" });
      // A Golf V Variant is not the Golf Plus the generation files as an MPV.
      const golf5 = {
        make: "VW",
        model: "Golf",
        fuel: "diesel",
        firstRegistration: { year: 2006 },
      } as const;
      expect(at({ ...golf5, powerKw: 103, body: "wagon" })).toMatchObject({
        reason: "no-variant",
      });
      // Octavia liftbacks are filed under both codes in one generation.
      expect(
        at({
          make: "Škoda",
          model: "Octavia",
          fuel: "diesel",
          powerKw: 110,
          body: "hatchback",
          firstRegistration: { year: 2017 },
        }),
      ).toBe("skoda/octavia/5e/sedan-diesel-110kw");
    });

    it("takes no sedan for a hatchback where the generation has wagons", () => {
      // The A 200 d hatchback may be one of the generation's wagons, not the A 200 d saloon.
      expect(
        at({
          make: "Mercedes-Benz",
          model: "A-Class",
          body: "hatchback",
          fuel: "diesel",
          powerKw: 110,
        }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
    });

    it("takes a wagon for a hatchback only where the register files its hatchbacks so", () => {
      // Every Golf VIII and nearly every ID.3 is a wagon in the register.
      expect(
        at({
          make: "Volkswagen",
          model: "Golf",
          trim: "2,0 TSI / 239 kW GTI Edition 50",
          firstRegistration: undefined,
          modelYear: 2027,
          body: "hatchback",
          fuel: "petrol",
          powerKw: 239,
          transmission: "automatic",
        }),
      ).toBe("volkswagen/golf/mk8/wagon-petrol-239kw");
      const id3 = {
        make: "Volkswagen",
        model: "ID.3 Neo",
        body: "hatchback",
        fuel: "bev",
      } as const;
      expect(at({ ...id3, powerKw: 125, firstRegistration: undefined, modelYear: 2026 })).toBe(
        "volkswagen/id-3/e1/wagon-bev-125kw",
      );
      // The stated body still wins where a Variant fits it, and the wagon takes over after.
      expect(at({ ...id3, powerKw: 150, manufactureYear: 2020 })).toBe(
        "volkswagen/id-3/e1/hatchback-bev-150kw",
      );
      expect(at({ ...id3, powerKw: 150, manufactureYear: 2022 })).toBe(
        "volkswagen/id-3/e1/wagon-bev-150kw",
      );
      // A badge still limits the fuel, and wording naming the wagon agrees with the stand-in;
      // a convertible does not.
      expect(at({ make: "VW", model: "Golf GTE", body: "hatchback", powerKw: 110 })).toBe(
        "volkswagen/golf/mk8/wagon-phev-110kw",
      );
      const golf8 = { make: "VW", body: "hatchback", fuel: "petrol", powerKw: 110 } as const;
      expect(at({ ...golf8, model: "Golf Variant" })).toBe(
        "volkswagen/golf/mk8/wagon-petrol-110kw",
      );
      expect(at({ ...golf8, model: "Golf Cabrio" })).toMatchObject({ reason: "no-variant" });
      // A Golf VII has real estates, and the Golf VI's hatchback type is not catalogued: a
      // hatchback there is not the Golf Variant.
      const golf = { make: "VW", model: "Golf", body: "hatchback" } as const;
      expect(
        at({ ...golf, fuel: "diesel", powerKw: 135, firstRegistration: { year: 2016 } }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      expect(
        at({ ...golf, fuel: "petrol", powerKw: 90, firstRegistration: { year: 2011 } }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
    });

    it("takes nothing for a convertible", () => {
      const golf = { make: "VW", model: "Golf", fuel: "petrol", powerKw: 110 } as const;
      expect(at({ ...golf, body: "convertible" })).toMatchObject({ reason: "no-variant" });
    });

    it("takes no stand-in when the text names another body", () => {
      // Listed as a hatchback, but "Avant" is the wagon: the sedan stand-in is not that car.
      expect(
        at({
          make: "Audi",
          model: "A6 Avant",
          manufactureYear: 2019,
          body: "hatchback",
          fuel: "diesel",
          powerKw: 170,
        }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      expect(
        at({
          make: "Alfa Romeo",
          model: "159 Sportwagon",
          body: "hatchback",
          fuel: "diesel",
          powerKw: 147,
          firstRegistration: { year: 2009 },
        }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      // Two bodies named ("Sportwagon", "Cabrio") still name one the stand-in is not.
      expect(
        at({
          make: "Alfa Romeo",
          model: "159",
          trim: "Sportwagon Cabrio",
          body: "hatchback",
          fuel: "diesel",
          powerKw: 147,
          firstRegistration: { year: 2009 },
        }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      // An Octavia Combi listed as a hatchback is neither the liftback nor, on that word alone,
      // the Combi.
      expect(
        at({
          make: "Škoda",
          model: "Octavia",
          trim: "Combi",
          body: "hatchback",
          fuel: "petrol",
          powerKw: 110,
        }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      // Wording that agrees with the stand-in keeps it: an Octavia Scout Combi listed as an SUV.
      expect(
        at({
          make: "Škoda",
          model: "Octavia",
          trim: "Scout Combi",
          body: "suv",
          fuel: "diesel",
          powerKw: 147,
        }),
      ).toBe("skoda/octavia/nx/wagon-diesel-147kw");
      // Without a stated body the wording is the body: a passenger Transit "Kombi" is filed as
      // an MPV.
      expect(
        at({
          make: "Ford",
          model: "Transit Custom Kombi",
          fuel: "diesel",
          powerKw: 100,
          firstRegistration: { year: 2025 },
        }),
      ).toBe("ford/transit-custom/nxn/mpv-diesel-100kw");
    });

    it("stays ambiguous when several register bodies fit", () => {
      expect(
        at({
          make: "Hyundai",
          model: "Tucson",
          powerKw: 104,
          ...diesel,
          firstRegistration: { year: 2017 },
        }),
      ).toMatchObject({
        status: "model",
        reason: "ambiguous",
      });
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
        "skoda/octavia/mk3/wagon-diesel-110kw",
      );
      expect(variantOf({ ...octavia, firstRegistration: { year: 2022 } })).toBe(
        "skoda/octavia/mk4/wagon-diesel-110kw",
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
        "skoda/octavia/mk4/wagon-diesel-110kw",
      );
    });

    it("settles a boundary year with a generation named in the text", () => {
      const year = { firstRegistration: { year: 2020 } };
      expect(variantOf({ ...octavia, ...year, trim: "IV 2.0 TDI" })).toBe(
        "skoda/octavia/mk4/wagon-diesel-110kw",
      );
      expect(variantOf({ ...octavia, ...year, trim: "Mk3 2.0 TDI" })).toBe(
        "skoda/octavia/mk3/wagon-diesel-110kw",
      );
    });

    it("does not read Škoda's iV plug-in badge or engine numbers as a generation", () => {
      expect(
        variantOf({ ...octavia, fuel: "phev", powerKw: 150, trim: "iV 1.4 TSI", modelYear: 2021 }),
      ).toBe("skoda/octavia/mk4/wagon-phev-150kw");
      expect(
        resolve({ ...octavia, firstRegistration: { year: 2020 }, trim: "3 4 2.0" }),
      ).toMatchObject({ reason: "ambiguous" });
    });

    it("reads a lower-case Roman numeral as a generation, but not Škoda's iV badge", () => {
      const octaviaIII = createResolver(
        variants("Škoda", "Octavia", octavia3, [
          { body: "wagon", fuel: "petrol", powerKw: 110, transmissions: ["automatic"] },
          { body: "wagon", fuel: "phev", powerKw: 150, transmissions: ["automatic"] },
        ]),
      );
      const petrol = { make: "Škoda", fuel: "petrol", powerKw: 110, transmission: "automatic" };
      for (const model of ["Octavia iv", "Octavia IV", "Octavia ii"]) {
        expect(octaviaIII.resolve({ ...petrol, model } as VehicleDescriptor)).toMatchObject({
          status: "model",
          reason: "ambiguous",
        });
      }
      expect(
        octaviaIII.resolve({ ...petrol, model: "Octavia iii" } as VehicleDescriptor),
      ).toMatchObject({
        status: "matched",
        variantId: "skoda/octavia/mk3/wagon-petrol-110kw",
      });
      expect(
        octaviaIII.resolve({ make: "Škoda", model: "Octavia iV", fuel: "phev", powerKw: 150 }),
      ).toMatchObject({
        status: "matched",
        variantId: "skoda/octavia/mk3/wagon-phev-150kw",
      });
      // Lower-case "iv" is read as the generation even where it may be the badge typed loosely.
      expect(
        octaviaIII.resolve({ make: "Škoda", model: "Octavia iv", fuel: "phev", powerKw: 150 }),
      ).toMatchObject({ status: "model", reason: "ambiguous" });
      // A lone lower-case "v" claims no generation, wherever it stands.
      for (const listing of [
        { model: "Octavia v" },
        { model: "Octavia", trim: "Combi v záruce" },
      ]) {
        expect(octaviaIII.resolve({ ...petrol, ...listing } as VehicleDescriptor)).toMatchObject({
          status: "matched",
          variantId: "skoda/octavia/mk3/wagon-petrol-110kw",
        });
      }
    });

    it("reads a lone I or V only in upper case, after the model name or as the first trim word", () => {
      const golfs = createResolver(
        [
          { slug: "mk1", name: "Golf I", from: 1974, to: 1983 },
          { slug: "mk5", name: "Golf V", from: 2003, to: 2008 },
          golf8,
        ].flatMap((generation) =>
          variants("Volkswagen", "Golf", generation, [
            { body: "hatchback", fuel: "petrol", powerKw: 110, transmissions: ["automatic"] },
          ]),
        ),
      );
      const petrol = { make: "VW", fuel: "petrol", powerKw: 110 } as const;
      // "v záruce" is "under warranty"; lower-case letters never pick among fitting generations.
      for (const listing of [
        { model: "Golf", trim: "v záruce 110 kW DSG" },
        { model: "Golf v" },
        { model: "Golf i" },
        { model: "Golf", trim: "i 110 kW" },
        { model: "Golf", trim: "110 kW DSG, V záruce" },
      ]) {
        expect(golfs.resolve({ ...petrol, ...listing })).toMatchObject({
          status: "model",
          reason: "ambiguous",
        });
      }
      expect(golfs.resolve({ ...petrol, model: "Golf V" })).toMatchObject({
        status: "matched",
        variantId: "volkswagen/golf/mk5/hatchback-petrol-110kw",
      });
      expect(golfs.resolve({ ...petrol, model: "Golf", trim: "I 1.6" })).toMatchObject({
        status: "matched",
        variantId: "volkswagen/golf/mk1/hatchback-petrol-110kw",
      });
    });

    it("reads a lone I right after the model name as a claim, however the model is spelled", () => {
      // The catalog has only the C-Class W203 ("C-Class II"); each listing names generation I.
      const cClass = createResolver(
        variants("Mercedes-Benz", "C-Class", { slug: "w203", name: "W203 II", from: 2000 }, [
          { body: "sedan", fuel: "petrol", powerKw: 100, transmissions: ["manual"] },
        ]),
      );
      const listing = { make: "Mercedes", fuel: "petrol", powerKw: 100 } as const;
      for (const vehicle of [
        ...["C-Class I", "C-Klasse I", "C-Trida I", "Třída C I", "C220 I"].map((model) => ({
          model,
        })),
        { model: "C-Klasse", trim: "I 1.8" },
      ]) {
        expect(cClass.resolve({ ...listing, ...vehicle })).toMatchObject({
          status: "model",
          reason: "ambiguous",
        });
      }
      expect(cClass.resolve({ ...listing, model: "C-Klasse" })).toMatchObject({
        status: "matched",
      });

      // A model name the hints read as fewer words ("3.0" is a displacement) keeps its I.
      const csl = createResolver(
        variants("BMW", "3.0 CSL", { slug: "mk2", name: "3.0 CSL II", from: 2023 }, [
          { body: "coupe", fuel: "petrol", powerKw: 412, transmissions: ["manual"] },
        ]),
      );
      const bmw = { make: "BMW", fuel: "petrol", powerKw: 412 } as const;
      expect(csl.resolve({ ...bmw, model: "3.0 CSL I" })).toMatchObject({ status: "model" });
      expect(csl.resolve({ ...bmw, model: "3.0 CSL" })).toMatchObject({ status: "matched" });
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
        "skoda/kodiaq/mk1/suv-diesel-140kw",
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
    it("blocks on a generation the catalog lacks, whatever it is called", () => {
      // Each catalog has only the newer generation; the listing names the older one.
      const kodiaq2 = createResolver(
        variants("Škoda", "Kodiaq", { slug: "mk2", name: "Kodiaq II", from: 2024 }, [
          { body: "suv", fuel: "diesel", powerKw: 140, transmissions: ["automatic"] },
        ]),
      );
      const listing = { ...kodiaq, powerKw: 140 };
      expect(kodiaq2.resolve({ ...listing, trim: "I 2.0 TDI" })).toMatchObject({ status: "model" });
      expect(kodiaq2.resolve({ ...listing, model: "Kodiaq 2.0 TDI", trim: "I DSG" })).toMatchObject(
        {
          status: "model",
        },
      );
      expect(kodiaq2.resolve({ ...listing, model: "Kodiaq I", trim: "2.0 TDI" })).toMatchObject({
        status: "model",
      });
      // "I. majitel" is the first owner, and an "I" deep in the trim claims nothing.
      for (const trim of ["2.0 TDI I. majitel", "2.0 TDI Style I 4x4"]) {
        expect(kodiaq2.resolve({ ...listing, trim })).toMatchObject({ status: "matched" });
      }

      const eClass213 = createResolver(
        variants("Mercedes-Benz", "E-Klasse", { slug: "w213", name: "W213", from: 2016 }, [
          { body: "sedan", fuel: "diesel", powerKw: 143, transmissions: ["automatic"] },
        ]),
      );
      const e220 = { make: "Mercedes", model: "E 220 d", fuel: "diesel", powerKw: 143 } as const;
      expect(eClass213.resolve({ ...e220, trim: "W212 143kW" })).toMatchObject({ status: "model" });
      expect(eClass213.resolve({ ...e220, trim: "w212 Avantgarde" })).toMatchObject({
        status: "model",
      });
      // "E220" in an E-Class listing is the engine badge, not a chassis code.
      expect(
        eClass213.resolve({ ...e220, model: "E-Klasse", trim: "E220 CDI W213" }),
      ).toMatchObject({ status: "matched" });

      // Platform codes claim a generation for the whole make: "5G" is the Golf VII.
      expect(
        resolve({ make: "VW", model: "Golf", trim: "5G 2.0 TDI", fuel: "diesel", powerKw: 85 }),
      ).toMatchObject({ status: "model" });

      // The catalog's 3 Series is the G20 only; "N47" is an engine, "V6" a layout.
      expect(
        resolve({ make: "BMW", model: "320d", trim: "F30 Touring", fuel: "diesel", powerKw: 140 }),
      ).toMatchObject({ status: "model" });
      expect(
        resolve({ make: "BMW", model: "320d", trim: "G20 M Sport", fuel: "diesel", powerKw: 140 }),
      ).toMatchObject({ status: "matched" });
      for (const trim of ["N47 M Sport", "v6 M Sport"]) {
        expect(
          resolve({ make: "BMW", model: "320d", trim, fuel: "diesel", powerKw: 140 }),
        ).toMatchObject({ status: "matched" });
      }
    });

    it("reads a lone I deep in the trim as no generation", () => {
      const kodiaqs = createResolver([
        ...variants("Škoda", "Kodiaq", { slug: "mk1", name: "Kodiaq I", from: 2016, to: 2024 }, [
          { body: "suv", fuel: "diesel", powerKw: 140, transmissions: ["automatic"] },
        ]),
        ...variants("Škoda", "Kodiaq", { slug: "mk2", name: "Kodiaq II", from: 2024 }, [
          { body: "suv", fuel: "diesel", powerKw: 140, transmissions: ["automatic"] },
        ]),
      ]);
      const listing = { ...kodiaq, model: "Kodiaq II", powerKw: 140, trim: "2.0 TDI Style I" };
      expect(kodiaqs.resolve(listing)).toMatchObject({
        status: "matched",
        variantId: "skoda/kodiaq/mk2/suv-diesel-140kw",
      });
    });

    it("finds no Variant when a chassis code contradicts the year", () => {
      const eClass = createResolver([
        ...variants(
          "Mercedes-Benz",
          "E-Klasse",
          { slug: "w212", name: "W212", from: 2009, to: 2016 },
          [{ body: "sedan", fuel: "diesel", powerKw: 143, transmissions: ["automatic"] }],
        ),
        ...variants("Mercedes-Benz", "E-Klasse", { slug: "w213", name: "W213", from: 2016 }, [
          { body: "sedan", fuel: "diesel", powerKw: 143, transmissions: ["automatic"] },
        ]),
      ]);
      const e220 = { make: "Mercedes", model: "E 220 d", fuel: "diesel", powerKw: 143 } as const;
      expect(
        eClass.resolve({ ...e220, trim: "W212", firstRegistration: { year: 2021 } }),
      ).toMatchObject({ status: "model", reason: "no-variant" });
      expect(eClass.resolve({ ...e220, trim: "W213", firstRegistration: { year: 2021 } })).toEqual(
        expect.objectContaining({
          status: "matched",
          variantId: expect.stringContaining("/w213/"),
        }),
      );
    });
  });

  describe("hybrid and electric wording", () => {
    const golf = createResolver(
      variants("Volkswagen", "Golf", golf8, [
        { body: "hatchback", fuel: "petrol", powerKw: 110, transmissions: ["automatic"] },
        { body: "hatchback", fuel: "phev", powerKw: 150, transmissions: ["automatic"] },
      ]),
    );
    const vw = { make: "VW", model: "Golf" } as const;

    it("never reads a hybrid's engine code as petrol or diesel", () => {
      for (const listing of [
        { model: "Golf GTE", trim: "1.4 TSI Plug-in Hybrid 110 kW DSG" },
        { trim: "1.4 TSI PHEV 110 kW DSG" },
        { trim: "1.4 TSI eHybrid 110 kW DSG" },
        { trim: "1,4 TSI Hybridní 110 kW DSG" },
        { trim: "1.4 TSI Hybrid 110 kW DSG" },
        { trim: "1.4 TSI Elektro/Benzin 110 kW DSG" },
        { trim: "1.5 TSI mHEV 110 kW DSG" },
        { trim: "1.4 TSI Vollhybrid 110 kW DSG" },
        { trim: "1.4 TSI Elektromotor 110 kW DSG" },
      ]) {
        expect(golf.resolve({ ...vw, ...listing })).toMatchObject({ status: "model" });
      }
      // Equipment is not propulsion: "elektrische Heckklappe" is a tailgate.
      for (const trim of ["1.4 TSI 110 kW DSG", "1.4 TSI 110 kW DSG elektrische Heckklappe"]) {
        expect(golf.resolve({ ...vw, trim })).toMatchObject({ status: "matched" });
      }
    });

    it("finds no Variant when the wording contradicts the stated fuel", () => {
      for (const trim of ["GTE 110 kW", "1.4 TSI Plug-in-Hybrid 110 kW", "Hybrid 110 kW"]) {
        expect(golf.resolve({ ...vw, fuel: "petrol", trim })).toMatchObject({
          status: "model",
          reason: "no-variant",
        });
      }
    });

    it("reads a make's own badge only for that make: an Opel GTE is petrol", () => {
      const opel = createResolver([
        ...variants("Opel", "Astra", { slug: "c", name: "Astra C", from: 1984, to: 1991 }, [
          { body: "hatchback", fuel: "petrol", powerKw: 110, transmissions: ["manual"] },
        ]),
        ...variants("Opel", "Kadett", { slug: "e", name: "Kadett E", from: 1984, to: 1991 }, [
          { body: "hatchback", fuel: "petrol", powerKw: 110, transmissions: ["manual"] },
        ]),
      ]);
      for (const model of ["Astra", "Kadett"]) {
        expect(
          opel.resolve({
            make: "Opel",
            model,
            trim: "GTE",
            fuel: "petrol",
            powerKw: 110,
            transmission: "manual",
          }),
        ).toMatchObject({ status: "matched" });
      }
      expect(golf.resolve({ ...vw, trim: "GTE 150 kW DSG" })).toMatchObject({
        status: "matched",
        variantId: "volkswagen/golf/mk8/hatchback-phev-150kw",
      });
    });

    it("reads a plug-in hybrid from its wording, and a mild hybrid by its stated fuel", () => {
      expect(
        golf.resolve({ ...vw, model: "Golf GTE", trim: "1.4 TSI Plug-in Hybrid 150 kW DSG" }),
      ).toMatchObject({
        status: "matched",
        variantId: "volkswagen/golf/mk8/hatchback-phev-150kw",
      });
      expect(
        golf.resolve({ ...vw, fuel: "petrol", trim: "1.5 eTSI Mild-Hybrid 110 kW DSG" }),
      ).toMatchObject({
        status: "matched",
        variantId: "volkswagen/golf/mk8/hatchback-petrol-110kw",
      });
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
    expect(variantOf(sauto)).toBe("skoda/kodiaq/mk1/suv-diesel-140kw");
  });

  describe("names listings use that the catalog lacks", () => {
    // Register types Wikidata does not date are named by their code ("Octavia 5E").
    const coded = createResolver([
      ...variants("Škoda", "Octavia", { slug: "5e", name: "Octavia 5E", from: 2013, to: 2020 }, [
        { body: "wagon", fuel: "diesel", powerKw: 110 },
      ]),
      ...variants("Škoda", "Fabia", { slug: "5j", name: "Fabia 5J", from: 2007, to: 2022 }, [
        { body: "hatchback", fuel: "petrol", powerKw: 70 },
      ]),
      ...variants("Škoda", "Fabia", { slug: "mk4", name: "Fabia IV (Mk4, PJ)", from: 2021 }, [
        { body: "hatchback", fuel: "petrol", powerKw: 70 },
      ]),
      ...variants("Volkswagen", "Transporter", { slug: "7h", name: "Transporter 7H", from: 2003 }, [
        { body: "mpv", fuel: "diesel", powerKw: 110 },
      ]),
      ...variants("Volkswagen", "Multivan", { slug: "st", name: "Multivan ST", from: 2021 }, [
        { body: "mpv", fuel: "diesel", powerKw: 110 },
      ]),
      ...variants("Mercedes-Benz", "ML", { slug: "w166", name: "W166", from: 2011, to: 2015 }, [
        { body: "suv", fuel: "diesel", powerKw: 190 },
      ]),
      ...variants("BMW", "3 Series", { slug: "346", name: "3 Series 346", from: 2000, to: 2006 }, [
        { body: "sedan", fuel: "diesel", powerKw: 110 },
      ]),
    ]);
    const at = (vehicle: VehicleDescriptor) => {
      const r = coded.resolve(vehicle);
      return r.status === "matched" ? r.variantId : r;
    };

    it("reads Škoda generation numerals onto the register's type codes", () => {
      const octavia = { make: "Škoda", fuel: "diesel", firstRegistration: { year: 2017 } } as const;
      expect(at({ ...octavia, model: "Octavia III", trim: "Combi 2.0 TDI 110 kW" })).toBe(
        "skoda/octavia/5e/wagon-diesel-110kw",
      );
      // The catalog has no Octavia II here: the numeral still blocks a match.
      expect(at({ ...octavia, model: "Octavia II", trim: "Combi 2.0 TDI 110 kW" })).toMatchObject({
        status: "model",
      });
      // 5J holds both the Fabia II and III, so either numeral fits it, but not both at once.
      const fabia = { make: "Škoda", trim: "1.0 TSI 70 kW", fuel: "petrol" } as const;
      for (const model of ["Fabia II", "Fabia III"]) {
        expect(at({ ...fabia, model, firstRegistration: { year: 2016 } })).toBe(
          "skoda/fabia/5j/hatchback-petrol-70kw",
        );
      }
      expect(
        at({
          ...fabia,
          model: "Fabia II",
          trim: "III 1.0 TSI 70 kW",
          firstRegistration: { year: 2016 },
        }),
      ).toMatchObject({ status: "model" });
      // A generation catalogued under its own name next to the aggregate type: "IV" names
      // only it, and a year both span stays on the Model without a numeral.
      expect(at({ ...fabia, model: "Fabia IV", firstRegistration: { year: 2022 } })).toBe(
        "skoda/fabia/mk4/hatchback-petrol-70kw",
      );
      expect(at({ ...fabia, model: "Fabia", firstRegistration: { year: 2022 } })).toMatchObject({
        status: "model",
        reason: "ambiguous",
      });
    });

    it("finds vans, classes and series named their own way, keeping generation claims", () => {
      expect(
        at({
          make: "Mercedes-Benz",
          model: "Třídy M",
          trim: "ML 350 CDI",
          fuel: "diesel",
          powerKw: 190,
          firstRegistration: { year: 2013 },
        }),
      ).toBe("mercedes-benz/ml/w166/suv-diesel-190kw");
      expect(
        at({
          make: "VW",
          model: "T6.1 Transporter",
          fuel: "diesel",
          powerKw: 110,
          firstRegistration: { year: 2021 },
        }),
      ).toMatchObject({ status: "model", modelId: "volkswagen/transporter" });
      // "T7" and "E46" name generations the catalog does not: the Model, not a Variant.
      expect(
        at({
          make: "VW",
          model: "T7 Multivan",
          fuel: "diesel",
          powerKw: 110,
          firstRegistration: { year: 2023 },
        }),
      ).toMatchObject({ status: "model", modelId: "volkswagen/multivan" });
      expect(
        at({
          make: "BMW",
          model: "E46",
          trim: "320d",
          fuel: "diesel",
          powerKw: 110,
          firstRegistration: { year: 2003 },
        }),
      ).toMatchObject({ status: "model", modelId: "bmw/3-series" });
    });
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
        { body: "wagon", fuel: "diesel", powerKw: 147, transmissions: ["automatic"] },
      ]),
      ...variants("Mercedes-Benz", "C-Klasse", w206, [
        { body: "sedan", fuel: "diesel", powerKw: 147, transmissions: ["automatic"] },
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
      variantId: "mercedes-benz/c-klasse/w206/sedan-diesel-147kw",
    });
  });
});
