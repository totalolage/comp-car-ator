import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worker } from "../scripts/service-worker.mjs";

// The worker runs here against an in-memory Cache API and a scripted network, through the
// events a browser sends it (install, activate, fetch).
const ORIGIN = "https://cars.f8y.dev";
const PRECACHE = ["/", "/en/", "/offline/", "/en/offline/", "/_astro/shell.js"];

type Handler = (event: unknown) => void;
const keyOf = (k: string | Request) => (typeof k === "string" ? new URL(k, ORIGIN).href : k.url);

function cacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const s = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, s);
    return {
      async put(k: string | Request, r: Response) {
        s.delete(keyOf(k)); // a replaced entry moves to the end, as in the Cache API
        s.set(keyOf(k), r);
      },
      async match(k: string | Request) {
        return s.get(keyOf(k))?.clone();
      },
      async keys() {
        return [...s.keys()].map((u) => new Request(u));
      },
      async delete(k: string | Request) {
        return s.delete(keyOf(k));
      },
      async addAll(urls: string[]) {
        for (const u of urls) s.set(keyOf(u), await fetch(new URL(u, ORIGIN)));
      },
    };
  };
  return {
    stores,
    open,
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    /** In one cache, or the first hit across all of them in creation order. */
    async match(k: string | Request, { cacheName }: { cacheName?: string } = {}) {
      const names = cacheName === undefined ? [...stores.keys()] : [cacheName];
      for (const name of names) {
        const hit = stores.get(name)?.get(keyOf(k));
        if (hit) return hit.clone();
      }
    },
  };
}

/** A same-origin response, as the browser types them. */
function basic(body: string, status = 200) {
  const r = new Response(body, { status });
  Object.defineProperty(r, "type", { value: "basic" });
  return r;
}

type Worker = Map<string, Handler>;
let handlers: Worker;
let store: ReturnType<typeof cacheStorage>;
let online: boolean;
let server: (url: URL) => Response;

/** A worker as one deploy serves it; the browser has not yet sent it any event. */
function boot(version: string, precache: string[]): Worker {
  const own: Worker = new Map();
  vi.stubGlobal("self", {
    addEventListener: (type: string, h: Handler) => own.set(type, h),
    registration: { navigationPreload: { enable: async () => {} } },
  });
  worker(version, precache);
  return own;
}

async function dispatch(type: string, extra: object = {}, to: Worker = handlers) {
  const waits: Promise<unknown>[] = [];
  let response: Promise<Response> | undefined;
  to.get(type)?.({
    ...extra,
    waitUntil: (p: Promise<unknown>) => waits.push(p),
    respondWith: (p: Promise<Response>) => {
      response = p;
    },
  });
  const result = await response;
  for (let i = 0; i < waits.length; i++) await waits[i]; // waits added while settling count too
  return result;
}

// A Request cannot be constructed with mode "navigate"; the worker reads only these fields.
const navigate = (path: string) =>
  dispatch("fetch", {
    request: {
      url: ORIGIN + path,
      method: "GET",
      mode: "navigate",
      destination: "document",
      credentials: "include",
      headers: new Headers(),
    },
    preloadResponse: Promise.resolve(undefined),
  });
const get = (path: string, init?: RequestInit, to?: Worker) =>
  dispatch("fetch", { request: new Request(ORIGIN + path, init) }, to);

