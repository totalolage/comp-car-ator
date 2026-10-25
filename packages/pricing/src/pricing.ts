/**
 * Landed price: what a Czech private buyer pays to own and register a listed car in CZ.
 * Formula: import-and-china.md §5 in the research notes; every rate, fee and threshold with
 * its source and as-of date is in `rules.ts`.
 */
import type {
  Condition,
  Fuel,
  FxTable,
  IsoDate,
  Market,
  Money,
  PriceBasis,
  Seller,
  SellerExtras,
  YearMonth,
} from "@cca/vocabulary";
import { PRICING_RULES as RULES } from "./rules.ts";

export interface LandedInput {
  price: Money;
  /**
   * Charges the seller invoices on top of `price` (delivery, preparation, dealer fees), in
   * `price`'s currency, on their own price basis. Part of the CZ VAT base for a new car.
   */
  sellerExtras?: SellerExtras;
  market: Market;
  seller: Seller;
  priceBasis: PriceBasis;
  condition: Condition;
  /** Absent = not stated; with condition `new` the car counts as never registered. */
  firstRegistration?: YearMonth;
  odometerKm?: number;
  fuel?: Fuel;
  euroClass?: number;
  /** German/Austrian periodic inspection still valid long enough for CZ. Unknown = undefined. */
  inspectionValid?: boolean;
}

export interface PricingEnv {
  fx: FxTable;
  /** Valuation day (vehicle age and the "new means of transport" VAT test). */
  today: IsoDate;
  /** Transport to CZ, CZK. Default `PRICING_RULES.transport.czk`. */
  transportCzk?: number;
}

/** Each code is a key of `PRICING_RULES`, which holds the line's rule reference. */
export type LandedLineCode =
  | "price"
  | "goods"
  /** Seller extras, converted and normalized like the price (net for new cars). */
  | "sellerExtras"
  | "vatCz"
  | "transport"
  | "inspection"
  | "registration"
  | "ecoFee";

export type LandedFlag =
  /** Euro class unknown: eco fee shown as 0 but may be up to 10,000 CZK. */
  | "ecoFeeUncertain"
  /** Inspection validity unknown on a car old enough to need one: the full CZ inspection is charged. */
  | "inspectionAssumed"
  /** The car counts as a "new means of transport", so CZ VAT applies. */
  | "newVehicleVat"
  /** Registration date or odometer missing, so the new/used VAT test could not decide; priced as used. */
  | "vatUncertain"
  /**
   * A simplification the other flags don't name: Austrian NoVA left in the price (new car, or
   * registered ≤ 48 months, where export makes it exempt or refundable), or the seller's VAT
   * status read from an unknown, margin or contradictory price basis.
   */
  | "approximate";

export interface LandedPrice {
  totalCzk: number;
  /** Additive: the lines sum to totalCzk. Each line is rounded to whole CZK (half up). */
  lines: { code: LandedLineCode; czk: number }[];
  flags: LandedFlag[];
  /** ČNB fixing date used, null for CZK prices. */
  fxDate: IsoDate | null;
}

export type LandedResult =
  | { ok: true; landed: LandedPrice }
  | { ok: false; reason: "fx-missing" | "unsupported-market" | "extras-currency" };

type Lines = LandedPrice["lines"];

/** Pricing's interface: one pure function. Never throws for well-typed input. */
export function landedPrice(input: LandedInput, env: PricingEnv): LandedResult {
  if (input.sellerExtras && input.sellerExtras.currency !== input.price.currency) {
    return { ok: false, reason: "extras-currency" };
  }
  if (input.market !== "CZ" && input.market !== "DE" && input.market !== "AT") {
    return { ok: false, reason: "unsupported-market" };
  }
  const fx = rateOf(input.price.currency, env.fx);
  if (!fx) return { ok: false, reason: "fx-missing" };
  const flags = new Set<LandedFlag>();
  const lines =
    input.market === "CZ"
      ? fromCz(input, fx.czkPerUnit, flags)
      : fromEu(input, env, fx.czkPerUnit, flags);
  const totalCzk = lines.reduce((sum, line) => sum + line.czk, 0);
  return { ok: true, landed: { totalCzk, lines, flags: [...flags], fxDate: fx.date } };
}

/** A Czech Listing: the asking price plus seller extras, as a private buyer pays them. */
function fromCz(input: LandedInput, czkPerUnit: number, flags: Set<LandedFlag>): Lines {
  const paid = (amount: number, basis: PriceBasis) =>
    asPaid(amount, basis, input.seller, RULES.marketVat.rates.CZ, flags) * czkPerUnit;
  const lines: Lines = [{ code: "price", czk: round(paid(input.price.amount, input.priceBasis)) }];
  const extras = input.sellerExtras;
  if (extras?.amount) {
    lines.push({ code: "sellerExtras", czk: round(paid(extras.amount, extras.basis)) });
  }
  return lines;
}

