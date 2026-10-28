import {
  type BundleContent,
  encodeBundle,
  memoryLoader,
  ODOMETER_BANDS,
  type UsedStats,
  type VariantRow,
} from "@cca/bundle";
import { type Catalog, openCatalog, type VariantFilters, type VariantResult } from "@cca/catalog";
import {
  BODIES,
  FUELS,
  MARKETS,
  type Market,
  OPENPILOT_LEVELS,
  type OpenpilotLevel,
  TRANSMISSIONS,
} from "@cca/vocabulary";
import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "../i18n/i18n.ts";
import {
  catalogQuery,
  type EnumFacet,
  facetOptions,
  namesOf,
  nextSort,
  odometerBands,
  RAIL,
  toggleValue,
  withoutScope,
} from "./catalog-view.ts";
import {
  type CatalogState,
  rangeFromText,
  readCatalogState,
  writeCatalogState,
} from "./url-state.ts";

// A deterministic catalog of 240 Variants over 4 makes, most with used listings in one to
// three (market, source) groups, so every facet has several values and overlaps.
function variants(): VariantRow[] {
  let seed = 1;
  const next = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const makes = ["skoda", "volkswagen", "toyota", "hyundai"];
  const sources = ["sauto", "tipcars", "autoscout24-de"];
  return Array.from({ length: 240 }, (_, i) => {
    const makeId = pick(makes);
    const model = `m${Math.floor(next() * 4)}`;
    const from = 2005 + Math.floor(next() * 20);
    const price = 200_000 + Math.floor(next() * 800_000);
    const groups = Math.floor(next() * 4);
    const q = (m: number) => ({ count: groups * 2, p10: m, median: m, p90: m });
    const used: UsedStats | null = groups
      ? {
          count: groups * 2,
          priceCzk: q(price),
          landedCzk: q(price + 30_000),
          odometerKm: q(90_000),
          years: { min: from, max: from + 3 },
          byMarket: {},
          markets: {},
          sources: {},
          groups: Array.from({ length: groups }, (_, g) => ({
            market: MARKETS[(i + g) % 3] as Market,
            source: sources[(i * 7 + g) % 3] as string,
            count: 2,
            priceCzk: { min: price - 50_000 * g, max: price + 50_000 * g },
            odometerKm: { min: 20_000 * g, max: 60_000 + 40_000 * g },
            years: { min: from, max: from + 3 },
          })),
        }
      : null;
    return {
      id: `${makeId}/${model}/v${i}`,
      makeId,
      modelId: `${makeId}/${model}`,
      generationId: `${makeId}/${model}/g`,
      make: makeId === "skoda" ? "Škoda" : makeId.charAt(0).toUpperCase() + makeId.slice(1),
      model: `Model ${model}`,
      generation: "G",
      years: { from, ...(next() < 0.6 ? { to: from + 6 } : {}) },
      body: pick(BODIES.slice(0, 5)),
      fuel: pick(FUELS.slice(0, 4)),
      powerKw: 50 + Math.floor(next() * 150),
      transmissions: [pick(TRANSMISSIONS)],
      ...(next() < 0.8 ? { seats: pick([4, 5, 7]) } : {}),
      ...(next() < 0.7 ? { consumptionL100km: Math.round(40 + next() * 60) / 10 } : {}),
      ...(next() < 0.4
        ? { newPriceCzk: { min: price * 2, max: price * 2.4, source: "list" as const, count: 1 } }
        : {}),
      // Every fifth Variant is on comma's list, cycling its levels; the rest are unlisted.
      ...(i % 5 === 0
        ? { openpilot: { level: OPENPILOT_LEVELS[(i / 5) % 6] as OpenpilotLevel, years: [from] } }
        : {}),
      used,
    };
  });
}

let catalog: Catalog;
beforeAll(async () => {
  const rows = variants();
  const content: BundleContent = {
    manifest: {
      format: 3,
      generatedAt: "2026-10-25T00:00:00Z",
      fx: {} as BundleContent["manifest"]["fx"],
      sources: [],
      counts: { makes: 4, models: 16, variants: rows.length, listings: 0 },
    },
    catalog: { makes: [], models: [], variants: rows },
    models: [],
  };
  catalog = await openCatalog(memoryLoader(encodeBundle(content)));
});

