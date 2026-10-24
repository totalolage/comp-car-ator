import type { Http } from "@cca/http";
import type { Observation } from "@cca/vocabulary";

/** Stable kebab-case id of a Source adapter ("cnb", "sauto", "autoscout24-de"). */
export type SourceId = string;

/**
 * `incremental`: only what is new since the last run (newest-first, stop at known refs).
 * `full`: a census of everything the adapter is configured to cover. After a full run
 * completes, the Ledger treats listings of this Source that were not seen as missing.
 */
export type HarvestMode = "incremental" | "full";

/**
 * The Source seam (docs/adr/0003-observation-vocabulary.md). One adapter per site, API or
 * dataset. An adapter hides pagination, parsing, query splitting and source quirks, and
 * emits Observations in the shared vocabulary.
 *
 * Interface contract:
 * - `harvest` is lazy: no request happens before the first `next()`.
 * - It may yield an Observation more than once; the Ledger is idempotent.
 * - In `full` mode it must yield a ListingSeen for every listing currently in scope, or
 *   throw. A harvest that throws is never treated as a census.
 * - It stops promptly when `ctx.signal` aborts (throwing the abort reason is fine).
 * - All network access goes through `ctx.http`; it never reads the clock except via `ctx.now`.
 * - Http errors it cannot work around propagate; the run fails, recorded data stays.
 */
export interface Source {
  readonly id: SourceId;
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

/** What the Ledger already knows about this Source, so incremental runs can stop early. */
export interface Checkpoint {
  /** Start of the last run of this Source that completed, or null on the first run. */
  readonly lastRunAt: Date | null;
  /** Whether a listing with this ref is already in the Ledger and not gone. */
  isKnown(ref: string): boolean;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {} };

export const emptyCheckpoint: Checkpoint = { lastRunAt: null, isKnown: () => false };
