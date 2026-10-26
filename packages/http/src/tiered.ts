/**
 * Internal seam of the Http module: one TierFetcher per fetch tier, plus the policy that
 * wraps them (pacing, retry/backoff, challenge detection, escalation, stopping a host that
 * keeps blocking). Not exported from the package index; only this package's own code and
 * tests reach it.
 */
import { detectChallenge } from "./challenge.ts";
import { cancelChunks, chunksOf, relayChunks, streams } from "./chunks.ts";
import {
  type Http,
  HttpBlockedError,
  HttpNetworkError,
  type HttpRequest,
  normalizeRequest,
  type Page,
  TIERS,
  type Tier,
} from "./types.ts";

export interface RawResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes?: Uint8Array;
  /**
   * Unread body of a streamed response. A fetcher asked to `stream` may return it only for a
   * 2xx response that is not HTML; it reads anything else in full (as for `binary`), so
   * challenge pages and errors are detected and retried as usual. A fetcher that cannot stream
   * reads every response in full; the policy then serves the bytes as chunks.
   */
  chunks?: AsyncIterable<Uint8Array>;
}

/**
 * Fetches one URL with one tier's tool. `headers` holds the caller's headers plus
 * Accept-Language; each tier adds its own browser defaults (User-Agent etc.) underneath, so a
 * tier that impersonates a browser keeps its headers consistent with its fingerprint.
 */
export type TierFetcher = (request: {
  url: string;
  headers: Record<string, string>;
  binary: boolean;
  stream: boolean;
  signal?: AbortSignal;
}) => Promise<RawResponse>;

export interface PolicyOptions {
  /** Minimum spacing between requests to one host, ms. Default 1000 (~1 req/s). */
  hostIntervalMs?: number;
  /** Per-hostname overrides, ms. */
  hostIntervals?: Record<string, number>;
  /** Attempts per tier for 429/5xx and network failures. Default 3. */
  attempts?: number;
  /**
   * Requests to one host that may end blocked in a row before the Http stops sending that host
   * anything: later requests reject with HttpBlockedError at once. Default 3.
   */
  maxConsecutiveBlocks?: number;
}

export interface TieredOptions extends PolicyOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const ACCEPT_LANGUAGE = {
  cs: "cs-CZ,cs;q=0.9,en;q=0.8",
  de: "de-DE,de;q=0.9,en;q=0.8",
  en: "en-US,en;q=0.9",
} as const;

const MAX_RETRY_AFTER_MS = 60_000;

interface BlockStreak {
  count: number;
  tier: Tier;
  marker: string;
}

