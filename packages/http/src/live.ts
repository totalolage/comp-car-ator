import {
  createTieredHttp,
  type PacingOptions,
  type RawResponse,
  type TierFetcher,
} from "./tiered.ts";
import type { Http } from "./types.ts";

export type LiveHttpOptions = PacingOptions;

/** The production Http adapter: real network, tier escalation T0 → T1 → T2. */
export function createLiveHttp(options: LiveHttpOptions = {}): Http {
  return createTieredHttp({ T0: fetchT0, T1: createT1Fetcher(), T2: createT2Fetcher() }, options);
}

/** T0: built-in fetch with browser-like headers. */
const fetchT0: TierFetcher = async ({ url, headers, binary, signal }) => {
  const response = await fetch(url, { headers, redirect: "follow", signal });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    url: response.url || url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: binary ? "" : decode(bytes, response.headers.get("content-type")),
    ...(binary ? { bytes } : {}),
  } satisfies RawResponse;
};

/** T1: TLS/HTTP2 impersonation (Impit). TODO(wave1-stream1): implement; until then T1 is skipped. */
function createT1Fetcher(): TierFetcher | undefined {
  return undefined;
}

/** T2: stealth browser (Patchright/Camoufox). TODO(wave1-stream1): implement behind an opt-in flag. */
function createT2Fetcher(): TierFetcher | undefined {
  return undefined;
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
