// The service worker (/sw.js) that makes the site installable and readable offline. An Astro
// integration writes it into dist/ once the build is done, when the hashed asset names are
// known; shell.ts registers it.
//
// - Pages: network first, so a page is never older than the last deploy while online; the
//   copy kept for offline is the last one fetched. The catalog pages (the installed app's
//   start) are precached; any other page never fetched falls back to /offline/ (or
//   /en/offline/).
// - Bundle data (/bundle/**.gz, /model/<id>/first.json.gz): network first as well. A model's
//   index and its rows files carry a stamp that must match (packages/bundle); serving a cached
//   index from yesterday's deploy next to a rows file fetched from today's would trip it on
//   every daily deploy, so the cache only answers when the network does not.
// - /_astro/ assets: hashed, so served from the cache this deploy's worker filled at install.
// The version is a hash of everything precached (the offline pages carry the data date, so in
// practice every deploy). All caches carry it: a kept page must find the assets it links, and
// a model's kept index the rows files of the same Bundle. A deploy installs a new worker,
// which takes over at once and deletes the older versions' caches, so what is kept for
// offline starts over after an update (which only happens online).
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Pages precached with the assets: the catalog in both locales, and the offline pages. */
const PRECACHED_PAGES = ["/", "/en/", "/offline/", "/en/offline/"];

/** @returns {import("astro").AstroIntegration} */
export function serviceWorker() {
  return {
    name: "comp-car-ator:service-worker",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const dist = fileURLToPath(dir);
        const assets = [];
        for (const entry of await readdir(join(dist, "_astro"), {
          withFileTypes: true,
          recursive: true,
        })) {
          if (entry.isFile())
            assets.push(
              `/${relative(dist, join(entry.parentPath, entry.name)).split("\\").join("/")}`,
            );
        }
        assets.sort();
        const precache = [...PRECACHED_PAGES, ...assets];
        const hash = createHash("sha256").update(worker.toString());
        for (const url of precache) {
          const file = url.endsWith("/") ? join(dist, url, "index.html") : join(dist, url);
          hash.update(url).update(await readFile(file));
        }
        const version = hash.digest("hex").slice(0, 12);
        const source = `(${worker})(${JSON.stringify(version)}, ${JSON.stringify(precache)});\n`;
        await writeFile(join(dist, "sw.js"), source);
        logger.info(`sw.js ${version}: ${precache.length} files precached`);
      },
    },
  };
}

/**
 * The worker itself, serialised into sw.js: it runs in the service worker scope, so it may use
 * only its arguments and the worker's globals.
 * @param {string} version
 * @param {string[]} precache
 */
function worker(version, precache) {
  /** @type {any} */
  const sw = self;
  const SHELL = `shell-${version}`;
  const PAGES = `pages-${version}`;
  const DATA = `data-${version}`;
  /** Entries kept per runtime cache; the oldest written go first. */
  const LIMIT = { [PAGES]: 60, [DATA]: 150 };

  sw.addEventListener("install", (/** @type {any} */ event) => {
    event.waitUntil(
      caches
        .open(SHELL)
        .then((cache) => cache.addAll(precache))
        .then(() => sw.skipWaiting()),
    );
  });

  sw.addEventListener("activate", (/** @type {any} */ event) => {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys())
          if (!name.endsWith(`-${version}`)) await caches.delete(name);
        await sw.registration.navigationPreload?.enable();
        await sw.clients.claim();
      })(),
    );
  });

  sw.addEventListener("fetch", (/** @type {any} */ event) => {
    /** @type {Request} */
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== location.origin) return;
    if (request.mode === "navigate") {
      event.respondWith(page(event, url));
    } else if (url.pathname.startsWith("/_astro/")) {
      event.respondWith(
        caches.match(request, { cacheName: SHELL }).then((hit) => hit ?? fetch(request)),
      );
    } else if (
      url.pathname.startsWith("/bundle/") ||
      /^\/model\/.+\/first\.json\.gz$/.test(url.pathname)
    ) {
      event.respondWith(networkFirst(event, DATA, url.href, fetch(request)));
    }
  });

  /**
   * A page is kept once per path: its query is URL state the islands read, not other HTML.
   * @param {any} event @param {URL} url
   */
  async function page(event, url) {
    const network = Promise.resolve(event.preloadResponse).then(
      (preloaded) => preloaded ?? fetch(event.request),
    );
    try {
      return await networkFirst(event, PAGES, url.origin + url.pathname, network);
    } catch {
      const offline = url.pathname.startsWith("/en/") ? "/en/offline/" : "/offline/";
      return (
        (await caches.match(url.origin + url.pathname, { cacheName: SHELL })) ??
        (await caches.match(offline, { cacheName: SHELL })) ??
        Response.error()
      );
    }
  }

  /**
   * The network's answer, kept in cache `name` under `key`; the kept copy when the network
   * fails.
   * @param {any} event @param {keyof typeof LIMIT} name @param {string} key
   * @param {Promise<Response>} network
   */
  async function networkFirst(event, name, key, network) {
    try {
      const response = await network;
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        event.waitUntil(
          caches
            .open(name)
            .then(async (cache) => {
              await cache.put(key, copy);
              const keys = await cache.keys();
              for (const old of keys.slice(0, Math.max(0, keys.length - LIMIT[name])))
                await cache.delete(old);
            })
            // Out of quota, say: the page still gets its response, just not kept.
            .catch(() => {}),
        );
      }
      return response;
    } catch (error) {
      const kept = await caches.match(key, { cacheName: name });
      if (kept) return kept;
      throw error;
    }
  }
}