export function createTieredHttp(
  fetchers: Partial<Record<Tier, TierFetcher>>,
  options: TieredOptions = {},
): Http {
  const baseSleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const attempts = Math.max(1, options.attempts ?? 3);
  const maxBlocks = Math.max(1, options.maxConsecutiveBlocks ?? 3);
  const queues = new Map<string, Promise<void>>();
  const lastAt = new Map<string, number>();
  /** Backoff after a 429, 5xx or network failure: no fetch to the host before this time. */
  const cooldownUntil = new Map<string, number>();
  const streaks = new Map<string, BlockStreak>();

  function intervalFor(host: string, request: HttpRequest): number {
    const configured = options.hostIntervals?.[host] ?? options.hostIntervalMs ?? 1000;
    return Math.max(configured, request.hostIntervalMs ?? 0);
  }

  /**
   * Runs `fn` in the host's turn, after every earlier request to the host has finished. A
   * request keeps the turn through its retries and tier escalation, so the requests queued
   * behind it wait out its backoff too. An abort while queued rejects at once and passes
   * the turn on.
   */
  async function inTurn<T>(host: string, signal: AbortSignal | undefined, fn: () => Promise<T>) {
    const previous = queues.get(host) ?? Promise.resolve();
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    queues.set(
      host,
      previous.then(() => done),
    );
    try {
      await abortable(previous, signal);
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * One fetch, at least the host interval after the previous fetch to that host and not before
   * its cooldown ends. The cooldown outlives the request that set it, so a 429 that used up its
   * attempts still slows the next request down.
   */
  async function spaced<T>(host: string, request: HttpRequest, fn: () => Promise<T>): Promise<T> {
    const last = lastAt.get(host);
    const earliest = Math.max(
      last === undefined ? 0 : last + intervalFor(host, request),
      cooldownUntil.get(host) ?? 0,
    );
    const wait = earliest - now();
    if (wait > 0) await abortable(baseSleep(wait), request.signal);
    try {
      const result = await fn();
      // A tier that missed the abort (e.g. while a browser started) must not return a result.
      request.signal?.throwIfAborted();
      return result;
    } finally {
      lastAt.set(host, now());
    }
  }

  /** Fails fast once a host has blocked `maxBlocks` requests in a row. */
  function throwIfStopped(host: string, url: string): void {
    const streak = streaks.get(host);
    if (streak && streak.count >= maxBlocks) {
      const detail = `stopped after ${streak.count} blocked requests to ${host}`;
      throw new HttpBlockedError(url, streak.tier, streak.marker, detail);
    }
  }

  function tiersFrom(minTier: Tier): Tier[] {
    const available = TIERS.filter((t) => fetchers[t]);
    if (available.length === 0) throw new Error("Http has no fetch tiers configured");
    const atOrAbove = available.filter((t) => TIERS.indexOf(t) >= TIERS.indexOf(minTier));
    // A requested tier that is not available falls back to the highest one we have.
    return atOrAbove.length > 0 ? atOrAbove : [available[available.length - 1] as Tier];
  }

  async function fetchWithRetry(
    tier: Tier,
    request: HttpRequest,
    host: string,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    const fetcher = fetchers[tier] as TierFetcher;
    const { url, signal } = request;
    const coolDown = (ms: number) => cooldownUntil.set(host, now() + ms);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      let response: RawResponse;
      try {
        response = await spaced(host, request, () =>
          fetcher({
            url,
            headers,
            binary: request.binary ?? false,
            stream: request.stream ?? false,
            signal,
          }),
        );
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        coolDown(backoffMs(attempt));
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      // A challenge is not retried at the same tier, whatever its status: escalation handles it.
      if (!retryable || detectChallenge(response)) return response;
      coolDown(retryAfterMs(response, now()) ?? backoffMs(attempt));
      if (attempt === attempts) return response;
    }
    throw new HttpNetworkError(url, lastError);
  }

  /** Walks the tiers; a challenge or a plain 403 moves to the next tier if there is one. */
  async function escalate(request: HttpRequest, host: string): Promise<Page> {
    const headers = {
      "accept-language": ACCEPT_LANGUAGE[request.locale ?? "cs"],
      ...lowerKeys(request.headers ?? {}),
    };
    const tiers = tiersFrom(request.minTier ?? "T0");
    let blocked: { tier: Tier; marker: string } | undefined;
    for (const [index, tier] of tiers.entries()) {
      const response = await fetchWithRetry(tier, request, host, headers);
      const marker = detectChallenge(response);
      if (marker) {
        await cancelChunks(response.chunks);
        blocked = { tier, marker };
        continue;
      }
      // A 403 without a known marker may be an unrecognized bot rule: try the next tier, and
      // return the 403 as a Page if no tier is left.
      if (response.status === 403 && index < tiers.length - 1) continue;
      if (!request.stream) return { ...response, tier };
      // A tier that cannot stream read the body in full; serve it as chunks all the same.
      const { bytes, chunks: streamed, ...rest } = response;
      const chunks = streamed ?? chunksOf(bytes ?? new TextEncoder().encode(rest.body));
      return {
        ...rest,
        ...(streams(rest.status, rest.headers["content-type"]) ? { body: "" } : {}),
        ...(request.binary && bytes ? { bytes } : {}),
        chunks: relayChunks(chunks, request.signal),
        tier,
      };
    }
    const { tier, marker } = blocked as { tier: Tier; marker: string };
    throw new HttpBlockedError(request.url, tier, marker);
  }

  return {
    async get(input: HttpRequest | string): Promise<Page> {
      const request = normalizeRequest(input);
      const host = new URL(request.url).hostname;
      throwIfStopped(host, request.url);
      return inTurn(host, request.signal, async () => {
        // The host may have been stopped while this request was queued.
        throwIfStopped(host, request.url);
        try {
          const page = await escalate(request, host);
          streaks.delete(host);
          return page;
        } catch (error) {
          if (error instanceof HttpBlockedError) {
            const { tier, marker } = error;
            streaks.set(host, { count: (streaks.get(host)?.count ?? 0) + 1, tier, marker });
          }
          throw error;
        }
      });
    },
  };
}

function abortable<T>(wait: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return wait;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

/** Retry-After as seconds or an HTTP date, capped so a hostile value cannot stall a run. */
function retryAfterMs(response: RawResponse, nowMs: number): number | undefined {
  const value = response.headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - nowMs;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
