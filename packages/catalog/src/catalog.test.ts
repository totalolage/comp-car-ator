import {
  type BundleContent,
  encodeBundle,
  type ListingRow,
  memoryLoader,
  type UsedStats,
  type VariantRow,
} from "@cca/bundle";
import type { Market } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { openCatalog } from "./index.ts";

/** Listing aggregates with one (market, source) group per entry, all at one price. */
function used(median: number, groups: [Market, string, number][]): UsedStats {
  const count = groups.reduce((n, [, , c]) => n + c, 0);
  const q = { count, p10: median, median, p90: median };
  return {
    count,
    priceCzk: q,
    landedCzk: q,
    odometerKm: null,
    byMarket: {},
    years: null,
    markets: Object.fromEntries(groups.map(([m, , c]) => [m, c])),
    sources: Object.fromEntries(groups.map(([, src, c]) => [src, c])),
    groups: groups.map(([market, source, c]) => ({
      market,
      source,
      count: c,
      priceCzk: { min: median, max: median },
      odometerKm: null,
      years: null,
    })),
  };
}

function variant(id: string, fields: Partial<VariantRow>): VariantRow {
  const [makeId, model] = id.split("/") as [string, string];
  return {
    id,
    makeId,
    modelId: `${makeId}/${model}`,
    generationId: `${makeId}/${model}/g`,
    make: makeId,
    model,
    generation: "G",
    years: { from: 2020 },
    body: "hatchback",
    fuel: "petrol",
    powerKw: 100,
    transmissions: ["manual"],
    used: null,
    ...fields,
  };
}

function listing(id: string, fields: Partial<ListingRow>): ListingRow {
  return {
    id,
    source: "sauto",
    url: `https://example.test/${id}`,
    market: "CZ",
    condition: "used",
    variantId: null,
    title: id,
    price: { amount: 1, currency: "CZK" },
    priceCzk: 1,
    landed: null,
    seller: "dealer",
    photos: [],
    firstSeen: "2026-10-01",
    lastSeen: "2026-10-24",
    daysOnMarket: 23,
    priceHistory: [],
    ...fields,
  };
}

const variants = [
  variant("skoda/octavia/a", {
    body: "wagon",
    fuel: "diesel",
    powerKw: 110,
    used: used(450_000, [
      ["CZ", "sauto", 3],
      ["DE", "autoscout24-de", 1],
    ]),
  }),
  variant("skoda/octavia/b", {
    body: "wagon",
    fuel: "petrol",
    powerKw: 110,
    used: used(520_000, [["CZ", "sauto", 2]]),
  }),
  variant("skoda/fabia/c", {
    fuel: "petrol",
    powerKw: 70,
    years: { from: 2021 },
    used: used(320_000, [["CZ", "sauto", 1]]),
  }),
  variant("volkswagen/golf/d", {
    fuel: "diesel",
    powerKw: 85,
    years: { from: 2012, to: 2019 },
    used: null,
  }),
];

const content: BundleContent = {
  manifest: {
    format: 2,
    generatedAt: "2026-10-24T16:00:00.000Z",
    fx: {},
    sources: [],
    counts: { makes: 2, models: 3, variants: variants.length, listings: 3 },
  },
  catalog: { makes: [], models: [], variants },
  models: [
    {
      model: { id: "skoda/octavia", makeId: "skoda", make: "Škoda", name: "Octavia" },
      generations: [],
      variantIds: ["skoda/octavia/a", "skoda/octavia/b"],
      listings: [
        listing("sauto:1", { variantId: "skoda/octavia/a", odometerKm: 90_000, priceCzk: 450_000 }),
        listing("as24:2", {
          variantId: "skoda/octavia/a",
          market: "DE",
          odometerKm: 140_000,
          priceCzk: 400_000,
        }),
        listing("sauto:3", {
          variantId: "skoda/octavia/b",
          odometerKm: 30_000,
          priceCzk: 520_000,
          gone: "2026-10-20",
        }),
      ],
      stats: [],
      history: [],
    },
  ],
};

async function open() {
  return openCatalog(memoryLoader(encodeBundle(content)));
}

