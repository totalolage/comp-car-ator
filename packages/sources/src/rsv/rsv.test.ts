import { Readable } from "node:stream";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import { type Cassette, createReplayHttp, type Http, loadCassette, type Page } from "@cca/http";
import type { CatalogEntry, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, type Logger } from "../source.ts";
import { RSV_SITE, type RsvOptions, rsvSource } from "./rsv.ts";
import { unzipFirst } from "./unzip.ts";

// The site's page, its reports API and the export ZIP of 2026-10-01, with real register rows
// (identifiers blanked; 1 in 50 vehicles of a few models) plus three broken rows, and the
// Wikidata generations of those models; recorded 2026-10-25.
const fixture = new URL("./fixtures/register.cassette.json", import.meta.url);
const now = new Date("2026-10-25T12:00:00Z");
const options: RsvOptions = { minVehicles: 2 };

interface Run {
  entries: CatalogEntry[];
  logs: { message: string; data?: Record<string, unknown> }[];
}

async function harvest(
  http: Http,
  mode: HarvestMode = "full",
  lastRunAt: Date | null = null,
  opts: RsvOptions = options,
): Promise<Run> {
  const logs: Run["logs"] = [];
  const log: Logger = {
    info: (message, data) => logs.push({ message, data }),
    warn: (message, data) => logs.push({ message, data }),
  };
  const entries: CatalogEntry[] = [];
  for await (const o of rsvSource(opts).harvest({
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, lastRunAt },
    now,
    log,
    signal: new AbortController().signal,
  }) as AsyncIterable<Observation>) {
    expect(o.kind).toBe("CatalogEntry");
    entries.push(o as CatalogEntry);
  }
  return { entries, logs };
}

const cassette = () => loadCassette(fixture);
const replay = async (edit?: (c: Cassette) => void) => {
  const c = await cassette();
  edit?.(c);
  return createReplayHttp(c);
};

const variantsOf = (entries: CatalogEntry[], make: string, model: string) =>
  entries.map((e) => e.variant).filter((v) => v.make === make && v.model === model);

