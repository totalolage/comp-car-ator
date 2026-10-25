import { memoryLoader, openBundle } from "@cca/bundle";
import { type Ledger, openLedger } from "@cca/ledger";
import type { ListPrice, Observation } from "@cca/vocabulary";
import { afterEach, describe, expect, it } from "vitest";
import { publish } from "./index.ts";

const at = (d: string) => new Date(`${d}T12:00:00Z`);

const tiguan: Observation = {
  kind: "CatalogEntry",
  variant: {
    make: "Volkswagen",
    model: "Tiguan",
    generation: { slug: "mk3", name: "Tiguan III", from: 2024 },
    body: "suv",
    fuel: "diesel",
    powerKw: 142,
    transmission: "automatic",
    years: { from: 2024 },
  },
};
const variantId = "volkswagen/tiguan/mk3/suv-diesel-142kw-automatic";

function offer(ref: string, amount: number, extra: Partial<ListPrice> = {}): ListPrice {
  return {
    kind: "ListPrice",
    ref,
    vehicle: {
      make: "Volkswagen",
      model: "Tiguan",
      trim: "Elegance 2.0 TDI 142 kW 7DSG",
      body: "suv",
      fuel: "diesel",
      powerKw: 142,
      transmission: "automatic",
      drive: ref.endsWith("4motion") ? "awd" : "fwd",
    },
    price: { amount, currency: "CZK" },
    market: "CZ",
    validFrom: "2026-07-01",
    ...extra,
  };
}

let ledger: Ledger;
afterEach(() => ledger?.close());

async function newPriceOn(day: string) {
  const bundle = await openBundle(memoryLoader(publish(ledger, { now: at(day) })));
  return (await bundle.catalog()).variants.find((v) => v.id === variantId)?.newPriceCzk;
}

async function record(day: string, observations: Observation[]) {
  await ledger.record({ source: "vw-cz", mode: "full", startedAt: at(day) }, observations);
}

describe("publish: New prices", () => {
  it("keeps offers that resolve to one Variant apart, and a later edition updates only its offer", async () => {
    ledger = openLedger(":memory:");
    await record("2026-07-01", [
      tiguan,
      offer("tiguan-elegance-20tdi-142", 1_000_000),
      offer("tiguan-elegance-20tdi-142-4motion", 1_100_000),
    ]);
    expect(await newPriceOn("2026-08-01")).toEqual({ min: 1_000_000, max: 1_100_000 });

    await record("2026-09-01", [
      offer("tiguan-elegance-20tdi-142", 1_050_000, { validFrom: "2026-09-01" }),
    ]);
    expect(await newPriceOn("2026-08-15")).toEqual({ min: 1_000_000, max: 1_100_000 });
    expect(await newPriceOn("2026-09-15")).toEqual({ min: 1_050_000, max: 1_100_000 });
  });

  it("applies an edition only within its validity, and a withdrawal ends the offer", async () => {
    ledger = openLedger(":memory:");
    await record("2026-06-01", [
      tiguan,
      offer("tiguan-elegance-20tdi-142", 1_000_000, { validTo: "2026-12-31" }),
      offer("tiguan-elegance-20tdi-142", 950_000, { validFrom: "2026-01-01" }),
    ]);
    expect(await newPriceOn("2025-12-31")).toBeUndefined();
    expect(await newPriceOn("2026-06-30")).toEqual({ min: 950_000, max: 950_000 });
    expect(await newPriceOn("2026-12-31")).toEqual({ min: 1_000_000, max: 1_000_000 });
    // Expired: the older, open-ended edition does not come back.
    expect(await newPriceOn("2027-01-01")).toBeUndefined();

    // Withdrawal: the source re-emits the current edition of the other offer with an end date.
    await record("2026-07-01", [offer("tiguan-elegance-20tdi-142-4motion", 1_100_000)]);
    await record("2026-10-01", [
      offer("tiguan-elegance-20tdi-142-4motion", 1_100_000, { validTo: "2026-09-30" }),
    ]);
    expect(await newPriceOn("2026-09-30")).toEqual({ min: 1_000_000, max: 1_100_000 });
    expect(await newPriceOn("2026-10-01")).toEqual({ min: 1_000_000, max: 1_000_000 });
  });
});

describe("publish: Listings", () => {
  it("keeps the asking price and prices seller extras into the landed price", async () => {
    ledger = openLedger(":memory:");
    const now = at("2026-10-24");
    await ledger.record({ source: "cnb", mode: "incremental", startedAt: now }, [
      { kind: "FxRate", currency: "EUR", validFor: "2026-10-23", czkPerUnit: 24.335 },
    ]);
    await ledger.record({ source: "autoscout24-de", mode: "incremental", startedAt: now }, [
      tiguan,
      {
        kind: "ListingSeen",
        ref: "x",
        url: "https://www.autoscout24.de/angebote/x",
        market: "DE",
        condition: "used",
        vehicle: {
          make: "VW",
          model: "Tiguan",
          fuel: "diesel",
          powerKw: 142,
          transmission: "automatic",
          firstRegistration: { year: 2025, month: 1 },
          euroClass: 6,
        },
        odometerKm: 20_000,
        price: { amount: 30_000, currency: "EUR" },
        sellerExtras: { amount: 990, currency: "EUR", basis: "gross" },
        priceBasis: "gross",
        seller: "dealer",
        photos: [],
      },
    ]);
    const bundle = await openBundle(memoryLoader(publish(ledger, { now })));
    const model = await bundle.model("volkswagen/tiguan");
    const [row] = model?.listings ?? [];
    expect(row).toMatchObject({
      price: { amount: 30_000, currency: "EUR" },
      sellerExtras: { amount: 990, currency: "EUR" },
      priceCzk: 730_050,
    });
    expect(row?.landed?.lines).toContainEqual({ code: "sellerExtras", czk: 24_092 });
  });
});
