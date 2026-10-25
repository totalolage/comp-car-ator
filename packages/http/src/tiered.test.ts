// Tests the Http policy through the internal tier seam (fake TierFetchers, fake clock).
import { describe, expect, it } from "vitest";
import { createTieredHttp, type RawResponse, type TierFetcher } from "./tiered.ts";
import { HttpBlockedError, HttpNetworkError } from "./types.ts";

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function ok(url: string, body = "ok"): RawResponse {
  return { url, status: 200, headers: {}, body };
}

function scripted(responses: (RawResponse | Error)[]): TierFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = async ({ url }: { url: string }) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(fetcher, { calls });
}

/** Answers every request with the same response. */
function always(response: RawResponse): TierFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = async ({ url }: { url: string }) => {
    calls.push(url);
    return { ...response, url };
  };
  return Object.assign(fetcher, { calls });
}

const cloudflare: RawResponse = {
  url: "https://a.example/",
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  body: "Just a moment...",
};

describe("Http policy: pacing", () => {
  it("paces requests to one host at the configured interval", async () => {
    const c = clock();
    const t0 = scripted([ok("https://a.example/1"), ok("https://a.example/2")]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 1000, ...c });
    await http.get("https://a.example/1");
    await http.get("https://a.example/2");
    expect(c.sleeps).toEqual([1000]);
  });

  it("serializes concurrent requests to one host and keeps each at least an interval apart", async () => {
    const c = clock();
    const at: number[] = [];
    const t0: TierFetcher = async ({ url }) => {
      at.push(c.now());
      return ok(url);
    };
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 500, ...c });
    await Promise.all([1, 2, 3].map((n) => http.get(`https://a.example/${n}`)));
    expect(at).toEqual([0, 500, 1000]);
  });

  it("does not pace different hosts against each other", async () => {
    const c = clock();
    const t0 = always(ok(""));
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 1000, ...c });
    await http.get("https://a.example/");
    await http.get("https://b.example/");
    expect(c.sleeps).toEqual([]);
  });

  it("lets a request raise its host's interval but not lower it", async () => {
    const c = clock();
    const http = createTieredHttp({ T0: always(ok("")) }, { hostIntervalMs: 1000, ...c });
    await http.get("https://a.example/1");
    await http.get({ url: "https://a.example/2", hostIntervalMs: 3000 });
    await http.get({ url: "https://a.example/3", hostIntervalMs: 10 });
    expect(c.sleeps).toEqual([3000, 1000]);
  });

  it("applies per-host interval overrides", async () => {
    const c = clock();
    const http = createTieredHttp(
      { T0: always(ok("")) },
      { hostIntervalMs: 1000, hostIntervals: { "a.example": 2500 }, ...c },
    );
    await http.get("https://a.example/1");
    await http.get("https://a.example/2");
    expect(c.sleeps).toEqual([2500]);
  });

  it("rejects a request aborted while queued at once, without fetching, and keeps the queue moving", async () => {
    let finishFirst: (r: RawResponse) => void = () => {};
    const calls: string[] = [];
    const t0: TierFetcher = ({ url }) => {
      calls.push(url);
      if (url.endsWith("/1")) return new Promise((resolve) => (finishFirst = resolve));
      return Promise.resolve(ok(url));
    };
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...clock() });
    const controller = new AbortController();
    const first = http.get("https://a.example/1");
    const second = http.get({ url: "https://a.example/2", signal: controller.signal });
    const third = http.get("https://a.example/3");
    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    finishFirst(ok("https://a.example/1"));
    await first;
    await third;
    expect(calls).toEqual(["https://a.example/1", "https://a.example/3"]);
  });

  it("stops waiting for the pacing slot when aborted", async () => {
    const controller = new AbortController();
    const t0 = always(ok(""));
    const http = createTieredHttp(
      { T0: t0 },
      {
        hostIntervalMs: 1000,
        now: () => 0,
        sleep: () => new Promise(() => {}), // the slot never comes
      },
    );
    await http.get("https://a.example/1");
    const waiting = http.get({ url: "https://a.example/2", signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(t0.calls).toHaveLength(1);
  });
});

