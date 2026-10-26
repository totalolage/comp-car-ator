import type { Impit } from "impit";
import { type BrowserOptions, createBrowserFetcher } from "./browser.ts";
import { type CacheOptions, createCachedHttp } from "./cache.ts";
import { idleChunks, idleTimeout, streams } from "./chunks.ts";
import {
  createTieredHttp,
  type PolicyOptions,
  type RawResponse,
  type TierFetcher,
} from "./tiered.ts";
import type { Http } from "./types.ts";

export interface LiveHttpOptions extends PolicyOptions {
  /**
   * Per-attempt timeout for T0/T1 fetches and T2 navigations, ms. Default 30 000. A `stream`
   * request at T0 instead gets this long for its headers and for each chunk.
   */
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
  return async ({ url, headers, binary, stream, signal }) => {
    if (stream) {
      return fetchStream(url, signal, timeoutMs, (combined) =>
        fetch(url, {
          headers: { ...T0_HEADERS, ...headers },
          redirect: "follow",
          signal: combined,
        }),
      );
    }
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
  return async ({ url, headers, binary, stream, signal }) => {
    client ??= import("impit").then(({ Impit }) => new Impit({ browser: "chrome151" }));
    // Impit cannot stop a native request before its headers arrive (an abort only ends the
    // wait), and its own timeout covers the whole body, so T1 does not stream: a `stream`
    // request is read in full under that timeout, which ends the native request with it, up to
    // T1_STREAM_MAX_BYTES. The policy then serves the bytes as chunks, as for T2.
    const response = await (await client).fetch(url, { headers, signal, timeout: timeoutMs });
    if (!stream) return toRaw(response.url || url, response, binary);
    return toRaw(response.url || url, response, true, T1_STREAM_MAX_BYTES);
  };
}

/** The largest body T1 reads for a `stream` request; larger downloads need T0. */
const T1_STREAM_MAX_BYTES = 256 * 2 ** 20;

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
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * A `stream` request: `timeoutMs` limits the wait for the headers, then each chunk read (not the
 * whole download, which may take hours). Only a 2xx response that is not HTML streams; anything
 * else is read in full under the header timeout, so the policy sees challenges and errors.
 */
async function fetchStream(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  send: (
    signal: AbortSignal,
  ) => Promise<FetchLikeResponse & { url: string; body: ReadableStream<Uint8Array> | null }>,
): Promise<RawResponse> {
  // One controller for the caller's abort and both timeouts, so a pending read sees either.
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  // Removed when the request or its stream ends: a Source reuses one signal for a whole run.
  signal?.addEventListener("abort", forward, { once: true });
  const release = () => signal?.removeEventListener("abort", forward);
  const timer = setTimeout(() => controller.abort(idleTimeout(timeoutMs)), timeoutMs);
  let streaming = false;
  try {
    const response = await send(controller.signal);
    if (!response.body || !streams(response.status, response.headers.get("content-type"))) {
      return await toRaw(response.url || url, response, true);
    }
    streaming = true;
    return {
      url: response.url || url,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: "",
      chunks: idleChunks(response.body, controller, timeoutMs, release),
    };
  } finally {
    clearTimeout(timer);
    if (!streaming) release();
  }
}

async function toRaw(url: string, response: FetchLikeResponse, binary: boolean, maxBytes?: number) {
  const bytes =
    maxBytes === undefined
      ? new Uint8Array(await response.arrayBuffer())
      : await readUpTo(url, response, maxBytes);
  const contentType = response.headers.get("content-type");
  // A binary request answered with text or HTML (a challenge or error page) keeps its text,
  // so challenge detection still sees it.
  const text = !binary || /^text\/|html/i.test(contentType ?? "");
  return {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text ? decode(bytes, contentType) : "",
    ...(binary ? { bytes } : {}),
  } satisfies RawResponse;
}

/** Reads the body in full, failing (and closing it) once it exceeds `maxBytes`. */
async function readUpTo(
  url: string,
  response: FetchLikeResponse,
  maxBytes: number,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new Error(`${url}: body over ${maxBytes} bytes, too large to read in full at this tier`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the body.
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > maxBytes) throw tooLarge();
    parts.push(part);
  }
  return Buffer.concat(parts);
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
