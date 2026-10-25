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
  /** Listings marked gone by this run (explicit ListingGone, or missing from a full census). */
  gone: number;
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
   * When the iterable completes, the run is marked complete. A `full` run with no rejected
   * Observations then closes a census: this Source's active listings in the run's scope that
   * no full run since the scope's previous complete full run saw are counted as missed (at
   * most once per day), and a listing missed on 2 days of censuses is gone as of the first
   * miss. Failed full runs in between belong to the census, so the slices they reported done
   * (SliceDone) may be skipped. When the iterable throws, what was recorded stays (each
   * SliceDone is durable once recorded), the run is marked failed, nothing is inferred, and
   * `record` rejects with that error. A SliceDone after a rejected Observation in that slice
   * is rejected too, so the slice is harvested again.
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
  /** All listings, active and gone, with history. */
  listings(): Iterable<LedgerListing>;
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
