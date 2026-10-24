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

const cloudflare: RawResponse = {
  url: "https://a.example/",
  status: 403,
  headers: { "cf-mitigated": "challenge" },
  body: "Just a moment...",
};

describe("Http policy", () => {
  it("paces requests to one host at the configured interval", async () => {
    const c = clock();
    const t0 = scripted([ok("https://a.example/1"), ok("https://a.example/2")]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 1000, ...c });
    await http.get("https://a.example/1");
    await http.get("https://a.example/2");
    expect(c.sleeps).toEqual([1000]);
  });

  it("retries 5xx with backoff and returns the eventual page", async () => {
    const c = clock();
    const t0 = scripted([{ ...ok("https://a.example/"), status: 503 }, ok("https://a.example/")]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...c });
    const page = await http.get("https://a.example/");
    expect(page).toMatchObject({ status: 200, tier: "T0" });
    expect(t0.calls).toHaveLength(2);
  });

  it("returns a non-retryable status as a Page", async () => {
    const t0 = scripted([{ ...ok("https://a.example/"), status: 404 }]);
    const http = createTieredHttp({ T0: t0 }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get("https://a.example/")).status).toBe(404);
  });

  it("escalates to the next tier on a bot challenge", async () => {
    const t0 = scripted([cloudflare]);
    const t1 = scripted([ok("https://a.example/", "real")]);
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect(await http.get("https://a.example/")).toMatchObject({ body: "real", tier: "T1" });
  });

  it("rejects with HttpBlockedError when the highest tier is challenged too", async () => {
    const http = createTieredHttp(
      { T0: scripted([cloudflare]) },
      { hostIntervalMs: 0, ...clock() },
    );
    await expect(http.get("https://a.example/")).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("rejects with HttpNetworkError after exhausting retries", async () => {
    const boom = new Error("ECONNRESET");
    const http = createTieredHttp(
      { T0: scripted([boom, boom, boom]) },
      { hostIntervalMs: 0, attempts: 3, ...clock() },
    );
    await expect(http.get("https://a.example/")).rejects.toBeInstanceOf(HttpNetworkError);
  });

  it("starts at the requested minimum tier when it is available", async () => {
    const t0 = scripted([]);
    const t1 = scripted([ok("https://a.example/")]);
    const http = createTieredHttp({ T0: t0, T1: t1 }, { hostIntervalMs: 0, ...clock() });
    expect((await http.get({ url: "https://a.example/", minTier: "T1" })).tier).toBe("T1");
    expect(t0.calls).toHaveLength(0);
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