describe("rsv source", () => {
  it("builds Variants from the register's passenger cars", async () => {
    const { entries } = await harvest(await replay());
    expect(entries.length).toBeGreaterThan(20);
    const makes = new Set(entries.map((e) => e.variant.make));
    for (const make of ["Škoda", "Volkswagen", "Mercedes-Benz", "BMW", "Hyundai", "Toyota"]) {
      expect(makes).toContain(make);
    }
    for (const e of entries) {
      expect(e.variant.transmissions).toBeUndefined();
      expect(e.variant.years.from).toBeGreaterThanOrEqual(2000);
      expect(e.variant.powerKw).toBeGreaterThan(0);
    }
    expect(variantsOf(entries, "Škoda", "Octavia").length).toBeGreaterThan(3);
  });

  it("makes generations of type-approval types, named by Wikidata where it dates them", async () => {
    const { entries } = await harvest(await replay());
    const generations = new Map(
      entries.map((e) => [`${e.variant.model}/${e.variant.generation.slug}`, e.variant.generation]),
    );
    // Wikidata dates Octavia II and Golf IV, not Octavia I.
    expect(generations.get("Octavia/1z")).toMatchObject({
      name: "Octavia II (Mk2, 1Z)",
      from: 2004,
    });
    expect(generations.get("Octavia/1u")?.name).toBe("Octavia 1U");
    expect(generations.get("Golf/1j")?.name).toBe("Golf IV (Mk4, 1J)");
    // Type 1K was built as Golf V and VI: no single Wikidata generation fits it.
    expect(generations.get("Golf/1k")?.name).toBe("Golf 1K");
    // The B5's run-out registrations (type 3BG, 2004-2005) are not the B6.
    expect(generations.get("Passat/3c")?.name).toBe("Passat B6 (3C)");
    expect(generations.get("Passat/3bg")?.name).toBe("Passat 3BG");
    // Mercedes-Benz types are model series; listings write the chassis code.
    expect(generations.get("C-Class/203")?.name).toBe("C-Class W203");
    // BMW body letters (346L sedan, 346C coupé) are one type.
    expect([...generations.keys()].filter((k) => k.startsWith("3 Series/"))).toEqual(
      expect.arrayContaining(["3 Series/346", "3 Series/390"]),
    );
    expect([...generations.keys()].some((k) => /^3 Series\/346[a-z]$/.test(k))).toBe(false);
  });

  it("spells makes and models the way the Resolver's aliases know them", async () => {
    const { entries } = await harvest(await replay());
    const makes = new Set(entries.map((e) => e.variant.make));
    expect([...makes].filter((m) => /^(vw|volkswagen)$/i.test(m))).toEqual(["Volkswagen"]);
    const models = new Set(entries.map((e) => `${e.variant.make} ${e.variant.model}`));
    for (const model of [
      "Škoda Octavia",
      "Volkswagen Golf",
      "Volkswagen Golf Plus",
      "Mercedes-Benz C-Class",
      "BMW 3 Series",
      "Hyundai i30",
      "Kia Ceed",
    ]) {
      expect(models).toContain(model);
    }
    // Body, engine and trim words never end up in a model name.
    for (const model of models) expect(model).not.toMatch(/combi|variant|tdi|\d\.\d|cdi|cw$/i);
  });

  it("maps body, fuel, power and Specs onto the vocabulary", async () => {
    const { entries } = await harvest(await replay());
    const octavia = variantsOf(entries, "Škoda", "Octavia").find(
      (v) =>
        v.generation.slug === "1z" && v.body === "wagon" && v.fuel === "diesel" && v.powerKw === 77,
    );
    expect(octavia).toMatchObject({
      engineCc: 1896,
      seats: 5,
      euroClass: 4,
      drive: "fwd",
      years: { from: 2005 },
    });
    const bmw = variantsOf(entries, "BMW", "3 Series");
    expect(new Set(bmw.map((v) => v.drive))).toEqual(new Set(["rwd"]));
    expect(new Set(bmw.map((v) => v.body))).toEqual(new Set(["sedan", "wagon", "coupe"]));
  });

  it("skips rows it cannot map and reports them, without failing the run", async () => {
    const { logs } = await harvest(await replay());
    const read = logs.find((l) => l.message === "rsv export read")?.data;
    // The fixture adds one row each with "0 / 0" kW, fuel "XYZ" and 20 of 99 columns; the
    // real rows of pre-EU national approvals add more without a type or body.
    const rejected = read?.rejected as Record<string, number>;
    expect(rejected["short-row"]).toBe(1);
    expect(rejected["no-power"]).toBeGreaterThanOrEqual(1);
    expect(rejected["unknown-fuel"]).toBeGreaterThanOrEqual(1);
    expect(read?.cars).toBeGreaterThan(400);
  });

  it("incremental run skips an export generated before the last run", async () => {
    const { entries, logs } = await harvest(
      await replay(),
      "incremental",
      new Date("2026-10-02T03:00:00Z"),
    );
    expect(entries).toEqual([]);
    expect(logs.map((l) => l.message)).toContain("rsv export unchanged since last run");
  });

  it("incremental run reads an export generated since the last run", async () => {
    const { entries } = await harvest(
      await replay(),
      "incremental",
      new Date("2026-09-02T03:00:00Z"),
    );
    expect(entries.length).toBeGreaterThan(20);
  });

  it("fails the run when the export's columns change", async () => {
    const http = await replay((c) => {
      const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
      if (!zip?.response.bodyBase64) throw new Error("fixture has no export");
      zip.response.bodyBase64 = Buffer.from(
        zipOf("Datum 1. registrace,Kategorie vozidla\r\n2020-01-01,M1\r\n"),
      ).toString("base64");
    });
    await expect(harvest(http)).rejects.toThrow(/Register export changed: no column/);
  });

  it("fails the run when the site stops listing the export", async () => {
    const http = await replay((c) => {
      const api = c.interactions.find((i) => i.request.url.includes("regularLatestReports"));
      if (!api) throw new Error("fixture has no reports API");
      api.response.body = "[]";
    });
    await expect(harvest(http)).rejects.toThrow(/lists no technical-data export/);
  });

  it("fails the run without Wikidata, which decides which types are one generation", async () => {
    const http = await replay((c) => {
      const wd = c.interactions.find((i) => i.request.url.includes("wikidata"));
      if (!wd) throw new Error("fixture has no Wikidata");
      Object.assign(wd.response, { status: 500, body: "" });
    });
    await expect(harvest(http)).rejects.toThrow(/Wikidata returned HTTP 500/);
  });

  it("starts the download over when the server drops it", async () => {
    const reference = await harvest(await replay());
    const flakyHttp = flaky(await replay(), 1);
    const { entries, logs } = await harvest(flakyHttp.http);
    expect(entries).toEqual(reference.entries);
    expect(flakyHttp.downloads()).toBe(2);
    expect(flakyHttp.closed()).toBe(2);
    expect(logs.map((l) => l.message)).toContain("rsv download interrupted; starting over");
  });

  it("fails after the last attempt without yielding a partial catalog", async () => {
    const flakyHttp = flaky(await replay(), 3);
    const yielded: Observation[] = [];
    const run = (async () => {
      for await (const o of rsvSource(options).harvest(context(flakyHttp.http))) yielded.push(o);
    })();
    await expect(run).rejects.toThrow(/download interrupted/);
    expect(yielded).toEqual([]);
    expect(flakyHttp.downloads()).toBe(3);
    expect(flakyHttp.closed()).toBe(3);
  });

  it("fails on a truncated archive instead of yielding a partial catalog", async () => {
    const http = await replay((c) => {
      const zip = exportOf(c);
      const bytes = Buffer.from(zip.response.bodyBase64 ?? "", "base64");
      zip.response.bodyBase64 = bytes.subarray(0, bytes.length / 2).toString("base64");
    });
    const yielded: Observation[] = [];
    const run = (async () => {
      for await (const o of rsvSource(options).harvest(context(http))) yielded.push(o);
    })();
    await expect(run).rejects.toThrow(/unexpected end/i);
    expect(yielded).toEqual([]);
  });

  it("reads a ZIP written with a data descriptor and a central directory, in tiny chunks", async () => {
    const reference = await harvest(await replay());
    const csv = await unzipText(
      Buffer.from(exportOf(await cassette()).response.bodyBase64 ?? "", "base64"),
    );
    const deflated = deflateRawSync(Buffer.from(csv, "utf8"));
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    const central = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(60)]);
    const zip = Buffer.concat([localHeader(), deflated, descriptor, central]);
    const http = await replay((c) => {
      exportOf(c).response.bodyBase64 = zip.toString("base64");
    });
    const { entries } = await harvest(rechunked(http, 7));
    expect(entries).toEqual(reference.entries);
  });

  it("streams the export: memory stays flat over 200,000 rows", async () => {
    const { header, row } = await realRow();
    const http = syntheticHttp(header, row, 200_000);
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 20);
    const { entries, logs } = await harvest(http, "full", null, { minVehicles: 5 });
    clearInterval(timer);
    expect(logs.find((l) => l.message === "rsv export read")?.data).toMatchObject({
      rows: 200_000,
      cars: 200_000,
    });
    expect(entries).toHaveLength(1);
    // ~100 MB of CSV went through; the adapter holds one record per candidate Variant.
    expect(peak - before).toBeLessThan(80 * 2 ** 20);
  }, 60_000);
});

