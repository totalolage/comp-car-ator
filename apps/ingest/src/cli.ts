/**
 * ingest CLI. Run with `pnpm ingest <command> ...` from the repo root.
 *
 *   run --source cnb[,sauto] --mode incremental|full --ledger ledger.sqlite [--out bundle/] [--replay x.cassette.json]
 *   publish --ledger ledger.sqlite --out bundle/
 *
 * The scheduled pipeline (docs/adr/0014-daily-ingest-pipeline.md); --store is
 * `github:<owner>/<repo>` (GITHUB_TOKEN) or a local directory:
 *   plan --store S [--date ISO] [--source a,b --mode m]   {"base": tag or "", "harvests": [...]}
 *   restore --store S --ledger ledger.sqlite [--base tag] [--init]
 *   harvest --source cnb --mode incremental|full --ledger ledger.sqlite --out cnb.ndjson
 *   release --store S --runs dir/ [--base tag] [--work dir/] [--keep 14] [--commit sha] [--init]
 *           (prints the new tag)
 *   import --ledger ledger.sqlite --observations file.json
 *   sample-bundle            regenerate fixtures/sample-bundle
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeBundleFiles } from "@cca/bundle/node";
import { createLiveHttp, createReplayHttp, loadCassette } from "@cca/http";
import { openLedger } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { type HarvestMode, type Logger, sources } from "@cca/sources";
import { findRelease, releaseRuns, restoreLedger } from "./data-release.ts";
import {
  buildSampleBundle,
  importObservations,
  type ObservationFile,
  runSource,
  SAMPLE,
} from "./ingest.ts";
import { releaseStoreFrom } from "./release-store.ts";
import { harvestToLog } from "./run-log.ts";
import { plan } from "./schedule.ts";

const log: Logger = {
  info: (message, data) => console.error(message, data ? JSON.stringify(data) : ""),
  warn: (message, data) => console.error(`WARN ${message}`, data ? JSON.stringify(data) : ""),
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    mode: { type: "string", default: "incremental" },
    ledger: { type: "string" },
    out: { type: "string" },
    replay: { type: "string" },
    observations: { type: "string" },
    store: { type: "string" },
    runs: { type: "string" },
    work: { type: "string" },
    keep: { type: "string", default: "14" },
    commit: { type: "string" },
    date: { type: "string" },
    base: { type: "string" },
    init: { type: "boolean", default: false },
  },
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}

function harvestMode(): HarvestMode {
  const mode = values.mode as HarvestMode;
  if (mode !== "incremental" && mode !== "full") throw new Error(`Unknown mode ${mode}`);
  return mode;
}

function knownSource(id: string) {
  const factory = sources[id];
  if (!factory) throw new Error(`Unknown source ${id}; known: ${Object.keys(sources).join(", ")}`);
  return factory();
}

const command = positionals[0];
const now = new Date();

switch (command) {
  case "run": {
    const mode = harvestMode();
    const ids = required("source").split(",");
    const ledger = openLedger(required("ledger"));
    const http = values.replay
      ? createReplayHttp(await loadCassette(values.replay))
      : createLiveHttp();
    let failed = false;
    for (const id of ids) {
      try {
        const summary = await runSource({ ledger, source: knownSource(id), http, mode, now, log });
        log.info(`${id} ${mode} run complete`, { ...summary });
      } catch (error) {
        failed = true;
        log.warn(`${id} ${mode} run failed`, { error: String(error) });
      }
    }
    if (values.out) await writeBundleFiles(values.out, publish(ledger, { now }));
    ledger.close();
    process.exitCode = failed ? 1 : 0;
    break;
  }
  case "plan": {
    // Explicit sources (a manual dispatch) run in the given mode; otherwise the schedule decides.
    const base = await findRelease(releaseStoreFrom(required("store")));
    const harvests = values.source
      ? values.source.split(",").map((id) => ({ source: knownSource(id).id, mode: harvestMode() }))
      : plan(
          Object.keys(sources),
          values.date ? new Date(values.date) : now,
          base?.manifest.lastCensus,
        );
    console.log(JSON.stringify({ base: base?.tag ?? "", harvests }));
    break;
  }
  case "restore": {
    const release = await restoreLedger(releaseStoreFrom(required("store")), required("ledger"), {
      base: values.base || undefined,
      init: values.init,
    });
    log.info(release ? `restored Ledger from ${release.tag}` : "no data release yet; new Ledger");
    break;
  }
  case "harvest": {
    const ledger = openLedger(required("ledger"));
    // TODO(wave1-stream1): once #22 lands, pass `cache: { dir }` (per-run directory) and
    // `await http.close()` after the harvest; T2 is opted into with CCA_HTTP_BROWSER.
    const http = createLiveHttp();
    const source = knownSource(required("source"));
    const report = await harvestToLog({
      ledger,
      source,
      http,
      mode: harvestMode(),
      now,
      out: required("out"),
      log,
    });
    ledger.close();
    log.info(`${source.id} harvest ${report.error ? "failed" : "complete"}`, { ...report });
    process.exitCode = report.error ? 1 : 0;
    break;
  }
  case "release": {
    const dir = required("runs");
    const logs = (await readdir(dir, { recursive: true }))
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => join(dir, name));
    if (logs.length === 0) {
      log.warn(`no run logs in ${dir}; nothing to release`);
      break;
    }
    const result = await releaseRuns({
      store: releaseStoreFrom(required("store")),
      logs,
      work: values.work ?? join(dir, ".work"),
      now,
      base: values.base || undefined,
      init: values.init,
      keep: Number(values.keep),
      commit: values.commit,
      log,
    });
    console.log(result.tag);
    break;
  }
  case "publish": {
    const ledger = openLedger(required("ledger"));
    await writeBundleFiles(required("out"), publish(ledger, { now }));
    ledger.close();
    break;
  }
  case "import": {
    const ledger = openLedger(required("ledger"));
    const file = JSON.parse(await readFile(required("observations"), "utf8")) as ObservationFile;
    for (const summary of await importObservations(ledger, file))
      log.info("imported", { ...summary });
    ledger.close();
    break;
  }
  case "sample-bundle": {
    await writeBundleFiles(SAMPLE.bundleDir, await buildSampleBundle());
    log.info(`sample bundle written to ${SAMPLE.bundleDir}`);
    break;
  }
  default:
    console.error(
      "usage: ingest <plan|restore|harvest|release|run|publish|import|sample-bundle> [options] (see src/cli.ts)",
    );
    process.exit(2);
}
