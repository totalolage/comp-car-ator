// End to end through public interfaces: ČNB Source (replayed) → Ledger → Publisher →
// Bundle → catalog query engine.
import { memoryLoader } from "@cca/bundle";
import { fsLoader } from "@cca/bundle/node";
import { openCatalog } from "@cca/catalog";
import { createReplayHttp, loadCassette } from "@cca/http";
import { openLedger } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { cnbSource } from "@cca/sources";
import { describe, expect, it } from "vitest";
import { buildSampleBundle, runSource, SAMPLE } from "./ingest.ts";

describe("ingest pipeline", () => {
  it("prices a German listing in CZK with the ČNB rate harvested in the same Ledger", async () => {
    const ledger = openLedger(":memory:");
    const now = SAMPLE.now;
    const fx = await runSource({
      ledger,
      source: cnbSource(),
      http: createReplayHttp(await loadCassette(SAMPLE.cnbCassette)),
      mode: "incremental",
      now,
    });
    expect(fx.recorded.FxRate).toBeGreaterThan(25);

    await ledger.record({ source: "rsv", mode: "full", startedAt: now }, [
      {
        kind: "CatalogEntry",
        variant: {
          make: "Volkswagen",
          model: "Golf",
          generation: { slug: "mk8", name: "Golf VIII", from: 2020 },
          body: "hatchback",
          fuel: "petrol",
          powerKw: 110,
          transmission: "automatic",
          years: { from: 2020 },
        },
      },
    ]);
    await ledger.record({ source: "autoscout24-de", mode: "incremental", startedAt: now }, [
      {
        kind: "ListingSeen",
        ref: "abc",
        url: "https://www.autoscout24.de/angebote/abc",
        market: "DE",
        condition: "used",
        vehicle: {
          make: "VW",
          model: "Golf",
          fuel: "petrol",
          powerKw: 110,
          transmission: "automatic",
          firstRegistration: { year: 2021, month: 9 },
          euroClass: 6,
        },
        odometerKm: 55_000,
        price: { amount: 15_000, currency: "EUR" },
        priceBasis: "gross",
        seller: "dealer",
        photos: [],
      },
    ]);

    const catalog = await openCatalog(memoryLoader(publish(ledger, { now })));
    ledger.close();

    expect(catalog.manifest.fx.EUR).toEqual({ czkPerUnit: 24.335, validFor: "2026-10-23" });
    const result = catalog.query({ filters: { market: ["DE"] } });
    expect(result.rows.map((r) => r.id)).toEqual([
      "volkswagen/golf/mk8/hatchback-petrol-110kw-automatic",
    ]);
    expect(result.rows[0]?.used?.priceCzk.median).toBe(365_025);

    const [listing] = (await catalog.model("volkswagen/golf"))?.listings().rows ?? [];
    expect(listing?.priceCzk).toBe(365_025);
    // goods 365,025 + transport 12,000 + full inspection 4,230 + registration 800
    expect(listing?.landed).toMatchObject({
      totalCzk: 382_055,
      fxDate: "2026-10-23",
      flags: ["inspectionAssumed"],
    });
  });

  it("the committed sample Bundle is what the pipeline produces (run `pnpm fixtures:bundle` after changes)", async () => {
    const files = await buildSampleBundle();
    const committed = fsLoader(SAMPLE.bundleDir);
    for (const [path, text] of files) expect(await committed(path), path).toBe(text);
  });
});
