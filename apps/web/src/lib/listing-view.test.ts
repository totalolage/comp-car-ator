import { fileURLToPath } from "node:url";
import {
  type BundleContent,
  encodeBundle,
  type ListingRow,
  memoryLoader,
  odometerBand,
  type VariantRow,
} from "@cca/bundle";
import { fsLoader } from "@cca/bundle/node";
import { type ModelView, openCatalog } from "@cca/catalog";
import type { Condition, Market } from "@cca/vocabulary";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../i18n/i18n.ts";
import {
  historySeries,
  landedBreakdown,
  listingBands,
  listingFacetOptions,
  listingPage,
  listingQuery,
  nextListingSort,
  priceChange,
  priceStats,
  toggleListingValue,
  variantMedians,
  variantNames,
  withRange,
} from "./listing-view.ts";
import { type ListingState, readListingState, writeListingState } from "./url-state.ts";

const cs = i18n("cs");
const en = i18n("en");
const SAMPLE = fileURLToPath(new URL("../../../../fixtures/sample-bundle", import.meta.url));

async function sampleModel(id: string): Promise<ModelView> {
  const view = await (await openCatalog(fsLoader(SAMPLE))).model(id);
  if (!view) throw new Error(`no model ${id}`);
  return view;
}

// A synthetic model: two Variants, 120 Listings over three Markets and three Conditions,
// odometer readings on the band edges, a few gone and a few excluded Listings.
function syntheticBundle(): BundleContent {
  let seed = 7;
  const next = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const variant = (id: string, powerKw: number): VariantRow => ({
    id,
    makeId: "mk",
    modelId: "mk/m",
    generationId: "mk/m/g1",
    make: "Make",
    model: "M",
    generation: "G1",
    years: { from: 2015 },
    body: "wagon",
    fuel: "diesel",
    powerKw,
    transmissions: ["manual"],
    used: null,
  });
  const variants = [variant("mk/m/a", 85), variant("mk/m/b", 110)];
  const markets: Market[] = ["CZ", "CZ", "CZ", "DE", "AT"];
  const conditions: Condition[] = ["used", "used", "used", "used", "demo", "new"];
  const edges = [9_999, 10_000, 49_999, 50_000, 99_999, 100_000, 150_000, 199_999, 200_000];
  const listings: ListingRow[] = Array.from({ length: 120 }, (_, i) => {
    const market = markets[i % markets.length] as Market;
    const priceCzk = 200_000 + Math.floor(next() * 400_000);
    const odometerKm =
      i % 4 === 0 ? (edges[i % edges.length] as number) : Math.floor(next() * 260_000);
    return {
      id: `src:${String(i).padStart(3, "0")}`,
      source: i % 3 ? "sauto" : "tipcars",
      url: `https://example.test/${i}`,
      market,
      condition: conditions[i % conditions.length] as Condition,
      variantId: i % 7 === 0 ? null : (variants[i % 2] as VariantRow).id,
      title: `Make M ${i}`,
      year: 2016 + (i % 6),
      ...(i % 11 === 0 ? {} : { odometerKm }),
      transmission: "manual",
      price: { amount: priceCzk, currency: "CZK" },
      priceCzk,
      landed:
        i % 13 === 0
          ? null
          : {
              totalCzk: priceCzk + (market === "CZ" ? 0 : 17_000),
              lines: [],
              flags: [],
              fxDate: null,
            },
      seller: "dealer",
      photos: [],
      firstSeen: "2026-09-01",
      lastSeen: "2026-10-24",
      ...(i % 10 === 9 ? { gone: "2026-10-20" } : {}),
      daysOnMarket: i % 50,
      ...(i % 17 === 5 ? { excluded: true as const } : {}),
      priceHistory: [
        { date: "2026-09-01", price: { amount: priceCzk, currency: "CZK" }, priceCzk },
      ],
    };
  });
  return {
    manifest: {
      format: 2,
      generatedAt: "2026-10-24T16:00:00.000Z",
      fx: {},
      sources: [],
      counts: { makes: 1, models: 1, variants: 2, listings: listings.length },
    },
    catalog: {
      makes: [{ id: "mk", name: "Make" }],
      models: [{ id: "mk/m", makeId: "mk", name: "M", listingCount: listings.length }],
      variants,
    },
    models: [
      {
        model: { id: "mk/m", makeId: "mk", make: "Make", name: "M" },
        generations: [{ id: "mk/m/g1", name: "G1", from: 2015 }],
        variantIds: variants.map((v) => v.id),
        listings,
        stats: [],
        history: [
          {
            market: "CZ",
            points: [
              { date: "2026-10-05", count: 30, medianCzk: 400_000 },
              { date: "2026-10-12", count: 31, medianCzk: 395_000 },
            ],
          },
          { market: "DE", points: [] },
          { market: "AT", points: [{ date: "2026-10-12", count: 4, medianCzk: 420_000 }] },
        ],
      },
    ],
  };
}

