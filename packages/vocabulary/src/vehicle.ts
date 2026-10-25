/**
 * Closed value sets and value types shared by every module. Sources map their
 * own labels onto these; anything they cannot map stays undefined rather than
 * being guessed.
 */

export const FUELS = [
  "petrol",
  "diesel",
  "lpg",
  "cng",
  "hev",
  "phev",
  "bev",
  "reev",
  "hydrogen",
  "other",
] as const;
export type Fuel = (typeof FUELS)[number];

export const BODIES = [
  "hatchback",
  "sedan",
  "wagon",
  "suv",
  "mpv",
  "coupe",
  "convertible",
  "pickup",
  "van",
  "other",
] as const;
export type Body = (typeof BODIES)[number];

export const TRANSMISSIONS = ["manual", "automatic"] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

export const DRIVES = ["fwd", "rwd", "awd"] as const;
export type Drive = (typeof DRIVES)[number];

/** Countries whose listings the app covers. A listing's market is where the car stands. */
export const MARKETS = ["CZ", "DE", "AT"] as const;
export type Market = (typeof MARKETS)[number];

export const CONDITIONS = ["new", "demo", "used"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const SELLERS = ["dealer", "private", "unknown"] as const;
export type Seller = (typeof SELLERS)[number];

/**
 * What the shown price includes. `gross` = incl. the origin country's VAT (DE dealers
 * showing "MwSt. ausweisbar"); `net` = excl. VAT (export/Netto price); `margin` = margin
 * scheme, VAT not separable; `unknown` = the source does not say (typical for private sellers).
 */
export const PRICE_BASES = ["gross", "net", "margin", "unknown"] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];

/** ISO 4217 code, upper case. */
export type CurrencyCode = string;

export interface Money {
  /** Major units (CZK, EUR), not cents. Finite and >= 0. */
  amount: number;
  currency: CurrencyCode;
}

/** Calendar date `YYYY-MM-DD` (no time zone; dates are Europe/Prague days). */
export type IsoDate = string;

export interface YearMonth {
  year: number;
  /** 1-12; absent when the source shows only the year. */
  month?: number;
}

/**
 * A vehicle as one source describes it: raw make/model text plus whatever specs the
 * source states. The Resolver matches it to a catalog Variant.
 */
export interface VehicleDescriptor {
  /** Make as shown by the source ("Škoda", "VW", "Mercedes-Benz"). */
  make: string;
  /** Model as shown by the source ("Octavia", "Golf Variant"). */
  model: string;
  /** Version or trim text as shown ("2.0 TDI Style DSG"). */
  trim?: string;
  /**
   * The source's own taxonomy ids for make/model (Sauto codebook values, AutoScout24
   * taxonomy ids), when it has them. Lets the Resolver keep per-source alias tables.
   */
  sourceTaxonomy?: { make?: string; model?: string };
  firstRegistration?: YearMonth;
  /** Year of manufacture, when the source states that instead of first registration. */
  manufactureYear?: number;
  /** Manufacturer's model year (price lists). */
  modelYear?: number;
  body?: Body;
  fuel?: Fuel;
  powerKw?: number;
  transmission?: Transmission;
  drive?: Drive;
  engineCc?: number;
  seats?: number;
  doors?: number;
  /** Euro emission class 0-7 (Euro 6d counts as 6). */
  euroClass?: number;
  /** Combined consumption, l/100 km (ICE and hybrids). */
  consumptionL100km?: number;
  /** Combined consumption, kWh/100 km (BEV). */
  consumptionKwh100km?: number;
  co2GKm?: number;
  /** Colour as shown by the source. */
  color?: string;
}

/** Latest ČNB fixing per currency. `CZK` is implicit (1). */
export type FxTable = Record<CurrencyCode, { czkPerUnit: number; validFor: IsoDate }>;
