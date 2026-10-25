// Tests the live adapter through `get()` against a local HTTP server: real T0 (fetch) and T1
// (Impit), the raw response cache, and T2 when CCA_HTTP_T2_TEST=1 (needs Chrome, see ADR 0005).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCachedHttp } from "./cache.ts";
import { createLiveHttp, type Http, HttpBlockedError, type Page } from "./index.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler = (_req, res) => res.end();
const hits: string[] = [];
let base = "";
const server = createServer((req, res) => {
  hits.push(req.url ?? "");
  handler(req, res);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  hits.length = 0;
});

/** Cloudflare-style UA rule: a challenge for clients without Chrome client hints. */
const challengeUnlessBrowser: Handler = (req, res) => {
  if (!req.headers["sec-ch-ua"]) {
    res.writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" });
    res.end("<title>Just a moment...</title>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<h1>listing</h1><p>${req.headers["accept-language"]}</p>`);
};

describe("live Http", () => {
  it("serves T0 pages with the final URL, decoded charset and browser headers", async () => {
    handler = (req, res) => {
      if (req.url === "/old") {
        res.writeHead(301, { location: "/new" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=windows-1250" });
      // "Škoda" in windows-1250, followed by the User-Agent the server saw.
      res.end(
        Buffer.concat([Buffer.from([0x8a]), Buffer.from(`koda ${req.headers["user-agent"]}`)]),
      );
    };
    const page = await createLiveHttp({ hostIntervalMs: 0 }).get(`${base}/old`);
    expect(page).toMatchObject({ url: `${base}/new`, status: 200, tier: "T0" });
    expect(page.body).toMatch(/^Škoda Mozilla\/5\.0 .*Chrome\//);
  });

  it("escalates from T0 to T1 (Impit) on a bot challenge", async () => {
    handler = challengeUnlessBrowser;
    const page = await createLiveHttp({ hostIntervalMs: 0 }).get({
      url: `${base}/list`,
      locale: "de",
    });
    expect(page).toMatchObject({ status: 200, tier: "T1" });
    expect(page.body).toContain("de-DE");
    expect(hits).toEqual(["/list", "/list"]);
  });

  it("starts at T1 when the request asks for it", async () => {
    handler = challengeUnlessBrowser;
    const page = await createLiveHttp({ hostIntervalMs: 0 }).get({
      url: `${base}/x`,
      minTier: "T1",
    });
    expect(page.tier).toBe("T1");
    expect(hits).toEqual(["/x"]);
  });

  it("rejects with HttpBlockedError when T1 is challenged too, then stops asking the host", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { server: "AkamaiGHost" }).end("Access Denied");
    };
    const http = createLiveHttp({ hostIntervalMs: 0, maxConsecutiveBlocks: 1, browser: false });
    await expect(http.get(`${base}/a`)).rejects.toMatchObject({ marker: "akamai", tier: "T1" });
    await expect(http.get(`${base}/b`)).rejects.toBeInstanceOf(HttpBlockedError);
    expect(hits).toEqual(["/a", "/a"]);
  });

  it("returns raw bytes for binary requests", async () => {
    handler = (_req, res) => {
      res
        .writeHead(200, { "content-type": "application/pdf" })
        .end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    };
    const page = await createLiveHttp({ hostIntervalMs: 0 }).get({
      url: `${base}/a.pdf`,
      binary: true,
    });
    expect([...(page.bytes ?? [])]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(page.body).toBe("");
  });
});

describe("raw response cache", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cca-http-cache-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("serves a repeated request from disk without touching the network", async () => {
    let n = 0;
    handler = (_req, res) => res.end(`page ${++n}`);
    const first = await createLiveHttp({ hostIntervalMs: 0, cache: { dir } }).get(
      `${base}/p?b=2&a=1`,
    );
    // A new Http (a later process in the same run) reads the same directory.
    const second = await createLiveHttp({ hostIntervalMs: 0, cache: { dir } }).get(
      `${base}/p?a=1&b=2`,
    );
    expect(second).toEqual(first);
    expect(second.body).toBe("page 1");
    expect(hits).toHaveLength(1);
  });

  it("keeps binary and text requests for one URL apart", async () => {
    handler = (_req, res) => res.end("data");
    const http = createLiveHttp({ hostIntervalMs: 0, cache: { dir } });
    await http.get(`${base}/d`);
    const binary = await http.get({ url: `${base}/d`, binary: true });
    expect(new TextDecoder().decode(binary.bytes)).toBe("data");
    expect(hits).toHaveLength(2);
  });

  it("does not store 5xx responses or blocks", async () => {
    handler = (_req, res) => res.writeHead(500).end("down");
    const http = createLiveHttp({ hostIntervalMs: 0, attempts: 1, cache: { dir } });
    expect((await http.get(`${base}/e`)).status).toBe(500);
    handler = (_req, res) => res.writeHead(403, { "cf-mitigated": "challenge" }).end();
    await expect(http.get(`${base}/f`)).rejects.toBeInstanceOf(HttpBlockedError);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("fetches again once an entry is older than maxAgeMs", async () => {
    let t = 0;
    let n = 0;
    const inner: Http = {
      get: async (r) =>
        ({ url: String(r), status: 200, headers: {}, body: `v${++n}`, tier: "T0" }) satisfies Page,
    };
    const http = createCachedHttp(inner, { dir, maxAgeMs: 1000, now: () => t });
    expect((await http.get("https://a.example/")).body).toBe("v1");
    t = 1000;
    expect((await http.get("https://a.example/")).body).toBe("v1");
    t = 1001;
    expect((await http.get("https://a.example/")).body).toBe("v2");
  });
});

describe.skipIf(!process.env.CCA_HTTP_T2_TEST)("T2 browser (CCA_HTTP_T2_TEST=1)", () => {
  let http: ReturnType<typeof createLiveHttp>;
  const seen = new Map<string, IncomingMessage["headers"]>();
  beforeAll(() => {
    http = createLiveHttp({ hostIntervalMs: 0, browser: { engine: "patchright" } });
  });
  afterAll(() => http.close());
  beforeEach(() => seen.clear());

  /** Records each request's headers by path, then hands it to `inner`. */
  const recording =
    (inner: Handler): Handler =>
    (req, res) => {
      seen.set(new URL(req.url ?? "", base).pathname, req.headers);
      inner(req, res);
    };

  it("renders the page in Chrome when the request starts at T2", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<body><script>document.body.append("rendered by js")</script></body>`);
    };
    const page = await http.get({ url: `${base}/t2`, minTier: "T2" });
    expect(page).toMatchObject({ status: 200, tier: "T2" });
    expect(page.body).toContain("rendered by js");
  }, 120_000);

  it("sends the caller's headers on the navigation, not on the page's subresources", async () => {
    handler = recording((req, res) => {
      if (req.url === "/sub.js") {
        res.writeHead(200, { "content-type": "text/javascript" }).end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "seen=1" });
      res.end(`<script src="/sub.js"></script><p>ok</p>`);
    });
    await http.get({ url: `${base}/first`, minTier: "T2" });
    seen.clear();
    await http.get({
      url: `${base}/headers`,
      minTier: "T2",
      headers: { "X-Test-Token": "abc", referer: `${base}/from` },
    });
    expect(seen.get("/headers")).toMatchObject({
      "x-test-token": "abc",
      referer: `${base}/from`,
      cookie: expect.stringContaining("seen=1"),
      "user-agent": expect.stringContaining("Chrome/"),
    });
    expect(seen.get("/sub.js")).toBeDefined();
    expect(seen.get("/sub.js")).not.toHaveProperty("x-test-token");
  }, 120_000);

  it("fetches binary requests with the browser's cookies and hands back the ones they change", async () => {
    handler = recording((req, res) => {
      if (req.url === "/a.pdf") {
        res.writeHead(200, {
          "content-type": "application/pdf",
          // A new cookie, a deletion, and an attribute-only change (now hidden from scripts).
          "set-cookie": ["pdf=1", "page=; Max-Age=0", "flag=1; HttpOnly"],
        });
        res.end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": ["page=1", "flag=1"] });
      res.end("ok");
    });
    await http.get({ url: `${base}/page`, minTier: "T2" });
    const pdf = await http.get({
      url: `${base}/a.pdf`,
      minTier: "T2",
      binary: true,
      headers: { "x-test-token": "abc" },
    });
    expect(pdf).toMatchObject({ status: 200, tier: "T2" });
    expect([...(pdf.bytes ?? [])]).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(seen.get("/a.pdf")).toMatchObject({
      cookie: expect.stringContaining("page=1"),
      "x-test-token": "abc",
      "user-agent": expect.stringContaining("Chrome/"),
    });
    handler = recording((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<body><script>document.body.append("js sees: " + document.cookie)</script></body>`);
    });
    const after = await http.get({ url: `${base}/after`, minTier: "T2" });
    expect(seen.get("/after")?.cookie).toContain("pdf=1");
    expect(seen.get("/after")?.cookie).toContain("flag=1");
    expect(seen.get("/after")?.cookie).not.toContain("page=");
    expect(after.body).toContain("js sees: ");
    expect(after.body).not.toContain("flag=1");
  }, 120_000);

  it("keeps a cookie a page changed while a binary fetch to another host ran", async () => {
    // A second host (pacing is per hostname), so the page fetch runs during the binary one.
    let release: () => void = () => {};
    const held = holdResponse("/held.bin", new Promise<void>((resolve) => (release = resolve)));
    const other = createServer(held.handle);
    await new Promise<void>((resolve) => other.listen(0, "localhost", resolve));
    const otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
    try {
      handler = recording((req, res) => {
        const value = new URL(req.url ?? "", base).searchParams.get("set");
        if (value) res.setHeader("set-cookie", `shared=${value}`);
        res.end("ok");
      });
      await http.get({ url: `${base}/?set=1`, minTier: "T2" });
      const binary = http.get({ url: `${otherBase}/held.bin`, minTier: "T2", binary: true });
      await held.arrival;
      await http.get({ url: `${base}/?set=2`, minTier: "T2" });
      release();
      await binary;
      await http.get({ url: `${base}/check`, minTier: "T2" });
      expect(seen.get("/check")?.cookie).toContain("shared=2");
    } finally {
      release();
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  }, 120_000);

  it("keeps a refreshed cookie whose seeded copy expired while a binary fetch ran", async () => {
    let release: () => void = () => {};
    const held = holdResponse("/held.bin", new Promise<void>((resolve) => (release = resolve)));
    const other = createServer(held.handle);
    await new Promise<void>((resolve) => other.listen(0, "localhost", resolve));
    const otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
    try {
      handler = recording((req, res) => {
        const value = new URL(req.url ?? "", base).searchParams.get("set");
        if (value) res.setHeader("set-cookie", value);
        res.end("ok");
      });
      await http.get({ url: `${base}/?set=session=old;Max-Age=3`, minTier: "T2" });
      const oldExpiry = Date.now() + 3000;
      const binary = http.get({ url: `${otherBase}/held.bin`, minTier: "T2", binary: true });
      await held.arrival;
      await http.get({ url: `${base}/?set=session=new;Max-Age=3600`, minTier: "T2" });
      await new Promise((resolve) => setTimeout(resolve, oldExpiry + 1000 - Date.now()));
      release();
      await binary;
      await http.get({ url: `${base}/check`, minTier: "T2" });
      expect(seen.get("/check")?.cookie).toContain("session=new");
    } finally {
      release();
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  }, 120_000);

  it("closes the connection of an aborted binary fetch", async () => {
    const held = holdResponse("/slow.zip");
    handler = held.handle;
    const controller = new AbortController();
    const pending = http.get({
      url: `${base}/slow.zip`,
      minTier: "T2",
      binary: true,
      signal: controller.signal,
    });
    await held.arrival;
    const abortedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // Unfixed, the connection stays open until the server ends the response 5 s later.
    expect((await held.closure) - abortedAt).toBeLessThan(2000);
  }, 120_000);

  it("closes the connection of a binary fetch still running at close()", async () => {
    const held = holdResponse("/slow.zip");
    handler = held.handle;
    // One browser at a time: the shared one relaunches if a later test needs it.
    await http.close();
    const own = createLiveHttp({
      hostIntervalMs: 0,
      attempts: 1,
      browser: { engine: "patchright" },
    });
    const pending = own.get({ url: `${base}/slow.zip`, minTier: "T2", binary: true });
    pending.catch(() => {});
    await held.arrival;
    const closedAt = Date.now();
    await own.close();
    expect((await held.closure) - closedAt).toBeLessThan(2000);
    await expect(pending).rejects.toThrow();
  }, 120_000);
});

/**
 * Serves `path` slowly, the way a large download goes: the response ends after `release` settles
 * or 5 s. Reports when the request arrives and when its connection closes; other paths get "ok".
 */
function holdResponse(path: string, release: Promise<void> = new Promise(() => {})) {
  let arrived: () => void = () => {};
  let closed: (at: number) => void = () => {};
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const closure = new Promise<number>((resolve) => {
    closed = resolve;
  });
  const handle: Handler = (req, res) => {
    if (req.url !== path) {
      res.end("ok");
      return;
    }
    const timer = setTimeout(() => res.end("late"), 5000);
    void release.then(() => res.end("released"));
    res.on("close", () => {
      clearTimeout(timer);
      closed(Date.now());
    });
    arrived();
  };
  return { handle, arrival, closure };
}