let synthetic: ModelView;
beforeAll(async () => {
  const content = syntheticBundle();
  const view = await (await openCatalog(memoryLoader(encodeBundle(content)))).model("mk/m");
  if (!view) throw new Error("no synthetic model");
  synthetic = view;
});

const active = (view: ModelView, state: ListingState = { filters: {} }) =>
  view.listings({ filters: state.filters, limit: Number.MAX_SAFE_INTEGER }).rows;

describe("listing query", () => {
  it("sorts by landed CZK by default, imports and Czech listings together, unknown last", async () => {
    const view = await sampleModel("skoda/octavia");
    const rows = view.listings(listingQuery({ filters: {} })).rows;
    const landed = rows.map((l) => l.landed?.totalCzk ?? Number.POSITIVE_INFINITY);
    expect(landed).toEqual([...landed].sort((a, b) => a - b));
    expect(new Set(rows.map((l) => l.market))).toEqual(new Set(["CZ", "DE", "AT"]));
    const de = rows.find((l) => l.market === "DE");
    // An import's landed price adds transport, inspection and registration to the price.
    expect(de?.landed?.totalCzk).toBeGreaterThan(de?.priceCzk ?? 0);
  });

  it("puts listings the outlier rule excluded after all others, whatever the sort", async () => {
    const view = await sampleModel("skoda/octavia");
    for (const dir of ["asc", "desc"] as const) {
      const page = listingPage(view, { filters: {}, sort: { key: "priceCzk", dir } });
      expect(page.rows.at(-1)?.excluded).toBe(true);
      expect(page.rows.slice(0, -1).every((l) => !l.excluded)).toBe(true);
      expect(page.total).toBe(13);
    }
    expect(listingPage(view, { filters: {} }, 3).rows).toHaveLength(3);
  });

  it("sorts by landed price both ways and picks each column's natural order", () => {
    const desc = synthetic.listings({
      ...listingQuery({ filters: {}, sort: { key: "landedCzk", dir: "desc" } }),
      limit: 500,
    }).rows;
    const known = desc.filter((l) => l.landed).map((l) => l.landed?.totalCzk as number);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(desc.at(-1)?.landed).toBeNull();
    expect(nextListingSort({ key: "landedCzk", dir: "asc" }, "landedCzk")).toEqual({
      key: "landedCzk",
      dir: "desc",
    });
    expect(nextListingSort({ key: "landedCzk", dir: "asc" }, "year")).toEqual({
      key: "year",
      dir: "desc",
    });
    expect(nextListingSort({ key: "year", dir: "desc" }, "odometerKm")).toEqual({
      key: "odometerKm",
      dir: "asc",
    });
  });

  it("hides gone listings unless asked, and filters by year, odometer and price together", () => {
    const all = active(synthetic);
    expect(all.some((l) => l.gone)).toBe(false);
    expect(active(synthetic, { filters: { includeGone: true } }).length).toBe(120);
    const state: ListingState = {
      filters: {
        year: { min: 2018, max: 2019 },
        odometerKm: { max: 99_999 },
        priceCzk: { min: 300_000 },
      },
    };
    const rows = active(synthetic, state);
    expect(rows.length).toBeGreaterThan(0);
    for (const l of rows) {
      expect(l.year).toBeGreaterThanOrEqual(2018);
      expect(l.year).toBeLessThanOrEqual(2019);
      expect(l.odometerKm).toBeLessThanOrEqual(99_999);
      expect(l.priceCzk).toBeGreaterThanOrEqual(300_000);
    }
  });

  it("odometer quick picks select exactly one published band each", () => {
    const withKm = active(synthetic).filter((l) => l.odometerKm !== undefined);
    for (const pick of listingBands()) {
      const rows = active(synthetic, { filters: { odometerKm: pick.range } });
      const expected = withKm.filter((l) => odometerBand(l.odometerKm as number) === pick.band);
      expect(rows.map((l) => l.id).sort()).toEqual(expected.map((l) => l.id).sort());
    }
  });
});

