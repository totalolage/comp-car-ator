/**
 * Records a cassette for a Source adapter from the live network.
 *
 *   pnpm --filter @cca/sources record <sourceId> <mode> <out.cassette.json> [--now ISO] [--last-run ISO]
 *
 * `--now` only stamps the run (adapters derive dates from it); the requests are live, so
 * pick `--now` close to the real time. Commit the cassette next to the adapter's test.
 */
import { createLiveHttp, recordingHttp, saveCassette } from "@cca/http";
import type { Observation } from "@cca/vocabulary";
import { type HarvestMode, sources } from "../src/index.ts";

const [id, mode, out, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const factory = id ? sources[id] : undefined;
if (!factory || (mode !== "incremental" && mode !== "full") || !out) {
  console.error(
    "usage: record <sourceId> <incremental|full> <out.cassette.json> [--now ISO] [--last-run ISO]",
  );
  process.exit(2);
}
const now = new Date(flag("--now") ?? Date.now());
const lastRun = flag("--last-run");
const recorder = recordingHttp(createLiveHttp());
const observations: Observation[] = [];
for await (const observation of factory().harvest({
  http: recorder.http,
  mode: mode as HarvestMode,
  checkpoint: { lastRunAt: lastRun ? new Date(lastRun) : null, isKnown: () => false },
  now,
  log: { info: (m, d) => console.error(m, d ?? ""), warn: (m, d) => console.error(m, d ?? "") },
  signal: AbortSignal.timeout(30 * 60_000),
})) {
  observations.push(observation);
}
await saveCassette(out, recorder.cassette());
console.error(`${observations.length} observations; cassette written to ${out}`);
