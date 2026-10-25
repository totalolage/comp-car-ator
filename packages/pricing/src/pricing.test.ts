import type { FxTable } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import {
  type LandedFlag,
  type LandedInput,
  type LandedLineCode,
  landedPrice,
  PRICING_RULES,
  type PricingEnv,
} from "./index.ts";

// ČNB rates of 2026-10-23, as in the research worked examples. ČNB quotes HUF per 100
// (6,570 CZK); the ČNB Source divides by the amount, so the table holds the per-unit rate.
const fx: FxTable = {
  EUR: { czkPerUnit: 24.335, validFor: "2026-10-23" },
  HUF: { czkPerUnit: 0.0657, validFor: "2026-10-23" },
};
const env: PricingEnv = { fx, today: "2026-10-24" };

/** Transport, evidenční kontrola and registration of an import with a valid inspection. */
const FEES = { transport: 12_000, inspection: 790, registration: 800 };
/** Evidenční kontrola + technical inspection + emissions. */
const FULL_INSPECTION = 790 + 2_490 + 950;

const czDealer: LandedInput = {
  price: { amount: 350_000, currency: "CZK" },
  market: "CZ",
  seller: "dealer",
  priceBasis: "gross",
  condition: "used",
};

/** Research worked example 1: a used 2019 Golf, Euro 6, dealer gross €15,000, HU valid. */
const deUsed: LandedInput = {
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
};

/** Research worked example 2: "new" by both tests (4 months, 3,000 km), dealer gross €40,000. */
const deNew: LandedInput = {
  ...deUsed,
  price: { amount: 40_000, currency: "EUR" },
  firstRegistration: { year: 2026, month: 6 },
  odometerKm: 3_000,
};

/** A 2001 car without a valid inspection, for the eco fee tiers. */
const deOld: LandedInput = {
  ...deUsed,
  price: { amount: 2_000, currency: "EUR" },
  firstRegistration: { year: 2001, month: 3 },
  odometerKm: 200_000,
  inspectionValid: false,
};
const deOldLines = {
  goods: 48_670,
  transport: 12_000,
  inspection: FULL_INSPECTION,
  registration: 800,
};

interface Case {
  name: string;
  input: LandedInput;
  env?: Partial<PricingEnv>;
  lines: Partial<Record<LandedLineCode, number>>;
  flags?: LandedFlag[];
  total: number;
}

