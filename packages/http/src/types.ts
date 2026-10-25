/**
 * Fetch tier (docs/adr/0005-fetch-tiers.md). Callers see which tier served a Page and may
 * ask for a minimum; escalation between tiers is hidden.
 */
export type Tier = "T0" | "T1" | "T2";

export const TIERS: readonly Tier[] = ["T0", "T1", "T2"];

export interface HttpRequest {
  url: string;
  /** Extra headers; browser-like defaults (User-Agent, Accept, Accept-Language) are added. */
  headers?: Record<string, string>;
  /** Start at this tier instead of T0 (e.g. a source known to need impersonation). */
  minTier?: Tier;
  /** Accept-Language flavour. Default "cs". */
  locale?: "cs" | "de" | "en";
  /** Return the raw bytes in `Page.bytes` (PDF price lists, ZIP datasets). */
  binary?: boolean;
  /**
   * Aborts in-flight fetches and backoff waits; `get` then rejects with the abort reason. A
   * request still queued for its host's pacing slot rejects when the slot comes, without fetching.
   */
  signal?: AbortSignal;
}

/** A fetched document. Any final HTTP status is a Page; callers decide what 404 means. */
export interface Page {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /**
   * Decoded text (charset from Content-Type, default UTF-8). For binary requests it is "" unless
   * the server answered with a text type (a challenge or error page).
   */
  body: string;
  /** Raw bytes, present only when the request asked for `binary`. */
  bytes?: Uint8Array;
  tier: Tier;
}

/**
 * The Http module's interface. `get` resolves with a Page for every final status after
 * internal retries (429/5xx, network errors, pacing). It rejects with:
 * - HttpBlockedError: a bot challenge persisted through the highest available tier;
 * - HttpNetworkError: the host stayed unreachable after retries;
 * - ReplayMissError: (replay adapter only) the request is not in the cassette.
 * Requests to one host are serialized and paced; different hosts run concurrently.
 */
export interface Http {
  get(request: HttpRequest | string): Promise<Page>;
}

export class HttpBlockedError extends Error {
  readonly url: string;
  readonly tier: Tier;
  constructor(url: string, tier: Tier, marker: string) {
    super(`Blocked by bot protection at ${tier} (${marker}): ${url}`);
    this.name = "HttpBlockedError";
    this.url = url;
    this.tier = tier;
  }
}

export class HttpNetworkError extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`Network failure after retries: ${url}`, { cause });
    this.name = "HttpNetworkError";
    this.url = url;
  }
}

export class ReplayMissError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`No recorded interaction for ${url}; re-record the cassette (see AGENTS.md)`);
    this.name = "ReplayMissError";
    this.url = url;
  }
}

export function normalizeRequest(request: HttpRequest | string): HttpRequest {
  return typeof request === "string" ? { url: request } : request;
}
