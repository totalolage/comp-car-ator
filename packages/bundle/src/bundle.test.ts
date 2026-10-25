import { describe, expect, it } from "vitest";
import {
  type BundleContent,
  BundleFormatError,
  encodeBundle,
  type ListingRow,
  type Loader,
  type ModelFile,
  memoryLoader,
  odometerBand,
  openBundle,
  type VariantRow,
} from "./index.ts";

const model: ModelFile = {
  model: { id: "skoda/octavia", makeId: "skoda", make: "Škoda", name: "Octavia" },
  generations: [{ id: "skoda/octavia/mk4", name: "Octavia IV", from: 2020 }],
  variantIds: [],
  listings: [],
  stats: [],
  history: [],
};

const content: BundleContent = {
  manifest: {
    format: 2,
    generatedAt: "2026-10-24T16:00:00.000Z",
    fx: { EUR: { czkPerUnit: 24.335, validFor: "2026-10-23" } },
    sources: [{ id: "cnb", lastRunAt: "2026-10-24T16:00:00.000Z" }],
    counts: { makes: 1, models: 1, variants: 0, listings: 0 },
  },
  catalog: {
    makes: [{ id: "skoda", name: "Škoda" }],
    models: [{ id: "skoda/octavia", makeId: "skoda", name: "Octavia", listingCount: 0 }],
    variants: [],
  },
  models: [model],
};

