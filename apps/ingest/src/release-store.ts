/**
 * Where data releases (Ledger + Bundle + manifest, ADR 0014) live between ingest runs. Two
 * adapters: GitHub Releases of the private ingest repo (the ingest workflow) and a local directory
 * (local runs and tests).
 */
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { githubReleaseStore } from "./github-release-store.ts";

export interface ReleaseStore {
  /** Published releases, newest first. Unfinished ones are never listed. */
  list(): Promise<{ tag: string; assets: string[] }[]>;
  /** Writes one asset of a published release to a file. */
  download(tag: string, asset: string, to: string): Promise<void>;
  /**
   * Publishes a release with these files as its assets and makes it the latest. Either every
   * file is up and the release is listed, or the call rejects and nothing new is listed.
   * Unfinished releases left by a crashed earlier call are cleaned up first.
   */
  create(tag: string, files: { name: string; path: string }[], notes?: string): Promise<void>;
  /** Deletes a release (and, on GitHub, its tag). */
  delete(tag: string): Promise<void>;
}

/**
 * Releases as directories under `root`: `<root>/<tag>/<asset>`. A release is written under a
 * `.draft-` name and renamed into place, which is atomic on one file system.
 */
export function localReleaseStore(root: string): ReleaseStore {
  const DRAFT = ".draft-";
  return {
    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const tags = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(DRAFT))
        .map((e) => e.name)
        .sort()
        .reverse();
      return Promise.all(
        tags.map(async (tag) => ({ tag, assets: (await readdir(join(root, tag))).sort() })),
      );
    },
    async download(tag, asset, to) {
      await cp(join(root, tag, asset), to);
    },
    async create(tag, files) {
      await mkdir(root, { recursive: true });
      for (const entry of await readdir(root)) {
        if (entry.startsWith(DRAFT)) await rm(join(root, entry), { recursive: true, force: true });
      }
      const draft = join(root, `${DRAFT}${tag}`);
      await mkdir(draft);
      try {
        for (const file of files) await cp(file.path, join(draft, basename(file.name)));
        await rename(draft, join(root, tag));
      } catch (error) {
        await rm(draft, { recursive: true, force: true });
        throw error;
      }
    },
    async delete(tag) {
      await rm(join(root, tag), { recursive: true, force: true });
    },
  };
}

/**
 * `github:<owner>/<repo>` (token from GITHUB_TOKEN; only releases tagged `tagPrefix…`) or a
 * directory path.
 */
export function releaseStoreFrom(spec: string, tagPrefix: string, env = process.env): ReleaseStore {
  if (!spec.startsWith("github:")) return localReleaseStore(spec);
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error(`${spec} needs GITHUB_TOKEN`);
  return githubReleaseStore({ repo: spec.slice("github:".length), token, tagPrefix });
}
