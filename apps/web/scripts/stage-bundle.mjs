// Stages the Bundle the site renders into public/bundle/ (docs/adr/0014-daily-ingest-pipeline.md):
// - BUNDLE_DIR: copy that directory (a Bundle written by `pnpm ingest publish`);
// - production builds on Vercel, or BUNDLE_URL: download the released Bundle archive. Any failure
//   fails the build, so the previous deployment stays up instead of one with sample data;
// - otherwise (previews, local): the committed sample fixture.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unpackBundle, writeBundleFiles } from "@cca/bundle/node";

const LATEST =
  "https://github.com/totalolage/comp-car-ator/releases/latest/download/bundle.json.gz";
const to = fileURLToPath(new URL("../public/bundle", import.meta.url));
const url = process.env.BUNDLE_URL ?? (process.env.VERCEL_ENV === "production" ? LATEST : null);

if (process.env.BUNDLE_DIR) {
  await rm(to, { recursive: true, force: true });
  await cp(process.env.BUNDLE_DIR, to, { recursive: true });
  console.log(`staged bundle ${process.env.BUNDLE_DIR} -> ${to}`);
} else if (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Bundle download ${url} failed: HTTP ${response.status}`);
  const files = unpackBundle(new Uint8Array(await response.arrayBuffer()));
  await writeBundleFiles(to, files);
  console.log(`staged bundle ${response.url} (${files.size} files) -> ${to}`);
} else {
  const sample = fileURLToPath(new URL("../../../fixtures/sample-bundle", import.meta.url));
  await rm(to, { recursive: true, force: true });
  await cp(sample, to, { recursive: true });
  console.log(`staged sample bundle ${sample} -> ${to}`);
}
