// Performance budget for the built site (apps/web/DESIGN.md, "Performance budget"). For
// every page in dist/ it adds up the HTML, the stylesheets it links and the JavaScript it
// loads (module scripts, island component and renderer URLs, and their static imports),
// gzipped, and fails the build when a page goes over. Bundle data (public/bundle) is
// reported but not budgeted here: its size follows the catalog, not the shell.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Gzipped bytes per page. */
const BUDGET = { html: 30_000, css: 8_000, js: 30_000, total: 60_000 };

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const gz = new Map();
async function gzSize(path) {
  if (!gz.has(path)) gz.set(path, gzipSync(await readFile(path), { level: 9 }).length);
  return gz.get(path);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** A JS file and everything it imports statically, as dist-absolute URL paths. */
async function jsClosure(url, seen) {
  if (seen.has(url)) return;
  seen.add(url);
  const source = await readFile(join(dist, url), "utf8");
  for (const [, spec] of source.matchAll(
    /(?:import|export)\s*(?:[^"'();]*?from\s*)?["']([^"']+\.js)["']/g,
  )) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      await jsClosure(spec.startsWith("/") ? spec : posix.join(posix.dirname(url), spec), seen);
    }
  }
}

const rows = [];
let failed = false;
for await (const file of walk(dist)) {
  if (!file.endsWith(".html") || file.includes(`${join(dist, "bundle")}`)) continue;
  const html = await readFile(file, "utf8");
  const css = new Set(
    [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]),
  );
  const js = new Set();
  const entries = [
    ...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g),
    ...html.matchAll(/(?:component|renderer)-url="([^"]+)"/g),
  ].map((m) => m[1]);
  for (const url of entries) await jsClosure(url, js);
  // Inline module scripts (Astro inlines small ones) import chunks too.
  for (const [, body] of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
    for (const [, spec] of body.matchAll(/["'](\/_astro\/[^"']+\.js)["']/g))
      await jsClosure(spec, js);
  }
  const size = {
    html: gzipSync(html, { level: 9 }).length,
    css: 0,
    js: 0,
  };
  for (const url of css) size.css += await gzSize(join(dist, url));
  for (const url of js) size.js += await gzSize(join(dist, url));
  size.total = size.html + size.css + size.js;
  const over = Object.keys(BUDGET).filter((k) => size[k] > BUDGET[k]);
  if (over.length) failed = true;
  rows.push({ page: `/${relative(dist, file)}`, ...size, over: over.join(",") });
}

rows.sort((a, b) => b.total - a.total);
const kb = (n) => `${(n / 1000).toFixed(1)}`.padStart(6);
console.log("page budget (kB gzip)        html    css     js  total");
console.log(
  `  budget                    ${kb(BUDGET.html)} ${kb(BUDGET.css)} ${kb(BUDGET.js)} ${kb(BUDGET.total)}`,
);
for (const r of rows) {
  console.log(
    `  ${r.page.padEnd(26).slice(0, 26)}${kb(r.html)} ${kb(r.css)} ${kb(r.js)} ${kb(r.total)}${r.over ? `  OVER: ${r.over}` : ""}`,
  );
}
let data = 0;
for await (const file of walk(join(dist, "bundle"))) data += (await stat(file)).size;
const catalog = await gzSize(join(dist, "bundle/catalog.json"));
console.log(
  `bundle data: ${kb(data)} kB raw, catalog.json ${kb(catalog)} kB gzip (not budgeted here)`,
);
if (failed) {
  console.error("Performance budget exceeded; see apps/web/DESIGN.md.");
  process.exit(1);
}
