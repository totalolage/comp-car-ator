import type { VariantSpec } from "./catalog.ts";
import type {
  Condition,
  CurrencyCode,
  IsoDate,
  Market,
  Money,
  PriceBasis,
  Seller,
  VehicleDescriptor,
} from "./vehicle.ts";

/**
 * Observation: one fact a Source saw, in source-neutral terms. The closed union is the
 * standard output of the Source seam (docs/adr/0003-observation-vocabulary.md).
 *
 * Observations carry no source id and no timestamp: the Ledger stamps both from the
 * run that recorded them, so an adapter cannot get them wrong.
 */
export type Observation = ListingSeen | ListingGone | FxRate | CatalogEntry | ListPrice;

export type ObservationKind = Observation["kind"];

/** A listing was visible at the source during this run. */
export interface ListingSeen {
  kind: "ListingSeen";
  /** Source-local id, stable for the listing's lifetime (e.g. Sauto item id). */
  ref: string;
  /** Canonical public URL of the listing. */
  url: string;
  market: Market;
  condition: Condition;
  vehicle: VehicleDescriptor;
  odometerKm?: number;
  /** Price as shown, in the listing's currency. */
  price: Money;
  priceBasis: PriceBasis;
  seller: Seller;
  location?: { region?: string; city?: string; postcode?: string };
  /** Absolute image URLs; first is the cover. */
  photos: string[];
  /** When the source says the listing was posted, if it says. */
  listedAt?: IsoDate;
}

/** The source positively reports the listing as removed or sold (e.g. a 404/410 detail page). */
export interface ListingGone {
  kind: "ListingGone";
  ref: string;
}

/** One ČNB fixing: how many CZK one unit of `currency` cost on `validFor`. */
export interface FxRate {
  kind: "FxRate";
  currency: CurrencyCode;
  validFor: IsoDate;
  /** ČNB `kurz / množství`, so per single unit even for per-100 quotes. */
  czkPerUnit: number;
}

/** A catalog Source describes a Variant (register, type approval, spec database). */
export interface CatalogEntry {
  kind: "CatalogEntry";
  variant: VariantSpec;
}

/** A manufacturer price list states the new price of a trim. */
export interface ListPrice {
  kind: "ListPrice";
  /** Trim text belongs in `vehicle.trim`; the Resolver maps the rest to a Variant. */
  vehicle: VehicleDescriptor;
  /** Gross consumer price in the market's currency. */
  price: Money;
  market: Market;
  validFrom: IsoDate;
}
