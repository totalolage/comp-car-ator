import type { VariantSpec } from "./catalog.ts";
import type {
  Condition,
  CurrencyCode,
  Fuel,
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
  | ListingPriceSeen
  | ListingGone
  | FxRate
  | CatalogEntry
  | VariantFacts
  | ListPrice
  | OpenpilotSupport
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
  /**
   * The census slice (`SliceDone.slice`) this listing was met in, for an adapter whose
   * slices hold a listing by what it seldom changes (a category and its ad id, a year), never
   * by price. A census that finishes the slice without seeing the listing counts it missed even
   * when other slices never finish. Leave it out where slices are price bands: a listing
   * repriced into another band would be missed in the one it left. The Ledger keeps it
   * between sightings that carry none; it is not part of the published listing.
   */
  slice?: string;
}

export interface SellerExtras extends Money {
  /** Fees can be shown gross while the car is shown net, so they carry their own basis. */
  basis: PriceBasis;
}

/**
 * A listing the Ledger knows was visible at the source during this run with this price, read
 * from list data that lacks the rest of its ListingSeen (an incremental run's search page). The
 * Ledger updates only the listing's price and its price history; every other field, and when
 * the listing was last seen, stays as the last ListingSeen left it, `priceBasis` included. It
 * still proves the listing live: a census it falls in does not count the listing missed.
 * `price` must be the amount the source's ListingSeen would carry, from the same field and in
 * the same currency, or the history records a change that did not happen. A ref the Ledger has no live listing for, or a
 * price in another currency, is rejected: only a ListingSeen can add or change those.
 */
export interface ListingPriceSeen {
  kind: "ListingPriceSeen";
  ref: string;
  price: Money;
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
 * Harvest slices one after another: Observations since the previous SliceDone (or the run's
 * start) belong to this one, but for a ListingSeen naming its own (`ListingSeen.slice`, which
 * an adapter may yield while another slice is harvested), and a rejected one among them keeps
 * the slice not done, as does a rejected sighting of a listing in the slice anywhere in the
 * run (a ListingSeen naming it in `ListingSeen.slice`, or a ListingPriceSeen of a listing the
 * Ledger holds in it). Listings in the slice that no run of the census saw count a miss when
 * it is done.
 */
export interface SliceDone {
  kind: "SliceDone";
  slice: string;
}

/**
 * How well comma.ai's openpilot driver assistance works on a car, best first: `upstream` works
 * with a comma device out of the box; `community` runs on community forks; `custom` needs
 * development builds or unusual setup; `underReview` is merged but not yet released;
 * `dashcam` records but never engages; `incompatible` cannot work (CAN security, FlexRay).
 */
export const OPENPILOT_LEVELS = [
  "upstream",
  "community",
  "custom",
  "underReview",
  "dashcam",
  "incompatible",
] as const;
export type OpenpilotLevel = (typeof OPENPILOT_LEVELS)[number];

/**
 * One row of openpilot's supported-car list: a make, a model and its model years, the package
 * the car needs, and how well openpilot supports it. The list is a census: a full run states
 * every row, and rows it no longer states leave the catalog. At snapshot time the Ledger
 * matches the row to Generations and Variants by make, model, fuel and years.
 */
export interface OpenpilotSupport {
  kind: "OpenpilotSupport";
  /** Source-local row key, stable while the list keeps the row (make, model text, package). */
  ref: string;
  /** Make and model as listed, without years or market ("Volkswagen", "Golf GTI"). */
  make: string;
  model: string;
  /** Fuel, only when the model name states it ("RAV4 Hybrid", "Kona Electric"). */
  fuel?: Fuel;
  /** Model years, ascending ("2018-20, 2023" is [2018, 2019, 2020, 2023]). */
  years: number[];
  level: OpenpilotLevel;
  /** The trim or package the car needs, as listed; absent when the list says "All". */
  package?: string;
  /**
   * The market the list refers the row to: its own qualifier ("Europe", "China") or the
   * list's default ("US").
   */
  market: string;
  /**
   * true: the row covers cars built for Europe; false: only for other markets (China);
   * absent: the list does not say (a US-referenced row: European versions may differ).
   */
  europe?: boolean;
  /** Harness connector the install needs ("VW J533 connector"). */
  harness?: string;
  /**
   * Who controls gas and brakes: `openpilot`; `optional`, openpilot behind an opt-in
   * toggle (alpha); or the car's own `stock` ACC.
   */
  longitudinal?: "openpilot" | "optional" | "stock";
  /** Below these speeds openpilot does not steer / does not engage, km/h. */
  minSteerKmh?: number;
  minEnableKmh?: number;
  /** Where to check the car on the list's own site. */
  url: string;
}