describe("catalog query engine", () => {
  it("returns every Variant with facet counts when unfiltered", async () => {
    const result = (await open()).query();
    expect(result.total).toBe(4);
    expect(result.facets.values.fuel).toEqual([
      { value: "diesel", count: 2 },
      { value: "petrol", count: 2 },
    ]);
    expect(result.facets.values.make).toEqual([
      { value: "skoda", count: 3 },
      { value: "volkswagen", count: 1 },
    ]);
  });

  it("ANDs facets and ORs values within a facet", async () => {
    const catalog = await open();
    const result = catalog.query({
      filters: { make: ["skoda"], fuel: ["diesel", "petrol"], body: ["wagon"] },
    });
    expect(result.rows.map((r) => r.id)).toEqual(["skoda/octavia/a", "skoda/octavia/b"]);
  });

  it("counts a facet without its own filter (disjunctive) but with the others", async () => {
    const result = (await open()).query({ filters: { fuel: ["diesel"], make: ["skoda"] } });
    expect(result.rows.map((r) => r.id)).toEqual(["skoda/octavia/a"]);
    // Fuel counts ignore the fuel filter but apply make=skoda.
    expect(result.facets.values.fuel).toEqual([
      { value: "petrol", count: 2 },
      { value: "diesel", count: 1 },
    ]);
    // Make counts ignore the make filter but apply fuel=diesel.
    expect(result.facets.values.make).toEqual([
      { value: "skoda", count: 1 },
      { value: "volkswagen", count: 1 },
    ]);
  });

  it("filters on listing-derived facets through Variant aggregates", async () => {
    const catalog = await open();
    expect(catalog.query({ filters: { market: ["DE"] } }).rows.map((r) => r.id)).toEqual([
      "skoda/octavia/a",
    ]);
    expect(
      catalog.query({ filters: { usedPriceCzk: { max: 460_000 } } }).rows.map((r) => r.id),
    ).toEqual(["skoda/octavia/a", "skoda/fabia/c"]);
  });

  it("requires listing-derived filters to hold for the same market/source group", async () => {
    const catalog = await open();
    // octavia/a has CZ listings on Sauto and DE listings on AutoScout24, none on Sauto in DE.
    expect(catalog.query({ filters: { market: ["DE"], source: ["sauto"] } }).total).toBe(0);
    const de = catalog.query({ filters: { market: ["DE"], source: ["autoscout24-de"] } });
    expect(de.rows.map((r) => r.id)).toEqual(["skoda/octavia/a"]);
    // A Variant with two groups still counts once.
    expect(catalog.query().facets.values.make).toContainEqual({ value: "skoda", count: 3 });
    expect(catalog.query().total).toBe(4);
  });

  it("filters ranges by overlap and reports bounds from the other filters", async () => {
    const result = (await open()).query({ filters: { year: { max: 2019 } } });
    expect(result.rows.map((r) => r.id)).toEqual(["volkswagen/golf/d"]);
    expect(result.facets.ranges.year).toEqual({ min: 2012, max: 2026 });
    expect(result.facets.ranges.powerKw).toEqual({ min: 85, max: 85 });
  });

  it("sorts with unknown values last, and pages", async () => {
    const catalog = await open();
    const asc = catalog.query({ sort: { key: "usedPriceCzk", dir: "asc" } });
    expect(asc.rows.map((r) => r.id)).toEqual([
      "skoda/fabia/c",
      "skoda/octavia/a",
      "skoda/octavia/b",
      "volkswagen/golf/d",
    ]);
    const page = catalog.query({ sort: { key: "usedPriceCzk", dir: "desc" }, offset: 1, limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(["skoda/octavia/a", "skoda/fabia/c"]);
    expect(page.total).toBe(4);
  });

  it("opens a model with its Variants and queryable listings", async () => {
    const view = await (await open()).model("skoda/octavia");
    expect(view?.variants.map((v) => v.id)).toEqual(["skoda/octavia/a", "skoda/octavia/b"]);
    expect(view?.listings().rows.map((l) => l.id)).toEqual(["sauto:1", "as24:2"]);
    expect(view?.listings({ filters: { includeGone: true } }).total).toBe(3);
    const filtered = view?.listings({
      filters: { odometerKm: { max: 100_000 }, market: ["CZ", "DE"] },
    });
    expect(filtered?.rows.map((l) => l.id)).toEqual(["sauto:1"]);
    expect(filtered?.facets.values.market).toEqual([{ value: "CZ", count: 1 }]);
  });

  it("returns null for an unknown model", async () => {
    expect(await (await open()).model("lada/niva")).toBeNull();
  });
});
