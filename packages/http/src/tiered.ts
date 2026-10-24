/**
 * Internal seam of the Http module: one TierFetcher per fetch tier, plus the policy that
 * wraps them (pacing, retry/backoff, challenge detection, escalation). Not exported from
 * the package index; only this package's own tests reach it.
 */
import { detectChallenge } from "./challenge.ts";
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
}

export type TierFetcher = (request: {
  url: string;
  headers: Record<string, string>;
  binary: boolean;
  signal?: AbortSignal;
}) => Promise<RawResponse>;

export interface PacingOptions {
  /** Minimum spacing between requests to one host, ms. Default 1000 (~1 req/s). */
  hostIntervalMs?: number;
  /** Per-hostname overrides, ms. */
  hostIntervals?: Record<string, number>;
  /** Attempts per tier for 429/5xx and network failures. Default 3. */
  attempts?: number;
}

export interface TieredOptions extends PacingOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const ACCEPT_LANGUAGE = {
  cs: "cs-CZ,cs;q=0.9,en;q=0.8",
  de: "de-DE,de;q=0.9,en;q=0.8",
  en: "en-US,en;q=0.9",
} as const;

const MAX_RETRY_AFTER_MS = 60_000;

export function createTieredHttp(
  fetchers: Partial<Record<Tier, TierFetcher>>,
  options: TieredOptions = {},
): Http {
  const baseSleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const attempts = Math.max(1, options.attempts ?? 3);
  const chains = new Map<string, Promise<unknown>>();
  const lastAt = new Map<string, number>();

  function intervalFor(host: string): number {
    return options.hostIntervals?.[host] ?? options.hostIntervalMs ?? 1000;
  }

  function paced<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(host) ?? Promise.resolve();
    const run = previous.then(async () => {
      const last = lastAt.get(host);
      if (last !== undefined) {
        const wait = last + intervalFor(host) - now();
        if (wait > 0) await baseSleep(wait);
      }
      try {
        return await fn();
      } finally {
        lastAt.set(host, now());
      }
    });
    chains.set(
      host,
      run.catch(() => undefined),
    );
    return run;
  }

  function tiersFrom(minTier: Tier): Tier[] {
    const available = TIERS.filter((t) => fetchers[t]);
    if (available.length === 0) throw new Error("Http has no fetch tiers configured");
    const atOrAbove = available.filter((t) => TIERS.indexOf(t) >= TIERS.indexOf(minTier));
    // A requested tier that is not available yet falls back to the highest one we have.
    return atOrAbove.length > 0 ? atOrAbove : [available[available.length - 1] as Tier];
  }

  async function fetchWithRetry(
    tier: Tier,
    request: HttpRequest,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    const fetcher = fetchers[tier] as TierFetcher;
    const { url, signal } = request;
    const host = new URL(url).hostname;
    const sleep = (ms: number) => abortable(baseSleep(ms), signal);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal?.throwIfAborted();
      let response: RawResponse;
      try {
        response = await paced(host, () =>
          fetcher({ url, headers, binary: request.binary ?? false, signal }),
        );
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (attempt < attempts) await sleep(backoffMs(attempt));
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts || detectChallenge(response)) return response;
      await sleep(retryAfterMs(response) ?? backoffMs(attempt));
    }
    throw new HttpNetworkError(url, lastError);
  }

  return {
    async get(input: HttpRequest | string): Promise<Page> {
      const request = normalizeRequest(input);
      const headers = {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": ACCEPT_LANGUAGE[request.locale ?? "cs"],
        ...lowerKeys(request.headers ?? {}),
      };
      const tiers = tiersFrom(request.minTier ?? "T0");
      let blocked: { tier: Tier; marker: string } | undefined;
      for (const tier of tiers) {
        const response = await fetchWithRetry(tier, request, headers);
        const marker = detectChallenge(response);
        if (!marker) return { ...response, tier };
        blocked = { tier, marker };
      }
      const { tier, marker } = blocked as { tier: Tier; marker: string };
      throw new HttpBlockedError(request.url, tier, marker);
    },
  };
}

function abortable(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

function retryAfterMs(response: RawResponse): number | undefined {
  const value = response.headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
