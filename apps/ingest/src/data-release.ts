/**
 * Data releases: how the Ledger survives between ephemeral ingest jobs and how the Bundle
 * reaches the web build (docs/adr/0014-daily-ingest-pipeline.md).
 *
 * A data release is tagged `data-<UTC stamp>` and carries `ledger.sqlite.zst`, `bundle.json.gz`
 * and `manifest.json` (sha256 and size of both, plus what the runs recorded). The newest one is
 * the latest; a release becomes visible only once complete, so a run that fails anywhere leaves
 * the previous release as the latest. Every job of one ingest works from the same base release,
 * and the new release is refused if the latest moved meanwhile, so run logs are recorded only
 * onto the Ledger they were harvested against, and only once.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { packBundle } from "@cca/bundle/node";
import { openLedger, RunFailedError, type RunSummary } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { type HarvestMode, type Logger, silentLogger } from "@cca/sources";
import type { ReleaseStore } from "./release-store.ts";
import { readLogInfo, recordLog } from "./run-log.ts";

export const ASSETS = {
  ledger: "ledger.sqlite.zst",
  bundle: "bundle.json.gz",
  manifest: "manifest.json",
} as const;
export const TAG_PREFIX = "data-";

export interface Manifest {
  dataRelease: 1;
  tag: string;
  createdAt: string;
  /** The release this one's Ledger was restored from. */
  previous: string | null;
  /** Commit of the app repo the ingest ran. */
  commit: string | null;
  assets: Record<string, { sha256: string; bytes: number }>;
  runs: RunOutcome[];
  /** Start of each Source's last applied census, carried from release to release (for `plan`). */
  lastCensus: Record<string, string>;
}

export interface RunOutcome {
  source: string;
  mode: HarvestMode;
  startedAt: string;
  /** Counters for the durable observations, including a failed run's accepted prefix. */
  summary?: RunSummary;
  /** Present when the harvest failed; what it got before failing is recorded. */
  error?: string;
}

export interface DataRelease {
  tag: string;
  manifest: Manifest;
}

/**
 * The newest data release, or the one tagged `tag`. Null only when the store lists no data
 * release at all; a store that cannot be listed rejects.
 */
export async function findRelease(store: ReleaseStore, tag?: string): Promise<DataRelease | null> {
  const releases = (await store.list()).filter((r) => r.tag.startsWith(TAG_PREFIX));
  const found = tag ? releases.find((r) => r.tag === tag) : releases[0];
  if (!found) {
    if (tag) throw new Error(`No data release ${tag}`);
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), "cca-manifest-"));
  try {
    await store.download(found.tag, ASSETS.manifest, join(dir, ASSETS.manifest));
    const manifest = JSON.parse(await readFile(join(dir, ASSETS.manifest), "utf8")) as Manifest;
    return { tag: found.tag, manifest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  /**
   * The release to restore (every job of one ingest uses the same base): a tag, null for "no
   * data release yet" (the first run; rejects if one exists by now), or undefined for the newest.
   */
  base?: string | null;
  /** Allow a fresh Ledger when there is no data release yet (the first run). */
  init?: boolean;
}

/**
 * Writes the base (default: newest) release's Ledger to `path`, checked against the manifest's
 * sha256, and returns the release. With no data release at all it rejects unless `init` (then it
 * clears `path` for a fresh Ledger and returns null): a missing release must never silently start
 * an empty Ledger that would then replace the real one. A null base rejects once any data release
 * exists, so a retried first run cannot restore a release made after its harvests.
 */
export async function restoreLedger(
  store: ReleaseStore,
  path: string,
  options: RestoreOptions = {},
): Promise<DataRelease | null> {
  const release = await findRelease(store, options.base ?? undefined);
  if (options.base === null && release)
    throw new Error(`Expected no data release, but ${release.tag} exists (made after the plan)`);
  if (!release) {
    if (options.init) {
      await rm(path, { force: true });
      return null;
    }
    throw new Error("No data release to restore the Ledger from (pass --init for the first run)");
  }
  const expected = release.manifest.assets[ASSETS.ledger];
  if (!expected) throw new Error(`${release.tag} has no ${ASSETS.ledger} in its manifest`);
  const compressed = `${path}.zst`;
  await store.download(release.tag, ASSETS.ledger, compressed);
  const actual = await fileDigest(compressed);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    await rm(compressed);
    throw new Error(`${release.tag}/${ASSETS.ledger} does not match its manifest sha256`);
  }
  await rm(path, { force: true });
  await pipeline(createReadStream(compressed), createZstdDecompress(), createWriteStream(path));
  await rm(compressed);
  return release;
}

export interface ReleaseRunsOptions {
  store: ReleaseStore;
  /** Run logs written by `harvestToLog`. */
  logs: string[];
  /** Scratch directory for the Ledger and assets. */
  work: string;
  now: Date;
  /**
   * The release the harvests restored, or null when there was none (the first run). It must
   * still be the newest. Required: defaulting to the newest would record the run logs onto a
   * Ledger they were not harvested against.
   */
  base: string | null;
  /** Allow starting a fresh Ledger when no data release exists (the first run). */
  init?: boolean;
  /** Data releases to keep, newest first. Default 14. */
  keep?: number;
  commit?: string | null;
  log?: Logger;
}

