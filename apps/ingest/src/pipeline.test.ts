// End to end through public interfaces: ČNB Source (replayed) → Ledger → Publisher →
// Bundle → catalog query engine.
import { memoryLoader } from "@cca/bundle";
import { fsLoader } from "@cca/bundle/node";
import { openCatalog } from "@cca/catalog";
import { createReplayHttp, loadCassette } from "@cca/http";
import { openLedger } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { cnbSource, type Source } from "@cca/sources";
import type { ListingSeen } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { buildSampleBundle, runSource, SAMPLE } from "./ingest.ts";

const noHttp = createReplayHttp({ version: 1, interactions: [] });

function golf(ref: string): ListingSeen {
  return {
    kind: "ListingSeen",
    ref,
    url: `https://www.autoscout24.de/angebote/${ref}`,
    market: "DE",
    condition: "used",
    vehicle: { make: "VW", model: "Golf" },
    price: { amount: 15_000, currency: "EUR" },
    priceBasis: "gross",
    seller: "dealer",
    photos: [],
  };
}

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
    expect(result.rows[0]?.used?.priceCzk?.median).toBe(365_025);

    const [listing] = (await catalog.model("volkswagen/golf"))?.listings().rows ?? [];
    expect(listing?.priceCzk).toBe(365_025);
    // goods 365,025 + transport 12,000 + full inspection 4,230 + registration 800
    expect(listing?.landed).toMatchObject({
      totalCzk: 382_055,
      fxDate: "2026-10-23",
      flags: ["inspectionAssumed"],
    });
  });

  it("resumes a failed full census: slices a failed run finished are skipped, not missed", async () => {
    const ledger = openLedger(":memory:");
    const harvested: string[][] = [];
    const doneAtStart: (Date | null)[] = [];
    const as24 = (slices: Record<string, string[]>, failIn?: string): Source => ({
      id: "autoscout24-de",
      scope: "de",
      async *harvest(ctx) {
        const run: string[] = [];
        harvested.push(run);
        doneAtStart.push(ctx.checkpoint.sliceDoneAt("A"));
        for (const [slice, refs] of Object.entries(slices)) {
          if (ctx.checkpoint.sliceDoneAt(slice)) continue;
          run.push(slice);
          for (const ref of refs) yield golf(ref);
          if (slice === failIn) throw new Error("HTTP 503");
          yield { kind: "SliceDone", slice };
        }
      },
    });
    const full = (source: Source, date: string) =>
      runSource({ ledger, source, http: noHttp, mode: "full", now: new Date(`${date}T03:00:00Z`) });

    await expect(full(as24({ A: ["a1", "a2"], B: ["b1"] }, "B"), "2026-10-10")).rejects.toThrow();
    const resumed = await full(as24({ A: ["a1", "a2"], B: ["b1"] }), "2026-10-11");
    expect(resumed).toMatchObject({ census: "applied", gone: 0 });
    expect(ledger.checkpoint("autoscout24-de", "de").sliceDoneAt("A")).toBeNull();
    // A new census harvests every slice again; a2 has sold.
    await full(as24({ A: ["a1"], B: ["b1"] }), "2026-10-12");
    await full(as24({ A: ["a1"], B: ["b1"] }), "2026-10-13");

    expect(harvested).toEqual([["A", "B"], ["B"], ["A", "B"], ["A", "B"]]);
    expect(doneAtStart).toEqual([null, new Date("2026-10-10T03:00:00Z"), null, null]);
    const gone = Object.fromEntries([...ledger.snapshot().listings()].map((l) => [l.ref, l.gone]));
    // Missed first on 10-12, not on 10-11: the resumed census counted the failed run's slice A.
    expect(gone).toEqual({ a1: null, a2: "2026-10-12", b1: null });
    ledger.close();
  });

  it("the committed sample Bundle is what the pipeline produces (run `pnpm fixtures:bundle` after changes)", async () => {
    const files = await buildSampleBundle();
    const committed = fsLoader(SAMPLE.bundleDir);
    for (const [path, text] of files) expect(await committed(path), path).toBe(text);
  });
});
