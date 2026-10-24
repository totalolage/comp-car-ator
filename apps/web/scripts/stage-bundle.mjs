// Copies the Bundle the site renders into public/bundle/. BUNDLE_DIR points at a published
// Bundle (the ingest workflow downloads one from the latest release); without it the site
// builds from the committed sample fixture.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const from =
  process.env.BUNDLE_DIR ??
  fileURLToPath(new URL("../../../fixtures/sample-bundle", import.meta.url));
const to = fileURLToPath(new URL("../public/bundle", import.meta.url));
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log(`staged bundle ${from} -> ${to}`);