export interface ReleaseResult {
  tag: string;
  runs: RunOutcome[];
}

/**
 * Restores the base Ledger, records the run logs into it (oldest run first), publishes the
 * Bundle and releases both as the new latest, then prunes old data releases. A failed harvest
 * is recorded as a failed run, as it would be in process; any other failure rejects before
 * anything is released. Rejects without releasing when a newer release than the base appeared,
 * or when a run started before the base was released (its logs belong to an older Ledger, as
 * when an earlier run's logs are released again after a newer release).
 */
export async function releaseRuns(options: ReleaseRunsOptions): Promise<ReleaseResult> {
  const { store, work, now, keep = 14, log = silentLogger } = options;
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error(`keep must be a whole number of at least 1, not ${keep}`);
  await mkdir(work, { recursive: true });
  const ledgerPath = join(work, "ledger.sqlite");
  const base = await restoreLedger(store, ledgerPath, { base: options.base, init: options.init });
  const previous = base?.tag ?? null;
  log.info(previous ? `restored Ledger from ${previous}` : "starting a new Ledger");

  const logs = await Promise.all(
    options.logs.map(async (path) => ({ path, info: await readLogInfo(path) })),
  );
  logs.sort((a, b) => a.info.startedAt.getTime() - b.info.startedAt.getTime());
  const oldest = logs[0]?.info;
  if (base && oldest && oldest.startedAt < new Date(base.manifest.createdAt))
    throw new Error(
      `${oldest.source} ran at ${oldest.startedAt.toISOString()}, before ${base.tag} was released; these run logs are stale`,
    );

  const files = {
    [ASSETS.ledger]: join(work, ASSETS.ledger),
    [ASSETS.bundle]: join(work, ASSETS.bundle),
    [ASSETS.manifest]: join(work, ASSETS.manifest),
  };
  const runs: RunOutcome[] = [];
  const ledger = openLedger(ledgerPath);
  try {
    for (const { path, info } of logs) {
      const run: RunOutcome = {
        source: info.source,
        mode: info.mode,
        startedAt: info.startedAt.toISOString(),
      };
      try {
        run.summary = await recordLog(ledger, path);
        log.info(`recorded ${info.source} ${info.mode}`, { ...run.summary });
      } catch (error) {
        if (!(error instanceof RunFailedError)) throw error;
        run.summary = error.summary;
        run.error = String(error.cause);
        log.warn(`recorded failed run ${info.source} ${info.mode}`, {
          error: run.error,
          ...run.summary,
        });
      }
      runs.push(run);
    }
    // Streamed: the Publisher hands over one model file at a time (ADR 0012, Scale).
    await packBundle(publish(ledger, { now }), createWriteStream(files[ASSETS.bundle]));
  } finally {
    ledger.close();
  }

  const tag = `${TAG_PREFIX}${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  await pipeline(
    createReadStream(ledgerPath),
    createZstdCompress(),
    createWriteStream(files[ASSETS.ledger]),
  );
  const lastCensus = { ...base?.manifest.lastCensus };
  // A complete Census with rejections did not mark anything gone, but it was taken: counting
  // it keeps a Source with one persistent bad listing from a full run every day.
  for (const run of runs) {
    const census = run.summary?.census;
    if (census === "applied" || census === "skipped-rejections")
      lastCensus[run.source] = run.startedAt;
  }
  const manifest: Manifest = {
    dataRelease: 1,
    tag,
    createdAt: now.toISOString(),
    previous,
    commit: options.commit ?? null,
    assets: {
      [ASSETS.ledger]: await fileDigest(files[ASSETS.ledger]),
      [ASSETS.bundle]: await fileDigest(files[ASSETS.bundle]),
    },
    runs,
    lastCensus,
  };
  await writeFile(files[ASSETS.manifest], `${JSON.stringify(manifest, null, 2)}\n`);
  const newest = await findRelease(store);
  if ((newest?.tag ?? null) !== previous)
    throw new Error(`${newest?.tag} was released after ${previous}; these run logs are stale`);
  await store.create(
    tag,
    Object.entries(files).map(([name, path]) => ({ name, path })),
    releaseNotes(manifest),
  );
  log.info(`released ${tag}`);

  // Best effort: the release is out, so a pruning failure must not fail the run.
  try {
    const stale = (await store.list()).filter((r) => r.tag.startsWith(TAG_PREFIX)).slice(keep);
    for (const { tag: old } of stale) {
      await store.delete(old);
      log.info(`pruned ${old}`);
    }
  } catch (error) {
    log.warn("could not prune old data releases", { error: String(error) });
  }
  return { tag, runs };
}

function releaseNotes(manifest: Manifest): string {
  const lines = manifest.runs.map((r) =>
    r.error
      ? `- ${r.source} ${r.mode}: failed (${r.error.slice(0, 200)}), partial ${JSON.stringify(r.summary)}`
      : `- ${r.source} ${r.mode}: ${JSON.stringify(r.summary?.recorded ?? {})}`,
  );
  return [
    "Automated data release from the daily ingest (docs/adr/0014-daily-ingest-pipeline.md).",
    "",
    ...lines,
  ].join("\n");
}

async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return { sha256: hash.digest("hex"), bytes: (await stat(path)).size };
}
