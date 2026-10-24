import type { FxTable } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { landedPrice } from "./index.ts";

// ČNB rates of 2026-10-23, as in the research worked examples.
const fx: FxTable = { EUR: { czkPerUnit: 24.335, validFor: "2026-10-23" } };
const env = { fx, today: "2026-10-24" };

describe("landedPrice", () => {
  it("passes CZ prices through", () => {
    const result = landedPrice(
      {
        price: { amount: 350_000, currency: "CZK" },
        market: "CZ",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
      },
      env,
    );
    expect(result).toEqual({
      ok: true,
      landed: {
        totalCzk: 350_000,
        lines: [{ code: "price", czk: 350_000 }],
        flags: [],
        fxDate: null,
      },
    });
  });

  it("matches the worked example: DE used 2019 Golf, Euro 6, dealer gross €15,000, inspection valid", () => {
    const result = landedPrice(
      {
        price: { amount: 15_000, currency: "EUR" },
        market: "DE",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
        firstRegistration: { year: 2019, month: 5 },
        odometerKm: 90_000,
        fuel: "petrol",
        euroClass: 6,
        inspectionValid: true,
      },
      env,
    );
    expect(result.ok && result.landed.totalCzk).toBe(378_615);
  });

  it("matches the worked example: DE 'new' car (4 months, 3,000 km) pays CZ VAT on the net price", () => {
    const result = landedPrice(
      {
        price: { amount: 40_000, currency: "EUR" },
        market: "DE",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
        firstRegistration: { year: 2026, month: 6 },
        odometerKm: 3_000,
        fuel: "petrol",
        euroClass: 6,
        inspectionValid: true,
      },
      env,
    );
    expect(result.ok && result.landed.totalCzk).toBeCloseTo(1_003_349, -1);
    expect(result.ok && result.landed.flags).toContain("newVehicleVat");
  });

  it("reports a missing FX rate instead of guessing", () => {
    const result = landedPrice(
      {
        price: { amount: 10_000, currency: "CHF" },
        market: "DE",
        seller: "private",
        priceBasis: "unknown",
        condition: "used",
      },
      env,
    );
    expect(result).toEqual({ ok: false, reason: "fx-missing" });
  });
});