describe("Bundle", () => {
  it("reads back exactly what was written", async () => {
    const reader = await openBundle(memoryLoader(encodeBundle(content)));
    expect(reader.manifest).toEqual(content.manifest);
    expect(await reader.catalog()).toEqual(content.catalog);
    expect(await reader.model("skoda/octavia")).toEqual(model);
  });

  it("returns null for an unknown model", async () => {
    const reader = await openBundle(memoryLoader(encodeBundle(content)));
    expect(await reader.model("skoda/kodiaq")).toBeNull();
  });

  it("loads each file once", async () => {
    const files = encodeBundle(content);
    const loads: string[] = [];
    const loader: Loader = async (path) => {
      loads.push(path);
      return files.get(path) ?? null;
    };
    const reader = await openBundle(loader);
    await Promise.all([
      reader.catalog(),
      reader.catalog(),
      reader.model("skoda/octavia"),
      reader.model("skoda/octavia"),
    ]);
    expect(loads.sort()).toEqual(["catalog.json", "manifest.json", "models/skoda/octavia.json"]);
  });

  it("refuses a Bundle in another format version", async () => {
    const files = encodeBundle(content);
    files.set("manifest.json", JSON.stringify({ ...content.manifest, format: 1 }));
    await expect(openBundle(memoryLoader(files))).rejects.toBeInstanceOf(BundleFormatError);
  });

  it("refuses a directory without a manifest", async () => {
    await expect(openBundle(memoryLoader(new Map()))).rejects.toBeInstanceOf(BundleFormatError);
  });

  it("puts an odometer reading in the band whose lower bound it reaches", () => {
    expect([0, 9_999, 10_000, 49_999, 50_000, 199_999, 200_000, 450_000].map(odometerBand)).toEqual(
      ["0-10k", "0-10k", "10-50k", "10-50k", "50-100k", "150-200k", "200k+", "200k+"],
    );
  });

  it("stores Variants, Listings and price cells column-wise and reads them back unchanged", async () => {
    const variant = (i: number): VariantRow => ({
      id: `skoda/octavia/mk4/wagon-diesel-${85 + i}kw-automatic`,
      makeId: "skoda",
      modelId: "skoda/octavia",
      generationId: "skoda/octavia/mk4",
      make: "Škoda",
      model: "Octavia",
      generation: "Octavia IV",
      years: i % 2 ? { from: 2020 } : { from: 2020, to: 2024 },
      body: "wagon",
      fuel: "diesel",
      powerKw: 85 + i,
      transmission: "automatic",
      ...(i % 3 ? { seats: 5, consumptionL100km: 4.6 } : {}),
      ...(i % 4 === 0
        ? { newPriceCzk: { min: 800_000, max: 900_000, source: "list", count: 2 } }
        : {}),
      used:
        i % 5 === 0
          ? null
          : {
              count: i,
              priceCzk:
                i % 7 ? { count: i, p10: 400_000, median: 450_000 + i, p90: 500_000 } : null,
              landedCzk: null,
              odometerKm: { count: i, p10: 10_000, median: 50_000, p90: 90_000 },
              byMarket: i % 2 ? { CZ: { count: i, p10: 1, median: 2, p90: 3 } } : {},
              years: null,
              markets: { CZ: i },
              sources: { sauto: i },
              groups: [
                {
                  market: "CZ",
                  source: "sauto",
                  count: i,
                  priceCzk: { min: 1, max: 2 },
                  odometerKm: null,
                  years: { min: 2020, max: 2021 },
                },
              ],
            },
    });
    const variants = Array.from({ length: 200 }, (_, i) => variant(i));
    const listing = (i: number): ListingRow => ({
      id: `sauto:${i}`,
      source: "sauto",
      url: `https://www.sauto.cz/${i}`,
      market: "CZ",
      condition: "used",
      variantId: i % 2 ? (variants[0] as VariantRow).id : null,
      title: "Škoda Octavia",
      ...(i % 3 ? { year: 2021, odometerKm: 1_000 * i } : {}),
      price: { amount: 400_000 + i, currency: "CZK" },
      priceCzk: 400_000 + i,
      landed:
        i % 2 ? null : { totalCzk: 1, lines: [{ code: "price", czk: 1 }], flags: [], fxDate: null },
      seller: "dealer",
      photos: i % 4 ? [] : ["https://img.example/1.jpg"],
      firstSeen: "2026-10-01",
      lastSeen: "2026-10-24",
      ...(i === 3 ? { gone: "2026-10-20", excluded: true as const } : {}),
      daysOnMarket: 23,
      priceHistory: [
        {
          date: "2026-10-01",
          price: { amount: 400_000 + i, currency: "CZK" },
          priceCzk: 400_000 + i,
        },
      ],
    });
    const rich: ModelFile = {
      ...model,
      variantIds: variants.map((v) => v.id),
      listings: Array.from({ length: 50 }, (_, i) => listing(i)),
      stats: [
        {
          variantId: null,
          market: "CZ",
          condition: "used",
          year: null,
          band: null,
          count: 3,
          p10: 1,
          median: 2,
          p90: 3,
        },
        {
          variantId: variants[0]?.id ?? null,
          market: "DE",
          condition: "new",
          year: 2024,
          band: "0-10k",
          count: 4,
          p10: 1,
          median: 2,
          p90: 3,
        },
      ],
    };
    const files = encodeBundle({
      ...content,
      catalog: { ...content.catalog, variants },
      models: [rich],
    });
    const reader = await openBundle(memoryLoader(files));
    expect((await reader.catalog()).variants).toStrictEqual(variants);
    expect(await reader.model("skoda/octavia")).toEqual(rich);
    // Repeated values are stored once per column, not once per row.
    expect(files.get("catalog.json")?.length).toBeLessThan(JSON.stringify(variants).length / 3);
  });

  it("keeps absent fields, nulls, empty and mixed values apart", async () => {
    const odd = [
      { a: 1, b: null, c: [], d: { e: null }, f: "x", g: true },
      { b: 2, c: null, d: null, f: null, g: "mixed" },
      { a: null, c: [[1], []], d: {}, f: "x" },
      {},
    ];
    const files = encodeBundle({
      ...content,
      models: [{ ...model, listings: odd as unknown as ListingRow[] }],
    });
    const reader = await openBundle(memoryLoader(files));
    expect((await reader.model("skoda/octavia"))?.listings).toStrictEqual(odd);
  });
});
