import type { CatalogEntry, ListingSeen, Observation } from "@cca/vocabulary";
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
    transmission: "automatic",
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

  it("resolves listings against the current catalog at snapshot time", async () => {
    ledger = openLedger(":memory:");
    await run("sauto", "incremental", "2026-10-10", [seen("1", 1)]);
    expect([...ledger.snapshot().listings()][0]?.resolution.status).toBe("unmatched");
    await run("rsv", "full", "2026-10-11", [octavia]);
    const snapshot = ledger.snapshot();
    expect(snapshot.catalog.map((v) => v.id)).toEqual([
      "skoda/octavia/mk4/wagon-diesel-110kw-automatic",
    ]);
    expect([...snapshot.listings()][0]?.resolution).toEqual({
      status: "matched",
      makeId: "skoda",
      modelId: "skoda/octavia",
      variantId: "skoda/octavia/mk4/wagon-diesel-110kw-automatic",
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
});
