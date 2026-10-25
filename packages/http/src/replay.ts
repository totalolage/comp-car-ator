import { readFile, writeFile } from "node:fs/promises";
import { detectChallenge } from "./challenge.ts";
import { chunksOf, relayChunks, streams } from "./chunks.ts";
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
      const { url, signal, binary, stream } = normalizeRequest(input);
      signal?.throwIfAborted();
      const key = matchKey(url);
      const candidates = byUrl.get(key);
      if (!candidates) throw new ReplayMissError(url);
      const index = Math.min(served.get(key) ?? 0, candidates.length - 1);
      served.set(key, index + 1);
      const { response } = candidates[index] as Interaction;
      const marker = detectChallenge(response);
      if (marker) throw new HttpBlockedError(url, response.tier, marker);
      const page = toPage(response, binary ?? false);
      if (stream) {
        // As live: a streamed body has no text, and arrives in 64 KiB pieces.
        const { body, bodyBase64 } = response;
        const bytes = Buffer.from(bodyBase64 ?? body, bodyBase64 !== undefined ? "base64" : "utf8");
        if (streams(response.status, response.headers["content-type"])) page.body = "";
        page.chunks = relayChunks(chunksOf(new Uint8Array(bytes)), signal);
      }
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
        const interaction = toInteraction(request.url, page);
        interactions.push(interaction);
        if (!page.chunks) return page;
        // A streamed body lands in the cassette when the consumer finishes or stops reading,
        // as far as it read; it is held in memory meanwhile, so record small fixtures only.
        const read: Uint8Array[] = [];
        const chunks = relayChunks(page.chunks, undefined, {
          chunk: (chunk) => read.push(chunk),
          end: () => {
            interaction.response.body = "";
            interaction.response.bodyBase64 = Buffer.concat(read).toString("base64");
          },
        });
        return { ...page, chunks };
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

/** Stores a Page as an Interaction (also the raw response cache's entry format). */
export function toInteraction(url: string, page: Page): Interaction {
  // Cookies are session state, not fixture data; keep them out of committed cassettes.
  const { "set-cookie": _cookie, ...headers } = page.headers;
  const { bytes, chunks: _chunks, ...rest } = page;
  return {
    request: { url },
    response: {
      ...rest,
      headers,
      ...(bytes ? { bodyBase64: Buffer.from(bytes).toString("base64") } : {}),
    },
  };
}

/** Serves a stored response in the mode the request asks for, as the live adapter would. */
export function toPage(response: Interaction["response"], binary: boolean): Page {
  const { bodyBase64, ...rest } = response;
  const raw = bodyBase64 !== undefined ? Buffer.from(bodyBase64, "base64") : undefined;
  const page: Page = { ...rest };
  if (binary) page.bytes = new Uint8Array(raw ?? Buffer.from(rest.body, "utf8"));
  else if (raw) page.body = raw.toString("utf8");
  return page;
}

/** URL identity for matching: query parameter order and fragment ignored. */
export function matchKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  parsed.hash = "";
  return parsed.toString();
}
