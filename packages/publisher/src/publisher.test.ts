import {
  type BundleFiles,
  type ModelFile,
  type ModelIndex,
  memoryLoader,
  openBundle,
  type PriceCell,
} from "@cca/bundle";
import { openCatalog } from "@cca/catalog";
import { type Ledger, openLedger } from "@cca/ledger";
import type {
  ListingSeen,
  ListPrice,
  Market,
  Observation,
  OpenpilotSupport,
} from "@cca/vocabulary";
import { afterEach, describe, expect, it } from "vitest";
import { publish } from "./index.ts";
import { syntheticRuns } from "./synthetic.ts";

const at = (d: string) => new Date(`${d}T12:00:00Z`);

const tiguanEntry: Observation = {
  kind: "CatalogEntry",
  variant: {
    make: "Volkswagen",
    model: "Tiguan",
    generation: { slug: "mk3", name: "Tiguan III", from: 2024 },
    body: "suv",
    fuel: "diesel",
    powerKw: 142,
    transmissions: ["automatic"],
    years: { from: 2024 },
  },
};
const golfEntry: Observation = {
  kind: "CatalogEntry",
  variant: {
    make: "Volkswagen",
    model: "Golf",
    generation: { slug: "mk8", name: "Golf VIII", from: 2020 },
    body: "hatchback",
    fuel: "petrol",
    powerKw: 110,
    transmissions: ["manual"],
    years: { from: 2020 },
  },
};
const tiguanId = "volkswagen/tiguan/mk3/suv-diesel-142kw";
const eurRate: Observation = {
  kind: "FxRate",
  currency: "EUR",
  validFor: "2026-10-01",
  czkPerUnit: 25,
};

function offer(ref: string, amount: number, extra: Partial<ListPrice> = {}): ListPrice {
  return {
    kind: "ListPrice",
    ref,
    vehicle: {
      make: "Volkswagen",
      model: "Tiguan",
      trim: "Elegance 2.0 TDI 142 kW 7DSG",
      body: "suv",
      fuel: "diesel",
      powerKw: 142,
      transmission: "automatic",
      drive: ref.endsWith("4motion") ? "awd" : "fwd",
    },
    price: { amount, currency: "CZK" },
    market: "CZ",
    validFrom: "2026-07-01",
    ...extra,
  };
}

/** A Tiguan Listing; CZ in CZK, DE/AT in EUR. */
function tiguan(ref: string, amount: number, extra: Partial<ListingSeen> = {}): ListingSeen {
  const market = extra.market ?? "CZ";
  return {
    kind: "ListingSeen",
    ref,
    url: `https://example.test/${ref}`,
    market,
    condition: "used",
    vehicle: {
      make: "VW",
      model: "Tiguan",
      fuel: "diesel",
      powerKw: 142,
      transmission: "automatic",
      firstRegistration: { year: 2024, month: 3 },
      euroClass: 6,
    },
    odometerKm: 20_000,
    price: { amount, currency: market === "CZ" ? "CZK" : "EUR" },
    priceBasis: "gross",
    seller: "dealer",
    photos: [],
    ...extra,
  };
}

/** `n` CZ Listings priced start, start + step, ... */
function series(prefix: string, n: number, start: number, step: number, extra = {}) {
  return Array.from({ length: n }, (_, i) => tiguan(`${prefix}${i}`, start + i * step, extra));
}

const opened: Ledger[] = [];
afterEach(() => {
  for (const l of opened.splice(0)) l.close();
});
function newLedger(): Ledger {
  const l = openLedger(":memory:");
  opened.push(l);
  return l;
}
let ledger: Ledger;

async function record(source: string, day: string, observations: Observation[]) {
  await ledger.record({ source, mode: "incremental", startedAt: at(day) }, observations);
}

async function open(day: string) {
  return openBundle(memoryLoader(publish(ledger, { now: at(day) })));
}

async function tiguanFile(day = "2026-10-24") {
  return whole(await (await open(day)).model("volkswagen/tiguan"));
}

