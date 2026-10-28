import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeTable } from "./columns.ts";
import {
  BundleChangedError,
  type BundleContent,
  type BundleFile,
  BundleFormatError,
  encodeBundle,
  fetchLoader,
  type ListingEntry,
  type ListingRow,
  type Loader,
  type ModelFile,
  type ModelIndex,
  memoryLoader,
  odometerBand,
  openBundle,
  type VariantRow,
} from "./index.ts";
import { fsLoader, packBundle, unpackBundle, writeBundleFiles } from "./node.ts";

const model: ModelFile = {
  model: { id: "skoda/octavia", makeId: "skoda", make: "Škoda", name: "Octavia" },
  generations: [{ id: "skoda/octavia/mk4", name: "Octavia IV", from: 2020 }],
  variantIds: [],
  listings: [],
  stats: [],
  history: [],
};

const listing = (i: number): ListingRow => ({
  id: `sauto:${i}`,
  source: "sauto",
  url: `https://www.sauto.cz/${i}`,
  market: "CZ",
  condition: "used",
  variantId: i % 2 ? "skoda/octavia/mk4/wagon-diesel-85kw" : null,
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

/** A model as the reader returns it, with every row loaded: the model file again. */
async function whole(index: ModelIndex | null) {
  if (!index) return index;
  const { listings, rows, ...rest } = index;
  return { ...rest, listings: byId(await rows(listings)) };
}

function byId(rows: ListingRow[]): ListingRow[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const content: BundleContent = {
  manifest: {
    format: 3,
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
    expect(await whole(await reader.model("skoda/octavia"))).toEqual(model);
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
    expect(loads.sort()).toEqual([
      "catalog.json",
      "manifest.json",
      "models/skoda/octavia/index.json",
    ]);
  });

  it("indexes a model's Listings, active and cheapest first, and loads only the rows asked for", async () => {
    // 100 Listings, dearer as the id grows; the first is gone and the second an outlier.
    const listings = Array.from({ length: 100 }, (_n, i) => {
      const { gone: _g, excluded: _e, ...row } = listing(i);
      return {
        ...row,
        landed: null,
        priceCzk: 100_000 + i,
        ...(i === 0 ? { gone: "2026-10-20" } : i === 1 ? { excluded: true as const } : {}),
      };
    });
    const files = encodeBundle({ ...content, models: [{ ...model, listings }] });
    const loads: string[] = [];
    const reader = await openBundle(async (path) => {
      loads.push(path);
      return files.get(path) ?? null;
    });
    const index = (await reader.model("skoda/octavia")) as ModelIndex;
    // The index carries what filters, sorts and statistics read, not what a row displays.
    expect(index.listings[0]).toEqual({
      variantId: null,
      market: "CZ",
      condition: "used",
      source: "sauto",
      year: 2021,
      odometerKm: 2_000,
      priceCzk: 100_002,
      firstSeen: "2026-10-01",
      daysOnMarket: 23,
    });
    expect(index.listings.map((l) => l.priceCzk).slice(-2)).toEqual([100_001, 100_000]);
    const picked = [index.listings[40], index.listings[0], index.listings[3]] as ListingEntry[];
    expect((await index.rows(picked)).map((r) => r.id)).toEqual(["sauto:42", "sauto:2", "sauto:5"]);
    expect(loads.filter((p) => p.startsWith("models/")).sort()).toEqual([
      "models/skoda/octavia/0.json",
      "models/skoda/octavia/1.json",
      "models/skoda/octavia/index.json",
    ]);
    await index.rows(index.listings.slice(0, 32));
    expect(loads).toHaveLength(4);
    expect(byId(await index.rows(index.listings))).toEqual(byId(listings));
    await expect(index.rows([{ ...index.listings[0] } as ListingEntry])).rejects.toThrow(
      /not from skoda\/octavia/,
    );
  });

  it("notices a rows file from another Bundle than the index it was read with", async () => {
    const before = encodeBundle({ ...content, models: [{ ...model, listings: [listing(1)] }] });
    const after = encodeBundle({
      ...content,
      models: [{ ...model, listings: [listing(2), listing(1)] }],
    });
    // The page opened the index before a deploy and asks for rows after it.
    const reader = await openBundle(
      async (path) => (path.endsWith("/0.json") ? after : before).get(path) ?? null,
    );
    const index = (await reader.model("skoda/octavia")) as ModelIndex;
    await expect(index.rows(index.listings)).rejects.toBeInstanceOf(BundleChangedError);
    // The same Listings in the same order, one of them repriced.
    const repriced = encodeBundle({
      ...content,
      models: [{ ...model, listings: [{ ...listing(1), priceCzk: 1 }] }],
    });
    const mixed = await openBundle(
      async (path) => (path.endsWith("/0.json") ? repriced : before).get(path) ?? null,
    );
    const old = (await mixed.model("skoda/octavia")) as ModelIndex;
    await expect(old.rows(old.listings)).rejects.toBeInstanceOf(BundleChangedError);
  });

  it("retries a model or rows file that failed to load", async () => {
    const files = encodeBundle({ ...content, models: [{ ...model, listings: [listing(1)] }] });
    let fail = true;
    const reader = await openBundle(async (path) => {
      if (path.startsWith("models/") && fail) {
        fail = false;
        throw new Error("offline");
      }
      return files.get(path) ?? null;
    });
    await expect(reader.model("skoda/octavia")).rejects.toThrow("offline");
    const index = (await reader.model("skoda/octavia")) as ModelIndex;
    fail = true;
    await expect(index.rows(index.listings)).rejects.toThrow("offline");
    expect((await index.rows(index.listings)).map((r) => r.id)).toEqual(["sauto:1"]);
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
      id: `skoda/octavia/mk4/wagon-diesel-${85 + i}kw`,
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
      transmissions: ["automatic"],
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
    expect(await whole(await reader.model("skoda/octavia"))).toEqual({
      ...rich,
      listings: byId(rich.listings),
    });
    // Repeated values are stored once per column, not once per row.
    expect(files.get("catalog.json")?.length).toBeLessThan(JSON.stringify(variants).length / 3);
  });

  it("keeps absent fields, nulls, empty and mixed values apart", async () => {
    const odd = JSON.parse(`[
      { "a": 1, "b": null, "c": [], "d": { "e": null }, "f": "x", "g": true, "h": { "k": 1 } },
      { "b": 2, "c": null, "d": null, "f": null, "g": "mixed", "h": 3 },
      { "a": null, "c": [[1], [], null, [null]], "d": {}, "f": "x", "h": [1] },
      { "__proto__": 1, "toString": "x", "d": { "constructor": 2, "__proto__": { "y": 3 } } },
      {}
    ]`) as unknown[];
    const files = encodeBundle({
      ...content,
      models: [{ ...model, listings: odd as unknown as ListingRow[] }],
    });
    const reader = await openBundle(memoryLoader(files));
    const index = (await reader.model("skoda/octavia")) as ModelIndex;
    expect(await index.rows(index.listings)).toStrictEqual(odd);
  });
});

describe("Bundle archive", () => {
  /** Packs into memory; `written` counts the compressed chunks that reached the target. */
  async function pack(files: Iterable<BundleFile>, written = { chunks: 0 }): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const to = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        written.chunks++;
        done();
      },
    });
    await packBundle(files, to);
    return Buffer.concat(chunks);
  }

  it("packs a Bundle into one file and unpacks it unchanged", async () => {
    const files = encodeBundle(content);
    expect(unpackBundle(await pack(files))).toEqual(files);
  });

  it("stays one JSON document, and reads the single-line archives written before", async () => {
    const files = encodeBundle(content);
    const archive = await pack(files);
    expect(JSON.parse(gunzipSync(archive).toString("utf8"))).toEqual({
      bundleArchive: 1,
      files: Object.fromEntries(files),
    });
    const legacy = gzipSync(JSON.stringify({ bundleArchive: 1, files: Object.fromEntries(files) }));
    expect(unpackBundle(legacy)).toEqual(files);
    expect(unpackBundle(await pack([]))).toEqual(new Map());
  });

  it("refuses a truncated archive", async () => {
    const text = gunzipSync(await pack(encodeBundle(content))).toString("utf8");
    const cut = text.slice(0, text.lastIndexOf("\n"));
    expect(() => unpackBundle(gzipSync(cut))).toThrow(/truncated/);
  });

  it("refuses an archive whose lines are not one file each", async () => {
    const text = gunzipSync(await pack(encodeBundle(content))).toString("utf8");
    const lines = text.split("\n");
    const joined = [lines[0], `${lines[1]}${lines[2]}`, ...lines.slice(3)].join("\n");
    expect(() => unpackBundle(gzipSync(joined))).toThrow(/malformed/);
    const noComma = text.replace("\n,", "\n");
    expect(() => unpackBundle(gzipSync(noComma))).toThrow(/malformed/);
    expect(() => unpackBundle(gzipSync(`${text}\n`))).toThrow();
  });

  it("streams: files are compressed as they come, not gathered first", async () => {
    const written = { chunks: 0 };
    const seenAt: number[] = [];
    function* files(): Generator<BundleFile> {
      for (let i = 0; i < 64; i++) {
        seenAt.push(written.chunks);
        // ~80 KB of numbers: gzip shrinks it, but every file still adds output.
        yield [
          `models/m${i}.json`,
          Array.from({ length: 16_384 }, (_, j) => (i * j) % 9973).join(),
        ];
      }
    }
    const archive = await pack(files(), written);
    expect(unpackBundle(archive).size).toBe(64);
    // Compressed output reached the target while files were still being produced.
    expect(seenAt.at(-1)).toBeGreaterThan(0);
  });

  it("rejects when the files fail midway", async () => {
    function* files(): Generator<BundleFile> {
      yield ["manifest.json", "{}"];
      throw new Error("Ledger closed");
    }
    await expect(pack(files())).rejects.toThrow("Ledger closed");
  });

  it("rejects when the target fails", async () => {
    const to = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error("disk full"));
      },
    });
    await expect(packBundle(encodeBundle(content), to)).rejects.toThrow("disk full");
  });

  it("upgrades a format-2 archive (one file per model) to the current format", async () => {
    const rich = { ...model, listings: [listing(0), listing(1), listing(2)] };
    const current = encodeBundle({ ...content, models: [rich] });
    const { listings, stats, ...rest } = rich;
    const v2 = new Map([
      [
        "models/skoda/octavia.json",
        JSON.stringify({ ...rest, listings: encodeTable(listings), stats: encodeTable(stats) }),
      ],
      ["catalog.json", current.get("catalog.json") as string],
      ["manifest.json", JSON.stringify({ ...content.manifest, format: 2 })],
    ]);
    const files = unpackBundle(await pack(v2));
    expect([...files.keys()].sort()).toEqual([...current.keys()].sort());
    const reader = await openBundle(memoryLoader(files));
    expect(await whole(await reader.model("skoda/octavia"))).toEqual({
      ...rich,
      listings: byId(listings),
    });
  });

  it("refuses an archive that would write outside the Bundle", async () => {
    const evil = await pack(new Map([["../../etc/passwd", "x"]]));
    expect(() => unpackBundle(evil)).toThrow(/invalid file/);
  });
});