beforeEach(async () => {
  handlers = new Map();
  store = cacheStorage();
  online = true;
  server = (url) => basic(`${url.pathname}${url.search} v2`);
  vi.stubGlobal("location", new URL(ORIGIN));
  vi.stubGlobal("caches", store);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: { url: string } | URL) => {
      if (!online) throw new TypeError("Failed to fetch");
      return server(new URL(input instanceof URL ? input : input.url));
    }),
  );
  await store.open("pages-old");
  handlers = boot("new", PRECACHE);
  await dispatch("install");
  await dispatch("activate");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker", () => {
  it("precaches the shell and drops older versions' caches", async () => {
    expect(await store.keys()).toEqual(["shell-new"]);
    expect([...(store.stores.get("shell-new")?.keys() ?? [])]).toHaveLength(PRECACHE.length);
  });

  it("lets a tab on the older deploy load its chunks until the new worker activates", async () => {
    store = cacheStorage();
    vi.stubGlobal("caches", store);
    await store.open("other-app");
    const old = boot("old", [...PRECACHE, "/_astro/lazy.old.js"]);
    await dispatch("install", {}, old);
    await dispatch("activate", {}, old);
    // The next deploy drops the old chunk and adds its own.
    server = (url) =>
      url.pathname === "/_astro/lazy.old.js" ? basic("not found", 404) : basic(`${url.pathname} v3`);
    const next = boot("next", [...PRECACHE, "/_astro/lazy.next.js"]);
    await dispatch("install", {}, next);
    expect(await store.keys()).toEqual(["other-app", "shell-old", "shell-next"]);

    // The open tab still runs the old worker: its own chunk comes from its cache, and a page
    // of the new deploy opened meanwhile finds the new chunks offline in the waiting cache.
    expect(await (await get("/_astro/lazy.old.js", {}, old))?.text()).toBe("/_astro/lazy.old.js v2");
    online = false;
    expect(await (await get("/_astro/lazy.next.js", {}, old))?.text()).toBe(
      "/_astro/lazy.next.js v3",
    );

    // Once no tab runs the old worker, the new one activates and drops the old caches only.
    await dispatch("activate", {}, next);
    expect(await store.keys()).toEqual(["other-app", "shell-next"]);
  });

  it("serves pages from the network, keeps one copy per path, and falls back offline", async () => {
    expect(await (await navigate("/model/a/?market=DE"))?.text()).toBe("/model/a/?market=DE v2");
    online = false;
    expect(await (await navigate("/model/a/"))?.text()).toBe("/model/a/?market=DE v2");
    expect(await (await navigate("/"))?.text()).toBe("/ v2"); // precached start page
    expect(await (await navigate("/compare/"))?.text()).toBe("/offline/ v2");
    expect(await (await navigate("/en/compare/"))?.text()).toBe("/en/offline/ v2");
  });

  it("answers Bundle data from the network first, the kept copy on failure or 5xx", async () => {
    await get("/bundle/models/a/index.json.gz");
    server = (url) => basic(`${url.pathname} v3`);
    expect(await (await get("/bundle/models/a/index.json.gz"))?.text()).toBe(
      "/bundle/models/a/index.json.gz v3",
    );
    server = () => basic("down", 503);
    expect(await (await get("/bundle/models/a/index.json.gz"))?.text()).toBe(
      "/bundle/models/a/index.json.gz v3",
    );
    server = () => basic("gone", 404);
    expect((await get("/bundle/models/a/index.json.gz"))?.status).toBe(404);
  });

  it("keeps the response when the cache write fails, and evicts the oldest at the cap", async () => {
    const open = store.open;
    store.open = async () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    expect(await (await get("/bundle/catalog.json.gz"))?.text()).toBe("/bundle/catalog.json.gz v2");
    store.open = open;
    for (let n = 0; n <= 150; n++) await get(`/bundle/models/m${n}/rows-0.json.gz`);
    const kept = [...(store.stores.get("data-new")?.keys() ?? [])];
    expect(kept).toHaveLength(150);
    expect(kept[0]).toBe(`${ORIGIN}/bundle/models/m1/rows-0.json.gz`);
  });

  it("serves hashed assets from the precache", async () => {
    online = false;
    expect(await (await get("/_astro/shell.js"))?.text()).toBe("/_astro/shell.js v2");
  });

  it("never reads or fills the cache for a request that carries its own credentials", async () => {
    await get("/bundle/catalog.json.gz");
    server = () => basic("someone's", 200);
    // Not answered by the worker, so neither read from the cache nor written to it.
    for (const init of [
      { headers: { Authorization: "Bearer a" } },
      { credentials: "include" as const },
    ]) {
      expect(await get("/bundle/catalog.json.gz", init)).toBeUndefined();
      expect(await get("/bundle/models/b/index.json.gz", init)).toBeUndefined();
      expect(await get("/_astro/shell.js", init)).toBeUndefined();
    }
    expect([...(store.stores.get("data-new")?.keys() ?? [])]).toEqual([
      `${ORIGIN}/bundle/catalog.json.gz`,
    ]);
    online = false;
    expect(await (await get("/bundle/catalog.json.gz"))?.text()).toBe("/bundle/catalog.json.gz v2");
  });

  it("leaves other origins, other methods and other paths to the browser", async () => {
    expect(await get("/manifest.webmanifest")).toBeUndefined();
    expect(await get("/_vercel/toolbar/x.js")).toBeUndefined();
    expect(
      await dispatch("fetch", { request: new Request("https://example.com/x") }),
    ).toBeUndefined();
    expect(
      await dispatch("fetch", { request: new Request(`${ORIGIN}/bundle/x`, { method: "POST" }) }),
    ).toBeUndefined();
  });
});