/** A model as the reader returns it, with every row loaded and sorted by id: the model file. */
async function whole(index: ModelIndex | null): Promise<ModelFile> {
  if (!index) throw new Error("no model file");
  const { listings, rows, ...rest } = index;
  const all = await rows(listings);
  return { ...rest, listings: all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

async function tiguanRow(day = "2026-10-24") {
  const catalog = await (await open(day)).catalog();
  return catalog.variants.find((v) => v.id === tiguanId);
}

function cell(stats: PriceCell[], match: Partial<PriceCell>): PriceCell | undefined {
  const full = { variantId: tiguanId, market: "CZ", condition: "used", year: null, band: null };
  const want = { ...full, ...match };
  return stats.find((c) =>
    (Object.keys(want) as (keyof typeof want)[]).every((k) => c[k] === want[k]),
  );
}

describe("publish: New prices", () => {
  async function newPriceOn(day: string) {
    return (await tiguanRow(day))?.newPriceCzk;
  }

  it("keeps offers that resolve to one Variant apart, and a later edition updates only its offer", async () => {
    ledger = newLedger();
    await record("vw-cz", "2026-07-01", [
      tiguanEntry,
      offer("tiguan-elegance-20tdi-142", 1_000_000),
      offer("tiguan-elegance-20tdi-142-4motion", 1_100_000),
    ]);
    expect(await newPriceOn("2026-08-01")).toEqual({
      min: 1_000_000,
      max: 1_100_000,
      source: "list",
      count: 2,
    });

    await record("vw-cz", "2026-09-01", [
      offer("tiguan-elegance-20tdi-142", 1_050_000, { validFrom: "2026-09-01" }),
    ]);
    expect(await newPriceOn("2026-08-15")).toMatchObject({ min: 1_000_000, max: 1_100_000 });
    expect(await newPriceOn("2026-09-15")).toMatchObject({ min: 1_050_000, max: 1_100_000 });
  });

  it("applies an edition only within its validity, and a withdrawal ends the offer", async () => {
    ledger = newLedger();
    await record("vw-cz", "2026-06-01", [
      tiguanEntry,
      offer("tiguan-elegance-20tdi-142", 1_000_000, { validTo: "2026-12-31" }),
      offer("tiguan-elegance-20tdi-142", 950_000, { validFrom: "2026-01-01" }),
    ]);
    expect(await newPriceOn("2025-12-31")).toBeUndefined();
    expect(await newPriceOn("2026-06-30")).toMatchObject({ min: 950_000, max: 950_000 });
    expect(await newPriceOn("2026-12-31")).toMatchObject({ min: 1_000_000, max: 1_000_000 });
    // Expired: the older, open-ended edition does not come back.
    expect(await newPriceOn("2027-01-01")).toBeUndefined();

    // Withdrawal: the source re-emits the current edition of the other offer with an end date.
    await record("vw-cz", "2026-07-01", [offer("tiguan-elegance-20tdi-142-4motion", 1_100_000)]);
    await record("vw-cz", "2026-10-01", [
      offer("tiguan-elegance-20tdi-142-4motion", 1_100_000, { validTo: "2026-09-30" }),
    ]);
    expect(await newPriceOn("2026-09-30")).toMatchObject({ min: 1_000_000, max: 1_100_000 });
    expect(await newPriceOn("2026-10-01")).toMatchObject({ min: 1_000_000, max: 1_000_000 });
  });

  it("falls back to Czech dealer Listings of new cars when no list price is current", async () => {
    ledger = newLedger();
    await record("vw-cz", "2026-06-01", [
      tiguanEntry,
      offer("tiguan-elegance-20tdi-142", 1_000_000, { validTo: "2026-09-30" }),
    ]);
    const asNew = { condition: "new", vehicle: { ...tiguan("x", 0).vehicle } } as const;
    await record("sauto", "2026-10-20", [
      tiguan("new-1", 1_150_000, {
        ...asNew,
        sellerExtras: { amount: 10_000, currency: "CZK", basis: "gross" },
      }),
      tiguan("new-2", 1_200_000, asNew),
      // Shown net: a private buyer pays Czech VAT on top.
      tiguan("new-net", 1_000_000, { ...asNew, priceBasis: "net" }),
      // A placeholder price: left out by the outlier rule.
      tiguan("new-placeholder", 1, asNew),
      // None of these sets a Czech new price: a demonstrator, a private seller, a German car.
      tiguan("demo", 900_000, { condition: "demo" }),
      tiguan("private-new", 800_000, { ...asNew, seller: "private" }),
    ]);
    await record("cnb", "2026-10-20", [eurRate]);
    await record("autoscout24-de", "2026-10-20", [
      tiguan("de-new", 30_000, { ...asNew, market: "DE" }),
    ]);

    // List price wins while it is current.
    expect(await newPriceOn("2026-09-30")).toEqual({
      min: 1_000_000,
      max: 1_000_000,
      source: "list",
      count: 1,
    });
    // After it expires: landed price (asking + seller extras, gross) of the dealer Listings.
    expect(await newPriceOn("2026-10-24")).toEqual({
      min: 1_160_000,
      max: 1_210_000,
      source: "dealer",
      count: 3,
    });
  });
});

describe("publish: price statistics", () => {
  it("computes count, p10, median and p90 per Variant, year and odometer band", async () => {
    ledger = newLedger();
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      ...series("a", 10, 500_000, 10_000),
      // A 2025 car under 10,000 km and one at exactly 10,000 km.
      ...series("b", 3, 700_000, 0, {
        odometerKm: 9_999,
        vehicle: { ...tiguan("x", 0).vehicle, firstRegistration: { year: 2025 } },
      }),
      ...series("c", 3, 600_000, 0, { odometerKm: 10_000 }),
    ]);
    const row = await tiguanRow();
    expect(row?.used).toMatchObject({
      count: 16,
      priceCzk: { count: 16, p10: 515_000, median: 575_000, p90: 700_000 },
      odometerKm: { count: 16, p10: 9_999, median: 20_000, p90: 20_000 },
      years: { min: 2024, max: 2025 },
      markets: { CZ: 16 },
      sources: { sauto: 16 },
    });

    const { stats } = await tiguanFile();
    // 500k..590k plus 3 × 600k; the 9,999 km cars are in another band.
    expect(cell(stats, { year: 2024, band: "10-50k" })).toEqual({
      variantId: tiguanId,
      market: "CZ",
      condition: "used",
      year: 2024,
      band: "10-50k",
      count: 13,
      p10: 512_000,
      median: 560_000,
      p90: 600_000,
    });
    expect(cell(stats, { year: null, band: "10-50k" })).toMatchObject({ count: 13 });
    expect(cell(stats, { year: 2025, band: null })).toMatchObject({ count: 3 });
    expect(cell(stats, { year: 2025, band: "0-10k" })).toMatchObject({
      count: 3,
      p10: 700_000,
      median: 700_000,
      p90: 700_000,
    });
    expect(cell(stats, { year: 2025, band: "10-50k" })).toBeUndefined();
    expect(cell(stats, { year: null, band: null })).toMatchObject({ count: 16, median: 575_000 });
    // The whole-model cells repeat the Variant's, since every Listing resolved to it.
    expect(cell(stats, { variantId: null })).toEqual({
      ...cell(stats, {}),
      variantId: null,
    });
    const tenK = stats.filter((c) => c.variantId === tiguanId && c.band === "10-50k");
    expect(tenK.map((c) => c.year)).toEqual([null, 2024]);
  });

  it("keeps Markets apart in cells and per-Market statistics", async () => {
    ledger = newLedger();
    await record("cnb", "2026-10-20", [eurRate]);
    await record("sauto", "2026-10-20", [tiguanEntry, ...series("cz", 3, 600_000, 0)]);
    await record("autoscout24-de", "2026-10-20", [
      tiguan("de1", 20_000, { market: "DE" }),
      tiguan("de2", 20_000, { market: "DE" }),
      tiguan("de3", 24_000, { market: "DE" }),
    ]);
    const used = (await tiguanRow())?.used;
    expect(used?.byMarket).toEqual({
      CZ: { count: 3, p10: 600_000, median: 600_000, p90: 600_000 },
      DE: { count: 3, p10: 500_000, median: 500_000, p90: 580_000 },
    });
    expect(used?.groups.map((g) => [g.market, g.source, g.count])).toEqual([
      ["CZ", "sauto", 3],
      ["DE", "autoscout24-de", 3],
    ]);
    const { stats } = await tiguanFile();
    expect(cell(stats, { market: "CZ" })?.median).toBe(600_000);
    expect(cell(stats, { market: "DE" })?.median).toBe(500_000);
    expect(stats.filter((c) => c.market === "AT")).toEqual([]);
  });

  it("keeps Conditions apart, and Listings without year or odometer only in the 'all' cells", async () => {
    ledger = newLedger();
    await record("cnb", "2026-10-20", [eurRate]);
    const { firstRegistration: _, ...noYear } = tiguan("x", 0).vehicle;
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      ...series("dated", 3, 500_000, 0),
      ...series("undated", 3, 400_000, 0, { vehicle: noYear, odometerKm: undefined }),
      ...series("new", 3, 1_100_000, 0, { condition: "new", odometerKm: 10 }),
      ...series("demo", 3, 950_000, 0, { condition: "demo", odometerKm: 5_000 }),
    ]);
    await record("autoscout24-at", "2026-10-20", [...series("at", 3, 21_000, 0, { market: "AT" })]);
    const { stats } = await tiguanFile();
    const variantCells = (market: string, condition: string) =>
      stats
        .filter((c) => c.variantId === tiguanId && c.market === market && c.condition === condition)
        .map((c) => [c.year, c.band, c.count, c.median]);
    expect(variantCells("CZ", "used")).toEqual([
      [null, null, 6, 450_000],
      [null, "10-50k", 3, 500_000],
      [2024, null, 3, 500_000],
      [2024, "10-50k", 3, 500_000],
    ]);
    expect(variantCells("CZ", "new")).toEqual([
      [null, null, 3, 1_100_000],
      [null, "0-10k", 3, 1_100_000],
      [2024, null, 3, 1_100_000],
      [2024, "0-10k", 3, 1_100_000],
    ]);
    expect(variantCells("CZ", "demo")[0]).toEqual([null, null, 3, 950_000]);
    expect(variantCells("AT", "used")[0]).toEqual([null, null, 3, 525_000]);
    // The catalog row counts used cars only.
    expect((await tiguanRow())?.used?.markets).toEqual({ CZ: 6, AT: 3 });
  });

  it("leaves outliers out of statistics but keeps them findable", async () => {
    ledger = newLedger();
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      ...series("a", 10, 500_000, 10_000),
      tiguan("typo", 5_400_000),
      tiguan("instalment", 5_990),
    ]);
    const used = (await tiguanRow())?.used;
    expect(used?.count).toBe(12);
    expect(used?.priceCzk).toMatchObject({ count: 10, median: 545_000 });
    expect(used?.groups[0]?.priceCzk).toEqual({ min: 5_990, max: 5_400_000 });

    const file = await tiguanFile();
    expect(file.listings.filter((l) => l.excluded).map((l) => l.id)).toEqual([
      "sauto:instalment",
      "sauto:typo",
    ]);
    expect(cell(file.stats, {})?.count).toBe(10);
  });

  it("applies only the floor to small or flat cohorts", async () => {
    ledger = newLedger();
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      // Small: 7 Listings, so no fences; the 10x price stays.
      ...series("small", 6, 500_000, 0),
      tiguan("small-high", 5_000_000),
    ]);
    expect((await tiguanRow())?.used?.priceCzk?.count).toBe(7);

    // Flat: IQR is 0, so no fences either.
    await record("sauto", "2026-10-21", [...series("flat", 4, 500_000, 0), tiguan("x", 4_000)]);
    const used = (await tiguanRow())?.used;
    expect(used?.count).toBe(12);
    expect(used?.priceCzk?.count).toBe(11);
  });

  it("gives no quantiles under 3 values, in the catalog as on the model page", async () => {
    ledger = newLedger();
    const golf = (ref: string, amount: number): ListingSeen =>
      tiguan(ref, amount, {
        vehicle: {
          make: "VW",
          model: "Golf",
          fuel: "petrol",
          powerKw: 110,
          transmission: "manual",
        },
      });
    await record("cnb", "2026-10-20", [eurRate]);
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      golfEntry,
      // A mispriced Listing alone in its cohort: no fences, so the outlier rule keeps it.
      golf("lone", 10_830),
      // Three Czech prices, one odometer reading among them.
      tiguan("cz0", 600_000),
      tiguan("cz1", 620_000, { odometerKm: undefined }),
      tiguan("cz2", 640_000, { odometerKm: undefined }),
    ]);
    await record("autoscout24-de", "2026-10-20", [
      tiguan("de0", 20_000, { market: "DE", odometerKm: undefined }),
      tiguan("de1", 22_000, { market: "DE", odometerKm: undefined }),
    ]);
    const catalog = await openCatalog(memoryLoader(publish(ledger, { now: at("2026-10-24") })));

    // Sorted by used price, the Golf comes last however cheap its one Listing.
    const sorted = catalog.query({ sort: { key: "usedPriceCzk", dir: "asc" } }).rows;
    expect(sorted.map((v) => [v.model, v.used?.count, v.used?.priceCzk?.median])).toEqual([
      ["Tiguan", 5, 600_000],
      ["Golf", 1, undefined],
    ]);
    const [tiguanRow, golfRow] = sorted;
    expect(golfRow?.used).toMatchObject({ priceCzk: null, landedCzk: null, byMarket: {} });
    // The pooled sample has 5 prices and landed prices, but Germany only 2 and odometers 1.
    expect(tiguanRow?.used).toMatchObject({
      priceCzk: { count: 5 },
      landedCzk: { count: 5 },
      odometerKm: null,
    });
    expect(Object.keys(tiguanRow?.used?.byMarket ?? {})).toEqual(["CZ"]);
    // Still findable by its price.
    const cheap = catalog.query({ filters: { usedPriceCzk: { max: 20_000 } } }).rows;
    expect(cheap.map((v) => v.model)).toEqual(["Golf"]);

    const golfView = await catalog.model("volkswagen/golf");
    expect(golfView?.stats).toEqual([]);
    const golfRows = (await golfView?.rows(golfView.listings().rows)) ?? [];
    expect(golfRows.map((l) => [l.id, l.excluded ?? false])).toEqual([["sauto:lone", false]]);
    const tiguanStats = (await catalog.model("volkswagen/tiguan"))?.stats ?? [];
    expect(new Set(tiguanStats.map((c) => c.market))).toEqual(new Set(["CZ"]));
  });
});

