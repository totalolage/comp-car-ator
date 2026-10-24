/**
 * Landed price: what a Czech private buyer pays to own and register a listed car in CZ.
 * Formula and sources: import-and-china.md §5 in the research notes (as of 2026-10-24).
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
  YearMonth,
} from "@cca/vocabulary";

export interface LandedInput {
  price: Money;
  market: Market;
  seller: Seller;
  priceBasis: PriceBasis;
  condition: Condition;
  /** Absent = never registered. */
  firstRegistration?: YearMonth;
  odometerKm?: number;
  fuel?: Fuel;
  euroClass?: number;
  /** German/Austrian periodic inspection still valid long enough for CZ. Unknown = false. */
  inspectionValid?: boolean;
}

export interface PricingEnv {
  fx: FxTable;
  /** Valuation day (vehicle age and the "new means of transport" VAT test). */
  today: IsoDate;
  /** Transport to CZ, CZK. Default 12,000. */
  transportCzk?: number;
}

export type LandedLineCode =
  | "price"
  | "goods"
  | "vatCz"
  | "transport"
  | "inspection"
  | "registration"
  | "ecoFee";

export type LandedFlag =
  /** Euro class unknown: eco fee shown as 0 but may be up to 10,000 CZK. */
  | "ecoFeeUncertain"
  /** Inspection validity unknown: the full CZ inspection set is charged. */
  | "inspectionAssumed"
  /** The car counts as a "new means of transport", so CZ VAT applies. */
  | "newVehicleVat"
  /** Registration date or odometer missing, so the new/used VAT test could not decide; priced as used. */
  | "vatUncertain"
  /** Rules for this market are simplified (AT: NoVA ignored). */
  | "approximate";

export interface LandedPrice {
  totalCzk: number;
  /** Additive: the lines sum to totalCzk. */
  lines: { code: LandedLineCode; czk: number }[];
  flags: LandedFlag[];
  /** ČNB fixing date used, null for CZK prices. */
  fxDate: IsoDate | null;
}

export type LandedResult =
  | { ok: true; landed: LandedPrice }
  | { ok: false; reason: "fx-missing" | "unsupported-market" };

const REGISTRATION_FEE = 800;
const DEFAULT_TRANSPORT = 12_000;
const INSPECTION_VALID = 790;
const INSPECTION_FULL = 790 + 2490 + 950;
const ORIGIN_VAT: Record<Market, number> = { CZ: 0.21, DE: 0.19, AT: 0.2 };

/** Pricing's interface: one pure function. Never throws for well-typed input. */
export function landedPrice(input: LandedInput, env: PricingEnv): LandedResult {
  if (input.market === "CZ") {
    const fx = rateOf(input.price.currency, env.fx);
    if (!fx) return { ok: false, reason: "fx-missing" };
    const czk = round(input.price.amount * fx.czkPerUnit);
    return {
      ok: true,
      landed: { totalCzk: czk, lines: [{ code: "price", czk }], flags: [], fxDate: fx.date },
    };
  }
  if (input.market === "DE" || input.market === "AT") return fromEu(input, env);
  return { ok: false, reason: "unsupported-market" };
}

function fromEu(input: LandedInput, env: PricingEnv): LandedResult {
  const fx = rateOf(input.price.currency, env.fx);
  if (!fx) return { ok: false, reason: "fx-missing" };
  const flags: LandedFlag[] = [];
  if (input.market === "AT") flags.push("approximate");

  const vat = ORIGIN_VAT[input.market];
  const dealer = input.seller === "dealer";
  const price = input.price.amount;
  const consumerGross = dealer && input.priceBasis === "net" ? price * (1 + vat) : price;
  const classification = isNewMeansOfTransport(input, env.today);
  // Undecidable cases are priced as used (German VAT stays in the price) and flagged.
  if (classification === "unknown") flags.push("vatUncertain");
  const isNew = classification === true;

  let goods: number;
  let vatCz = 0;
  if (isNew) {
    flags.push("newVehicleVat");
    const net =
      dealer && (input.priceBasis === "gross" || input.priceBasis === "net")
        ? consumerGross / (1 + vat)
        : price;
    goods = net * fx.czkPerUnit;
    vatCz = 0.21 * goods;
  } else {
    goods = consumerGross * fx.czkPerUnit;
  }

  let inspection = INSPECTION_FULL;
  if (input.inspectionValid) inspection = INSPECTION_VALID;
  else if (input.inspectionValid === undefined) flags.push("inspectionAssumed");

  let ecoFee = 0;
  if (input.fuel !== "bev") {
    if (input.euroClass === undefined) flags.push("ecoFeeUncertain");
    else ecoFee = input.euroClass >= 3 ? 0 : ([10_000, 5_000, 3_000][input.euroClass] ?? 0);
  }

  const lines: LandedPrice["lines"] = [
    { code: "goods", czk: round(goods) },
    ...(vatCz > 0 ? [{ code: "vatCz" as const, czk: round(vatCz) }] : []),
    { code: "transport", czk: env.transportCzk ?? DEFAULT_TRANSPORT },
    { code: "inspection", czk: inspection },
    { code: "registration", czk: REGISTRATION_FEE },
    ...(ecoFee > 0 ? [{ code: "ecoFee" as const, czk: ecoFee }] : []),
  ];
  const totalCzk = lines.reduce((sum, line) => sum + line.czk, 0);
  return { ok: true, landed: { totalCzk, lines, flags, fxDate: fx.date } };
}

/**
 * ZDPH §19(1)(a): a car is a "new means of transport" if never registered, or registered
 * ≤ 6 months ago, or driven ≤ 6,000 km; it is used only when both limits are exceeded.
 * Returns "unknown" when the listing's evidence cannot decide (missing date or odometer).
 */
function isNewMeansOfTransport(input: LandedInput, today: IsoDate): boolean | "unknown" {
  const km = input.odometerKm;
  if (km !== undefined && km <= 6000) return true;
  const reg = input.firstRegistration;
  if (!reg) return input.condition === "new" ? true : "unknown";
  // Registrations are known to the month, so a calendar-month difference d means the true
  // elapsed time lies strictly between d - 1 and d + 1 months; d = 6 cannot be decided.
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const monthsAgo = (month: number) => (ty - reg.year) * 12 + (tm - month);
  const newest = monthsAgo(reg.month ?? 12);
  const oldest = monthsAgo(reg.month ?? 1);
  if (oldest <= 5) return true;
  if (newest >= 7 && km !== undefined) return false;
  return "unknown";
}

function rateOf(
  currency: string,
  fx: FxTable,
): { czkPerUnit: number; date: IsoDate | null } | null {
  if (currency === "CZK") return { czkPerUnit: 1, date: null };
  const rate = fx[currency];
  return rate ? { czkPerUnit: rate.czkPerUnit, date: rate.validFor } : null;
}

function round(value: number): number {
  return Math.round(value);
}
