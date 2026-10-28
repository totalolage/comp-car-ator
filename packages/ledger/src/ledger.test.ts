import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CatalogEntry, ListingSeen, ListPrice, Observation } from "@cca/vocabulary";
import { afterEach, describe, expect, it } from "vitest";
import { type Ledger, openLedger } from "./index.ts";

const day = (d: string) => new Date(`${d}T03:00:00Z`);

function seen(ref: string, amount: number, extra: Partial<ListingSeen> = {}): ListingSeen {
  return {
    kind: "ListingSeen",
    ref,
    url: `https://www.sauto.cz/osobni/detail/skoda/octavia/${ref}`,
    market: "CZ",
    condition: "used",
    vehicle: {
      make: "Škoda",
      model: "Octavia Combi",
      fuel: "diesel",
      powerKw: 110,
      transmission: "automatic",
      firstRegistration: { year: 2021, month: 3 },
    },
    odometerKm: 98_000,
    price: { amount, currency: "CZK" },
    priceBasis: "gross",
    seller: "dealer",
    photos: [],
    ...extra,
  };
}

const octavia: CatalogEntry = {
  kind: "CatalogEntry",
  variant: {
    make: "Škoda",
    model: "Octavia",
    generation: { slug: "mk4", name: "Octavia IV", from: 2020 },
    body: "wagon",
    fuel: "diesel",
    powerKw: 110,
    years: { from: 2020 },
  },
};

let ledger: Ledger;
afterEach(() => ledger?.close());

async function run(
  source: string,
  mode: "incremental" | "full",
  date: string,
  obs: Iterable<Observation> | AsyncIterable<Observation>,
) {
  return ledger.record({ source, mode, startedAt: day(date) }, obs);
}

