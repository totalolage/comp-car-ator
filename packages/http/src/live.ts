import type { Impit } from "impit";
import { type BrowserOptions, createBrowserFetcher } from "./browser.ts";
import { type CacheOptions, createCachedHttp } from "./cache.ts";
import {
  createTieredHttp,
  type PolicyOptions,
  type RawResponse,
  type TierFetcher,
} from "./tiered.ts";
import type { Http } from "./types.ts";

export interface LiveHttpOptions extends PolicyOptions {
  /** Per-attempt timeout for T0/T1 fetches and T2 navigations, ms. Default 30 000. */
  timeoutMs?: number;
  /**
   * Raw response cache on disk: a cached Page is served without touching the network. Off unless
   * set. Point `dir` at a per-run directory, or set `maxAgeMs`, so incremental runs see new data.
   */
  cache?: CacheOptions;
  /**
   * Enables T2, the stealth browser. Off by default; the environment variable
   * `CCA_HTTP_BROWSER=patchright|camoufox` enables it too, so an ingest job can opt in without a
   * code change. `false` keeps it off whatever the environment says.
   */
  browser?: BrowserOptions | false;
}

/** The production Http adapter, plus `close()` to shut down a T2 browser before exit. */
export interface LiveHttp extends Http {
  close(): Promise<void>;
}

/**
 * The production Http adapter: real network, tier escalation T0 → T1 → T2 (T2 only when
 * enabled), optionally behind the raw response cache.
 */
export function createLiveHttp(options: LiveHttpOptions = {}): LiveHttp {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const browserOptions = options.browser ?? browserFromEnv();
  const t2 = browserOptions ? createBrowserFetcher(browserOptions, timeoutMs) : undefined;
  const tiered = createTieredHttp(
    { T0: createT0Fetcher(timeoutMs), T1: createT1Fetcher(timeoutMs), T2: t2?.fetch },
    options,
  );
  const http = options.cache ? createCachedHttp(tiered, options.cache) : tiered;
  return {
    get: (request) => http.get(request),
    close: async () => {
      await t2?.close();
    },
  };
}

/** Headers a Chrome navigation sends; T0 adds them under the caller's. */
const T0_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
};

/** T0: built-in fetch with browser-like headers. */
function createT0Fetcher(timeoutMs: number): TierFetcher {
  return async ({ url, headers, binary, signal }) => {
    const response = await fetch(url, {
      headers: { ...T0_HEADERS, ...headers },
      redirect: "follow",
      signal: withTimeout(signal, timeoutMs),
    });
    return toRaw(response.url || url, response, binary);
  };
}

/**
 * T1: TLS/HTTP2 impersonation of Chrome (Impit). Impit supplies the User-Agent, client hints
 * and Accept headers that match its fingerprint; only the caller's headers go on top. The
 * native module loads on first use, so callers that never escalate never pay for it.
 */
function createT1Fetcher(timeoutMs: number): TierFetcher {
  let client: Promise<Impit> | undefined;
  return async ({ url, headers, binary, signal }) => {
    client ??= import("impit").then(({ Impit }) => new Impit({ browser: "chrome151" }));
    const response = await (await client).fetch(url, { headers, signal, timeout: timeoutMs });
    return toRaw(response.url || url, response, binary);
  };
}

function browserFromEnv(): BrowserOptions | undefined {
  const engine = process.env.CCA_HTTP_BROWSER;
  if (!engine) return undefined;
  if (engine !== "patchright" && engine !== "camoufox") {
    throw new Error(`CCA_HTTP_BROWSER must be "patchright" or "camoufox", got "${engine}"`);
  }
  return { engine };
}

interface FetchLikeResponse {
  status: number;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
}

async function toRaw(url: string, response: FetchLikeResponse, binary: boolean) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  // A binary request answered with text (a challenge or error page) keeps its text, so
  // challenge detection still sees it.
  const text = !binary || /^text\//i.test(contentType ?? "");
  return {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text ? decode(bytes, contentType) : "",
    ...(binary ? { bytes } : {}),
  } satisfies RawResponse;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