const t = i18n("cs");
const everything = Number.MAX_SAFE_INTEGER;
const ids = (r: VariantResult) => r.rows.map((v) => v.id);
const enumFacets = RAIL.flatMap((f) => (f.kind === "enum" ? [f.key] : []));

/** Views a person can reach by clicking facets, typing ranges and sorting. */
const views: CatalogState[] = [
  { filters: {} },
  { filters: { make: ["skoda"] } },
  {
    filters: { make: ["skoda", "toyota"], fuel: ["diesel", "petrol"] },
    sort: { key: "usedPriceCzk", dir: "desc" },
  },
  { filters: { body: ["wagon"], year: { min: 2015 }, powerKw: { max: 150 } } },
  {
    filters: { market: ["DE"], source: ["autoscout24-de"], usedPriceCzk: { max: 600_000 } },
    sort: { key: "usedCount", dir: "desc" },
  },
  {
    filters: { transmission: ["automatic"], odometerKm: { max: 50_000 }, seats: { min: 5 } },
    sort: { key: "consumptionL100km", dir: "asc" },
  },
  { filters: { newPriceCzk: { min: 600_000 }, consumptionL100km: { max: 7.5 } } },
  { filters: { make: ["skoda", "volkswagen"], model: ["skoda/m1", "volkswagen/m2"] } },
  { filters: { market: ["CZ", "DE"], source: ["sauto", "tipcars"], body: ["wagon", "suv"] } },
  { filters: { openpilot: ["upstream", "unlisted"] } },
  { filters: { make: ["toyota"], openpilot: ["community"] } },
];

