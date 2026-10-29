import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CatalogEntry,
  ListingSeen,
  ListPrice,
  Observation,
  OpenpilotSupport,
} from "@cca/vocabulary";
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

/** Makes a current Ledger file look like schema `version`, as an older Data release carries it. */
function downgrade(db: DatabaseSync, version: number) {
  if (version < 6) {
    db.exec(`
      DROP INDEX listings_slice;
      ALTER TABLE listings DROP COLUMN slice;
      ALTER TABLE listings DROP COLUMN missed_census;
      ALTER TABLE runs DROP COLUMN census;
    `);
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
}

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

  it("reprices a live listing from a price-only sighting, leaving the rest and when it was seen", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "full", "2026-10-10", [seen("1", 489_000), seen("2", 1)]);
    const price = (ref: string, amount: number, currency = "CZK"): Observation => ({
      kind: "ListingPriceSeen",
      ref,
      price: { amount, currency },
    });
    const unchanged = await run("sauto", "incremental", "2026-10-11", [price("1", 489_000)]);
    expect(unchanged).toMatchObject({ priceChanges: 0, rejected: [] });
    const later = await run("sauto", "incremental", "2026-10-12", [
      price("1", 479_000),
      // Only a ListingSeen adds a listing or changes its currency.
      price("9", 1),
      price("2", 1, "EUR"),
    ]);
    expect(later).toMatchObject({ priceChanges: 1, recorded: { ListingPriceSeen: 1 } });
    expect(later.rejected.map((r) => r.reason)).toEqual([
      "no live listing with this ref to reprice",
      "price currency EUR differs from the listing's CZK",
    ]);

    const [listing] = [...ledger.snapshot().listings()];
    expect(listing).toMatchObject({
      id: "sauto:1",
      lastSeen: "2026-10-10",
      price: { amount: 479_000, currency: "CZK" },
      priceBasis: "gross",
      vehicle: { powerKw: 110 },
      priceHistory: [
        { date: "2026-10-10", price: { amount: 489_000, currency: "CZK" } },
        { date: "2026-10-12", price: { amount: 479_000, currency: "CZK" } },
      ],
    });
    // A price-only sighting is a census sighting: a listing full runs miss stays live by it.
    await run("sauto", "full", "2026-10-17", [seen("2", 1)]);
    await run("sauto", "incremental", "2026-10-18", [price("1", 479_000)]);
    expect((await run("sauto", "full", "2026-10-24", [seen("2", 1)])).gone).toBe(0);
    const twice = await run("sauto", "full", "2026-10-31", [seen("2", 1)]);
    expect(twice.gone).toBe(1);
    const gone = await run("sauto", "incremental", "2026-11-01", [price("1", 1)]);
    expect(gone.rejected).toHaveLength(1);
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
      downgrade(db, 2);
      db.close();

      ledger = openLedger(file);
      expect(ledger.snapshot().catalog.map((c) => c.id)).toEqual([
        "skoda/octavia/mk4/wagon-diesel-110kw",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the slice of the Bazoš and TipCars listings and the census of the runs an older Ledger holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-ledger-"));
    try {
      const file = join(dir, "ledger.sqlite");
      ledger = openLedger(file);
      const bazos = (ref: string) =>
        seen(ref, 1, {
          vehicle: { make: "Škoda", model: "Octavia", sourceTaxonomy: { make: "skoda" } },
        });
      const used2019 = seen("u", 1, {
        vehicle: { make: "Škoda", model: "Fabia", manufactureYear: 2019 },
      });
      const fresh = seen("n", 1, { condition: "new" });
      await run("bazos", "full", "2026-10-04", [bazos("13"), bazos("23")]);
      await run("tipcars", "full", "2026-10-04", [used2019, fresh]);
      // The next census's first day finished part 3 without ad 23, before the upgrade.
      async function* failing() {
        yield bazos("13");
        yield { kind: "SliceDone", slice: "skoda;part=3/10" } as const;
        throw new Error("Ford never finishes");
      }
      await expect(run("bazos", "full", "2026-10-11", failing())).rejects.toThrow();
      ledger.close();
      // A schema v5 Ledger, from before listings named their slice and runs their census.
      const db = new DatabaseSync(file);
      downgrade(db, 5);
      db.exec("UPDATE listings SET missed_full_runs = 0, first_missed = NULL, last_missed = NULL");
      db.close();

      ledger = openLedger(file);
      // The census carries on: part 3 stays done.
      expect(ledger.checkpoint("bazos").sliceDoneAt("skoda;part=3/10")).toEqual(day("2026-10-11"));
      /** A census week where some slice never finishes: Sunday, then retries that finish none. */
      const week = async (source: string, sunday: string, obs: Observation[]) => {
        const days = [sunday, `${sunday.slice(0, 8)}${Number(sunday.slice(8)) + 1}`];
        days.push(`${sunday.slice(0, 8)}${Number(sunday.slice(8)) + 6}`);
        for (const [i, date] of days.entries()) {
          async function* failing() {
            if (i === 0) yield* obs;
            throw new Error("never finishes");
          }
          await expect(run(source, "full", date, failing())).rejects.toThrow();
        }
      };
      const part3 = { kind: "SliceDone", slice: "skoda;part=3/10" } as const;
      await week("bazos", "2026-10-18", [bazos("13"), part3]);
      await week("bazos", "2026-10-25", [bazos("13"), part3]);
      const years = [
        fresh,
        { kind: "SliceDone", slice: "used:2019" },
        { kind: "SliceDone", slice: "new" },
      ] as const;
      await week("bazos", "2026-11-01", []);
      await week("tipcars", "2026-10-11", [...years]);
      await week("tipcars", "2026-10-18", [...years]);
      await week("tipcars", "2026-10-25", []);
      expect(
        Object.fromEntries([...ledger.snapshot().listings()].map((l) => [l.id, l.gone])),
      ).toEqual({
        "bazos:13": null,
        "bazos:23": "2026-10-18",
        "tipcars:n": null,
        "tipcars:u": "2026-10-11",
      });
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
      // Recorded before the fix (2026-10-28), against the EUR amounts confirmed on TipCars:
      // a Dubai dealer's Wrangler at its 10 830 EUR; a listing the fixed adapter saw again
      // in EUR before the Ledger was corrected; one it saw again in CZK; a seller in CZK
      // who switched to EUR before the fix, and one who switched on the day of the fix; one
      // held at an amount other than the confirmed 9 920 EUR, whose price went up and back the
      // same day; one priced in CZK at its confirmed amount after the fix; one seller in CZK
      // all along.
      ledger = openLedger(file);
      await run("tipcars", "full", "2026-10-25", [seen("32587046", 400_000)]);
      await run("tipcars", "full", "2026-10-26", [
        seen("56607021", 10_830),
        seen("19337165", 55_000),
        seen("32587046", 16_800),
        seen("32587182", 9_500),
        seen("1", 489_000),
      ]);
      await run("tipcars", "incremental", "2026-10-27", [
        seen("32587029", 15_900),
        seen("32587151", 450_000),
        seen("32587182", 9_600),
      ]);
      await run("tipcars", "incremental", "2026-10-27", [seen("32587182", 9_500)]);
      await run("tipcars", "incremental", "2026-10-28", [
        seen("32587029", 225_000),
        seen("32587151", 20_500, eur(20_500)),
        seen("32587193", 22_600),
      ]);
      await run("tipcars", "incremental", "2026-10-29", [seen("19337165", 55_000, eur(55_000))]);
      ledger.close();
      // A schema v3 Ledger, as Data releases carry.
      const db = new DatabaseSync(file);
      downgrade(db, 3);
      db.close();

      ledger = openLedger(file);
      const listings = new Map([...ledger.snapshot().listings()].map((l) => [l.id, l]));
      expect(listings.get("tipcars:56607021")).toMatchObject({
        ...eur(10_830),
        priceHistory: [{ date: "2026-10-26", ...eur(10_830) }],
      });
      expect(listings.get("tipcars:19337165")).toMatchObject({
        ...eur(55_000),
        priceHistory: [
          { date: "2026-10-26", ...eur(55_000) },
          { date: "2026-10-29", ...eur(55_000) },
        ],
      });
      expect(listings.get("tipcars:32587029")).toMatchObject({
        ...czk(225_000),
        priceHistory: [
          { date: "2026-10-27", ...eur(15_900) },
          { date: "2026-10-28", ...czk(225_000) },
        ],
      });
      expect(listings.get("tipcars:32587046")).toMatchObject({
        ...eur(16_800),
        priceHistory: [
          { date: "2026-10-25", ...czk(400_000) },
          { date: "2026-10-26", ...eur(16_800) },
        ],
      });
      expect(listings.get("tipcars:32587151")).toMatchObject({
        ...eur(20_500),
        priceHistory: [
          { date: "2026-10-27", ...czk(450_000) },
          { date: "2026-10-28", ...eur(20_500) },
        ],
      });
      expect(listings.get("tipcars:32587182")).toMatchObject({
        ...czk(9_500),
        priceHistory: [
          { date: "2026-10-26", ...czk(9_500) },
          { date: "2026-10-27", ...czk(9_500) },
        ],
      });
      expect(listings.get("tipcars:32587193")).toMatchObject({
        ...czk(22_600),
        priceHistory: [{ date: "2026-10-28", ...czk(22_600) }],
      });
      expect(listings.get("tipcars:1")).toMatchObject({
        ...czk(489_000),
        priceHistory: [{ date: "2026-10-26", ...czk(489_000) }],
      });
      const later = await run("tipcars", "incremental", "2026-11-01", [
        seen("56607021", 10_830, eur(10_830)),
      ]);
      expect(later.priceChanges).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps repeated EUR TipCars history points when correcting an older Ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-ledger-"));
    try {
      const file = join(dir, "ledger.sqlite");
      const eur = { price: { amount: 10_830, currency: "EUR" as const } };
      ledger = openLedger(file);
      await run("tipcars", "full", "2026-10-26", [seen("56607021", 10_830, eur)]);
      ledger.close();

      const db = new DatabaseSync(file);
      downgrade(db, 3);
      db.prepare(
        "INSERT INTO price_history (listing_id, date, amount, currency) VALUES (?, ?, ?, ?)",
      ).run("tipcars:56607021", "2026-10-27", 10_830, "EUR");
      db.close();

      ledger = openLedger(file);
      const listing = [...ledger.snapshot().listings()][0];
      expect(listing?.priceHistory).toEqual([
        { date: "2026-10-26", price: { amount: 10_830, currency: "EUR" } },
        { date: "2026-10-27", price: { amount: 10_830, currency: "EUR" } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("relabels as gross the Sauto prices recorded as net when it opens an older Ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-ledger-"));
    try {
      const file = join(dir, "ledger.sqlite");
      const czk = (amount: number) => ({ price: { amount, currency: "CZK" } });
      // A Sauto seller who priced without VAT and later cut the price; a Sauto listing with
      // deductible VAT; another Source's net price, which stays.
      ledger = openLedger(file);
      await run("sauto", "incremental", "2026-10-26", [
        seen("1", 605_000, { priceBasis: "net" }),
        seen("2", 489_000),
      ]);
      await run("sauto", "incremental", "2026-10-27", [seen("1", 580_800, { priceBasis: "net" })]);
      await run("bazos", "incremental", "2026-10-27", [seen("3", 400_000, { priceBasis: "net" })]);
      ledger.close();
      // A schema v4 Ledger, as Data releases carry.
      const db = new DatabaseSync(file);
      downgrade(db, 4);
      db.close();

      ledger = openLedger(file);
      const listings = new Map([...ledger.snapshot().listings()].map((l) => [l.id, l]));
      expect(listings.get("sauto:1")).toMatchObject({
        ...czk(580_800),
        priceBasis: "gross",
        priceHistory: [
          { date: "2026-10-26", ...czk(605_000) },
          { date: "2026-10-27", ...czk(580_800) },
        ],
      });
      expect(listings.get("sauto:2")).toMatchObject({ ...czk(489_000), priceBasis: "gross" });
      expect(listings.get("bazos:3")).toMatchObject({
        ...czk(400_000),
        priceBasis: "net",
        priceHistory: [{ date: "2026-10-27", ...czk(400_000) }],
      });
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

  describe("openpilot list rows", () => {
    function variant(
      model: string,
      generation: CatalogEntry["variant"]["generation"],
      fuel: CatalogEntry["variant"]["fuel"],
      powerKw: number,
      years: CatalogEntry["variant"]["years"],
    ): CatalogEntry {
      const make = model === "Golf" ? "Volkswagen" : model === "Sorento" ? "Kia" : "Hyundai";
      return {
        kind: "CatalogEntry",
        variant: { make, model, generation, body: "hatchback", fuel, powerKw, years },
      };
    }
    const mk7 = { slug: "au", name: "Golf VII", from: 2012, to: 2020 };
    const mk8 = { slug: "cd", name: "Golf VIII", from: 2020 };
    const kona = { slug: "os", name: "Kona I", from: 2017, to: 2023 };
    // A register type spanning both Generations (ADR 0011).
    const wide = { slug: "1k", name: "Golf 1K", from: 2004, to: 2019 };
    const catalog = [
      variant("Golf", mk7, "petrol", 81, { from: 2012, to: 2020 }),
      variant("Golf", mk7, "petrol", 110, { from: 2012, to: 2014 }),
      // A Variant ending in the row's first year, an earlier car filed under the same
      // type, and the e-Golf.
      variant("Golf", mk7, "petrol", 63, { from: 2013, to: 2015 }),
      variant("Golf", wide, "diesel", 77, { from: 2009, to: 2016 }),
      variant("Golf", mk7, "bev", 100, { from: 2014, to: 2020 }),
      variant("Golf", wide, "petrol", 59, { from: 2004, to: 2019 }),
      // One type over two designs: the earlier car's Variant runs on into the later one's.
      variant(
        "Santa Fe",
        { slug: "tm", name: "Santa Fe TM", from: 2008, to: 2024 },
        "petrol",
        110,
        {
          from: 2008,
          to: 2020,
        },
      ),
      variant(
        "Santa Fe",
        { slug: "tm", name: "Santa Fe TM", from: 2008, to: 2024 },
        "diesel",
        147,
        {
          from: 2018,
          to: 2024,
        },
      ),
      // Two types that overlap without one inside the other.
      variant("Tucson", { slug: "a", name: "Tucson A", from: 2010, to: 2020 }, "petrol", 70, {
        from: 2010,
        to: 2020,
      }),
      variant("Tucson", { slug: "b", name: "Tucson B", from: 2015, to: 2022 }, "petrol", 71, {
        from: 2015,
        to: 2022,
      }),
      variant("Golf", mk8, "petrol", 110, { from: 2020 }),
      variant("Kona", kona, "petrol", 88, { from: 2017, to: 2023 }),
      variant("Kona", kona, "bev", 150, { from: 2018, to: 2023 }),
    ];
    // Each row is its own platform unless it names one.
    function row(model: string, years: number[], extra: Partial<OpenpilotSupport> = {}) {
      const make = model.startsWith("Golf")
        ? "Volkswagen"
        : model.startsWith("Sorento")
          ? "Kia"
          : "Hyundai";
      return {
        kind: "OpenpilotSupport",
        ref: `${make}|${model} ${years.join(",")}`,
        make,
        model,
        years,
        platform: `${model} ${years.join(",")}`,
        level: "upstream",
        market: "US",
        url: "https://comma.ai/vehicles",
        ...extra,
      } satisfies OpenpilotSupport;
    }
    const placed = () =>
      Object.fromEntries(
        ledger
          .snapshot()
          .openpilot.map((m) => [`${m.model} ${m.years.join(",")}`, [m.modelId, m.variantIds]]),
      );

    it("places a row on the Generation its model years fall in and the Variants that fit", async () => {
      ledger = openLedger(":memory:");
      await run("rsv", "full", "2026-10-01", catalog);
      await run("comma-openpilot", "full", "2026-10-02", [
        // Mostly Golf VII: not Golf VIII, nor a Golf VII Variant built only before 2015 or
        // ending in 2015, nor the e-Golf, which is listed on its own.
        row("Golf", [2015, 2016, 2017, 2018, 2019, 2020]),
        // Wholly inside both Golf VII and the wider type: the narrower one.
        row("Golf R", [2015, 2016, 2017, 2018]),
        // One year both Generations were built in decides nothing.
        row("Golf", [2020], { package: "Adaptive Cruise Control (ACC) & Lane Assist" }),
        // The combustion Kona: the electric one is listed on its own.
        row("Kona", [2020]),
        row("Kona Electric", [2018, 2019, 2020, 2021], { fuel: "bev" }),
        // Rows for other markets, and models the catalog does not know, stay unplaced, even
        // where the Resolver would take the longer name for a shorter one.
        row("Kona", [2022], { market: "China", europe: false }),
        // Mostly before the only Kona Generation the catalog has.
        row("Kona", [2015, 2016, 2017, 2018]),
        // Wholly inside two types, neither inside the other.
        row("Tucson", [2016, 2017]),
        row("Santa Fe", [2019, 2020, 2021]),
        row("Golf Cabriolet", [2016]),
        // A car comma defines no platform for.
        row("Kona", [2019], { platform: undefined }),
      ]);
      expect(placed()).toEqual({
        "Golf 2015,2016,2017,2018,2019,2020": [
          "volkswagen/golf",
          ["volkswagen/golf/au/hatchback-petrol-81kw"],
        ],
        "Golf R 2015,2016,2017,2018": [
          "volkswagen/golf",
          ["volkswagen/golf/au/hatchback-petrol-81kw"],
        ],
        "Golf 2020": ["volkswagen/golf", []],
        "Kona 2020": ["hyundai/kona", ["hyundai/kona/os/hatchback-petrol-88kw"]],
        "Kona Electric 2018,2019,2020,2021": [
          "hyundai/kona",
          ["hyundai/kona/os/hatchback-bev-150kw"],
        ],
        "Kona 2022": [null, []],
        "Kona 2015,2016,2017,2018": ["hyundai/kona", []],
        "Tucson 2016,2017": ["hyundai/tucson", []],
        "Santa Fe 2019,2020,2021": [
          "hyundai/santa-fe",
          ["hyundai/santa-fe/tm/hatchback-diesel-147kw"],
        ],
        "Golf Cabriolet 2016": ["volkswagen/golf", []],
        "Kona 2019": ["hyundai/kona", []],
      });
      const kona = ledger.snapshot().openpilot.find((m) => m.row.endsWith("Kona 2020"));
      expect(kona).toMatchObject({
        row: "comma-openpilot:Hyundai|Kona 2020",
        level: "upstream",
        market: "US",
        generationIds: ["hyundai/kona/os"],
      });
    });

    it("reads a platform's Generation from all its rows, and no year on a changeover decides", async () => {
      const tl = { slug: "tl", name: "Tucson TL", from: 2015, to: 2020 };
      const nx4 = { slug: "nx4", name: "Tucson NX4", from: 2021 };
      const um = { slug: "um", name: "Sorento UM", from: 2015, to: 2020 };
      const mq4 = { slug: "mq4", name: "Sorento MQ4", from: 2020 };
      ledger = openLedger(":memory:");
      await run("rsv", "full", "2026-10-01", [
        variant("Tucson", tl, "petrol", 97, { from: 2015, to: 2021 }),
        variant("Tucson", tl, "diesel", 100, { from: 2015, to: 2020 }),
        variant("Tucson", nx4, "petrol", 110, { from: 2020 }),
        // Registered three years before its Generation: an earlier engine filed under it.
        variant("Tucson", nx4, "petrol", 130, { from: 2018, to: 2024 }),
        variant("Sorento", um, "diesel", 147, { from: 2015, to: 2020 }),
        variant("Sorento", mq4, "diesel", 148, { from: 2020 }),
      ]);
      await run("comma-openpilot", "full", "2026-10-02", [
        // comma's US Tucson 2021 is the TL, though the register's NX4 starts in 2021: its
        // platform's other row is a TL, so the platform holds both Generations.
        row("Tucson", [2021], { platform: "HYUNDAI_TUCSON" }),
        row("Tucson Diesel", [2019], { platform: "HYUNDAI_TUCSON", fuel: "diesel" }),
        row("Tucson", [2022], { platform: "HYUNDAI_TUCSON_4TH_GEN" }),
        row("Tucson", [2023, 2024], { platform: "HYUNDAI_TUCSON_4TH_GEN" }),
        // Alone on its platform, a changeover year names no Generation either.
        row("Tucson", [2021], {
          ref: "Hyundai|Tucson 2021|alone",
          platform: "HYUNDAI_TUCSON_ALONE",
        }),
        // One platform, wholly the UM: its 2018 row is placed, its 2019 one sits within a
        // year of the MQ4. A row with years clear of the changeover is placed on them.
        row("Sorento", [2018], { platform: "KIA_SORENTO" }),
        row("Sorento", [2019], { platform: "KIA_SORENTO" }),
        row("Sorento", [2021, 2022, 2023], { platform: "KIA_SORENTO_4TH_GEN" }),
      ]);
      const where = Object.fromEntries(
        ledger
          .snapshot()
          .openpilot.map((m) => [
            `${m.model} ${m.years.join(",")} ${m.platform}`,
            [m.generationIds, m.variantIds],
          ]),
      );
      expect(where).toEqual({
        "Tucson 2021 HYUNDAI_TUCSON": [[], []],
        "Tucson Diesel 2019 HYUNDAI_TUCSON": [[], []],
        "Tucson 2022 HYUNDAI_TUCSON_4TH_GEN": [
          ["hyundai/tucson/nx4"],
          ["hyundai/tucson/nx4/hatchback-petrol-110kw"],
        ],
        "Tucson 2023,2024 HYUNDAI_TUCSON_4TH_GEN": [
          ["hyundai/tucson/nx4"],
          ["hyundai/tucson/nx4/hatchback-petrol-110kw"],
        ],
        "Tucson 2021 HYUNDAI_TUCSON_ALONE": [[], []],
        "Sorento 2018 KIA_SORENTO": [["kia/sorento/um"], ["kia/sorento/um/hatchback-diesel-147kw"]],
        "Sorento 2019 KIA_SORENTO": [[], []],
        "Sorento 2021,2022,2023 KIA_SORENTO_4TH_GEN": [
          ["kia/sorento/mq4"],
          ["kia/sorento/mq4/hatchback-diesel-148kw"],
        ],
      });
    });

    it("places no platform that is two cars, and no row on a changeover", async () => {
      const g = (slug: string, from: number, to?: number) => ({
        slug,
        name: slug,
        from,
        ...(to ? { to } : {}),
      });
      ledger = openLedger(":memory:");
      await run("rsv", "full", "2026-10-01", [
        // Most of the platform's years in one Generation, the rest clear in the next.
        variant("Elantra", g("a", 2015, 2020), "petrol", 90, { from: 2015, to: 2020 }),
        variant("Elantra", g("b", 2021), "petrol", 91, { from: 2021 }),
        // Two Generations still built: two starts, not one inside the other.
        variant("Ioniq", g("c", 2015), "petrol", 92, { from: 2015 }),
        variant("Ioniq", g("d", 2021), "petrol", 93, { from: 2021 }),
        // A successor that has run longer than one design is still a changeover.
        variant("Bayon", g("e", 2010, 2016), "petrol", 94, { from: 2010, to: 2016 }),
        variant("Bayon", g("f", 2017), "petrol", 95, { from: 2017, to: 2026 }),
        // A long successor overlapping its predecessor, and a long open one beside an open
        // predecessor: both still mark a changeover.
        variant("Venue", g("g", 2010, 2018), "petrol", 96, { from: 2010, to: 2018 }),
        variant("Venue", g("h", 2017), "petrol", 97, { from: 2017 }),
        variant("Getz", g("i", 2005), "petrol", 98, { from: 2009 }),
        variant("Getz", g("j", 2015), "petrol", 99, { from: 2015 }),
        // A long type begun earlier and overlapping the chosen one may be its predecessor.
        variant("Accent", g("k", 2005, 2018), "petrol", 100, { from: 2005, to: 2018 }),
        variant("Accent", g("l", 2015), "petrol", 101, { from: 2015 }),
        variant("i10", g("m", 2005, 2018), "petrol", 102, { from: 2005, to: 2018 }),
        variant("i10", g("n", 2015), "petrol", 103, { from: 2015 }),
      ]);
      await run("comma-openpilot", "full", "2026-10-02", [
        row("Elantra", [2017, 2018, 2019, 2020, 2021, 2022, 2023], { platform: "E" }),
        row("Ioniq", [2018, 2019], { platform: "I" }),
        row("Ioniq", [2021], { platform: "I" }),
        row("Bayon", [2015], { platform: "B" }),
        row("Bayon", [2016], { platform: "B" }),
        row("Venue", [2015], { platform: "V" }),
        row("Venue", [2016], { platform: "V" }),
        row("Venue", [2017], { platform: "V" }),
        row("Getz", [2010, 2011], { platform: "G" }),
        row("Getz", [2016], { platform: "G" }),
        row("Accent", [2015], { platform: "A" }),
        row("Accent", [2021, 2022], { platform: "A" }),
        // Years clear in that earlier type too: two cars.
        row("i10", [2012, 2013], { platform: "T" }),
        row("i10", [2015], { platform: "T" }),
        row("i10", [2021, 2022, 2023], { platform: "T" }),
      ]);
      expect(
        Object.fromEntries(
          ledger.snapshot().openpilot.map((m) => [`${m.model} ${m.years.join(",")}`, m.variantIds]),
        ),
      ).toEqual({
        "Elantra 2017,2018,2019,2020,2021,2022,2023": [],
        "Ioniq 2018,2019": ["hyundai/ioniq/c/hatchback-petrol-92kw"],
        "Ioniq 2021": [],
        "Bayon 2015": ["hyundai/bayon/e/hatchback-petrol-94kw"],
        "Bayon 2016": [],
        "Venue 2015": ["hyundai/venue/g/hatchback-petrol-96kw"],
        "Venue 2016": [],
        "Venue 2017": [],
        "Getz 2010,2011": ["hyundai/getz/i/hatchback-petrol-98kw"],
        "Getz 2016": [],
        "Accent 2015": [],
        "Accent 2021,2022": ["hyundai/accent/l/hatchback-petrol-101kw"],
        "i10 2012,2013": [],
        "i10 2015": [],
        "i10 2021,2022,2023": [],
      });
    });

    it("a census retires the rows the list no longer states", async () => {
      ledger = openLedger(":memory:");
      await run("rsv", "full", "2026-10-01", catalog);
      await run("comma-openpilot", "full", "2026-10-02", [
        row("Kona", [2020]),
        row("Golf", [2016]),
      ]);
      await run("comma-openpilot", "incremental", "2026-10-05", [row("Kona", [2020])]);
      expect(ledger.snapshot().openpilot).toHaveLength(2);
      const census = await run("comma-openpilot", "full", "2026-10-09", [row("Kona", [2020])]);
      expect(census).toMatchObject({ census: "applied", retired: 1 });
      expect(ledger.snapshot().openpilot.map((m) => m.row)).toEqual([
        "comma-openpilot:Hyundai|Kona 2020",
      ]);
    });

    it("rejects rows with unordered years or an unknown level", async () => {
      ledger = openLedger(":memory:");
      const summary = await run("comma-openpilot", "full", "2026-10-02", [
        row("Kona", [2021, 2020]),
        row("Kona", [2020], { level: "works" as never }),
        row("Kona", [2020], { minSteerKmh: -1 }),
        row("Kona", [2020]),
      ]);
      expect(summary.recorded).toEqual({ OpenpilotSupport: 1 });
      expect(summary.rejected.map((r) => r.reason)).toEqual([
        "years must be a non-empty ascending list of years",
        "unknown level works",
        "speeds must be finite numbers >= 0",
      ]);
    });
  });
});

describe("Ledger absence per finished slice", () => {
  const inSlice = (ref: string, slice: string) => seen(ref, 1, { slice });
  const done = (slice: string) => ({ kind: "SliceDone", slice }) as const;
  const plusDays = (date: string, days: number) =>
    new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  /** A full run of a Source whose slice B never finishes: it yields `obs`, then fails. */
  async function unfinished(date: string, obs: Observation[]) {
    async function* failing() {
      yield* obs;
      throw new Error("slice B never finishes");
    }
    await expect(run("bazos", "full", date, failing())).rejects.toThrow("never finishes");
  }

  /** A census week: Sunday harvests what it can, then daily retries finish nothing. */
  async function stalledWeek(sunday: string, obs: Observation[]) {
    await unfinished(sunday, obs);
    await unfinished(plusDays(sunday, 1), []);
    await unfinished(plusDays(sunday, 6), []);
  }

  const goneOf = () =>
    Object.fromEntries([...ledger.snapshot().listings()].map((l) => [l.ref, l.gone]));

  it("retires listings of a finished slice while another slice never finishes", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [
      inSlice("a1", "A"),
      inSlice("a2", "A"),
      done("A"),
      inSlice("b1", "B"),
      inSlice("b2", "B"),
    ]);
    // a2 has sold; b2 is somewhere in B, which is never read whole.
    await stalledWeek("2026-10-11", [inSlice("a1", "A"), done("A"), inSlice("b1", "B")]);
    expect(goneOf()).toEqual({ a1: null, a2: null, b1: null, b2: null });
    await stalledWeek("2026-10-18", [inSlice("a1", "A"), done("A"), inSlice("b1", "B")]);
    await stalledWeek("2026-10-25", [inSlice("a1", "A"), done("A")]);
    // Missed by two censuses, gone as of the first miss; B's listings are never missed.
    expect(goneOf()).toEqual({ a1: null, a2: "2026-10-11", b1: null, b2: null });
  });

  it("a stalled census gives way to a new one after a week, a progressing one does not", async () => {
    ledger = openLedger(":memory:");
    await unfinished("2026-10-04", [inSlice("a1", "A"), done("A")]);
    await unfinished("2026-10-05", []);
    await unfinished("2026-10-09", []);
    // Its runs span 5 days: A stays done.
    expect(ledger.checkpoint("bazos").sliceDoneAt("A")).toEqual(day("2026-10-04"));
    await unfinished("2026-10-10", []);
    expect(ledger.checkpoint("bazos").sliceDoneAt("A")).toBeNull();

    // A census that finishes a slice every day carries on past a week.
    await unfinished("2026-10-11", [done("A")]);
    for (let d = 1; d <= 8; d++) await unfinished(plusDays("2026-10-11", d), [done(`C${d}`)]);
    const checkpoint = ledger.checkpoint("bazos");
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-11"));
    expect(checkpoint.sliceDoneAt("C8")).toEqual(day("2026-10-19"));
  });

  it("does not retire a listing that moved into an unfinished slice", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("m", "A"), inSlice("p", "A"), done("A")]);
    // m moves to B, whose walk meets it without finishing; p moves too, but only its price is
    // met (ListingPriceSeen), so the Ledger still holds it in A.
    const price = { kind: "ListingPriceSeen", ref: "p", price: { amount: 1, currency: "CZK" } };
    await stalledWeek("2026-10-11", [done("A"), inSlice("m", "B"), price as Observation]);
    await stalledWeek("2026-10-18", [done("A"), price as Observation]);
    await stalledWeek("2026-10-25", [done("A"), price as Observation]);
    // m was last seen in B, which no census finishes; p was seen in every census.
    expect(goneOf()).toEqual({ m: null, p: null });
  });

  it("keeps a listing live that a failing run met before its failure", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("m", "A"), done("A")]);
    // m moved to B. Bazos meets it in B's walk and gives it a price there, as met; a later
    // request fails the run before B finishes.
    const price = { kind: "ListingPriceSeen", ref: "m", price: { amount: 1, currency: "CZK" } };
    await stalledWeek("2026-10-11", [done("A"), price as Observation]);
    await stalledWeek("2026-10-18", [done("A"), price as Observation]);
    // The next census fails before reaching B.
    await unfinished("2026-10-25", [done("A")]);
    expect(goneOf()).toEqual({ m: null });
  });

  it("a rejected sighting naming its slice keeps that one not done, not the next SliceDone", async () => {
    ledger = openLedger(":memory:");
    await unfinished("2026-10-04", [inSlice("a1", "A"), inSlice("b1", "B"), done("A")]);
    // Met while another slice's walk runs: a1's row, unreadable, naming A.
    await unfinished("2026-10-11", [{ ...inSlice("a1", "A"), url: "" }, done("C"), done("A")]);
    const checkpoint = ledger.checkpoint("bazos");
    expect(checkpoint.sliceDoneAt("C")).toEqual(day("2026-10-11"));
    // A's SliceDone in that run is rejected; the earlier one stands.
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-04"));
    // One naming no slice still keeps the next SliceDone from counting.
    const unnamed = { ...seen("b1", 1), url: "" };
    await unfinished("2026-10-12", [unnamed, done("D")]);
    expect(ledger.checkpoint("bazos").sliceDoneAt("D")).toBeNull();
  });

  it("retires a listing missed twice only once the census of its second miss is over", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("a1", "A"), inSlice("m", "A"), done("A")]);
    await stalledWeek("2026-10-11", [inSlice("a1", "A"), done("A")]);
    await unfinished("2026-10-18", [inSlice("a1", "A"), done("A")]);
    // m moved to B, whose walk (not taken) a later run of this census meets it on.
    expect(goneOf()).toEqual({ a1: null, m: null });
    const price = { kind: "ListingPriceSeen", ref: "m", price: { amount: 1, currency: "CZK" } };
    await unfinished("2026-10-19", [price as Observation]);
    await unfinished("2026-10-24", []);
    await stalledWeek("2026-10-25", [inSlice("a1", "A"), done("A")]);
    expect(goneOf()).toEqual({ a1: null, m: null });
  });

  it("a rejected sighting in a later run of the census clears a pending second miss", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("a1", "A"), inSlice("x", "A"), done("A")]);
    await stalledWeek("2026-10-11", [inSlice("a1", "A"), done("A")]);
    await unfinished("2026-10-18", [inSlice("a1", "A"), done("A")]);
    // The census ends the next day; x is met there, but its page no longer parses.
    const broken = { ...inSlice("x", "B"), url: "" };
    const end = await run("bazos", "full", "2026-10-19", [broken, done("B")]);
    expect(end).toMatchObject({ census: "skipped-rejections", gone: 0 });
    expect(goneOf()).toEqual({ a1: null, x: null });
  });

  it("a rejected sighting keeps the slice the Ledger holds the listing in not done", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("a1", "A"), inSlice("m", "A"), done("A")]);
    // m moved to B and its card no longer parses there.
    const broken = { ...inSlice("m", "B"), url: "" };
    for (const sunday of ["2026-10-11", "2026-10-18", "2026-10-25"]) {
      await stalledWeek(sunday, [inSlice("a1", "A"), done("A"), broken]);
    }
    expect(goneOf()).toEqual({ a1: null, m: null });
  });

  it("counts at most one miss per census, even when it ends after its slices", async () => {
    ledger = openLedger(":memory:");
    await run("bazos", "full", "2026-10-04", [inSlice("a1", "A"), inSlice("x", "A")]);
    await unfinished("2026-10-11", [inSlice("a1", "A"), done("A")]);
    // The census completes the next day: x is missed once, by this census.
    const end = await run("bazos", "full", "2026-10-12", [inSlice("b1", "B"), done("B")]);
    expect(end).toMatchObject({ census: "applied", gone: 0 });
    const next = await run("bazos", "full", "2026-10-18", [
      inSlice("a1", "A"),
      done("A"),
      inSlice("b1", "B"),
      done("B"),
    ]);
    expect(next.gone).toBe(1);
    expect(goneOf()).toEqual({ a1: null, b1: null, x: "2026-10-11" });
  });

  it("a rejected sighting of a listing keeps its slice not done and its listings unmissed", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("a1", "A"), inSlice("a2", "A"), done("A")]);
    const broken = { ...inSlice("a2", "A"), price: { amount: Number.NaN, currency: "CZK" } };
    // Before the SliceDone of its slice, and after it (the slice is undone).
    for (const [sunday, obs] of [
      ["2026-10-11", [inSlice("a1", "A"), broken, done("A")]],
      ["2026-10-18", [inSlice("a1", "A"), done("A"), broken]],
      ["2026-10-25", [inSlice("a1", "A"), done("A"), broken]],
    ] as const) {
      await unfinished(sunday, [...obs]);
      expect(ledger.checkpoint("bazos").sliceDoneAt("A")).toBeNull();
      await unfinished(plusDays(sunday, 1), []);
      await unfinished(plusDays(sunday, 6), []);
    }
    expect(goneOf()).toEqual({ a1: null, a2: null });
  });

  it("keeps a listing's slice out of the published listing and between sightings without one", async () => {
    ledger = openLedger(":memory:");
    await stalledWeek("2026-10-04", [inSlice("a1", "A"), inSlice("a2", "A"), done("A")]);
    await run("bazos", "incremental", "2026-10-12", [seen("a2", 2)]);
    const [, a2] = [...ledger.snapshot().listings()];
    expect(a2).not.toHaveProperty("slice");
    // Still held in A: the next two censuses that finish A without it retire it, once over.
    await stalledWeek("2026-10-18", [inSlice("a1", "A"), done("A")]);
    await stalledWeek("2026-10-25", [inSlice("a1", "A"), done("A")]);
    expect(goneOf()).toEqual({ a1: null, a2: null });
    await unfinished("2026-11-01", []);
    expect(goneOf()).toEqual({ a1: null, a2: "2026-10-18" });
  });
});