describe("Bundle storage", () => {
  const rich = { ...model, listings: [listing(0), listing(1)] };
  const files = encodeBundle({ ...content, models: [rich] });

  it("stores files gzipped for the website and reads them back from disk and over HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bundle-"));
    await writeBundleFiles(dir, files, { gzip: true });
    const index = join(dir, "models/skoda/octavia/index.json.gz");
    expect(gunzipSync(await readFile(index)).toString("utf8")).toBe(
      files.get("models/skoda/octavia/index.json"),
    );
    // Over HTTP: the `.gz` bytes as stored, or already inflated by the host.
    const served = (inflate: boolean): typeof fetch =>
      (async (url: URL) => {
        const path = url.pathname.slice(1);
        try {
          const bytes = await readFile(join(dir, path));
          return new Response(inflate ? gunzipSync(bytes) : bytes);
        } catch {
          return new Response(null, { status: 404 });
        }
      }) as unknown as typeof fetch;
    for (const loader of [
      fsLoader(dir),
      fetchLoader("http://bundle.test/", { gzip: true, fetch: served(false) }),
      fetchLoader("http://bundle.test/", { gzip: true, fetch: served(true) }),
    ]) {
      const reader = await openBundle(loader);
      expect(await whole(await reader.model("skoda/octavia"))).toEqual({
        ...rich,
        listings: byId(rich.listings),
      });
      expect(await reader.model("skoda/kodiaq")).toBeNull();
    }
    await rm(dir, { recursive: true });
  });
});