function context(http: Http) {
  return {
    http,
    mode: "full" as const,
    checkpoint: emptyCheckpoint,
    now,
    log: { info() {}, warn() {} },
    signal: new AbortController().signal,
  };
}

function exportOf(c: Cassette) {
  const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
  if (!zip) throw new Error("fixture has no export");
  return zip;
}

/** The export download breaks after 20 kB on its first `failures` attempts. */
function flaky(inner: Http, failures: number) {
  let downloads = 0;
  let closed = 0;
  const http: Http = {
    async get(request) {
      const page = await inner.get(request);
      if (typeof request === "string" || !request.stream || !page.chunks) return page;
      const attempt = ++downloads;
      const source = page.chunks;
      async function* chunks() {
        let bytes = 0;
        try {
          for await (const chunk of source) {
            if (attempt <= failures && bytes > 20_000) throw new TypeError("terminated");
            bytes += chunk.length;
            yield chunk;
          }
        } finally {
          closed++;
        }
      }
      return { ...page, chunks: chunks() };
    },
  };
  return { http, downloads: () => downloads, closed: () => closed };
}

/** Serves streamed bodies in `size`-byte chunks. */
function rechunked(inner: Http, size: number): Http {
  return {
    async get(request) {
      const page = await inner.get(request);
      if (!page.chunks) return page;
      const source = page.chunks;
      async function* chunks() {
        for await (const chunk of source) {
          for (let at = 0; at < chunk.length; at += size) yield chunk.subarray(at, at + size);
        }
      }
      return { ...page, chunks: chunks() };
    },
  };
}