/** A German or Austrian Listing bought by a Czech private buyer and registered in CZ. */
function fromEu(
  input: LandedInput,
  env: PricingEnv,
  czkPerUnit: number,
  flags: Set<LandedFlag>,
): Lines {
  const market = input.market as "DE" | "AT";
  const vat = RULES.marketVat.rates[market];
  const age = monthsSince(input.firstRegistration, env.today);
  const classification = isNewMeansOfTransport(input, age);
  // Undecidable cases are priced as used (the Market's VAT stays in the price) and flagged.
  if (classification === "unknown") flags.add("vatUncertain");
  const isNew = classification === true;
  if (isNew) flags.add("newVehicleVat");
  // Austrian prices carry NoVA, which export makes exempt (new) or refundable (registered
  // ≤ 48 months); without CO₂ data it stays in.
  if (market === "AT" && (isNew || !(age && age.min >= RULES.atNova.refundMaxMonths))) {
    flags.add("approximate");
  }

  const invoiced = (amount: number, basis: PriceBasis) =>
    (isNew
      ? exportNet(amount, basis, input.seller, vat, flags)
      : asPaid(amount, basis, input.seller, vat, flags)) * czkPerUnit;
  const goods = invoiced(input.price.amount, input.priceBasis);
  const extras = input.sellerExtras
    ? invoiced(input.sellerExtras.amount, input.sellerExtras.basis)
    : 0;
  const vatCz = isNew ? RULES.vatCz.rate * (goods + extras) : 0;

  const lines: Lines = [
    { code: "goods", czk: round(goods) },
    ...(extras > 0 ? [{ code: "sellerExtras" as const, czk: round(extras) }] : []),
    ...(vatCz > 0 ? [{ code: "vatCz" as const, czk: round(vatCz) }] : []),
    { code: "transport", czk: round(env.transportCzk ?? RULES.transport.czk) },
    { code: "inspection", czk: inspection(input, age, flags) },
    { code: "registration", czk: RULES.registration.czk },
  ];
  const ecoFee = ecoFeeOf(input, flags);
  if (ecoFee > 0) lines.push({ code: "ecoFee", czk: ecoFee });
  return lines;
}

/**
 * What a private buyer pays for an amount shown on `basis` when the car is not a new means of
 * transport: the consumer gross. Only a VAT payer quotes net, so a net amount gets the Market's
 * VAT; a private seller cannot charge VAT, so their "net" amount is taken as is.
 */
function asPaid(
  amount: number,
  basis: PriceBasis,
  seller: Seller,
  vat: number,
  flags: Set<LandedFlag>,
): number {
  if (basis !== "net") return amount;
  if (seller === "private") {
    flags.add("approximate");
    return amount;
  }
  if (seller === "unknown") flags.add("approximate");
  return amount * (1 + vat);
}

/**
 * The invoice amount of a new means of transport supplied to another EU state: net of the
 * Market's VAT (exempt supply). A private seller's agreed price is taxed as is, not divided.
 * A margin-scheme price cannot apply to a new car, and an unknown basis may include VAT:
 * both are taken as is and flagged. A gross price from an unknown seller is assumed to
 * include VAT, flagged. (A net price needs no flag: it is the base whoever sells.)
 */
function exportNet(
  amount: number,
  basis: PriceBasis,
  seller: Seller,
  vat: number,
  flags: Set<LandedFlag>,
): number {
  if (seller === "private" || basis === "net") return amount;
  if (basis === "gross") {
    if (seller !== "dealer") flags.add("approximate");
    return amount / (1 + vat);
  }
  flags.add("approximate");
  return amount;
}

/** Calendar months between first registration and today, as the range the true age lies in. */
interface Age {
  /** The true age is strictly greater than this. */
  min: number;
  /** The true age is strictly less than this. */
  max: number;
}

/**
 * Registrations are known to the month (sometimes only the year), so a calendar-month
 * difference d means the true elapsed time lies strictly between d - 1 and d + 1 months.
 */
function monthsSince(reg: YearMonth | undefined, today: IsoDate): Age | null {
  if (!reg) return null;
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const monthsAgo = (month: number) => (ty - reg.year) * 12 + (tm - month);
  return { min: monthsAgo(reg.month ?? 12) - 1, max: monthsAgo(reg.month ?? 1) + 1 };
}

/**
 * ZDPH §19(1)(a): a car is a "new means of transport" if never registered, or registered
 * ≤ 6 months ago, or driven ≤ 6,000 km; it is used only when both limits are exceeded.
 * Returns "unknown" when the listing's evidence cannot decide (missing date or odometer).
 */
function isNewMeansOfTransport(input: LandedInput, age: Age | null): boolean | "unknown" {
  const { months, km: maxKm } = RULES.newMeansOfTransport;
  const km = input.odometerKm;
  if (km !== undefined && km <= maxKm) return true;
  if (!age) return input.condition === "new" ? true : "unknown";
  if (age.max <= months) return true;
  if (age.min >= months && km !== undefined) return false;
  return "unknown";
}

function inspection(input: LandedInput, age: Age | null, flags: Set<LandedFlag>): number {
  const { identityCheckCzk, technicalCzk, emissionsCzk, noneDueMonths } = RULES.inspection;
  const neverRegistered = !age && input.condition === "new";
  const noneDue = neverRegistered || (age !== null && age.max <= noneDueMonths);
  if (noneDue || input.inspectionValid) return identityCheckCzk;
  if (input.inspectionValid === undefined) flags.add("inspectionAssumed");
  // A BEV has no exhaust emissions to measure.
  return identityCheckCzk + technicalCzk + (input.fuel === "bev" ? 0 : emissionsCzk);
}

function ecoFeeOf(input: LandedInput, flags: Set<LandedFlag>): number {
  if (input.fuel === "bev") return 0;
  if (input.euroClass === undefined) {
    flags.add("ecoFeeUncertain");
    return 0;
  }
  return RULES.ecoFee.czkByEuroClass[input.euroClass] ?? 0;
}

function rateOf(
  currency: string,
  fx: FxTable,
): { czkPerUnit: number; date: IsoDate | null } | null {
  if (currency === "CZK") return { czkPerUnit: 1, date: null };
  const rate = fx[currency];
  return rate ? { czkPerUnit: rate.czkPerUnit, date: rate.validFor } : null;
}

/** Whole CZK, half up (amounts are never negative). */
function round(value: number): number {
  return Math.round(value);
}
