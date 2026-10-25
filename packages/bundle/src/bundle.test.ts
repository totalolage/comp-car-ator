import { describe, expect, it } from "vitest";
import {
  type BundleContent,
  BundleFormatError,
  encodeBundle,
  type Loader,
  type ModelFile,
  memoryLoader,
  odometerBand,
  openBundle,
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
});
