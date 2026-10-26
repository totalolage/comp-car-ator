// Stages the Bundle the site renders into public/bundle/ (docs/adr/0014-daily-ingest-pipeline.md):
// - BUNDLE_DIR: copy that directory (a Bundle written by `pnpm ingest publish`);
// - production builds on Vercel, or BUNDLE_TOKEN set: download the newest Data release's Bundle
//   from the private ingest repo (BUNDLE_REPO, default totalolage/comp-car-ator-ingest) with
//   BUNDLE_TOKEN (read-only), checked against its manifest. Any failure fails the build, so the
//   previous deployment stays up instead of one with sample data;
// - otherwise (previews, local): the committed sample fixture.
import { createHash } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unpackBundle, writeBundleFiles } from "@cca/bundle/node";

const to = fileURLToPath(new URL("../public/bundle", import.meta.url));
const { BUNDLE_DIR, BUNDLE_TOKEN, VERCEL_ENV } = process.env;
const repo = process.env.BUNDLE_REPO ?? "totalolage/comp-car-ator-ingest";

async function github(path, accept = "application/vnd.github+json") {
  if (!BUNDLE_TOKEN) throw new Error("BUNDLE_TOKEN is not set; production builds need it");
  const response = await fetch(path.startsWith("https:") ? path : `https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${BUNDLE_TOKEN}`, accept, "user-agent": "comp-car-ator-web" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response;
}

async function asset(release, name) {
  const found = release.assets.find((a) => a.name === name);
  if (!found) throw new Error(`${release.tag_name} has no ${name}`);
  const response = await github(found.url, "application/octet-stream");
  return new Uint8Array(await response.arrayBuffer());
}

if (BUNDLE_DIR) {
  await rm(to, { recursive: true, force: true });
  await cp(BUNDLE_DIR, to, { recursive: true });
  console.log(`staged bundle ${BUNDLE_DIR} -> ${to}`);
} else if (VERCEL_ENV === "production" || BUNDLE_TOKEN) {
  const release = await (await github(`/repos/${repo}/releases/latest`)).json();
  const manifest = JSON.parse(new TextDecoder().decode(await asset(release, "manifest.json")));
  const archive = await asset(release, "bundle.json.gz");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== manifest.assets?.["bundle.json.gz"]?.sha256)
    throw new Error(`${release.tag_name}/bundle.json.gz does not match its manifest sha256`);
  const files = unpackBundle(archive);
  await writeBundleFiles(to, files);
  console.log(`staged bundle ${repo}@${release.tag_name} (${files.size} files) -> ${to}`);
} else {
  const sample = fileURLToPath(new URL("../../../fixtures/sample-bundle", import.meta.url));
  await rm(to, { recursive: true, force: true });
  await cp(sample, to, { recursive: true });
  console.log(`staged sample bundle ${sample} -> ${to}`);
}
