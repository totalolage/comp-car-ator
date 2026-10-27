/**
 * One harvest job of the daily ingest (docs/adr/0014-daily-ingest-pipeline.md): the Runs the
 * plan gave a Source, in order, each to its own Run log.
 */
import type { Http } from "@cca/http";
import type { Ledger } from "@cca/ledger";
import type { HarvestMode, Logger, Source } from "@cca/sources";
import { type HarvestReport, harvestToLog } from "./run-log.ts";
import type { HarvestModes } from "./schedule.ts";

/** The incremental Run before a full one stops after this long, leaving the rest to the full. */
const CATCH_UP_MS = 60 * 60_000;

export interface HarvestJobOptions {
  /** Read only, for the Source's Checkpoint. */
  ledger: Ledger;
  source: Source;
  http: Http;
  modes: HarvestModes;
  /** Run log file. For `incremental,full` each Run writes next to it, `x.ndjson` becoming
   * `x.incremental.ndjson` and `x.full.ndjson`. */
  out: string;
  log?: Logger;
  /** Ends the whole job: a Run still going is cut off as failed, a Run not started fails at once. */
  signal?: AbortSignal;
  /** Each Run's start. Default: the wall clock. */
  clock?: () => Date;
  /** Limit of the incremental Run of `incremental,full`. Default: an hour. */
  catchUpMs?: number;
}

/**
 * Runs the job's harvests and resolves with one report per Run, even when Runs fail. Of
 * `incremental,full`, the full Run runs even when the incremental one failed: Census progress
 * does not depend on it.
 */
export async function harvestJob(options: HarvestJobOptions): Promise<HarvestReport[]> {
  const { modes, out, signal, clock = () => new Date(), catchUpMs = CATCH_UP_MS } = options;
  const runs: { mode: HarvestMode; out: string; limit?: number }[] =
    modes === "incremental,full"
      ? [
          { mode: "incremental", out: logOf(out, "incremental"), limit: catchUpMs },
          { mode: "full", out: logOf(out, "full") },
        ]
      : [{ mode: modes, out }];
  const reports: HarvestReport[] = [];
  for (const run of runs) {
    const signals = [signal, run.limit === undefined ? undefined : AbortSignal.timeout(run.limit)];
    reports.push(
      await harvestToLog({
        ledger: options.ledger,
        source: options.source,
        http: options.http,
        log: options.log,
        mode: run.mode,
        now: clock(),
        out: run.out,
        signal: AbortSignal.any(signals.filter((s) => s !== undefined)),
      }),
    );
  }
  return reports;
}

function logOf(out: string, mode: string): string {
  return out.replace(/(\.ndjson)?$/, `.${mode}.ndjson`);
}