describe("price statistics", () => {
  it("reads the published cell for the unfiltered model, per Market and Condition", async () => {
    const view = await sampleModel("skoda/octavia");
    const rows = priceStats(view, { filters: {} });
    const cz = rows.find((r) => r.market === "CZ" && r.condition === "used");
    expect(cz).toMatchObject({
      from: "cell",
      count: 9,
      quantiles: { p10: 393_720, median: 515_000, p90: 593_000 },
    });
    // Markets are never pooled: DE and AT have their own rows, too small for quantiles.
    expect(rows.map((r) => `${r.market}-${r.condition}`)).toEqual([
      "CZ-new",
      "CZ-used",
      "DE-used",
      "AT-used",
    ]);
    expect(rows.find((r) => r.market === "DE")?.quantiles).toBeNull();
  });

  it("recomputes to the same numbers as every published cell", async () => {
    for (const id of ["skoda/octavia", "volkswagen/golf"]) {
      const view = await sampleModel(id);
      expect(view.stats.length).toBeGreaterThan(0);
      for (const cell of view.stats) {
        const pick = listingBands().find((b) => b.band === cell.band);
        const filters = {
          market: [cell.market],
          condition: [cell.condition],
          ...(cell.variantId ? { variant: [cell.variantId] } : {}),
          ...(cell.year === null ? {} : { year: { min: cell.year, max: cell.year } }),
          ...(pick ? { odometerKm: pick.range } : {}),
        };
        const published = priceStats(view, { filters });
        // A price filter every listing passes forces the recomputing path.
        const recomputed = priceStats(view, { filters: { ...filters, priceCzk: { min: 0 } } });
        expect(published).toHaveLength(1);
        expect(published[0]?.from).toBe("cell");
        expect(recomputed[0]?.from).toBe("listings");
        expect(recomputed[0]?.count).toBe(cell.count);
        expect(recomputed[0]?.quantiles).toEqual(published[0]?.quantiles);
      }
    }
  });

  it("recomputes multi-year and filtered selections from kept, active listings", () => {
    const state: ListingState = {
      filters: { year: { min: 2017, max: 2019 }, condition: ["used"] },
    };
    const rows = priceStats(synthetic, state);
    expect(rows.every((r) => r.from === "listings" && r.condition === "used")).toBe(true);
    const cz = rows.find((r) => r.market === "CZ");
    const kept = active(synthetic, state).filter((l) => l.market === "CZ" && !l.excluded);
    expect(cz?.count).toBe(kept.length);
    const prices = kept.map((l) => l.priceCzk).sort((a, b) => a - b);
    const mid = (prices.length - 1) / 2;
    const median = Math.round(
      ((prices[Math.floor(mid)] as number) + (prices[Math.ceil(mid)] as number)) / 2,
    );
    expect(cz?.quantiles?.median).toBe(median);
    expect(cz?.quantiles?.p10).toBeLessThanOrEqual(median);
    expect(cz?.quantiles?.p90).toBeGreaterThanOrEqual(median);
  });

  it("leaves excluded listings out, ignores the sold toggle, and shows no quantiles under 3", async () => {
    const view = await sampleModel("skoda/octavia");
    const used = priceStats(view, {
      filters: { condition: ["used"], priceCzk: { max: 1_000_000 } },
    });
    // The 1 CZK placeholder listing is active but excluded; the cell count of 9 holds.
    expect(used.find((r) => r.market === "CZ")?.count).toBe(9);
    expect(priceStats(view, { filters: { includeGone: true } })).toEqual(
      priceStats(view, { filters: {} }),
    );
    const one = active(synthetic).find((l) => !l.excluded) as ListingRow;
    const price = { min: one.priceCzk, max: one.priceCzk };
    const few = priceStats(synthetic, {
      filters: { market: [one.market], condition: [one.condition], priceCzk: price },
    });
    expect(few[0]?.count).toBeLessThan(3);
    expect(few[0]?.quantiles).toBeNull();
  });

  it("gives each Variant its used median per Market from the cells", async () => {
    const view = await sampleModel("skoda/octavia");
    const cell = view.stats.find((c) => c.variantId && !c.year && !c.band);
    expect(variantMedians(view)).toEqual({ [cell?.variantId as string]: { CZ: 497_000 } });
  });
});

