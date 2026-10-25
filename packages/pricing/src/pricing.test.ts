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

  it("puts seller extras of a new DE car into the CZ VAT base, net of German VAT", () => {
    const input = {
      price: { amount: 40_000, currency: "EUR" },
      market: "DE" as const,
      seller: "dealer" as const,
      priceBasis: "gross" as const,
      condition: "new" as const,
      fuel: "petrol" as const,
      euroClass: 6,
      inspectionValid: true,
    };
    const without = landedPrice(input, env);
    const result = landedPrice(
      { ...input, sellerExtras: { amount: 1_190, currency: "EUR", basis: "gross" } },
      env,
    );
    if (!result.ok || !without.ok) throw new Error("expected a landed price");
    const line = (code: string) => result.landed.lines.find((l) => l.code === code)?.czk;
    // €1,190 gross of 19% German VAT is €1,000 net.
    expect(line("sellerExtras")).toBe(24_335);
    expect(line("goods")).toBe(without.landed.lines.find((l) => l.code === "goods")?.czk);
    expect(line("vatCz")).toBe(Math.round(0.21 * (40_000 / 1.19 + 1_000) * 24.335));
    expect(result.landed.totalCzk).toBe(result.landed.lines.reduce((sum, l) => sum + l.czk, 0));
  });

  it("adds seller extras of a used DE car as invoiced, without CZ VAT", () => {
    const result = landedPrice(
      {
        price: { amount: 15_000, currency: "EUR" },
        sellerExtras: { amount: 500, currency: "EUR", basis: "gross" },
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
    if (!result.ok) throw new Error("expected a landed price");
    expect(result.landed.lines.map((l) => l.code)).not.toContain("vatCz");
    expect(result.landed.lines).toContainEqual({ code: "sellerExtras", czk: 12_168 });
    expect(result.landed.totalCzk).toBe(378_615 + 12_168);
  });

  it("adds seller extras to a CZ price", () => {
    const result = landedPrice(
      {
        price: { amount: 350_000, currency: "CZK" },
        sellerExtras: { amount: 9_900, currency: "CZK", basis: "gross" },
        market: "CZ",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
      },
      env,
    );
    expect(result.ok && result.landed.lines).toEqual([
      { code: "price", czk: 350_000 },
      { code: "sellerExtras", czk: 9_900 },
    ]);
    expect(result.ok && result.landed.totalCzk).toBe(359_900);
  });

  it("adds Czech VAT to a CZ dealer's net amounts, each on its own basis", () => {
    const result = landedPrice(
      {
        price: { amount: 350_000, currency: "CZK" },
        sellerExtras: { amount: 10_000, currency: "CZK", basis: "net" },
        market: "CZ",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
      },
      env,
    );
    expect(result.ok && result.landed.lines).toEqual([
      { code: "price", czk: 350_000 },
      { code: "sellerExtras", czk: 12_100 },
    ]);
  });

  it("normalizes gross seller extras of a net-priced new car on their own basis", () => {
    const result = landedPrice(
      {
        price: { amount: 30_000, currency: "EUR" },
        sellerExtras: { amount: 1_190, currency: "EUR", basis: "gross" },
        market: "DE",
        seller: "dealer",
        priceBasis: "net",
        condition: "new",
        euroClass: 6,
        inspectionValid: true,
      },
      env,
    );
    if (!result.ok) throw new Error("expected a landed price");
    expect(result.landed.lines).toContainEqual({ code: "goods", czk: 730_050 });
    expect(result.landed.lines).toContainEqual({ code: "sellerExtras", czk: 24_335 });
    expect(result.landed.lines).toContainEqual({
      code: "vatCz",
      czk: Math.round(0.21 * 31_000 * 24.335),
    });
  });

  it("refuses seller extras in another currency than the price", () => {
    const result = landedPrice(
      {
        price: { amount: 15_000, currency: "EUR" },
        sellerExtras: { amount: 9_900, currency: "CZK", basis: "gross" },
        market: "DE",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
      },
      env,
    );
    expect(result).toEqual({ ok: false, reason: "extras-currency" });
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

  it("prices a used car with unknown registration and odometer as used, flagged", () => {
    const result = landedPrice(
      {
        price: { amount: 15_000, currency: "EUR" },
        market: "DE",
        seller: "dealer",
        priceBasis: "gross",
        condition: "used",
        euroClass: 6,
        inspectionValid: true,
      },
      env,
    );
    expect(result.ok && result.landed.flags).toEqual(["vatUncertain"]);
    expect(result.ok && result.landed.totalCzk).toBe(378_615);
  });

  it("does not assume January for a registration year without month", () => {
    const base = {
      price: { amount: 40_000, currency: "EUR" },
      market: "DE" as const,
      seller: "dealer" as const,
      priceBasis: "gross" as const,
      condition: "used" as const,
      odometerKm: 9_000,
      euroClass: 6,
      inspectionValid: true,
    };
    const thisYear = landedPrice({ ...base, firstRegistration: { year: 2026 } }, env);
    expect(thisYear.ok && thisYear.landed.flags).toContain("vatUncertain");
    const lastYear = landedPrice({ ...base, firstRegistration: { year: 2025, month: 1 } }, env);
    expect(lastYear.ok && lastYear.landed.flags).toEqual([]);
    // Registered exactly six calendar months ago: the day decides, which listings never show.
    const sixMonths = landedPrice({ ...base, firstRegistration: { year: 2026, month: 4 } }, env);
    expect(sixMonths.ok && sixMonths.landed.flags).toContain("vatUncertain");
    const fiveMonths = landedPrice({ ...base, firstRegistration: { year: 2026, month: 5 } }, env);
    expect(fiveMonths.ok && fiveMonths.landed.flags).toContain("newVehicleVat");
  });
});
