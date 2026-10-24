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
  VehicleDescriptor,
} from "@cca/vocabulary";

export interface RunInfo {
  source: SourceId;
  mode: HarvestMode;
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
}

/**
 * The Ledger's interface. Opened on a SQLite file (or ":memory:" in tests). Not safe for
 * concurrent writers; one ingest process owns the file.
 */
export interface Ledger {
  /** What incremental runs of this Source may skip. */
  checkpoint(source: SourceId): Checkpoint;
  /**
   * Records one run's Observations, streaming them in batched transactions. Idempotent per
   * (source, day): re-recording the same Observations changes nothing.
   *
   * When the iterable completes, the run is marked complete; for a `full` run, this
   * Source's active listings that were not seen are counted as missed, and a listing missed
   * by 2 consecutive complete full runs is gone as of the first miss. When the iterable
   * throws, what was recorded stays, the run is marked failed, nothing is inferred, and
   * `record` rejects with that error.
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
  listPrices: (Omit<ListPrice, "kind"> & { resolution: Resolution })[];
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
  priceBasis: PriceBasis;
  seller: Seller;
  location?: { region?: string; city?: string; postcode?: string };
  photos: string[];
  listedAt?: IsoDate;
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  gone: IsoDate | null;
  /** One entry per price change, oldest first; the first is the price when first seen. */
  priceHistory: { date: IsoDate; price: Money }[];
  /** Resolved against the current catalog at snapshot time. */
  resolution: Resolution;
}
