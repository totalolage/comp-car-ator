/**
 * Composition root: wires Sources, Http, the Ledger and the Publisher. The CLI (cli.ts) is a
 * thin argument parser over these functions; tests call them directly.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BundleFiles } from "@cca/bundle";
import { createReplayHttp, type Http, loadCassette } from "@cca/http";
import { type Ledger, openLedger, type RunSummary } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { cnbSource, type HarvestMode, type Logger, type Source, silentLogger } from "@cca/sources";
import type { Observation } from "@cca/vocabulary";

export interface RunSourceOptions {
  ledger: Ledger;
  source: Source;
  http: Http;
  mode: HarvestMode;
  now: Date;
  log?: Logger;
  signal?: AbortSignal;
}

/** Harvests one Source into the Ledger as one run. Rejects if the harvest fails. */
export function runSource(options: RunSourceOptions): Promise<RunSummary> {
  const {
    ledger,
    source,
    http,
    mode,
    now,
    log = silentLogger,
    signal = new AbortController().signal,
  } = options;
  return ledger.record(
    { source: source.id, mode, scope: source.scope, startedAt: now },
    source.harvest({ http, mode, checkpoint: ledger.checkpoint(source.id), now, log, signal }),
  );
}

/**
 * Observations recorded from a file instead of a live Source, run by run. Used for the
 * sample fixture and for seeding a Ledger by hand.
 */
export interface ObservationFile {
  runs: { source: string; mode: HarvestMode; startedAt: string; observations: Observation[] }[];
}

export async function importObservations(
  ledger: Ledger,
  file: ObservationFile,
): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];
  for (const run of file.runs) {
    summaries.push(
      await ledger.record(
        { source: run.source, mode: run.mode, startedAt: new Date(run.startedAt) },
        run.observations,
      ),
    );
  }
  return summaries;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const SAMPLE = {
  observations: `${repoRoot}fixtures/sample-observations.json`,
  cnbCassette: `${repoRoot}packages/sources/src/cnb/fixtures/incremental-latest.cassette.json`,
  bundleDir: `${repoRoot}fixtures/sample-bundle`,
  now: new Date("2026-10-24T16:00:00Z"),
};

/**
 * Builds the sample Bundle the web app and Wave 1 web streams develop against: the recorded
 * ČNB fixing plus hand-written sample observations, through the real Ledger and Publisher.
 */
export async function buildSampleBundle(): Promise<BundleFiles> {
  const ledger = openLedger(":memory:");
  try {
    const file = JSON.parse(await readFile(SAMPLE.observations, "utf8")) as ObservationFile;
    await importObservations(ledger, file);
    await runSource({
      ledger,
      source: cnbSource(),
      http: createReplayHttp(await loadCassette(SAMPLE.cnbCassette)),
      mode: "incremental",
      now: SAMPLE.now,
    });
    return publish(ledger, { now: SAMPLE.now });
  } finally {
    ledger.close();
  }
}
