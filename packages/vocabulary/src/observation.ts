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
  YearMonth,
} from "./vehicle.ts";

/**
 * Observation: one fact a Source saw, in source-neutral terms. The closed union is the
 * standard output of the Source seam (docs/adr/0003-source-seam-and-observation-vocabulary.md).
 *
 * Observations carry no source id and no timestamp: the Ledger stamps both from the
 * run that recorded them, so an adapter cannot get them wrong.
 */
export type Observation =
  | ListingSeen
  | ListingGone
  | FxRate
  | CatalogEntry
  | VariantFacts
  | ListPrice
  | SliceDone;

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
  /**
   * Sum of the charges the seller invoices on top of `price` and the buyer cannot decline
   * (delivery/Überführung, preparation, dealer registration fees), in `price`'s currency.
   * Not charges already in `price`, nor transport the buyer arranges. Absent when the
   * listing shows none.
   */
  sellerExtras?: SellerExtras;
  priceBasis: PriceBasis;
  seller: Seller;
  location?: { region?: string; city?: string; postcode?: string };
  /** Absolute image URLs; first is the cover. */
  photos: string[];
  /** When the source says the listing was posted, if it says. */
  listedAt?: IsoDate;
  /** Last month the origin country's periodic inspection (DE "HU") is valid, if shown. */
  inspectionValidUntil?: YearMonth;
}

export interface SellerExtras extends Money {
  /** Fees can be shown gross while the car is shown net, so they carry their own basis. */
  basis: PriceBasis;
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

/**
 * A catalog Source fully identifies and describes a Variant (register, type approval).
 * Only CatalogEntries create Variants.
 */
export interface CatalogEntry {
  kind: "CatalogEntry";
  variant: VariantSpec;
}

/**
 * Partial Spec evidence from a Source that cannot identify a Variant on its own (EEA has no
 * body, Wikidata is sparse). At snapshot time the Ledger resolves `vehicle` and fills the
 * matched Variant's missing Specs; CatalogEntry values win over facts.
 */
export interface VariantFacts {
  kind: "VariantFacts";
  vehicle: VehicleDescriptor;
  facts: VariantFactFields;
}

export type VariantFactFields = Partial<
  Pick<
    VariantSpec,
    | "drive"
    | "engineCc"
    | "seats"
    | "doors"
    | "euroClass"
    | "consumptionL100km"
    | "consumptionKwh100km"
    | "co2GKm"
    | "massKg"
    | "lengthMm"
  >
>;

/**
 * A manufacturer price list states the new price of one offer in one edition. An offer is
 * one priced configuration (Trim, engine, drive, gearbox, model year...); several offers
 * usually resolve to the same Variant, so the offer has its own identity, `ref`.
 */
export interface ListPrice {
  kind: "ListPrice";
  /**
   * Source-local id of the offer, stable across editions: the manufacturer's sales code, or
   * the row key of a curated table. Unique within the Source, markets included: offers that
   * differ in anything priced need different refs; a later edition of the offer reuses it.
   */
  ref: string;
  /** Trim text belongs in `vehicle.trim`; the Resolver maps the rest to a Variant. */
  vehicle: VehicleDescriptor;
  /** Gross consumer price in the market's currency. */
  price: Money;
  market: Market;
  /** First day this edition's price applies. An edition replaces earlier ones of its offer. */
  validFrom: IsoDate;
  /**
   * Last day this edition's price applies, inclusive. Absent: until a later edition. Set it
   * when the list states an end date, or re-emit the edition with it when the offer is
   * withdrawn; the offer then has no New price after that day.
   */
  validTo?: IsoDate;
}

/**
 * The Source has yielded every listing currently in one slice of its `scope` during this run
 * (e.g. an AutoScout24 make/model/year/price query under the result cap). `slice` is the
 * adapter's own stable key. Full runs report slices so a census that fails part way resumes:
 * the next full run reads `Checkpoint.sliceDoneAt` and skips slices already done.
 */
export interface SliceDone {
  kind: "SliceDone";
  slice: string;
}