describe("publish: model files", () => {
  it("shards Listings per model and compacts gone Listings and photos", async () => {
    ledger = newLedger();
    const photos = ["1", "2", "3", "4", "5"].map((p) => `https://img.example.test/${p}.jpg`);
    await record("sauto", "2026-08-01", [
      tiguanEntry,
      golfEntry,
      tiguan("old", 600_000),
      tiguan("recent", 600_000),
      tiguan("active", 600_000, { photos }),
      // Model only: no Tiguan with 300 kW.
      tiguan("model-only", 900_000, { vehicle: { ...tiguan("x", 0).vehicle, powerKw: 300 } }),
      // Unknown make: in no model file.
      tiguan("unknown", 100_000, { vehicle: { make: "Lada", model: "Niva" } }),
      tiguan("golf", 400_000, {
        vehicle: {
          make: "VW",
          model: "Golf",
          fuel: "petrol",
          powerKw: 110,
          transmission: "manual",
        },
      }),
    ]);
    await record("sauto", "2026-08-10", [{ kind: "ListingGone", ref: "old" }]);
    await record("sauto", "2026-10-10", [{ kind: "ListingGone", ref: "recent" }]);

    const files = new Map(publish(ledger, { now: at("2026-10-24") }));
    expect([...files.keys()].sort()).toEqual([
      "catalog.json",
      "manifest.json",
      "models/volkswagen/golf/0.json",
      "models/volkswagen/golf/index.json",
      "models/volkswagen/tiguan/0.json",
      "models/volkswagen/tiguan/index.json",
    ]);
    const bundle = await openBundle(memoryLoader(files));
    const tiguanListings = (await whole(await bundle.model("volkswagen/tiguan"))).listings;
    expect(tiguanListings.map((l) => [l.id, l.variantId, l.gone ?? null])).toEqual([
      ["sauto:active", tiguanId, null],
      ["sauto:model-only", null, null],
      ["sauto:recent", tiguanId, "2026-10-10"],
    ]);
    expect(tiguanListings[0]?.photos).toEqual(photos.slice(0, 1));
    expect((await whole(await bundle.model("volkswagen/golf"))).listings.map((l) => l.id)).toEqual([
      "sauto:golf",
    ]);
    expect(bundle.manifest.counts).toMatchObject({ models: 2, listings: 4 });
    const catalog = await bundle.catalog();
    expect(catalog.models.map((m) => [m.id, m.listingCount])).toEqual([
      ["volkswagen/golf", 1],
      ["volkswagen/tiguan", 2],
    ]);
  });

  it("holds one model's Listings at a time, so memory follows the largest model", async () => {
    ledger = newLedger();
    await record("sauto", "2026-10-20", [
      tiguanEntry,
      golfEntry,
      ...["g1", "g2"].map((ref) =>
        tiguan(ref, 400_000, {
          vehicle: { make: "VW", model: "Golf", fuel: "petrol", powerKw: 110 },
        }),
      ),
      ...["t1", "t2", "t3"].map((ref) => tiguan(ref, 600_000)),
    ]);
    // Count the Listings the Publisher reads back per model (by id) from the snapshot.
    let readBack = 0;
    const counted: Ledger = {
      ...ledger,
      snapshot() {
        const snapshot = ledger.snapshot();
        return {
          ...snapshot,
          *listings(ids) {
            for (const listing of snapshot.listings(ids)) {
              if (ids) readBack++;
              yield listing;
            }
          },
        };
      },
    };
    const files = publish(counted, { now: at("2026-10-24") });
    expect(files.next().value?.[0]).toBe("models/volkswagen/golf/index.json");
    expect(readBack).toBe(2);
    expect(files.next().value?.[0]).toBe("models/volkswagen/golf/0.json");
    expect(files.next().value?.[0]).toBe("models/volkswagen/tiguan/index.json");
    expect(readBack).toBe(5);
    expect(files.next().value?.[0]).toBe("models/volkswagen/tiguan/0.json");
    expect([...files].map(([path]) => path)).toEqual(["catalog.json", "manifest.json"]);
  });

  it("gives every model an id that opens its model file, whatever the names", async () => {
    ledger = newLedger();
    const named = (make: string, model: string, slug = "mk1"): Observation =>
      ({
        ...golfEntry,
        variant: {
          ...golfEntry.variant,
          make,
          model,
          generation: { slug, name: model, from: 2020 },
        },
      }) as Observation;
    await record("rsv", "2026-10-01", [
      // The register names some models "."; they have no id and stay out.
      named("Lada - Vaz", "."),
      named("Lada - Vaz", "Niva (4x4)", "2121"),
      named("Lada - Vaz", "Lada 112", "."),
      named("Citroën", "ë-C4"),
      named("Volkswagen", "ID.3"),
    ]);
    const catalog = await openCatalog(memoryLoader(publish(ledger, { now: at("2026-10-24") })));
    const ids = catalog.query({ limit: 100 }).facets.values.model.map((m) => m.value);
    expect(ids.sort()).toEqual(["citroen/e-c4", "lada-vaz/niva-4x4", "volkswagen/id-3"]);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((await catalog.model(id))?.model.id).toBe(id);
    }
  });

  it("keeps a weekly median per Market, including Listings long gone", async () => {
    ledger = newLedger();
    await record("cnb", "2026-08-01", [eurRate]);
    await record("sauto", "2026-08-03", [tiguanEntry, tiguan("long-gone", 700_000)]);
    await record("sauto", "2026-08-10", [{ kind: "ListingGone", ref: "long-gone" }]);
    await record("sauto", "2026-10-05", [tiguan("a", 500_000), tiguan("b", 600_000)]);
    await record("sauto", "2026-10-14", [tiguan("a", 480_000)]);
    await record("sauto", "2026-10-19", [{ kind: "ListingGone", ref: "b" }]);
    await record("autoscout24-de", "2026-10-12", [tiguan("de", 20_000, { market: "DE" })]);

    const { history } = await tiguanFile("2026-10-24");
    const points = (market: Market) =>
      history.find((h) => h.market === market)?.points.map((p) => [p.date, p.count, p.medianCzk]);
    expect(history.map((h) => h.market)).toEqual(["CZ", "DE"]);
    expect(points("CZ")).toEqual([
      ["2026-08-03", 1, 700_000],
      ["2026-10-05", 2, 550_000],
      ["2026-10-12", 2, 550_000],
      ["2026-10-19", 1, 480_000],
      ["2026-10-24", 1, 480_000],
    ]);
    expect(points("DE")).toEqual([
      ["2026-10-12", 1, 500_000],
      ["2026-10-19", 1, 500_000],
      ["2026-10-24", 1, 500_000],
    ]);
  });
});

