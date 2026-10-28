// Writes a copy of the sample Bundle whose Škoda Octavia model file is as large as the most
// popular model at scale (ADR 0012: ~2.25 MB raw), so a build shows the model page's weight
// with a big listing table:
//
//   node apps/web/scripts/large-model-bundle.ts /tmp/large-bundle [listings=6000]
//   BUNDLE_DIR=/tmp/large-bundle pnpm --filter web build
//
// Listings are the sample's Octavia Listings repeated with varied price, year, odometer and
// price history; the history gets two years of weekly points per Market.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBundle, type ListingRow, type ModelFile, openBundle } from "@cca/bundle";
import { fsLoader } from "@cca/bundle/node";

const OUT = process.argv[2];
const LISTINGS = Number(process.argv[3] ?? 6000);
if (!OUT) throw new Error("usage: large-model-bundle.ts <out-dir> [listings]");
const MODEL = "skoda/octavia";

let seed = 11;
const rand = () => {
  seed = (seed * 48_271) % 2_147_483_647;
  return seed / 2_147_483_647;
};

const sample = fileURLToPath(new URL("../../../fixtures/sample-bundle", import.meta.url));
const bundle = await openBundle(fsLoader(sample));
const catalog = await bundle.catalog();
const models: ModelFile[] = [];
for (const m of catalog.models) {
  const index = await bundle.model(m.id);
  if (!index) continue;
  const { listings, rows, ...rest } = index;
  models.push({ ...rest, listings: await rows(listings) });
}
const octavia = models.find((m) => m.model.id === MODEL);
if (!octavia) throw new Error(`${MODEL} missing from the sample Bundle`);

const base = octavia.listings.filter((l) => !l.excluded);
octavia.listings = Array.from({ length: LISTINGS }, (_, i): ListingRow => {
  const from = base[i % base.length] as ListingRow;
  const factor = 0.7 + rand() * 0.6;
  const amount = Math.round(from.price.amount * factor);
  const priceCzk = Math.round(from.priceCzk * factor);
  const moves = Math.floor(rand() * 4);
  return {
    ...from,
    id: `${from.source}:${String(i).padStart(6, "0")}`,
    url: `${from.url}?n=${i}`,
    year: 2020 + Math.floor(rand() * 5),
    odometerKm: Math.round(rand() * 250_000),
    price: { ...from.price, amount },
    priceCzk,
    landed: from.landed && {
      ...from.landed,
      totalCzk: from.landed.totalCzk - from.priceCzk + priceCzk,
    },
    photos: Array.from({ length: 3 }, (_, p) => `https://img.example.test/${i}/${p}.jpg`),
    daysOnMarket: Math.floor(rand() * 120),
    priceHistory: Array.from({ length: moves + 1 }, (_, k) => ({
      date: `2026-${String(7 + k).padStart(2, "0")}-01`,
      price: { ...from.price, amount: Math.round(amount * (1 + (moves - k) * 0.03)) },
      priceCzk: Math.round(priceCzk * (1 + (moves - k) * 0.03)),
    })),
  };
});
octavia.listings.sort((a, b) => (a.id < b.id ? -1 : 1));
octavia.history = octavia.history.map((h) => ({
  market: h.market,
  points: Array.from({ length: 104 }, (_, w) => ({
    date: new Date(Date.UTC(2024, 9, 28 + 7 * w)).toISOString().slice(0, 10),
    count: 20 + Math.floor(rand() * 200),
    medianCzk: Math.round(400_000 + rand() * 80_000 - w * 600),
  })),
}));

const files = encodeBundle({ manifest: bundle.manifest, catalog, models });
for (const [name, text] of files) {
  const path = join(OUT, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
let size = 0;
for (const [name, text] of files) if (name.startsWith(`models/${MODEL}/`)) size += text.length;
console.log(
  `wrote ${files.size} files to ${OUT}; ${MODEL} model files ${(size / 1e6).toFixed(2)} MB raw`,
);
