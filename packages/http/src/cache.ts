import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Interaction, matchKey, toInteraction, toPage } from "./replay.ts";
import { type Http, type HttpRequest, normalizeRequest, type Page } from "./types.ts";

export interface CacheOptions {
  /** Directory for cache entries, one JSON file per request. Created on first write. */
  dir: string;
  /** Entries older than this are fetched again and overwritten, ms. Default: no expiry. */
  maxAgeMs?: number;
}

/**
 * One cache file. `interaction` has the cassette's Interaction shape, so an entry can be copied
 * into a cassette when recording fixtures.
 */
interface CacheEntry {
  version: 1;
  storedAt: string;
  key: string;
  interaction: Interaction;
}

/**
 * The raw response cache: serves a stored Page for a request it has seen, without pacing or
 * network. A request is identified by its URL (query order ignored), `binary`, locale, headers
 * and `minTier` (a T2 request wants the rendered page, not a cached T0 one).
 * Final Pages are stored except 429 and 5xx; errors are never stored.
 */
export function createCachedHttp(
  inner: Http,
  options: CacheOptions & { now?: () => number },
): Http {
  const now = options.now ?? Date.now;

  async function lookup(key: string, file: string, binary: boolean): Promise<Page | undefined> {
    let entry: CacheEntry;
    try {
      entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry;
    } catch {
      return undefined; // missing or unreadable: a miss
    }
    if (entry.version !== 1 || entry.key !== key) return undefined;
    const age = now() - Date.parse(entry.storedAt);
    if (options.maxAgeMs !== undefined && !(age <= options.maxAgeMs)) return undefined;
    return toPage(entry.interaction.response, binary);
  }

  async function store(key: string, file: string, request: HttpRequest, page: Page) {
    const entry: CacheEntry = {
      version: 1,
      storedAt: new Date(now()).toISOString(),
      key,
      interaction: toInteraction(request.url, page),
    };
    await mkdir(options.dir, { recursive: true });
    // Write then rename, so a crash never leaves a half-written entry behind.
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, `${JSON.stringify(entry)}\n`);
    await rename(temp, file);
  }

  return {
    async get(input) {
      const request = normalizeRequest(input);
      request.signal?.throwIfAborted();
      const key = cacheKey(request);
      const file = join(options.dir, `${createHash("sha256").update(key).digest("hex")}.json`);
      const cached = await lookup(key, file, request.binary ?? false);
      if (cached) return cached;
      const page = await inner.get(request);
      if (page.status !== 429 && page.status < 500) await store(key, file, request, page);
      return page;
    },
  };
}

function cacheKey(request: HttpRequest): string {
  const headers = Object.entries(request.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value])
    .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
  return JSON.stringify([
    matchKey(request.url),
    request.binary ?? false,
    request.locale ?? "cs",
    request.minTier ?? "T0",
    headers,
  ]);
}
