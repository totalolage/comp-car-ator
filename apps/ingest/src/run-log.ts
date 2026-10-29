/**
 * A run log: one Source run written to a file instead of the Ledger, so harvests can run as
 * parallel jobs on separate machines and a single job records them all (ADR 0014).
 *
 * NDJSON: a `run` line (RunInfo), one `observation` line each, and an `end` line saying whether
 * the harvest completed. Recording a log replays it through `Ledger.record` with the same
 * outcome the in-process run would have had: a failed or truncated log ends by throwing, so the
 * Ledger keeps what was recorded (and every SliceDone) and marks the run failed.
 */

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Http } from "@cca/http";
import { type Ledger, RunFailedError, type RunInfo, type RunSummary } from "@cca/ledger";
import { type HarvestMode, type Logger, type Source, silentLogger } from "@cca/sources";
import type { Observation } from "@cca/vocabulary";

type Line =
  | { run: { source: string; mode: HarvestMode; scope?: string; startedAt: string } }
  | { observation: Observation }
  | { end: "complete" }
  | { end: "failed"; error: string };

export interface HarvestToLogOptions {
  /** Read only, for the Source's Checkpoint. */
  ledger: Ledger;
  source: Source;
  http: Http;
  mode: HarvestMode;
  now: Date;
  /** File to write. */
  out: string;
  log?: Logger;
  signal?: AbortSignal;
}

export interface HarvestReport {
  source: string;
  mode: HarvestMode;
  observations: number;
  /** The harvest's error, or null when it completed. */
  error: string | null;
}

/**
 * Harvests one Source into a run log. Resolves even when the harvest fails; see `error`. An
 * aborted `signal` fails the harvest even when the Source ignores it: the run stops after the
 * observation in hand is written, so what was harvested (and every finished slice) is kept, and
 * it never ends as complete.
 */
export async function harvestToLog(options: HarvestToLogOptions): Promise<HarvestReport> {
  const { ledger, source, http, mode, now, out, log = silentLogger } = options;
  const signal = options.signal ?? new AbortController().signal;
  const file = createWriteStream(out);
  // A write error is not the harvest failing: it fails the whole call.
  let writeError: Error | null = null;
  file.on("error", (error) => {
    writeError ??= error;
  });
  const write = async (line: Line) => {
    if (writeError) throw writeError;
    if (!file.write(`${JSON.stringify(line)}\n`)) await once(file, "drain");
  };
  const report: HarvestReport = { source: source.id, mode, observations: 0, error: null };
  try {
    await write({
      run: { source: source.id, mode, scope: source.scope, startedAt: now.toISOString() },
    });
    try {
      const checkpoint = ledger.checkpoint(source.id, source.scope);
      for await (const observation of source.harvest({
        http,
        mode,
        checkpoint,
        now,
        log,
        signal,
      })) {
        await write({ observation });
        report.observations++;
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      await write({ end: "complete" });
    } catch (error) {
      if (writeError) throw writeError;
      report.error = String(error);
      await write({ end: "failed", error: report.error });
    }
  } finally {
    if (!file.destroyed) {
      file.end();
      await once(file, "close").catch(() => {});
    }
  }
  if (writeError) throw writeError;
  return report;
}

/** Records a run log into the Ledger as one run. Rejects like `Ledger.record` when the run failed. */
export async function recordLog(ledger: Ledger, path: string): Promise<RunSummary> {
  const log = await openLog(path);
  try {
    return await ledger.record(log.info, log.observations());
  } catch (error) {
    // Broken JSON and file reads are release failures, not failed harvests to publish.
    if (error instanceof RunFailedError && !(error.cause instanceof HarvestFailedError))
      throw error.cause;
    throw error;
  }
}

class HarvestFailedError extends Error {}

/** The run a log describes, without reading past its first line. */
export async function readLogInfo(path: string): Promise<RunInfo> {
  const log = await openLog(path);
  await log.close();
  return log.info;
}

async function openLog(path: string): Promise<{
  info: RunInfo;
  observations(): AsyncIterable<Observation>;
  close(): Promise<unknown>;
}> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const first = await lines.next();
  const head = first.done ? undefined : (JSON.parse(first.value) as Line);
  if (!head || !("run" in head)) {
    lines.return?.();
    throw new Error(`${path} is not a run log`);
  }
  const info: RunInfo = { ...head.run, startedAt: new Date(head.run.startedAt) };
  async function* observations(): AsyncIterable<Observation> {
    try {
      for (let next = await lines.next(); !next.done; next = await lines.next()) {
        const line = JSON.parse(next.value) as Line;
        if ("observation" in line) yield line.observation;
        else if ("end" in line && line.end === "complete") return;
        else if ("end" in line && line.end === "failed")
          throw new HarvestFailedError(`harvest failed: ${line.error}`);
        else throw new Error(`malformed run log ${path}: invalid record`);
      }
      throw new HarvestFailedError(`run log ${path} is truncated (no end line)`);
    } finally {
      await lines.return?.();
    }
  }
  return { info, observations, close: async () => lines.return?.() };
}
