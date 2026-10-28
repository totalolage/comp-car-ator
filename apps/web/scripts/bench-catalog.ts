// Query-time benchmark for the catalog page: opens the catalog query engine over a synthetic
// Bundle of ~50k Variants (most with used listings in one to four (market, source) groups)
// and times the queries the catalog island issues on a facet click, a range edit and a sort.
// "max" includes the first use of each sort order, which the engine computes once and keeps.
//
//   node apps/web/scripts/bench-catalog.ts [variants=50000] [runs=20]

import { gzipSync } from "node:zlib";
import { type BundleContent, encodeBundle, memoryLoader, type VariantRow } from "@cca/bundle";
import { openCatalog, type VariantQuery } from "@cca/catalog";
import { BODIES, FUELS, MARKETS, TRANSMISSIONS } from "@cca/vocabulary";
import { catalogQuery, firstPaintRow } from "../src/lib/catalog-view.ts";

const VARIANTS = Number(process.argv[2] ?? 50_000);
const RUNS = Number(process.argv[3] ?? 20);
const SOURCES = ["sauto", "tipcars", "bazos", "autoscout24-de", "autoscout24-at", "aaa-auto"];

// Deterministic pseudo-random numbers, so runs are comparable.
let seed = 42;
const rand = () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

function synthetic(n: number): BundleContent {
  const makes = Array.from({ length: 80 }, (_, i) => ({ id: `make${i}`, name: `Make ${i}` }));
  const models = makes.flatMap((make, i) =>
    Array.from({ length: 5 + (i % 30) }, (_, j) => ({
      id: `${make.id}/model${j}`,
      makeId: make.id,
      name: `Model ${j}`,
      listingCount: 0,
    })),
  );
  const variants: VariantRow[] = Array.from({ length: n }, (_, i) => {
    const model = pick(models);
    const from = 2000 + Math.floor(rand() * 26);
    const price = 150_000 + Math.floor(rand() * 2_000_000);
    const groups = rand() < 0.6 ? Math.ceil(rand() * 4) : 0;
    const q = (m: number) => ({ count: groups * 5, p10: m * 0.7, median: m, p90: m * 1.4 });
    return {
      id: `${model.id}/v${i}`,
      makeId: model.makeId,
      modelId: model.id,
      generationId: `${model.id}/g${from}`,
      make: model.makeId,
      model: model.name,
      generation: `G${from}`,
      years: { from, ...(rand() < 0.7 ? { to: Math.min(2026, from + 7) } : {}) },
      body: pick(BODIES),
      fuel: pick(FUELS),
      powerKw: 40 + Math.floor(rand() * 300),
      transmission: pick(TRANSMISSIONS),
      seats: pick([2, 4, 5, 5, 5, 7]),
      consumptionL100km: Math.round((3 + rand() * 9) * 10) / 10,
      ...(rand() < 0.3
        ? { newPriceCzk: { min: price, max: price * 1.3, source: "list" as const, count: 1 } }
        : {}),
      used: groups
        ? {
            count: groups * 5,
            priceCzk: q(price / 2),
            landedCzk: q(price / 2 + 20_000),
            odometerKm: q(120_000),
            years: { min: from, max: from + 5 },
            byMarket: {},
            markets: {},
            sources: {},
            groups: Array.from({ length: groups }, () => ({
              market: pick(MARKETS),
              source: pick(SOURCES),
              count: 5,
              priceCzk: { min: price * 0.3, max: price * 0.7 },
              odometerKm: { min: 10_000 + rand() * 100_000, max: 120_000 + rand() * 200_000 },
              years: { min: from, max: from + 5 },
            })),
          }
        : null,
    };
  });
  return {
    manifest: {
      format: 3,
      generatedAt: "2026-10-25T00:00:00Z",
      fx: {} as BundleContent["manifest"]["fx"],
      sources: [],
      counts: { makes: makes.length, models: models.length, variants: n, listings: 0 },
    },
    catalog: { makes, models, variants },
    models: [],
  };
}

const files = encodeBundle(synthetic(VARIANTS));
const catalogBytes = (files.get("catalog.json") ?? "").length;
let t = performance.now();
const catalog = await openCatalog(memoryLoader(files));
const openMs = performance.now() - t;
// The first query reads every row into the engine's columns; later ones reuse them.
t = performance.now();
catalog.query({ limit: 1 });
const firstMs = performance.now() - t;

const cases: [string, VariantQuery][] = [
  ["no filters, default sort", { sort: { key: "make", dir: "asc" }, limit: 100 }],
  ["no filters, no sort", { limit: 100 }],
  ["one make", { filters: { make: ["make3"] }, sort: { key: "make", dir: "asc" }, limit: 100 }],
  [
    "make + fuel + body",
    { filters: { make: ["make3", "make7"], fuel: ["diesel"], body: ["wagon", "suv"] }, limit: 100 },
  ],
  [
    "ranges: year, power, used price, km",
    {
      filters: {
        year: { min: 2015 },
        powerKw: { min: 80, max: 150 },
        usedPriceCzk: { max: 400_000 },
        odometerKm: { max: 150_000 },
      },
      limit: 100,
    },
  ],
  [
    "market + source, sort by used price desc",
    {
      filters: { market: ["DE"], source: ["autoscout24-de"] },
      sort: { key: "usedPriceCzk", dir: "desc" },
      limit: 100,
    },
  ],
  ["all rows (name index at load)", { limit: Number.MAX_SAFE_INTEGER }],
];

console.log(
  `${VARIANTS} Variants, catalog.json ${(catalogBytes / 1e6).toFixed(1)} MB, open ${openMs.toFixed(0)} ms, first query ${firstMs.toFixed(0)} ms, ${RUNS} runs per query`,
);
console.log("query                                       total   median ms   max ms");
for (const [name, query] of cases) {
  const times: number[] = [];
  let total = 0;
  for (let i = 0; i < RUNS; i++) {
    t = performance.now();
    total = catalog.query(query).total;
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] as number;
  const max = times[times.length - 1] as number;
  console.log(
    `${name.padEnd(42)} ${String(total).padStart(6)} ${median.toFixed(1).padStart(11)} ${max.toFixed(1).padStart(8)}`,
  );
}

// The catalog page's first paint: the island's serialized props (rows cut by firstPaintRow,
// facet counts without the model facet), as CatalogPage.astro builds them.
const first = catalog.query(catalogQuery({ filters: {} }));
const props = JSON.stringify({
  ...first,
  rows: first.rows.map(firstPaintRow),
  facets: { ...first.facets, values: { ...first.facets.values, model: [] } },
});
console.log(
  `first-paint props: ${(props.length / 1000).toFixed(0)} kB raw, ${(gzipSync(props).length / 1000).toFixed(1)} kB gzip`,
);