describe("Http policy: retry and backoff", () => {
  it("retries 5xx with exponential backoff and returns the eventual page", async () => {
    const c = clock();
    const t0 = scripted([
      { ...ok("https://a.example/"), status: 503 },
      { ...ok("https://a.example/"), status: 502 },
      ok("https://a.example/"),
    ]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...c });
    const page = await http.get("https://a.example/");
    expect(page).toMatchObject({ status: 200, tier: "T0" });
    expect(c.sleeps).toEqual([1000, 2000]);
  });

  it("waits Retry-After on 429, capped at one minute", async () => {
    const c = clock();
    const t0 = scripted([
      { ...ok("https://a.example/"), status: 429, headers: { "retry-after": "7" } },
      { ...ok("https://a.example/"), status: 429, headers: { "retry-after": "3600" } },
      ok("https://a.example/"),
    ]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...c });
    expect((await http.get("https://a.example/")).status).toBe(200);
    expect(c.sleeps).toEqual([7000, 60_000]);
  });

  it("returns the last 5xx as a Page once attempts run out", async () => {
    const t0 = always({ ...ok(""), status: 500 });
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, attempts: 2, ...clock() });
    expect((await http.get("https://a.example/")).status).toBe(500);
    expect(t0.calls).toHaveLength(2);
  });

  it("holds back other requests to the host during backoff", async () => {
    const c = clock();
    const order: string[] = [];
    const responses = [{ ...ok(""), status: 429 }, ok(""), ok("")];
    const t0: TierFetcher = async ({ url }) => {
      order.push(`${url}@${c.now()}`);
      return { ...(responses.shift() as RawResponse), url };
    };
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...c });
    await Promise.all([http.get("https://a.example/1"), http.get("https://a.example/2")]);
    expect(order).toEqual([
      "https://a.example/1@0",
      "https://a.example/1@1000",
      "https://a.example/2@1000",
    ]);
  });

  it("makes the next request wait out a 429 that used up its attempts", async () => {
    const c = clock();
    const t0 = scripted([{ ...ok(""), status: 429, headers: { "retry-after": "30" } }, ok("")]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, attempts: 1, ...c });
    expect((await http.get("https://a.example/1")).status).toBe(429);
    await http.get("https://a.example/2");
    expect(c.sleeps).toEqual([30_000]);
  });

  it("waits the longer of the host interval and the cooldown", async () => {
    const c = clock();
    const t0 = scripted([
      { ...ok(""), status: 429, headers: { "retry-after": "2" } },
      ok(""),
      { ...ok(""), status: 429, headers: { "retry-after": "9" } },
      ok(""),
    ]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 5000, ...c });
    await http.get("https://a.example/1");
    await http.get("https://a.example/2");
    expect(c.sleeps).toEqual([5000, 5000, 9000]);
  });

  it("lets the next request through after one is aborted during its backoff", async () => {
    const c = clock();
    const controller = new AbortController();
    const sleep = async (ms: number) => {
      controller.abort(new Error("cancelled"));
      await c.sleep(ms);
    };
    const t0 = scripted([{ ...ok(""), status: 503 }, ok("https://a.example/2")]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, now: c.now, sleep });
    const first = http.get({ url: "https://a.example/1", signal: controller.signal });
    const second = http.get("https://a.example/2");
    await expect(first).rejects.toThrow("cancelled");
    expect((await second).status).toBe(200);
    expect(t0.calls).toEqual(["https://a.example/1", "https://a.example/2"]);
  });

  it("returns a non-retryable status as a Page", async () => {
    const t0 = scripted([{ ...ok("https://a.example/"), status: 404 }]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get("https://a.example/")).status).toBe(404);
  });

  it("rejects with HttpNetworkError after exhausting retries", async () => {
    const boom = new Error("ECONNRESET");
    const http = createTieredHttp(
      { T0: scripted([boom, boom, boom]) },
      { hostIntervalMs: 0, attempts: 3, ...clock() },
    );
    await expect(http.get("https://a.example/")).rejects.toBeInstanceOf(HttpNetworkError);
  });

  it("stops retrying when the request is aborted during backoff", async () => {
    const controller = new AbortController();
    const t0 = scripted([{ ...ok("https://a.example/"), status: 503 }, ok("https://a.example/")]);
    const http = createTieredHttp(
      { T0: t0 },
      {
        hostIntervalMs: 0,
        now: () => 0,
        sleep: async () => controller.abort(new Error("cancelled")),
      },
    );
    await expect(
      http.get({ url: "https://a.example/", signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(t0.calls).toHaveLength(1);
  });
});

describe("Http policy: tiers and challenges", () => {
  it("escalates to the next tier on a bot challenge", async () => {
    const t0 = scripted([cloudflare]);
    const t1 = scripted([ok("https://a.example/", "real")]);
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect(await http.get("https://a.example/")).toMatchObject({ body: "real", tier: "T1" });
  });

  it("escalates on a plain 403 and returns a 403 from the last tier as a Page", async () => {
    const forbidden = { ...ok("https://a.example/"), status: 403, body: "Forbidden" };
    const t0 = scripted([forbidden]);
    const t1 = scripted([forbidden]);
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect(await http.get("https://a.example/")).toMatchObject({ status: 403, tier: "T1" });
    expect([t0.calls.length, t1.calls.length]).toEqual([1, 1]);
  });

  it("does not retry a challenged response at the same tier", async () => {
    const t0 = always({ ...cloudflare, status: 503 });
    const t1 = always(ok("", "real"));
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get("https://a.example/")).tier).toBe("T1");
    expect(t0.calls).toHaveLength(1);
  });

  it("rejects with HttpBlockedError when the highest tier is challenged too", async () => {
    const http = createTieredHttp(
      { T0: always(cloudflare), T1: always(cloudflare) },
      { hostIntervalMs: 0, ...clock() },
    );
    await expect(http.get("https://a.example/")).rejects.toMatchObject({
      name: "HttpBlockedError",
      tier: "T1",
      marker: "cloudflare",
    });
  });

  it("starts at the requested minimum tier when it is available", async () => {
    const t0 = scripted([]);
    const t1 = scripted([ok("https://a.example/")]);
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get({ url: "https://a.example/", minTier: "T1" })).tier).toBe("T1");
    expect(t0.calls).toHaveLength(0);
  });

  it("falls back to the highest available tier when the requested one is off", async () => {
    const t1 = always(ok(""));
    const http = createTieredHttp(
      { T0: always(ok("")), T1: t1 },
      { hostIntervalMs: 0, ...clock() },
    );
    expect((await http.get({ url: "https://a.example/", minTier: "T2" })).tier).toBe("T1");
  });

  it("stops sending a host anything after repeated blocked requests", async () => {
    const t0 = always(cloudflare);
    const t1 = always(cloudflare);
    const other = always(ok(""));
    const http = createTieredHttp(
      { T0: async (r) => (r.url.includes("b.example") ? other(r) : t0(r)), T1: t1 },
      { hostIntervalMs: 0, maxConsecutiveBlocks: 2, ...clock() },
    );
    for (const n of [1, 2]) {
      await expect(http.get(`https://a.example/${n}`)).rejects.toBeInstanceOf(HttpBlockedError);
    }
    const third = http.get("https://a.example/3");
    await expect(third).rejects.toThrow(/stopped after 2 blocked requests to a\.example/);
    expect([t0.calls.length, t1.calls.length]).toEqual([2, 2]);
    // Other hosts are unaffected.
    expect((await http.get("https://b.example/")).status).toBe(200);
  });

  it("also stops requests that were already queued for the host", async () => {
    const t0 = always(cloudflare);
    const http = createTieredHttp(
      { T0: t0 },
      { hostIntervalMs: 0, maxConsecutiveBlocks: 1, ...clock() },
    );
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => http.get(`https://a.example/${n}`)),
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(t0.calls).toHaveLength(1);
  });

  it("resets the block count after a page gets through", async () => {
    const t0 = scripted([
      cloudflare,
      ok("https://a.example/2"),
      cloudflare,
      ok("https://a.example/4"),
    ]);
    const http = createTieredHttp(
      { T0: t0 },
      { hostIntervalMs: 0, maxConsecutiveBlocks: 2, ...clock() },
    );
    await expect(http.get("https://a.example/1")).rejects.toBeInstanceOf(HttpBlockedError);
    await http.get("https://a.example/2");
    await expect(http.get("https://a.example/3")).rejects.toBeInstanceOf(HttpBlockedError);
    expect((await http.get("https://a.example/4")).status).toBe(200);
  });

  it.each([
    [
      "akamai",
      {
        status: 200,
        headers: {},
        body: "<h1>Zugriff verweigert / Access denied</h1><p>Error Reference: 0.b25d1502.1792855061.14e82adb</p>",
      },
    ],
    ["akamai", { status: 403, headers: { server: "AkamaiGHost" }, body: "" }],
    [
      "edgeone",
      {
        status: 200,
        headers: { server: "TencentEdgeOne" },
        body: "<script>document.cookie='EO_Bot_Ssid=1'</script>",
      },
    ],
    ["cloudflare", { status: 403, headers: {}, body: "<title>Just a moment...</title>" }],
    ["datadome", { status: 403, headers: { "x-datadome": "protected" }, body: "" }],
  ])("recognizes a %s block", async (marker, response) => {
    const http = createTieredHttp(
      { T0: always({ url: "", ...response }) },
      { hostIntervalMs: 0, ...clock() },
    );
    await expect(http.get("https://a.example/")).rejects.toMatchObject({ marker });
  });

  it("does not mistake a normal page carrying Cloudflare's script for a challenge", async () => {
    const body = `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><div class="g-recaptcha captcha">`;
    const http = createTieredHttp({ T0: always(ok("", body)) }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get("https://a.example/")).status).toBe(200);
  });
});