describe("Ledger", () => {
  it("keeps the latest FX fixing per currency", async () => {
    ledger = openLedger(":memory:");
    await run("cnb", "incremental", "2026-10-22", [
      { kind: "FxRate", currency: "EUR", validFor: "2026-10-21", czkPerUnit: 24.3 },
      { kind: "FxRate", currency: "EUR", validFor: "2026-10-22", czkPerUnit: 24.4 },
    ]);
    expect(ledger.snapshot().fx).toEqual({ EUR: { czkPerUnit: 24.4, validFor: "2026-10-22" } });
  });

  it("records listings with price history and is idempotent within a day", async () => {
    ledger = openLedger(":memory:");
    const first = await run("sauto", "incremental", "2026-10-10", [seen("1", 489_000)]);
    expect(first).toMatchObject({ newListings: 1, priceChanges: 0, recorded: { ListingSeen: 1 } });
    await run("sauto", "incremental", "2026-10-10", [seen("1", 489_000)]);
    const later = await run("sauto", "incremental", "2026-10-17", [seen("1", 479_000)]);
    expect(later).toMatchObject({ newListings: 0, priceChanges: 1 });

    const [listing] = [...ledger.snapshot().listings()];
    expect(listing).toMatchObject({
      id: "sauto:1",
      firstSeen: "2026-10-10",
      lastSeen: "2026-10-17",
      gone: null,
      price: { amount: 479_000, currency: "CZK" },
      priceHistory: [
        { date: "2026-10-10", price: { amount: 489_000, currency: "CZK" } },
        { date: "2026-10-17", price: { amount: 479_000, currency: "CZK" } },
      ],
    });
  });

  it("marks a listing gone after two complete full runs miss it, as of the first miss", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 1), seen("2", 2)]);
    const once = await run("sauto", "full", "2026-10-17", [seen("1", 1)]);
    expect(once.gone).toBe(0);
    const twice = await run("sauto", "full", "2026-10-24", [seen("1", 1)]);
    expect(twice.gone).toBe(1);
    const gone = [...ledger.snapshot().listings()].find((l) => l.id === "sauto:2");
    expect(gone?.gone).toBe("2026-10-17");
    expect(ledger.checkpoint("sauto").isKnown("2")).toBe(false);
    expect(ledger.checkpoint("sauto").isKnown("1")).toBe(true);
  });

  it("incremental runs never infer absence", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 1)]);
    await run("sauto", "incremental", "2026-10-17", []);
    await run("sauto", "incremental", "2026-10-24", []);
    expect([...ledger.snapshot().listings()][0]?.gone).toBeNull();
  });

  it("an explicit ListingGone marks the listing gone immediately", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "incremental", "2026-10-10", [seen("1", 1)]);
    const summary = await run("sauto", "incremental", "2026-10-12", [
      { kind: "ListingGone", ref: "1" },
    ]);
    expect(summary.gone).toBe(1);
    expect([...ledger.snapshot().listings()][0]?.gone).toBe("2026-10-12");
  });

  it("a failed run keeps what it recorded, infers nothing, and does not advance the checkpoint", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 1), seen("2", 2)]);
    async function* failing() {
      yield seen("3", 3);
      throw new Error("site changed");
    }
    await expect(run("sauto", "full", "2026-10-17", failing())).rejects.toThrow("site changed");
    const listings = [...ledger.snapshot().listings()];
    expect(listings.map((l) => l.id)).toEqual(["sauto:1", "sauto:2", "sauto:3"]);
    expect(listings.every((l) => l.gone === null)).toBe(true);
    expect(ledger.checkpoint("sauto").lastRunAt).toEqual(day("2026-10-10"));
  });

  it("rejects observations that break invariants and records the rest", async () => {
    ledger = openLedger(":memory:");
    const summary = await run("sauto", "incremental", "2026-10-10", [
      seen("1", Number.NaN),
      seen("", 1),
      seen("2", 2),
    ]);
    expect(summary.recorded).toEqual({ ListingSeen: 1 });
    expect(summary.rejected.map((r) => r.reason)).toEqual([
      "price must be a finite amount >= 0 with an ISO currency",
      "ref is empty",
    ]);
  });

  it("rejects a CatalogEntry whose make, model or generation has no slug", async () => {
    ledger = openLedger(":memory:");
    const v = octavia.variant;
    const summary = await run("rsv", "full", "2026-10-10", [
      { ...octavia, variant: { ...v, make: "Lada - Vaz", model: "." } },
      { ...octavia, variant: { ...v, make: "?" } },
      { ...octavia, variant: { ...v, generation: { ...v.generation, slug: "-" } } },
      { ...octavia, variant: { ...v, make: "Lada - Vaz", model: "Niva (4x4)" } },
    ]);
    expect(summary.rejected.map((r) => r.reason)).toEqual([
      "variant make/model has no slug",
      "variant make/model has no slug",
      "variant generation slug/name is empty",
    ]);
    expect(ledger.snapshot().catalog.map((c) => c.id)).toEqual([
      "lada-vaz/niva-4x4/mk4/wagon-diesel-110kw",
    ]);
  });

  it("drops catalog entries recorded with an empty id part when it opens an older Ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-ledger-"));
    try {
      const file = join(dir, "ledger.sqlite");
      openLedger(file).close();
      // A schema v2 Ledger from before the slug check, as Data releases carry.
      const db = new DatabaseSync(file);
      const insert = db.prepare(
        "INSERT INTO catalog_entries (variant_id, source, data, updated) VALUES (?, 'rsv', ?, '2026-10-01')",
      );
      const v = octavia.variant;
      const dot = {
        ...v,
        make: "Lada - Vaz",
        model: ".",
        generation: { slug: "2111", name: ". 2111" },
      };
      insert.run("lada-vaz//2111/wagon-diesel-110kw", JSON.stringify(dot));
      insert.run("/octavia/mk4/wagon-diesel-110kw", JSON.stringify({ ...v, make: "?" }));
      const noGeneration = { ...v, generation: { ...v.generation, slug: "-" } };
      insert.run("skoda/octavia//wagon-diesel-110kw", JSON.stringify(noGeneration));
      insert.run("skoda/octavia/mk4/wagon-diesel-110kw", JSON.stringify(v));
      db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
      db.close();

      ledger = openLedger(file);
      expect(ledger.snapshot().catalog.map((c) => c.id)).toEqual([
        "skoda/octavia/mk4/wagon-diesel-110kw",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("relabels the EUR prices TipCars recorded as CZK when it opens an older Ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-ledger-"));
    try {
      const file = join(dir, "ledger.sqlite");
      const czk = (amount: number) => ({ price: { amount, currency: "CZK" } });
      const eur = (amount: number) => ({ price: { amount, currency: "EUR" } });
      // Recorded before the fix (2026-10-28): a Dubai dealer's Wrangler at 10 830 EUR, then
      // 10 500 EUR; a listing the fixed adapter saw again in EUR before the Ledger was
      // corrected; one it saw again in CZK; one seller in CZK all along.
      ledger = openLedger(file);
      await run("tipcars", "full", "2026-10-26", [
        seen("56607021", 10_830),
        seen("19337165", 9_148),
        seen("1", 489_000),
      ]);
      await run("tipcars", "incremental", "2026-10-27", [
        seen("56607021", 10_500),
        seen("32587029", 9_000),
      ]);
      await run("tipcars", "incremental", "2026-10-28", [seen("32587029", 225_000)]);
      await run("tipcars", "incremental", "2026-10-29", [seen("19337165", 9_148, eur(9_148))]);
      ledger.close();
      // A schema v3 Ledger, as Data releases carry.
      const db = new DatabaseSync(file);
      db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
      db.close();

      ledger = openLedger(file);
      const listings = new Map([...ledger.snapshot().listings()].map((l) => [l.id, l]));
      expect(listings.get("tipcars:56607021")).toMatchObject({
        ...eur(10_500),
        priceHistory: [
          { date: "2026-10-26", ...eur(10_830) },
          { date: "2026-10-27", ...eur(10_500) },
        ],
      });
      expect(listings.get("tipcars:19337165")).toMatchObject({
        ...eur(9_148),
        priceHistory: [{ date: "2026-10-26", ...eur(9_148) }],
      });
      expect(listings.get("tipcars:32587029")).toMatchObject({
        ...czk(225_000),
        priceHistory: [
          { date: "2026-10-27", ...eur(9_000) },
          { date: "2026-10-28", ...czk(225_000) },
        ],
      });
      expect(listings.get("tipcars:1")).toMatchObject({
        ...czk(489_000),
        priceHistory: [{ date: "2026-10-26", ...czk(489_000) }],
      });
      const later = await run("tipcars", "incremental", "2026-11-01", [
        seen("56607021", 10_500, eur(10_500)),
      ]);
      expect(later.priceChanges).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves listings against the current catalog at snapshot time", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "incremental", "2026-10-10", [seen("1", 1)]);
    expect([...ledger.snapshot().listings()][0]?.resolution.status).toBe("unmatched");
    await run("rsv", "full", "2026-10-11", [octavia]);
    const snapshot = ledger.snapshot();
    expect(snapshot.catalog.map((v) => v.id)).toEqual(["skoda/octavia/mk4/wagon-diesel-110kw"]);
    expect([...snapshot.listings()][0]?.resolution).toEqual({
      status: "matched",
      makeId: "skoda",
      modelId: "skoda/octavia",
      variantId: "skoda/octavia/mk4/wagon-diesel-110kw",
    });
  });

  it("merges catalog entries for one Variant from several sources field by field", async () => {
    ledger = openLedger(":memory:");
    await run("rsv", "full", "2026-10-01", [
      { ...octavia, variant: { ...octavia.variant, seats: 5 } },
    ]);
    await run("eea", "full", "2026-10-02", [
      { ...octavia, variant: { ...octavia.variant, co2GKm: 126 } },
    ]);
    expect(ledger.snapshot().catalog).toMatchObject([{ seats: 5, co2GKm: 126 }]);
  });

  it("collects the gearboxes every source states for one Variant", async () => {
    ledger = openLedger(":memory:");
    const summary = await run("skoda-prices", "full", "2026-10-01", [
      { ...octavia, variant: { ...octavia.variant, transmissions: ["manual"] } },
      { ...octavia, variant: { ...octavia.variant, transmissions: [] } },
      { ...octavia, variant: { ...octavia.variant, transmissions: ["cvt" as "manual"] } },
    ]);
    expect(summary.rejected.map((r) => r.reason)).toEqual([
      "transmissions must be a non-empty list of known transmissions",
      "transmissions must be a non-empty list of known transmissions",
    ]);
    await run("rsv", "full", "2026-10-02", [octavia]);
    await run("vw-prices", "full", "2026-10-03", [
      { ...octavia, variant: { ...octavia.variant, transmissions: ["automatic", "manual"] } },
    ]);
    expect(ledger.snapshot().catalog).toMatchObject([
      { id: "skoda/octavia/mk4/wagon-diesel-110kw", transmissions: ["automatic", "manual"] },
    ]);
  });

  it("a catalog census retires the entries its Source no longer states", async () => {
    ledger = openLedger(":memory:");
    const rekeyed: CatalogEntry = {
      ...octavia,
      variant: { ...octavia.variant, generation: { ...octavia.variant.generation, slug: "nx" } },
    };
    const ids = () => ledger.snapshot().catalog.map((v) => v.id);
    await run("rsv", "full", "2026-09-01", [octavia]);
    await run("skoda-prices", "full", "2026-09-02", [rekeyed]);
    // Incremental runs, failed runs and censuses with rejections infer nothing.
    await run("rsv", "incremental", "2026-09-15", [rekeyed]);
    await expect(
      run(
        "rsv",
        "full",
        "2026-09-20",
        (async function* () {
          yield rekeyed;
          throw new Error("download interrupted");
        })(),
      ),
    ).rejects.toThrow();
    const broken = { ...rekeyed, variant: { ...rekeyed.variant, powerKw: -1 } };
    expect(await run("rsv", "full", "2026-09-25", [rekeyed, broken])).toMatchObject({
      census: "skipped-rejections",
      retired: 0,
    });
    expect(ids()).toEqual([
      "skoda/octavia/mk4/wagon-diesel-110kw",
      "skoda/octavia/nx/wagon-diesel-110kw",
    ]);

    // The next census states only the re-keyed Variant: rsv's old entry retires; the price
    // list's own census is separate.
    expect(await run("rsv", "full", "2026-10-01", [rekeyed])).toMatchObject({ retired: 1 });
    expect(ids()).toEqual(["skoda/octavia/nx/wagon-diesel-110kw"]);
    // Stating it again restores it.
    await run("rsv", "full", "2026-11-01", [octavia, rekeyed]);
    expect(ids()).toEqual([
      "skoda/octavia/mk4/wagon-diesel-110kw",
      "skoda/octavia/nx/wagon-diesel-110kw",
    ]);
  });

  it("fills missing Specs from partial VariantFacts without overriding CatalogEntries", async () => {
    ledger = openLedger(":memory:");
    await run("rsv", "full", "2026-10-01", [
      { ...octavia, variant: { ...octavia.variant, seats: 5 } },
    ]);
    await run("eea", "full", "2026-10-02", [
      {
        kind: "VariantFacts",
        vehicle: { make: "Skoda", model: "Octavia", fuel: "diesel", powerKw: 110 },
        facts: { co2GKm: 126, seats: 7 },
      },
    ]);
    expect(ledger.snapshot().catalog).toMatchObject([{ seats: 5, co2GKm: 126 }]);
  });

  it("re-recording a full run on the same day does not count a second miss", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 1), seen("2", 2)]);
    await run("sauto", "full", "2026-10-17", [seen("1", 1)]);
    const replay = await run("sauto", "full", "2026-10-17", [seen("1", 1)]);
    expect(replay.gone).toBe(0);
    expect(ledger.checkpoint("sauto").isKnown("2")).toBe(true);
  });

  it("a full run with rejected observations is not a census", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 1), seen("2", 2)]);
    const broken = [seen("1", 1), seen("2", Number.NaN)];
    expect((await run("sauto", "full", "2026-10-17", broken)).census).toBe("skipped-rejections");
    expect((await run("sauto", "full", "2026-10-24", broken)).census).toBe("skipped-rejections");
    expect([...ledger.snapshot().listings()].every((l) => l.gone === null)).toBe(true);
  });

  it("census inference stays inside the run's scope", async () => {
    ledger = openLedger(":memory:");
    const sliced = (scope: string, date: string, obs: ListingSeen[]) =>
      ledger.record({ source: "as24", mode: "full", scope, startedAt: day(date) }, obs);
    await sliced("makes:skoda", "2026-10-10", [seen("s", 1)]);
    await sliced("makes:vw", "2026-10-10", [seen("v", 1)]);
    // Two more Škoda slices without the VW listing must not retire it.
    await sliced("makes:skoda", "2026-10-17", [seen("s", 1)]);
    const third = await sliced("makes:skoda", "2026-10-24", [seen("s", 1)]);
    expect(third).toMatchObject({ census: "applied", gone: 0 });
    expect(ledger.checkpoint("as24").isKnown("v")).toBe(true);
    expect(ledger.checkpoint("as24", "makes:vw").lastRunAt).toEqual(day("2026-10-10"));
    expect(ledger.checkpoint("as24", "makes:skoda").lastRunAt).toEqual(day("2026-10-24"));
  });

  it("a slice with a rejected observation is not done", async () => {
    ledger = openLedger(":memory:");
    const failed = run("as24", "full", "2026-10-10", {
      async *[Symbol.asyncIterator]() {
        yield seen("1", 1);
        yield { kind: "SliceDone", slice: "A" } as const;
        yield seen("2", Number.NaN);
        yield { kind: "SliceDone", slice: "B" } as const;
        yield { kind: "SliceDone", slice: "B" } as const;
        throw new Error("HTTP 503");
      },
    });
    await expect(failed).rejects.toThrow("HTTP 503");
    const checkpoint = ledger.checkpoint("as24");
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-10"));
    expect(checkpoint.sliceDoneAt("B")).toBeNull();

    // A full run that completes with a rejection ends the census without inferring absence,
    // so the next census harvests every slice again.
    const rejected = await run("as24", "full", "2026-10-11", [seen("2", Number.NaN)]);
    expect(rejected.census).toBe("skipped-rejections");
    expect(ledger.checkpoint("as24").sliceDoneAt("A")).toBeNull();
  });

  it("rejects VariantFacts with unknown fields or non-finite values", async () => {
    ledger = openLedger(":memory:");
    const vehicle = { make: "Skoda", model: "Octavia" };
    const summary = await run("eea", "full", "2026-10-02", [
      { kind: "VariantFacts", vehicle, facts: { co2GKm: Number.NaN } },
      { kind: "VariantFacts", vehicle, facts: { colour: "red" } as never },
      { kind: "VariantFacts", vehicle, facts: { co2GKm: 120 } },
    ]);
    expect(summary.recorded).toEqual({ VariantFacts: 1 });
    expect(summary.rejected.map((r) => r.reason)).toEqual([
      "fact co2GKm must be a finite number >= 0",
      "unknown fact colour",
    ]);
  });
  it("gives a price-list Source the edition in force of each of its Offers", async () => {
    ledger = openLedger(":memory:");
    const edition = (ref: string, amount: number, validFrom: string, validTo?: string) =>
      ({
        kind: "ListPrice",
        ref,
        vehicle: { make: "Škoda", model: "Kodiaq", fuel: "diesel", powerKw: 110 },
        price: { amount, currency: "CZK" },
        market: "CZ",
        validFrom,
        ...(validTo ? { validTo } : {}),
      }) satisfies ListPrice;
    await run("skoda-pricelist", "full", "2026-09-02", [
      edition("a", 1_000_000, "2026-09-01"),
      edition("b", 1_100_000, "2026-09-01"),
    ]);
    await run("skoda-pricelist", "full", "2026-10-22", [
      edition("a", 1_050_000, "2026-10-21"),
      edition("b", 1_100_000, "2026-09-01", "2026-10-20"),
    ]);
    await run("vw-pricelist", "full", "2026-10-22", [edition("a", 900_000, "2026-10-01")]);

    expect(ledger.checkpoint("skoda-pricelist").offersInForce()).toEqual([
      edition("a", 1_050_000, "2026-10-21"),
    ]);
    expect(ledger.checkpoint("cnb").offersInForce()).toEqual([]);
  });
});
