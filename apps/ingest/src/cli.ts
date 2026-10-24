/**
 * ingest CLI. Run with `pnpm ingest <command> ...` from the repo root.
 *
 *   run --source cnb[,sauto] --mode incremental|full --ledger ledger.sqlite [--out bundle/] [--replay x.cassette.json]
 *   publish --ledger ledger.sqlite --out bundle/
 *   import --ledger ledger.sqlite --observations file.json
 *   sample-bundle            regenerate fixtures/sample-bundle
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { writeBundleFiles } from "@cca/bundle/node";
import { createLiveHttp, createReplayHttp, loadCassette } from "@cca/http";
import { openLedger } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { type HarvestMode, type Logger, sources } from "@cca/sources";
import {
  buildSampleBundle,
  importObservations,
  type ObservationFile,
  runSource,
  SAMPLE,
} from "./ingest.ts";

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

const command = positionals[0];
const now = new Date();

switch (command) {
  case "run": {
    const mode = values.mode as HarvestMode;
    if (mode !== "incremental" && mode !== "full") throw new Error(`Unknown mode ${mode}`);
    const ids = required("source").split(",");
    const ledger = openLedger(required("ledger"));
    const http = values.replay
      ? createReplayHttp(await loadCassette(values.replay))
      : createLiveHttp();
    let failed = false;
    for (const id of ids) {
      const factory = sources[id];
      if (!factory)
        throw new Error(`Unknown source ${id}; known: ${Object.keys(sources).join(", ")}`);
      try {
        const summary = await runSource({ ledger, source: factory(), http, mode, now, log });
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
    console.error("usage: ingest <run|publish|import|sample-bundle> [options] (see src/cli.ts)");
    process.exit(2);
}
