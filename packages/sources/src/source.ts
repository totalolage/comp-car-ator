import type { Http } from "@cca/http";
import type { Observation } from "@cca/vocabulary";

/** Stable kebab-case id of a Source adapter ("cnb", "sauto", "autoscout24-de"). */
export type SourceId = string;

/**
 * `incremental`: only what is new since the last run (newest-first, stop at known refs).
 * Existing listings' price changes are not refreshed by incremental runs; full runs do that.
 * `full`: a census of everything the adapter covers under its `scope`. After a full run
 * completes cleanly, the Ledger treats this Source's listings in that scope that no full run
 * of the census saw as missing. A census can span runs: see `Checkpoint.sliceDoneAt`.
 */
export type HarvestMode = "incremental" | "full";

/**
 * The Source seam (docs/adr/0003-source-seam-and-observation-vocabulary.md). One adapter per site, API or
 * dataset. An adapter hides pagination, parsing, query splitting and source quirks, and
 * emits Observations in the shared vocabulary.
 *
 * Interface contract:
 * - `harvest` is lazy: no request happens before the first `next()`.
 * - It may yield an Observation more than once; the Ledger is idempotent.
 * - In `full` mode it must yield a ListingSeen for every listing currently in scope, or
 *   throw. A harvest that throws is never treated as a census. An adapter that splits its
 *   scope into slices yields SliceDone after each finished slice, and may skip slices whose
 *   `ctx.checkpoint.sliceDoneAt` is set: earlier full runs of this census covered them.
 * - It stops promptly when `ctx.signal` aborts: pass it to every `ctx.http.get` (throwing the
 *   abort reason is fine).
 * - All network access goes through `ctx.http`; it never reads the clock except via `ctx.now`.
 * - Http errors it cannot work around propagate; the run fails, recorded data stays.
 */
export interface Source {
  readonly id: SourceId;
  /**
   * Stable name of what this adapter instance covers (e.g. AutoScout24 slice "makes:skoda,vw").
   * Census inference only touches listings last seen under the same scope, so narrowing or
   * slicing a Source never retires listings outside the slice. Default "all".
   */
  readonly scope?: string;
  harvest(ctx: HarvestContext): AsyncIterable<Observation>;
}

export interface HarvestContext {
  readonly http: Http;
  readonly mode: HarvestMode;
  readonly checkpoint: Checkpoint;
  /** Start of this run. Use instead of `new Date()`. */
  readonly now: Date;
  readonly log: Logger;
  readonly signal: AbortSignal;
}

/**
 * What the Ledger already knows about this Source in this run's scope, so incremental runs can
 * stop early and a failed full census can resume.
 */
export interface Checkpoint {
  /** Start of the last complete run of this Source in this scope, or null on the first run. */
  readonly lastRunAt: Date | null;
  /** Whether a listing with this ref is already in the Ledger and not gone. */
  isKnown(ref: string): boolean;
  /**
   * When a full run of the current census (full runs in this scope since the last complete
   * one) reported this slice done, or null. A full harvest skips slices with a date; it may
   * redo old ones if it judges them stale. A complete full run ends the census, so the next
   * one starts with every slice null.
   */
  sliceDoneAt(slice: string): Date | null;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {} };

export const emptyCheckpoint: Checkpoint = {
  lastRunAt: null,
  isKnown: () => false,
  sliceDoneAt: () => null,
};
