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
    async match(k: string | Request, { cacheName }: { cacheName: string }) {
      return stores.get(cacheName)?.get(keyOf(k))?.clone();
    },
  };
}

/** A same-origin response, as the browser types them. */
function basic(body: string, status = 200) {
  const r = new Response(body, { status });
  Object.defineProperty(r, "type", { value: "basic" });
  return r;
}

let handlers: Map<string, Handler>;
let store: ReturnType<typeof cacheStorage>;
let online: boolean;
let server: (url: URL) => Response;

async function dispatch(type: string, extra: object = {}) {
  const waits: Promise<unknown>[] = [];
  let response: Promise<Response> | undefined;
  handlers.get(type)?.({
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
    request: { url: ORIGIN + path, method: "GET", mode: "navigate" },
    preloadResponse: Promise.resolve(undefined),
  });
const get = (path: string) => dispatch("fetch", { request: new Request(ORIGIN + path) });

beforeEach(async () => {
  handlers = new Map();
  store = cacheStorage();
  online = true;
  server = (url) => basic(`${url.pathname}${url.search} v2`);
  vi.stubGlobal("self", {
    addEventListener: (type: string, h: Handler) => handlers.set(type, h),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { navigationPreload: { enable: async () => {} } },
  });
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
  worker("new", PRECACHE);
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

  it("leaves other origins, other methods and other paths to the browser", async () => {
    expect(await get("/manifest.webmanifest")).toBeUndefined();
    expect(
      await dispatch("fetch", { request: new Request("https://example.com/x") }),
    ).toBeUndefined();
    expect(
      await dispatch("fetch", { request: new Request(`${ORIGIN}/bundle/x`, { method: "POST" }) }),
    ).toBeUndefined();
  });
});
