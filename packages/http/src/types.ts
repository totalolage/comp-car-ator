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
   * Minimum spacing before this request after the previous request to its host, ms. Raises the
   * Http's configured host interval for this request; never lowers it. Lets a Source slow down
   * for a site that wants it without runner configuration.
   */
  hostIntervalMs?: number;
  /**
   * Deliver the body as `Page.chunks` instead of buffering it, for downloads too large for
   * memory (the vehicle register CSV). Retries, escalation and challenge detection happen on
   * the status and headers, before the first byte. At T0 the live adapter's timeout then
   * limits the wait for the headers and for each chunk, not the whole download; T1 and T2
   * cannot stream, so they read the body in full under the timeout (T1 up to 256 MiB) and
   * serve it as chunks. Streamed responses are never cached.
   */
  stream?: boolean;
  /**
   * Aborts in-flight fetches, pacing and backoff waits; `get` then rejects with the abort reason.
   * A request still queued for its host's pacing slot rejects at once and frees its place.
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
  /**
   * Raw bytes, present only when the request asked for `binary`; with `stream` too, only when
   * the body was read in full (`chunks` always has it).
   */
  bytes?: Uint8Array;
  /**
   * The raw body, present only when the request asked for `stream`; iterate it once. A 2xx
   * response that is not HTML streams from the network (`body` is ""); any other response
   * was read in full for challenge detection, so `body` has its text and `chunks` replays it.
   * Aborting the request's signal stops the iteration with the abort reason. Read it to the end
   * or stop it (`break` in `for await`, or its iterator's `return()`): a stream left unread
   * holds its connection open until the request's signal aborts.
   */
  chunks?: AsyncIterable<Uint8Array>;
  tier: Tier;
}

/**
 * The Http module's interface. `get` resolves with a Page for every final status after
 * internal retries (429/5xx, network errors, pacing). It rejects with:
 * - HttpBlockedError: a bot challenge persisted through the highest available tier, or the
 *   host already blocked several requests in a row (the Http stops asking it for this run);
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
  /** Which protection answered (`cloudflare`, `akamai`, …), from challenge detection. */
  readonly marker: string;
  constructor(url: string, tier: Tier, marker: string, detail?: string) {
    super(`Blocked by bot protection at ${tier} (${marker})${detail ? `; ${detail}` : ""}: ${url}`);
    this.name = "HttpBlockedError";
    this.url = url;
    this.tier = tier;
    this.marker = marker;
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
