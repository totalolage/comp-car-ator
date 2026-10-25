/**
 * Measured scale run of the Publisher on a synthetic Ledger (numbers: docs/adr/0010-publisher-statistics.md).
 * Run each step in its own process so the peak memory belongs to that step:
 *
 *   node packages/publisher/scripts/scale.ts generate <ledger.sqlite> [listings] [variants] [days]
 *   node packages/publisher/scripts/scale.ts publish <ledger.sqlite> <bundle dir>
 */
import { rm } from "node:fs/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { writeBundleFiles } from "@cca/bundle/node";
import { openLedger } from "@cca/ledger";
import { publish } from "../src/index.ts";
import { syntheticRuns } from "../src/synthetic.ts";

const END = "2026-10-24";
const [step, ledgerPath, ...rest] = process.argv.slice(2);
if (!ledgerPath || (step !== "generate" && step !== "publish")) {
  console.error(
    "usage: scale.ts generate <ledger> [listings] [variants] [days] | publish <ledger> <dir>",
  );
  process.exit(2);
}

const started = performance.now();
const seconds = () => ((performance.now() - started) / 1000).toFixed(1);
const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(2);

if (step === "generate") {
  const [listings = 200_000, variants = 50_000, days = 180] = rest.map(Number);
  await rm(ledgerPath, { force: true });
  const ledger = openLedger(ledgerPath);
  let recorded = 0;
  for (const { run, observations } of syntheticRuns({ listings, variants, days, end: END })) {
    const summary = await ledger.record(run, observations);
    recorded += observations.length;
    if (summary.rejected.length)
      throw new Error(`rejected: ${JSON.stringify(summary.rejected[0])}`);
  }
  ledger.close();
  console.log(
    JSON.stringify({
      step,
      listings,
      variants,
      days,
      observations: recorded,
      seconds: seconds(),
      peakRssMb: peakMb(),
    }),
  );
} else {
  const dir = rest[0];
  if (!dir) throw new Error("publish needs a bundle dir");
  const ledger = openLedger(ledgerPath);
  const files = publish(ledger, { now: new Date(`${END}T16:00:00Z`) });
  const publishSeconds = seconds();
  const publishPeakMb = peakMb();
  ledger.close();
  await writeBundleFiles(dir, files);

  const sizes = [...files].map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) }));
  sizes.sort((a, b) => b.bytes - a.bytes);
  let gzipTotal = 0;
  for (const text of files.values()) gzipTotal += gzipSync(text).length;
  const brotli = (path: string) => brotliCompressSync(files.get(path) ?? "").length;
  const largestModel = sizes.find((s) => s.path.startsWith("models/"));
  const manifest = JSON.parse(files.get("manifest.json") ?? "{}");
  const modelSizes = sizes.filter((s) => s.path.startsWith("models/")).map((s) => s.bytes);
  console.log(
    JSON.stringify(
      {
        step,
        counts: manifest.counts,
        publishSeconds,
        publishPeakRssMb: publishPeakMb,
        files: files.size,
        totalMb: mb(sizes.reduce((n, s) => n + s.bytes, 0)),
        gzipTotalMb: mb(gzipTotal),
        catalogMb: mb(Buffer.byteLength(files.get("catalog.json") ?? "")),
        catalogBrotliMb: mb(brotli("catalog.json")),
        largestModel: largestModel && {
          path: largestModel.path,
          mb: mb(largestModel.bytes),
          brotliMb: mb(brotli(largestModel.path)),
        },
        medianModelKb: Math.round((modelSizes[Math.floor(modelSizes.length / 2)] ?? 0) / 1024),
        largestFiles: sizes.slice(0, 5).map((s) => `${s.path} ${mb(s.bytes)} MB`),
      },
      null,
      2,
    ),
  );
}