const cases: Case[] = [
  // Czech Listings: what a private buyer pays the seller.
  {
    name: "CZ dealer gross: the asking price",
    input: czDealer,
    lines: { price: 350_000 },
    total: 350_000,
  },
  {
    name: "CZ dealer net: plus 21% Czech VAT",
    input: { ...czDealer, priceBasis: "net" },
    lines: { price: 423_500 },
    total: 423_500,
  },
  {
    name: "CZ private seller: the price as is",
    input: {
      ...czDealer,
      seller: "private",
      priceBasis: "unknown",
      price: { amount: 200_000, currency: "CZK" },
    },
    lines: { price: 200_000 },
    total: 200_000,
  },
  {
    name: "CZ seller extras on their own basis",
    input: { ...czDealer, sellerExtras: { amount: 10_000, currency: "CZK", basis: "net" } },
    lines: { price: 350_000, sellerExtras: 12_100 },
    total: 362_100,
  },
  {
    name: "CZ unknown seller quoting net: assumed a VAT payer",
    input: {
      ...czDealer,
      seller: "unknown",
      priceBasis: "net",
      price: { amount: 100_000, currency: "CZK" },
    },
    lines: { price: 121_000 },
    flags: ["approximate"],
    total: 121_000,
  },
  {
    name: "CZ private seller quoting net: cannot charge VAT, taken as is",
    input: {
      ...czDealer,
      seller: "private",
      priceBasis: "net",
      price: { amount: 100_000, currency: "CZK" },
    },
    lines: { price: 100_000 },
    flags: ["approximate"],
    total: 100_000,
  },
  {
    name: "CZ Listing priced in EUR: converted",
    input: { ...czDealer, price: { amount: 10_000, currency: "EUR" } },
    lines: { price: 243_350 },
    total: 243_350,
  },

  // Germany: the "new means of transport" test and the seller's VAT status.
  {
    name: "worked example 1: DE used, dealer gross, German VAT stays in",
    input: deUsed,
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "worked example 2: DE new (4 months, 3,000 km), dealer gross: CZ VAT on the net",
    input: deNew,
    lines: { goods: 817_983, vatCz: 171_776, ...FEES },
    flags: ["newVehicleVat"],
    total: 1_003_349,
  },
  {
    name: "DE new by age alone: registered 5 months ago, 9,000 km",
    input: { ...deNew, firstRegistration: { year: 2026, month: 5 }, odometerKm: 9_000 },
    lines: { goods: 817_983, vatCz: 171_776, ...FEES },
    flags: ["newVehicleVat"],
    total: 1_003_349,
  },
  {
    name: "DE new by km alone: a 2024 car with 5,500 km",
    input: { ...deNew, firstRegistration: { year: 2024, month: 1 }, odometerKm: 5_500 },
    lines: { goods: 817_983, vatCz: 171_776, ...FEES },
    flags: ["newVehicleVat"],
    total: 1_003_349,
  },
  {
    name: "DE used: both limits exceeded (21 months, 9,000 km)",
    input: { ...deNew, firstRegistration: { year: 2025, month: 1 }, odometerKm: 9_000 },
    lines: { goods: 973_400, ...FEES },
    total: 986_990,
  },
  {
    name: "DE dealer net, used: plus 19% German VAT, rounded half up",
    input: { ...deUsed, priceBasis: "net", price: { amount: 10_000, currency: "EUR" } },
    lines: { goods: 289_587, ...FEES },
    total: 303_177,
  },
  {
    name: "DE unknown seller quoting net, used: assumed a VAT payer",
    input: {
      ...deUsed,
      seller: "unknown",
      priceBasis: "net",
      price: { amount: 10_000, currency: "EUR" },
    },
    lines: { goods: 289_587, ...FEES },
    flags: ["approximate"],
    total: 303_177,
  },
  {
    name: "DE private seller, used: the agreed price",
    input: { ...deUsed, seller: "private", priceBasis: "unknown" },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "DE private seller, new: the agreed price taxed as is, not divided by 1.19",
    input: {
      ...deNew,
      seller: "private",
      priceBasis: "unknown",
      price: { amount: 30_000, currency: "EUR" },
      firstRegistration: { year: 2026, month: 8 },
      odometerKm: 1_000,
    },
    lines: { goods: 730_050, vatCz: 153_311, ...FEES },
    flags: ["newVehicleVat"],
    total: 896_951,
  },
  {
    name: "DE dealer new, margin scheme: impossible for a new car, taken as is",
    input: { ...deNew, priceBasis: "margin" },
    lines: { goods: 973_400, vatCz: 204_414, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 1_191_404,
  },
  {
    name: "DE dealer new, unknown basis: may include VAT, taken as is",
    input: { ...deNew, priceBasis: "unknown" },
    lines: { goods: 973_400, vatCz: 204_414, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 1_191_404,
  },
  {
    name: "DE seller extras of a new car: net of German VAT, in the CZ VAT base",
    input: { ...deNew, sellerExtras: { amount: 1_190, currency: "EUR", basis: "gross" } },
    lines: { goods: 817_983, sellerExtras: 24_335, vatCz: 176_887, ...FEES },
    flags: ["newVehicleVat"],
    total: 1_032_795,
  },
  {
    name: "DE net new car with gross extras: each normalized on its own basis",
    input: {
      ...deNew,
      priceBasis: "net",
      price: { amount: 30_000, currency: "EUR" },
      sellerExtras: { amount: 1_190, currency: "EUR", basis: "gross" },
    },
    lines: { goods: 730_050, sellerExtras: 24_335, vatCz: 158_421, ...FEES },
    flags: ["newVehicleVat"],
    total: 926_396,
  },
  {
    name: "DE seller extras of a used car: as invoiced, no CZ VAT",
    input: { ...deUsed, sellerExtras: { amount: 500, currency: "EUR", basis: "gross" } },
    lines: { goods: 365_025, sellerExtras: 12_168, ...FEES },
    total: 390_783,
  },

  {
    name: "DE exactly 6,000 km on a 2019 car: still a new means of transport",
    input: { ...deUsed, odometerKm: 6_000 },
    lines: { goods: 306_744, vatCz: 64_416, ...FEES },
    flags: ["newVehicleVat"],
    total: 384_750,
  },
  {
    name: "DE 6,001 km on a 2019 car: used",
    input: { ...deUsed, odometerKm: 6_001 },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "DE dealer margin scheme, used: the price as paid",
    input: { ...deUsed, priceBasis: "margin" },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "DE unknown seller gross, new: assumed to include VAT",
    input: { ...deNew, seller: "unknown" },
    lines: { goods: 817_983, vatCz: 171_776, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 1_003_349,
  },
  {
    name: "DE private seller quoting net, new: the agreed price either way",
    input: { ...deNew, seller: "private", priceBasis: "net", price: { amount: 30_000, currency: "EUR" } },
    lines: { goods: 730_050, vatCz: 153_311, ...FEES },
    flags: ["newVehicleVat"],
    total: 896_951,
  },
  {
    name: "rounding: CZ VAT is taken on the unrounded goods (102,600.497, not 102,600.54)",
    input: { ...deNew, priceBasis: "net", price: { amount: 20_077, currency: "EUR" } },
    lines: { goods: 488_574, vatCz: 102_600, ...FEES },
    flags: ["newVehicleVat"],
    total: 604_764,
  },

  // Austria: 20% USt; NoVA stays in the price where export would remove it.
  {
    name: "AT used, registered over 48 months ago: the price as paid",
    input: { ...deUsed, market: "AT" },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "AT dealer net, used: plus 20% Austrian VAT",
    input: {
      ...deUsed,
      market: "AT",
      priceBasis: "net",
      price: { amount: 10_000, currency: "EUR" },
    },
    lines: { goods: 292_020, ...FEES },
    total: 305_610,
  },
  {
    name: "AT used, registered 41 months ago: NoVA refundable on export",
    input: {
      ...deUsed,
      market: "AT",
      firstRegistration: { year: 2023, month: 5 },
      odometerKm: 40_000,
    },
    lines: { goods: 365_025, ...FEES },
    flags: ["approximate"],
    total: 378_615,
  },
  {
    name: "AT new, dealer gross: net of 20% USt, NoVA left in",
    input: {
      ...deNew,
      market: "AT",
      price: { amount: 36_000, currency: "EUR" },
      firstRegistration: { year: 2026, month: 7 },
      odometerKm: 2_000,
    },
    lines: { goods: 730_050, vatCz: 153_311, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 896_951,
  },
  {
    name: "AT registration unknown: VAT test undecidable, NoVA refund possible",
    input: { ...deUsed, market: "AT", firstRegistration: undefined, odometerKm: 50_000 },
    lines: { goods: 365_025, ...FEES },
    flags: ["vatUncertain", "approximate"],
    total: 378_615,
  },

  {
    name: "AT new, dealer net: 20% USt never added, NoVA may be in",
    input: { ...deNew, market: "AT", priceBasis: "net", price: { amount: 30_000, currency: "EUR" } },
    lines: { goods: 730_050, vatCz: 153_311, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 896_951,
  },
  {
    name: "AT new, private seller: the agreed price taxed as is",
    input: {
      ...deNew,
      market: "AT",
      seller: "private",
      priceBasis: "unknown",
      price: { amount: 30_000, currency: "EUR" },
      firstRegistration: { year: 2026, month: 8 },
      odometerKm: 1_000,
    },
    lines: { goods: 730_050, vatCz: 153_311, ...FEES },
    flags: ["newVehicleVat", "approximate"],
    total: 896_951,
  },
  ...(
    [
      [{ year: 2022, month: 10 }, ["approximate"]],
      [{ year: 2022, month: 9 }, []],
      [{ year: 2022 }, ["approximate"]],
      [{ year: 2021 }, []],
    ] as const
  ).map(
    ([firstRegistration, flags]): Case => ({
      name: `AT used, registered ${firstRegistration.year}-${"month" in firstRegistration ? firstRegistration.month : "??"}: NoVA refund ${flags.length ? "possible" : "ruled out"} (48 months)`,
      input: { ...deUsed, market: "AT", firstRegistration },
      lines: { goods: 365_025, ...FEES },
      flags: [...flags],
      total: 378_615,
    }),
  ),

  // Eco fee tiers (zákon 542/2020): a 2001 car without a valid inspection.
  {
    name: "eco fee: Euro 3 pays none",
    input: { ...deOld, euroClass: 3 },
    lines: deOldLines,
    total: 65_700,
  },
  {
    name: "eco fee: Euro 2 pays 3,000",
    input: { ...deOld, euroClass: 2 },
    lines: { ...deOldLines, ecoFee: 3_000 },
    total: 68_700,
  },
  {
    name: "eco fee: Euro 1 pays 5,000",
    input: { ...deOld, euroClass: 1 },
    lines: { ...deOldLines, ecoFee: 5_000 },
    total: 70_700,
  },
  {
    name: "eco fee: below Euro 1 pays 10,000",
    input: { ...deOld, euroClass: 0 },
    lines: { ...deOldLines, ecoFee: 10_000 },
    total: 75_700,
  },
  {
    name: "eco fee: Euro class unknown shows 0, flagged",
    input: { ...deOld, euroClass: undefined },
    lines: deOldLines,
    flags: ["ecoFeeUncertain"],
    total: 65_700,
  },
  {
    name: "eco fee: a BEV pays none, Euro class or not, and has no emissions measured",
    input: { ...deOld, euroClass: undefined, fuel: "bev" },
    lines: { ...deOldLines, inspection: 790 + 2_490 },
    total: 64_750,
  },

  // Inspection.
  {
    name: "inspection expired: the full CZ inspection",
    input: { ...deUsed, inspectionValid: false },
    lines: { goods: 365_025, ...FEES, inspection: FULL_INSPECTION },
    total: 382_055,
  },
  {
    name: "inspection unknown on an older car: full inspection, flagged",
    input: { ...deUsed, inspectionValid: undefined },
    lines: { goods: 365_025, ...FEES, inspection: FULL_INSPECTION },
    flags: ["inspectionAssumed"],
    total: 382_055,
  },
  {
    name: "inspection: under 36 months no periodic inspection is due yet",
    input: { ...deUsed, firstRegistration: { year: 2024, month: 1 }, inspectionValid: false },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "inspection: 35 calendar months ago is certainly under 36",
    input: { ...deUsed, firstRegistration: { year: 2023, month: 11 }, inspectionValid: undefined },
    lines: { goods: 365_025, ...FEES },
    total: 378_615,
  },
  {
    name: "inspection: 36 calendar months ago may already be due",
    input: { ...deUsed, firstRegistration: { year: 2023, month: 10 }, inspectionValid: undefined },
    lines: { goods: 365_025, ...FEES, inspection: FULL_INSPECTION },
    flags: ["inspectionAssumed"],
    total: 382_055,
  },
  {
    name: "inspection: a never-registered new car needs only the identity check",
    input: {
      ...deNew,
      condition: "new",
      firstRegistration: undefined,
      odometerKm: undefined,
      inspectionValid: undefined,
    },
    lines: { goods: 817_983, vatCz: 171_776, ...FEES },
    flags: ["newVehicleVat"],
    total: 1_003_349,
  },

  // FX and rounding.
  {
    name: "FX: HUF, quoted by ČNB per 100, is priced per unit",
    input: {
      ...deUsed,
      seller: "private",
      priceBasis: "unknown",
      price: { amount: 5_000_000, currency: "HUF" },
    },
    lines: { goods: 328_500, ...FEES },
    total: 342_090,
  },
  {
    name: "rounding: a transport override is rounded half up like every line",
    input: deUsed,
    env: { transportCzk: 12_345.5 },
    lines: { goods: 365_025, ...FEES, transport: 12_346 },
    total: 378_961,
  },
];

describe("landedPrice", () => {
  it.each(cases)("$name", ({ input, env: overrides, lines, flags = [], total }) => {
    const result = landedPrice(input, { ...env, ...overrides });
    if (!result.ok) throw new Error(`expected a landed price, got ${result.reason}`);
    const { landed } = result;
    expect(Object.fromEntries(landed.lines.map((l) => [l.code, l.czk]))).toEqual(lines);
    expect(landed.flags).toEqual(flags);
    expect(landed.totalCzk).toBe(total);
    expect(landed.lines.reduce((sum, l) => sum + l.czk, 0)).toBe(total);
    expect(landed.fxDate).toBe(input.price.currency === "CZK" ? null : "2026-10-23");
    for (const line of landed.lines) {
      expect(Number.isInteger(line.czk)).toBe(true);
      expect(PRICING_RULES[line.code].sources.length).toBeGreaterThan(0);
    }
  });

  it("keeps the breakdown in display order", () => {
    const result = landedPrice(
      { ...deOld, euroClass: 2, sellerExtras: { amount: 100, currency: "EUR", basis: "gross" } },
      env,
    );
    expect(result.ok && result.landed.lines.map((l) => l.code)).toEqual([
      "goods",
      "sellerExtras",
      "transport",
      "inspection",
      "registration",
      "ecoFee",
    ]);
  });

  it("refuses seller extras in another currency than the price", () => {
    const result = landedPrice(
      { ...deUsed, sellerExtras: { amount: 9_900, currency: "CZK", basis: "gross" } },
      env,
    );
    expect(result).toEqual({ ok: false, reason: "extras-currency" });
  });

  it("reports a missing FX rate instead of guessing", () => {
    const result = landedPrice({ ...deUsed, price: { amount: 10_000, currency: "CHF" } }, env);
    expect(result).toEqual({ ok: false, reason: "fx-missing" });
  });

  it("prices a car with unknown registration and odometer as used, flagged", () => {
    const result = landedPrice(
      { ...deUsed, firstRegistration: undefined, odometerKm: undefined },
      env,
    );
    expect(result.ok && result.landed.flags).toEqual(["vatUncertain"]);
    expect(result.ok && result.landed.totalCzk).toBe(378_615);
  });

  it("does not assume January for a registration year without month", () => {
    const base = { ...deNew, odometerKm: 9_000 };
    const flagsFor = (firstRegistration: LandedInput["firstRegistration"]) => {
      const result = landedPrice({ ...base, firstRegistration }, env);
      return result.ok ? result.landed.flags : [];
    };
    expect(flagsFor({ year: 2026 })).toContain("vatUncertain");
    expect(flagsFor({ year: 2025, month: 1 })).toEqual([]);
    // Registered exactly six calendar months ago: the day decides, which listings never show.
    expect(flagsFor({ year: 2026, month: 4 })).toContain("vatUncertain");
    expect(flagsFor({ year: 2026, month: 5 })).toContain("newVehicleVat");
  });
});
