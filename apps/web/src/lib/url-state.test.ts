import { describe, expect, it } from "vitest";
import {
  type CatalogState,
  readCatalogState,
  readListingState,
  writeCatalogState,
  writeListingState,
} from "./url-state.ts";

describe("catalog URL state", () => {
  const full: CatalogState = {
    filters: {
      make: ["skoda", "volkswagen"],
      model: ["skoda/octavia"],
      body: ["wagon"],
      fuel: ["diesel", "petrol"],
      transmission: ["automatic"],
      market: ["CZ", "DE"],
      source: ["sauto"],
      year: { min: 2015, max: 2020 },
      powerKw: { max: 110 },
      seats: { min: 7 },
      consumptionL100km: { max: 5.5 },
      newPriceCzk: { min: 500000 },
      usedPriceCzk: { min: 200000, max: 400000 },
      odometerKm: { max: 150000 },
    },
    sort: { key: "usedPriceCzk", dir: "desc" },
    compare: [
      "skoda/octavia/nx/wagon-diesel-85kw-manual",
      "volkswagen/golf/mk8/hatchback-petrol-81kw-manual",
    ],
  };

  it("survives a round trip through the URL", () => {
    expect(readCatalogState(writeCatalogState(full))).toEqual(full);
  });

  it("writes one short, readable, canonical form", () => {
    expect(writeCatalogState(full)).toBe(
      "?make=skoda,volkswagen&model=skoda/octavia&body=wagon&fuel=diesel,petrol" +
        "&gearbox=automatic&market=CZ,DE&source=sauto&year=2015-2020&power=-110&seats=7-" +
        "&consumption=-5.5&newPrice=500000-&usedPrice=200000-400000&km=-150000" +
        "&sort=-usedPrice" +
        "&cmp=skoda/octavia/nx/wagon-diesel-85kw-manual,volkswagen/golf/mk8/hatchback-petrol-81kw-manual",
    );
  });

  it("gives equal states equal URLs regardless of selection order", () => {
    const a = writeCatalogState({ filters: { fuel: ["petrol", "diesel"], make: ["vw", "skoda"] } });
    const b = writeCatalogState({
      filters: { make: ["skoda", "vw", "skoda"], fuel: ["diesel", "petrol"] },
    });
    expect(a).toBe(b);
  });

  it("keeps the compare list in the order it was built", () => {
    expect(readCatalogState(writeCatalogState({ compare: ["b", "a"] })).compare).toEqual([
      "b",
      "a",
    ]);
  });

  it("writes nothing for an empty state or empty selections", () => {
    expect(writeCatalogState({})).toBe("");
    expect(writeCatalogState({ filters: { fuel: [], year: {} } })).toBe("");
    expect(readCatalogState("")).toEqual({ filters: {} });
  });

  it("tells an explicitly empty compare list from an absent one", () => {
    expect(writeCatalogState({ compare: [] })).toBe("?cmp=");
    expect(readCatalogState("?cmp=").compare).toEqual([]);
    expect(readCatalogState("?fuel=diesel").compare).toBeUndefined();
  });

  it("reads hand-edited and legacy URLs leniently", () => {
    const state = readCatalogState(
      "?fuel=diesel,,steam,diesel&fuel=petrol&body=WAGON&year=2020-2015&power=abc&km=-&sort=-nope" +
        "&cmp=a,b,c,d,e&utm_source=x&bad=%E0%A4%A",
    );
    expect(state).toEqual({
      filters: { fuel: ["diesel"], year: { min: 2015, max: 2020 } },
      compare: ["a", "b", "c", "d"],
    });
  });

  it("ignores sort values that are not own aliases", () => {
    for (const sort of ["constructor", "-toString", "__proto__", "powerKw"]) {
      expect(readCatalogState(`?sort=${sort}`).sort).toBeUndefined();
    }
  });

  it("keeps a comma inside a value apart from the list separator", () => {
    const state = { filters: { source: ["a,b", "c"] } };
    const url = writeCatalogState(state);
    expect(url).toBe("?source=a%2Cb,c");
    expect(readCatalogState(url)).toEqual(state);
  });

  it("decodes percent-encoded values and form-encoded spaces", () => {
    const state = readCatalogState("make=%C5%A1koda&model=skoda%2Foctavia&source=x+y&sort=year");
    expect(state.filters).toEqual({ make: ["škoda"], model: ["skoda/octavia"], source: ["x y"] });
    expect(state.sort).toEqual({ key: "year", dir: "asc" });
    expect(writeCatalogState(state)).toBe(
      "?make=%C5%A1koda&model=skoda/octavia&source=x%20y&sort=year",
    );
  });
});

describe("listing URL state", () => {
  it("survives a round trip, including the gone-listings flag", () => {
    const state = {
      filters: {
        variant: ["skoda/octavia/nx/wagon-diesel-85kw-manual"],
        condition: ["used" as const],
        market: ["DE" as const],
        landedCzk: { max: 450000 },
        odometerKm: { min: 10000, max: 90000 },
        includeGone: true,
      },
      sort: { key: "landedCzk" as const, dir: "asc" as const },
    };
    const url = writeListingState(state);
    expect(url).toBe(
      "?variant=skoda/octavia/nx/wagon-diesel-85kw-manual&condition=used&market=DE" +
        "&landed=-450000&km=10000-90000&gone=1&sort=landed",
    );
    expect(readListingState(url)).toEqual(state);
  });

  it("reads a percent-encoded flag", () => {
    expect(readListingState("?gone=%31").filters).toEqual({ includeGone: true });
  });

  it("drops values outside the vocabulary and catalog-only sort keys", () => {
    expect(readListingState("?condition=new,mint&gone=yes&sort=-power")).toEqual({
      filters: { condition: ["new"] },
    });
  });
});
