import { readFile, writeFile } from "node:fs/promises";
import { detectChallenge } from "./challenge.ts";
import {
  type Http,
  HttpBlockedError,
  normalizeRequest,
  type Page,
  ReplayMissError,
  type Tier,
} from "./types.ts";

/** One recorded request/response pair. */
export interface Interaction {
  request: { url: string };
  response: {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    /** Binary responses (requests with `binary`) are stored base64-encoded; `body` is then "". */
    bodyBase64?: string;
    tier: Tier;
  };
}

/** A recorded set of interactions, stored as `*.cassette.json` next to the tests that replay it. */
export interface Cassette {
  version: 1;
  interactions: Interaction[];
}

/**
 * The test Http adapter. Serves recorded responses matched on the URL (query parameter
 * order ignored). Repeated requests for one URL get the recorded responses in order, then
 * the last one again. A recorded bot challenge rejects with HttpBlockedError, as the live
 * adapter would after exhausting its tiers.
 */
export function createReplayHttp(cassette: Cassette): Http {
  const byUrl = new Map<string, Interaction[]>();
  for (const interaction of cassette.interactions) {
    const key = matchKey(interaction.request.url);
    byUrl.set(key, [...(byUrl.get(key) ?? []), interaction]);
  }
  const served = new Map<string, number>();
  return {
    async get(input) {
      const { url, signal, binary } = normalizeRequest(input);
      signal?.throwIfAborted();
      const key = matchKey(url);
      const candidates = byUrl.get(key);
      if (!candidates) throw new ReplayMissError(url);
      const index = Math.min(served.get(key) ?? 0, candidates.length - 1);
      served.set(key, index + 1);
      const { bodyBase64, ...response } = (candidates[index] as Interaction).response;
      const marker = detectChallenge(response);
      if (marker) throw new HttpBlockedError(url, response.tier, marker);
      // Serve in the mode the request asks for, as the live adapter would.
      const raw = bodyBase64 !== undefined ? Buffer.from(bodyBase64, "base64") : undefined;
      const page: Page = { ...response };
      if (binary) page.bytes = new Uint8Array(raw ?? Buffer.from(response.body, "utf8"));
      else if (raw) page.body = raw.toString("utf8");
      return page;
    },
  };
}

/** Wraps an Http and remembers every interaction, for recording fixtures from the live adapter. */
export function recordingHttp(inner: Http): { http: Http; cassette(): Cassette } {
  const interactions: Interaction[] = [];
  return {
    http: {
      async get(input) {
        const request = normalizeRequest(input);
        const page = await inner.get(request);
        // Cookies are session state, not fixture data; keep them out of committed cassettes.
        const { "set-cookie": _cookie, ...headers } = page.headers;
        const { bytes, ...rest } = page;
        interactions.push({
          request: { url: request.url },
          response: {
            ...rest,
            headers,
            ...(bytes ? { bodyBase64: Buffer.from(bytes).toString("base64") } : {}),
          },
        });
        return page;
      },
    },
    cassette: () => ({ version: 1, interactions: [...interactions] }),
  };
}

export async function loadCassette(path: string | URL): Promise<Cassette> {
  const cassette = JSON.parse(await readFile(path, "utf8")) as Cassette;
  if (cassette.version !== 1) throw new Error(`Unsupported cassette version in ${path}`);
  return cassette;
}

export async function saveCassette(path: string | URL, cassette: Cassette): Promise<void> {
  await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`);
}

function matchKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  parsed.hash = "";
  return parsed.toString();
}