describe("price history", () => {
  it("gives one series per Market with points, in Market order, limited to chosen Markets", () => {
    expect(historySeries(synthetic, { filters: {} }).map((s) => s.market)).toEqual(["CZ", "AT"]);
    expect(
      historySeries(synthetic, { filters: { market: ["AT", "DE"] } }).map((s) => s.market),
    ).toEqual(["AT"]);
    expect(historySeries(synthetic, { filters: {} })[0]?.points).toHaveLength(2);
  });
});

describe("one listing", () => {
  it("breaks an imported listing's landed price into its lines, with notes and the rate", async () => {
    const view = await sampleModel("skoda/octavia");
    const de = active(view).find((l) => l.market === "DE") as ListingRow;
    const fx = { EUR: { czkPerUnit: 24.335, validFor: "2026-10-23" } };
    const b = landedBreakdown(de, fx, cs);
    expect(b?.lines.map((l) => l.label)).toEqual([
      "Cena vozu, přepočtená",
      "Doprava do ČR",
      "Technická kontrola (STK)",
      "Registrace a značky",
    ]);
    expect(b?.total).toBe(cs.czk(476_962));
    expect(b?.notes).toEqual([cs.t("landedFlag.inspectionAssumed")]);
    expect(b?.rate).toBe("1 EUR = 24,335 Kč (ČNB, 23. 10. 2026)");
    const sum = de.landed?.lines.reduce((s, l) => s + l.czk, 0);
    expect(sum).toBe(de.landed?.totalCzk);
    expect(landedBreakdown(de, fx, en)?.lines[0]?.label).toBe("Car price, converted");
    const czk = active(view).find((l) => l.market === "CZ") as ListingRow;
    expect(landedBreakdown(czk, fx, en)?.rate).toBeNull();
    expect(landedBreakdown({ ...czk, landed: null }, fx, en)).toBeNull();
  });

  it("reports a price move since the first sighting", async () => {
    const view = await sampleModel("skoda/octavia");
    const moved = active(view).find((l) => l.priceHistory.length > 1) as ListingRow;
    const first = moved.priceHistory[0]?.priceCzk as number;
    expect(priceChange(moved)).toEqual({
      amount: moved.priceCzk - first,
      percent: Math.round(((moved.priceCzk - first) / first) * 100),
    });
    expect(priceChange({ ...moved, priceHistory: moved.priceHistory.slice(-1) })).toBeNull();
  });

  it("compares a listing that switched currency by value, not by the number shown", async () => {
    const view = await sampleModel("skoda/octavia");
    const row = active(view)[0] as ListingRow;
    const switched: ListingRow = {
      ...row,
      price: { amount: 500_000, currency: "CZK" },
      priceCzk: 500_000,
      priceHistory: [
        { date: "2026-09-01", price: { amount: 20_000, currency: "EUR" }, priceCzk: 500_000 },
        { date: "2026-10-01", price: { amount: 500_000, currency: "CZK" }, priceCzk: 500_000 },
      ],
    };
    expect(priceChange(switched)).toBeNull();
    const cheaper: ListingRow = {
      ...switched,
      price: { amount: 475_000, currency: "CZK" },
      priceCzk: 475_000,
    };
    expect(priceChange(cheaper)).toEqual({ amount: -25_000, percent: -5 });
  });
});

