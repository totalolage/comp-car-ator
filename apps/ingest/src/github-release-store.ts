/** The ReleaseStore adapter for GitHub Releases (REST API, token auth). */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { type Logger, silentLogger } from "@cca/sources";
import type { ReleaseStore } from "./release-store.ts";

export interface GithubReleaseStoreOptions {
  /** `owner/name` */
  repo: string;
  /** Needs Contents: read and write on the repo. */
  token: string;
  /** The store sees, cleans up and deletes only releases whose tag starts with this. */
  tagPrefix: string;
  /** Default https://api.github.com; tests point it at a fake. */
  apiUrl?: string;
  /** Draft ids, upload timings and retries. */
  log?: Logger;
  /** Wait before an upload's second attempt, twice as long before its third. Default 10 s. */
  retryDelayMs?: number;
}

/** Tries per asset. A day's release carries the whole day's harvest, so one bad answer from
 *  GitHub must not lose it; a failure that survives three tries is not a blip. */
const UPLOAD_ATTEMPTS = 3;

/** GitHub answered with an error status. */
class GithubError extends Error {
  status: number;
  /** Retry-After in milliseconds, when GitHub sent one. */
  retryAfterMs: number | null;
  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Whether a failed upload may be tried again: no answer at all (the connection broke), or a
 * status GitHub gives transiently. A 404 is among them because the uploads host has answered it
 * for a draft the API had just created (run 41769699218); the caller retries only after the API
 * confirms the draft is still there, so a deleted release is never retried.
 */
function transient(error: unknown): boolean {
  if (!(error instanceof GithubError)) return true;
  const { status } = error;
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

interface GithubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  upload_url: string;
  assets: { id: number; name: string }[];
}

export function githubReleaseStore(options: GithubReleaseStoreOptions): ReleaseStore {
  const api = `${options.apiUrl ?? "https://api.github.com"}/repos/${options.repo}`;
  const log = options.log ?? silentLogger;
  const retryDelayMs = options.retryDelayMs ?? 10_000;
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "car-db-ingest",
  };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${api}${path}`;
    const method = init.method ?? "GET";
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
      // A 404 on a read or delete is an answer ("not there"); on a write it is a failure.
      if (response.ok || (response.status === 404 && (method === "GET" || method === "DELETE")))
        return response;
      // Only GETs are retried here: an upload is retried by `upload`, which first checks the
      // draft and clears a partial asset; a create is cleaned up by the caller instead.
      if (method === "GET" && response.status >= 500 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      const requestId = response.headers.get("x-github-request-id");
      const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
      throw new GithubError(
        `GitHub ${method} ${url}: ${response.status} ${await response.text()}${requestId ? ` (request ${requestId})` : ""}`,
        response.status,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
      );
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await call(path, init);
    if (response.status === 404) throw new Error(`GitHub ${path}: 404`);
    return (await response.json()) as T;
  }

  /** This store's releases (tag prefix), drafts included, across every page. */
  async function releases(): Promise<GithubRelease[]> {
    const all: GithubRelease[] = [];
    let next: string | null = "/releases?per_page=100";
    while (next) {
      const response = await call(next);
      if (!response.ok) throw new Error(`GitHub ${next}: ${response.status}`);
      all.push(...((await response.json()) as GithubRelease[]));
      next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return all.filter((r) => r.tag_name.startsWith(options.tagPrefix));
  }

  /** A published release by tag. */
  async function byTag(tag: string): Promise<GithubRelease | undefined> {
    const response = await call(`/releases/tags/${encodeURIComponent(tag)}`);
    return response.status === 404 ? undefined : ((await response.json()) as GithubRelease);
  }

  async function remove(release: GithubRelease): Promise<void> {
    await call(`/releases/${release.id}`, { method: "DELETE" });
    // A draft has no tag yet; deleting a missing ref answers 404 or 422, both fine.
    if (!release.draft)
      await fetch(`${api}/git/refs/tags/${encodeURIComponent(release.tag_name)}`, {
        method: "DELETE",
        headers,
      });
  }

  /**
   * Uploads one asset to a draft, trying again while the failure looks transient and the draft
   * is still a draft. Before another try it removes any asset of the same name the failed one
   * left (an empty "starter" asset, or a whole one whose answer was lost), which would otherwise
   * make GitHub refuse the name.
   */
  async function upload(release: GithubRelease, file: { name: string; path: string }) {
    const { size } = await stat(file.path);
    const url = `${release.upload_url.replace(/\{.*\}$/, "")}?name=${encodeURIComponent(file.name)}`;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const body = createReadStream(file.path);
      try {
        await call(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "content-length": String(size) },
          body: Readable.toWeb(body) as unknown as BodyInit,
          duplex: "half",
        } as RequestInit);
        log.info(`uploaded ${file.name} to draft ${release.id}`, {
          bytes: size,
          seconds: Math.round((Date.now() - started) / 1000),
          attempt,
        });
        return;
      } catch (error) {
        // GitHub may answer before it has read the whole body; stop sending this attempt's.
        body.destroy();
        if (attempt >= UPLOAD_ATTEMPTS || !transient(error)) throw error;
        const wait = Math.max(
          retryDelayMs * attempt,
          error instanceof GithubError ? (error.retryAfterMs ?? 0) : 0,
        );
        log.warn(`upload of ${file.name} to draft ${release.id} failed; trying again`, {
          error: String(error),
          attempt,
          waitSeconds: wait / 1000,
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
        const state = await call(`/releases/${release.id}`).catch(() => null);
        const current = state?.ok ? ((await state.json()) as GithubRelease) : null;
        if (!current?.draft) throw error;
        for (const left of current.assets.filter((a) => a.name === file.name))
          await call(`/releases/assets/${left.id}`, { method: "DELETE" });
      }
    }
  }

  return {
    async list() {
      return (await releases())
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({ tag: r.tag_name, assets: r.assets.map((a) => a.name).sort() }))
        .sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
    },

    async download(tag, asset, to) {
      const release = await byTag(tag);
      const found = release?.draft ? undefined : release?.assets.find((a) => a.name === asset);
      if (!found) throw new Error(`Release ${tag} has no asset ${asset}`);
      const response = await call(`/releases/assets/${found.id}`, {
        headers: { accept: "application/octet-stream" },
      });
      if (!response.ok || !response.body) throw new Error(`Download of ${tag}/${asset} failed`);
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(to),
      );
    },

    async create(tag, files, notes = "") {
      for (const stale of await releases()) {
        if (stale.draft) await remove(stale);
      }
      const release = await json<GithubRelease>("/releases", {
        method: "POST",
        body: JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: true }),
      });
      log.info(`created draft ${release.id} for ${tag}`);
      let publishing = false;
      try {
        for (const file of files) await upload(release, file);
        publishing = true;
        await call(`/releases/${release.id}`, {
          method: "PATCH",
          body: JSON.stringify({ draft: false, make_latest: "true" }),
        });
      } catch (error) {
        // The publishing PATCH may have gone through with its response lost. A release that PATCH
        // published is complete (publishing is the last step): keep it. One published before this
        // call got that far was not published by it: keep it, but fail. Delete the release only
        // when it is known to be a draft; when its state is unknown, the next create cleans it up
        // if it is.
        const state = await call(`/releases/${release.id}`).catch(() => null);
        const current = state?.ok ? ((await state.json()) as GithubRelease) : null;
        if (current && !current.draft) {
          if (publishing) return;
          throw error;
        }
        if (current) await remove(current).catch(() => {});
        throw error;
      }
    },

    async delete(tag) {
      const release = await byTag(tag);
      if (release) await remove(release);
    },
  };
}