// Each test builds synthetic Ledgers: well under a second normally, slow on a loaded runner.
describe("publish: determinism and scale", { timeout: 60_000 }, () => {
  async function synthetic(listings: number, shuffle: boolean): Promise<BundleFiles> {
    const l = newLedger();
    for (const { run, observations } of syntheticRuns({
      listings,
      variants: 400,
      days: 60,
      end: "2026-10-24",
    })) {
      await l.record(run, shuffle ? [...observations].reverse() : observations);
    }
    return new Map(publish(l, { now: at("2026-10-24") }));
  }

  it("publishes byte-identical files for the same Ledger state, whatever the recording order", async () => {
    const a = await synthetic(1_500, false);
    const b = await synthetic(1_500, true);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [path, text] of a) expect(b.get(path), path).toBe(text);
  });

  it("gives each Variant its best openpilot level with that level's years, and the model all rows", async () => {
    ledger = newLedger();
    const row = (model: string, years: number[], level: OpenpilotSupport["level"]) =>
      ({
        kind: "OpenpilotSupport",
        ref: `${model} ${years.join(",")}`,
        make: "Volkswagen",
        model,
        years,
        level,
        market: "US",
        url: "https://comma.ai/vehicles#volkswagen",
      }) satisfies OpenpilotSupport;
    await record("rsv", "2026-10-01", [golfEntry, tiguanEntry]);
    await record("comma-openpilot", "2026-10-02", [
      row("Golf", [2023], "dashcam"),
      row("Golf GTI", [2021, 2022], "community"),
      row("Golf", [2024], "upstream"),
      row("Golf", [2021, 2022], "upstream"),
      row("Tiguan", [2024, 2025], "community"),
    ]);
    const bundle = await open("2026-10-24");
    const levels = Object.fromEntries(
      (await bundle.catalog()).variants.map((v) => [v.id, v.openpilot]),
    );
    // Upstream wins; its years unite; the dashcam year is another level's and stays out.
    expect(levels).toEqual({
      "volkswagen/golf/mk8/hatchback-petrol-110kw": {
        level: "upstream",
        years: [2021, 2022, 2024],
      },
      [tiguanId]: { level: "community", years: [2024, 2025] },
    });
    const golf = await bundle.model("volkswagen/golf");
    expect(golf?.openpilot?.map((r) => [r.model, r.years, r.level])).toEqual([
      ["Golf", [2021, 2022], "upstream"],
      ["Golf", [2024], "upstream"],
      ["Golf GTI", [2021, 2022], "community"],
      ["Golf", [2023], "dashcam"],
    ]);
  });

  it("produces a Bundle the catalog query engine reads back consistently", async () => {
    const files = await synthetic(3_000, false);
    const catalog = await openCatalog(memoryLoader(files));
    const bundle = await openBundle(memoryLoader(files));
    const index = await bundle.catalog();
    expect([...files.keys()].filter((p) => p.endsWith("/index.json"))).toHaveLength(
      index.models.length,
    );
    expect(index.variants).toHaveLength(400);

    let listings = 0;
    for (const { id } of index.models) {
      const model = await catalog.model(id);
      if (!model) throw new Error(`missing model file ${id}`);
      listings += model.listings({ filters: { includeGone: true } }).total;
      for (const c of model.stats) {
        expect(c.count).toBeGreaterThanOrEqual(3);
        expect(c.p10 <= c.median && c.median <= c.p90).toBe(true);
      }
      const activeUsed = model.listings({ filters: { condition: ["used"] } }).total;
      expect(index.models.find((m) => m.id === id)?.listingCount).toBe(activeUsed);
    }
    expect(listings).toBe(bundle.manifest.counts.listings);
    expect(catalog.query({ filters: { market: ["DE"] } }).total).toBeGreaterThan(0);
  });
});