describe("listing rail", () => {
  it("names Variants by generation, body, fuel and power, disambiguating equal names", () => {
    const names = variantNames(synthetic.variants, en);
    expect(names["mk/m/a"]).toBe("G1 · estate · diesel · 85 kW");
    const twin = { ...(synthetic.variants[0] as VariantRow), id: "mk/m/a2" };
    const twins = variantNames([synthetic.variants[0] as VariantRow, twin], en);
    expect(twins["mk/m/a"]).not.toBe(twins["mk/m/a2"]);
  });

  it("offers values with counts, hides one-value facets and keeps a chosen value without matches", () => {
    const names = variantNames(synthetic.variants, en);
    const result = synthetic.listings({ filters: {} });
    const market = listingFacetOptions("market", result, {}, names, en);
    expect(market.map((o) => o.label)).toEqual(["Czechia", "Germany", "Austria"]);
    expect(listingFacetOptions("transmission", result, {}, names, en)).toEqual([]);
    const variant = listingFacetOptions("variant", result, {}, names, en);
    expect(variant.map((o) => o.label)).toEqual([names["mk/m/a"], names["mk/m/b"]]);
    const filters = toggleListingValue({}, "body", "sedan");
    const chosen = listingFacetOptions("body", synthetic.listings({ filters }), filters, names, en);
    expect(chosen).toEqual([{ value: "sedan", label: "sedan", count: 0, checked: true }]);
    expect(toggleListingValue(filters, "body", "sedan")).toEqual({});
    expect(withRange({ year: { min: 1 } }, "year", undefined)).toEqual({});
    expect(withRange({}, "landedCzk", { max: 500_000 })).toEqual({ landedCzk: { max: 500_000 } });
  });
});

describe("listing URL state", () => {
  it("round-trips a deep link with Variant ids, a band pick, landed sort and sold listings", () => {
    const state: ListingState = {
      filters: {
        variant: ["skoda/octavia/mk4/wagon-diesel-110kw"],
        market: ["DE", "CZ"],
        year: { min: 2020, max: 2022 },
        odometerKm: listingBands()[2]?.range,
        landedCzk: { max: 600_000 },
        includeGone: true,
      },
      sort: { key: "landedCzk", dir: "desc" },
    };
    const url = writeListingState(state);
    expect(url).toBe(
      "?variant=skoda/octavia/mk4/wagon-diesel-110kw&market=CZ,DE&year=2020-2022&landed=-600000&km=50000-99999&gone=1&sort=-landed",
    );
    expect(writeListingState(readListingState(url))).toBe(url);
  });

  it("serves a shared band pick from the published cell", async () => {
    const view = await sampleModel("skoda/octavia");
    const [row] = priceStats(view, readListingState("?km=50000-99999&condition=used&market=CZ"));
    expect(row).toMatchObject({ from: "cell", count: 4, quantiles: { median: 537_000 } });
  });
});
