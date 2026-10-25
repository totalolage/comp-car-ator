/** The ReleaseStore adapter for GitHub Releases (REST API, token auth). */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { ReleaseStore } from "./release-store.ts";

export interface GithubReleaseStoreOptions {
  /** `owner/name` */
  repo: string;
  /** Needs Contents: read and write on the repo. */
  token: string;
  /** Default https://api.github.com; tests point it at a fake. */
  apiUrl?: string;
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
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "comp-car-ator-ingest",
  };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${api}${path}`;
    const method = init.method ?? "GET";
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
      // A 404 on a read or delete is an answer ("not there"); on a write it is a failure.
      if (response.ok || (response.status === 404 && (method === "GET" || method === "DELETE")))
        return response;
      // Only GETs are retried: a half-done upload or create is cleaned up by the caller instead.
      if (method === "GET" && response.status >= 500 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      throw new Error(`GitHub ${method} ${url}: ${response.status} ${await response.text()}`);
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await call(path, init);
    if (response.status === 404) throw new Error(`GitHub ${path}: 404`);
    return (await response.json()) as T;
  }

  async function releases(): Promise<GithubRelease[]> {
    return json<GithubRelease[]>("/releases?per_page=100");
  }

  async function byTag(tag: string): Promise<GithubRelease | undefined> {
    return (await releases()).find((r) => r.tag_name === tag);
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
      try {
        const uploadUrl = release.upload_url.replace(/\{.*\}$/, "");
        for (const file of files) {
          const { size } = await stat(file.path);
          await call(`${uploadUrl}?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", "content-length": String(size) },
            body: Readable.toWeb(createReadStream(file.path)) as unknown as BodyInit,
            duplex: "half",
          } as RequestInit);
        }
        await call(`/releases/${release.id}`, {
          method: "PATCH",
          body: JSON.stringify({ draft: false, make_latest: "true" }),
        });
      } catch (error) {
        // The publishing PATCH may have gone through with its response lost: a published
        // release is complete (publishing is the last step), so keep it; delete a draft.
        const now = await byTag(tag).catch(() => undefined);
        if (now && !now.draft) return;
        await remove({ ...release, draft: true }).catch(() => {});
        throw error;
      }
    },

    async delete(tag) {
      const release = await byTag(tag);
      if (release) await remove(release);
    },
  };
}
