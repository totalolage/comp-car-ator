import type { Resolution } from "@cca/resolver";
import type { Checkpoint, HarvestMode, SourceId } from "@cca/sources";
import type {
  CatalogVariant,
  Condition,
  FxTable,
  IsoDate,
  ListPrice,
  Market,
  Money,
  Observation,
  ObservationKind,
  PriceBasis,
  Seller,
  SellerExtras,
  VehicleDescriptor,
  YearMonth,
} from "@cca/vocabulary";

export interface RunInfo {
  source: SourceId;
  mode: HarvestMode;
  /** The Source's coverage name (`Source.scope`); census inference stays inside it. Default "all". */
  scope?: string;
  /** Every Observation of the run is stamped with this time. */
  startedAt: Date;
}

export interface RunSummary {
  recorded: Partial<Record<ObservationKind, number>>;
  /**
   * Observations that broke an invariant (non-finite price, empty ref...), with reasons.
   * They are skipped; the rest of the run is recorded.
   */
  rejected: { kind: string; reason: string }[];
  newListings: number;
  priceChanges: number;
  /** Listings marked gone by this run (explicit ListingGone, or missed by 2 censuses). */
  gone: number;
  /** Catalog entries of this Source retired by this run's census (stated by none of its runs). */
  retired: number;
  /**
   * Whether this run counted as a census: only complete full runs without rejected
   * Observations do, since rejections may mean the parser broke on part of the site.
   */
  census: "applied" | "skipped-rejections" | "not-full";
}

/**
 * The Ledger's interface. Opened on a SQLite file (or ":memory:" in tests). Not safe for
 * concurrent writers; one ingest process owns the file.
 */
export interface Ledger {
  /** What a run of this Source in this scope (default "all") may skip. */
  checkpoint(source: SourceId, scope?: string): Checkpoint;
  /**
   * Records one run's Observations, streaming them in batched transactions. Idempotent per
   * (source, day): re-recording the same Observations changes nothing.
   *
   * A census is the full runs of a scope from the first after its previous complete full run,
   * so the slices a failed one reported done (SliceDone) may be skipped. A complete full run
   * ends it, and so does stalling: once its full runs span 6 days and its last two finished no
   * slice, the next full run starts a new one (a slice that can never finish keeps no census
   * open for good).
   *
   * Absence: a listing that no run of the census saw (ListingSeen or ListingPriceSeen) is
   * counted missed, at most once per census and per day, and a listing missed by 2 censuses in
   * a row is gone as of the first miss. When any full run ends, complete or failed, this counts
   * the listings of the slices it finished (`ListingSeen.slice`), so finished slices retire
   * listings while others never finish. When a complete full run without rejected
   * Observations ends, it counts every active listing of the Source in the run's scope, and
   * retires this Source's catalog entries in the scope that no run of the census stated (a
   * Variant re-keyed or withdrawn; a later run that states it again restores it).
   *
   * When the iterable throws, what was recorded stays (each SliceDone is durable once
   * recorded), the run is marked failed, only its finished slices are inferred on, and
   * `record` rejects with that error. A SliceDone is rejected after a rejected Observation in
   * its slice or a rejected sighting of a listing in it (see `SliceDone`), so the slice is
   * harvested again.
   */
  record(
    run: RunInfo,
    observations: AsyncIterable<Observation> | Iterable<Observation>,
  ): Promise<RunSummary>;
  /** The read model for publishing, as of now. */
  snapshot(): LedgerSnapshot;
  close(): void;
}

export interface LedgerSnapshot {
  fx: FxTable;
  sources: { id: SourceId; lastRunAt: Date | null }[];
  /** Merged catalog: one entry per Variant id. */
  catalog: CatalogVariant[];
  /**
   * Every recorded edition of every new-price offer. `offer` is `<source>:<ref>`. On a day,
   * an offer's price is its edition with the latest `validFrom` on or before that day,
   * unless that edition's `validTo` is before the day (then it has none).
   */
  listPrices: (Omit<ListPrice, "kind" | "ref"> & { offer: string; resolution: Resolution })[];
  /**
   * All listings, active and gone, with history, in id order. Given `ids`, only those, in
   * that order (unknown ids are skipped): a reader that groups listings by something the
   * Ledger does not store, such as the Resolver's model, makes one pass for the grouping and
   * reads each group back instead of holding every listing at once.
   */
  listings(ids?: Iterable<string>): Iterable<LedgerListing>;
}

export interface LedgerListing {
  /** `<source>:<ref>` */
  id: string;
  source: SourceId;
  ref: string;
  url: string;
  market: Market;
  condition: Condition;
  vehicle: VehicleDescriptor;
  odometerKm?: number;
  /** Latest price. */
  price: Money;
  /** As last seen; see `ListingSeen.sellerExtras`. */
  sellerExtras?: SellerExtras;
  priceBasis: PriceBasis;
  seller: Seller;
  location?: { region?: string; city?: string; postcode?: string };
  photos: string[];
  listedAt?: IsoDate;
  inspectionValidUntil?: YearMonth;
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  gone: IsoDate | null;
  /** One entry per price change, oldest first; the first is the price when first seen. */
  priceHistory: { date: IsoDate; price: Money }[];
  /** Resolved against the current catalog at snapshot time. */
  resolution: Resolution;
}