describe("catalog view over the query engine", () => {
  it("reproduces the same result from a restored URL", () => {
    for (const view of views) {
      const restored = readCatalogState(writeCatalogState(view));
      const before = catalog.query(catalogQuery(view, {}, everything));
      const after = catalog.query(catalogQuery(restored, {}, everything));
      expect(after).toEqual(before);
    }
  });

  it("gives every facet count the meaning the rail states for the click it labels", () => {
    const single = new Set<EnumFacet>([
      "make",
      "model",
      "body",
      "fuel",
      "transmission",
      "openpilot",
    ]);
    for (const view of views) {
      const result = catalog.query(catalogQuery(view, {}, everything));
      for (const facet of enumFacets) {
        const active = (view.filters[facet]?.length ?? 0) > 0;
        for (const option of facetOptions(facet, result, view.filters, {}, t)) {
          // The checkbox's own toggle, then a trip through the URL, as a click does.
          const filters = toggleValue(view.filters, facet, option.value);
          const state = readCatalogState(writeCatalogState({ ...view, filters }));
          const after = catalog.query(catalogQuery(state, {}, everything)).total;
          const { total } = result;
          const { count } = option;
          const at = [facet, option.value];
          expect([...at, option.adds]).toEqual([
            ...at,
            active && !option.checked && single.has(facet),
          ]);
          if (!active) expect([...at, after]).toEqual([...at, count]);
          else if (option.adds) expect([...at, after]).toEqual([...at, total + count]);
          else if (!option.checked) {
            // Listing country or source: Variants overlap, so the click adds at most N.
            expect(after).toBeGreaterThanOrEqual(Math.max(total, count));
            expect(after).toBeLessThanOrEqual(total + count);
          } else if (view.filters[facet]?.length === 1) {
            // The only checked value: every row has it, and unchecking clears the facet.
            expect([...at, count]).toEqual([...at, total]);
            expect(state.filters[facet]).toBeUndefined();
          } else if (single.has(facet)) expect([...at, after]).toEqual([...at, total - count]);
          else {
            expect(after).toBeGreaterThanOrEqual(total - count);
            expect(after).toBeLessThanOrEqual(total);
          }
        }
      }
    }
  });

  it("keeps a facet's counts when its own values are toggled and recounts the others", () => {
    const optionsOf = (filters: VariantFilters, facet: EnumFacet) =>
      facetOptions(facet, catalog.query(catalogQuery({ filters }, {}, 0)), filters, {}, t);
    const counts = (filters: VariantFilters, facet: EnumFacet) =>
      Object.fromEntries(optionsOf(filters, facet).map((o) => [o.value, o.count]));
    const option = (filters: VariantFilters, facet: EnumFacet, value: string) =>
      optionsOf(filters, facet).find((o) => o.value === value);
    const total = (filters: VariantFilters) =>
      catalog.query(catalogQuery({ filters }, {}, 0)).total;
    const start: VariantFilters = { fuel: ["diesel"] };
    const makes = counts(start, "make");
    const a = Object.keys(makes)[0] as string;
    const b = Object.keys(makes)[1] as string;
    const ca = makes[a] as number;
    const cb = makes[b] as number;

    const withA = toggleValue(start, "make", a);
    expect(total(withA)).toBe(ca);
    expect(counts(withA, "make")).toEqual(makes);
    expect(option(withA, "make", b)).toMatchObject({ count: cb, checked: false, adds: true });

    const withAB = toggleValue(withA, "make", b);
    expect(withAB.make).toEqual([a, b]);
    expect(total(withAB)).toBe(ca + cb);
    expect(counts(withAB, "make")).toEqual(makes);
    expect(option(withAB, "make", b)).toMatchObject({ count: cb, checked: true, adds: false });

    const removedB = toggleValue(withAB, "make", b);
    expect(removedB).toEqual(withA);
    expect(total(removedB)).toBe(ca);
    expect(option(removedB, "make", b)).toMatchObject({ count: cb, checked: false, adds: true });

    // Other facets count only the chosen makes; with nothing chosen there, they sum to the total.
    for (const filters of [withA, withAB, removedB]) {
      const sum = Object.values(counts(filters, "body")).reduce((n, c) => n + c, 0);
      expect(sum).toBe(total(filters));
    }
    expect(counts(withAB, "body")).not.toEqual(counts(withA, "body"));

    // Clearing the last make clears the facet and the models under it.
    const withModel = toggleValue(withA, "model", `${a}/m1`);
    const cleared = toggleValue(withModel, "make", a);
    expect(cleared).toEqual(start);
    expect(writeCatalogState({ filters: cleared })).toBe("?fuel=diesel");
    expect(total(cleared)).toBe(total(start));
    expect(optionsOf(cleared, "make").every((o) => !o.checked && !o.adds)).toBe(true);
    expect(counts(cleared, "make")).toEqual(makes);
  });

  it("adds exactly +N for a model on a make's category page", () => {
    const scope: VariantFilters = { make: ["skoda"] };
    const view = (filters: VariantFilters) => {
      const result = catalog.query(catalogQuery({ filters }, scope, 0));
      return {
        total: result.total,
        models: facetOptions("model", result, { ...filters, ...scope }, {}, t),
      };
    };
    const [first, second] = view({}).models;
    if (!first || !second) throw new Error("the test catalog has several Škoda models");
    const url = writeCatalogState({ filters: toggleValue({}, "model", first.value) });
    expect(url).toBe(`?model=${first.value}`);
    const one = withoutScope(readCatalogState(url), scope).filters;
    const before = view(one);
    const added = before.models.find((o) => o.value === second.value);
    expect(added).toMatchObject({ checked: false, adds: true });
    const after = view(toggleValue(one, "model", second.value));
    expect(after.total).toBe(before.total + (added?.count ?? Number.NaN));
  });

  it("narrows rows and counts together", () => {
    for (const view of views) {
      const result = catalog.query(catalogQuery(view, {}, everything));
      expect(result.rows).toHaveLength(result.total);
      // A facet with nothing chosen counts each Variant under every value it has; one value
      // per Variant (make, body, fuel, transmission) sums to the total.
      for (const facet of ["make", "body", "fuel", "transmission"] as EnumFacet[]) {
        if (view.filters[facet]) continue;
        const sum = result.facets.values[facet].reduce((n, c) => n + c.count, 0);
        expect([facet, sum]).toEqual([facet, result.total]);
      }
      const { min = -Infinity, max = Infinity } = view.filters.powerKw ?? {};
      for (const v of result.rows) expect(v.powerKw >= min && v.powerKw <= max).toBe(true);
    }
  });

  it("applies a category page's scope on top of the URL state, never from it", () => {
    const scope: VariantFilters = { make: ["skoda"] };
    const url = "?make=toyota&fuel=diesel";
    const state = withoutScope(readCatalogState(url), scope);
    expect(writeCatalogState(state)).toBe("?fuel=diesel");
    const scoped = catalog.query(catalogQuery(state, scope, everything));
    const direct = catalog.query(
      catalogQuery(readCatalogState("?make=skoda&fuel=diesel"), {}, everything),
    );
    expect(ids(scoped)).toEqual(ids(direct));
    expect(scoped.total).toBeGreaterThan(0);
  });

  it("keeps a chosen value with no matches offered, so it can be unchosen", () => {
    const filters: VariantFilters = { make: ["skoda"], fuel: ["diesel"], body: ["van"] };
    const result = catalog.query(catalogQuery({ filters }));
    const bodies = facetOptions("body", result, filters, {}, t);
    expect(bodies.find((o) => o.value === "van")).toMatchObject({ checked: true });
    // Vocabulary order, not count order, so options stay put while counts change.
    const order = bodies.map((o) => BODIES.indexOf(o.value as never));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("labels makes and models by name, sorted in the page's language", () => {
    const all = catalog.query({ limit: everything });
    const makes = facetOptions("make", all, {}, namesOf(all.rows), t);
    expect(makes.map((o) => o.label)).toEqual(["Hyundai", "Škoda", "Toyota", "Volkswagen"]);
  });

  it("offers openpilot levels best first, then unlisted, with their own labels", () => {
    const all = catalog.query({ limit: everything });
    const options = facetOptions("openpilot", all, {}, {}, i18n("en"));
    expect(options.map((o) => o.label)).toEqual([
      "Supported",
      "Community",
      "Custom setup",
      "Under review",
      "Dashcam only",
      "Incompatible",
      "Not listed",
    ]);
    expect(options.find((o) => o.value === "unlisted")?.count).toBe(192);
  });

  it("sorts by a clicked column, flipping on the second click", () => {
    const first = nextSort({ key: "make", dir: "asc" }, "powerKw");
    expect(first).toEqual({ key: "powerKw", dir: "asc" });
    expect(nextSort(first, "powerKw")).toEqual({ key: "powerKw", dir: "desc" });
    const rows = catalog.query(catalogQuery({ filters: {}, sort: first }, {}, everything)).rows;
    const power = rows.map((v) => v.powerKw);
    expect(power).toEqual([...power].sort((a, b) => a - b));
  });
});

describe("odometer quick picks", () => {
  it("follow the Bundle's odometer bands", () => {
    const bands = odometerBands();
    expect(bands).toHaveLength(ODOMETER_BANDS.length);
    // Bands are contiguous: open below the first and above the last.
    expect(bands[0]?.range.min).toBeUndefined();
    expect(bands.at(-1)?.range.max).toBeUndefined();
    for (let i = 1; i < bands.length; i++)
      expect(bands[i]?.range.min).toBe(bands[i - 1]?.range.max);
    // A band is a km range the URL carries like any typed one.
    const state = { filters: { odometerKm: bands[1]?.range } };
    expect(readCatalogState(writeCatalogState(state))).toEqual(state);
  });
});

describe("typed ranges", () => {
  it("reads Czech and English number styles", () => {
    expect(rangeFromText("300 000", "")).toEqual({ min: 300_000 });
    expect(rangeFromText("", "5,5")).toEqual({ max: 5.5 });
    expect(rangeFromText("1.5", "7")).toEqual({ min: 1.5, max: 7 });
    expect(rangeFromText(" ", "")).toBeUndefined();
    // Mid-typing "1,5": "1," already narrows to 1 while the field keeps the comma.
    expect(rangeFromText("1,", "")).toEqual({ min: 1 });
  });

  it("makes no range from text a restored URL would read differently", () => {
    // Non-numbers, negative, reversed or unwritable ends stay as text until they are a range.
    for (const [min, max] of [
      ["abc", ""],
      ["-5", ""],
      ["2020", "2010"],
      ["1e21", ""],
      ["", "99999999999999999"],
    ] as const) {
      expect([min, max, rangeFromText(min, max)]).toEqual([min, max, null]);
    }
  });
});