/** The fixture's header and its first data row, as CSV lines. */
async function realRow(): Promise<{ header: string; row: string }> {
  const c = await cassette();
  const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
  const csv = await unzipText(Buffer.from(zip?.response.bodyBase64 ?? "", "base64"));
  const [header, ...rows] = csv.replace(/^\ufeff/, "").split("\r\n");
  // An Octavia II: a row the adapter keeps.
  const row = rows.find((r) => !r.includes('"') && r.includes("OCTAVIA") && r.includes(",1Z,"));
  if (!header || !row) throw new Error("fixture has no plain Octavia II row");
  return { header, row };
}

async function unzipText(zip: Buffer): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of unzipFirst(Readable.from([new Uint8Array(zip)]))) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

/** A one-file ZIP (local header + DEFLATE data; enough for a streaming reader). */
function zipOf(text: string): Uint8Array {
  return Buffer.concat([localHeader(), deflateRawSync(Buffer.from(text, "utf8"))]);
}

function localHeader(): Buffer {
  const name = Buffer.from("DK_1.csv");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x08, 6); // sizes follow the data
  head.writeUInt16LE(8, 8); // DEFLATE
  head.writeUInt16LE(name.length, 26);
  return Buffer.concat([head, name]);
}

/** The site, its API and an export ZIP of `rows` copies of one row, deflated on the fly. */
function syntheticHttp(header: string, row: string, rows: number): Http {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}): Page => ({
    url,
    status: 200,
    headers,
    body: JSON.stringify(body),
    tier: "T0",
  });
  return {
    async get(request) {
      const url = typeof request === "string" ? request : request.url;
      if (url === `${RSV_SITE}/`) return json(url, "", { _ren: "token" });
      if (url.includes("regularLatestReports")) {
        return json(url, [
          { NormalizedNazev: "vypisvozidel", Guid: "synthetic", Vygenerovano: "2026-10-01T15:48" },
        ]);
      }
      if (url.includes("/vypiszregistru/synthetic")) {
        async function* csv() {
          yield Buffer.from(`﻿${header}\r\n`);
          const block = Buffer.from(`${row}\r\n`.repeat(1000));
          for (let i = 0; i < rows / 1000; i++) yield block;
        }
        const deflated = Readable.from(csv()).pipe(createDeflateRaw());
        async function* chunks() {
          yield new Uint8Array(localHeader());
          for await (const chunk of deflated) yield new Uint8Array(chunk as Buffer);
        }
        return { url, status: 200, headers: {}, body: "", chunks: chunks(), tier: "T0" };
      }
      return json(url, { results: { bindings: [] } });
    },
  };
}
