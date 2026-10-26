/** Node-only helpers (file system). Import from "@cca/bundle/node"; never from browser code. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BundleFiles, Loader } from "./bundle.ts";

/** Replaces `dir` with exactly these files. */
export async function writeBundleFiles(dir: string, files: BundleFiles): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

export function fsLoader(dir: string): Loader {
  return async (path) => {
    try {
      return await readFile(join(dir, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
}

/**
 * A whole Bundle as one gzipped JSON file, the form the ingest pipeline releases it in and the
 * web build downloads (docs/adr/0014-daily-ingest-pipeline.md).
 */
export function packBundle(files: BundleFiles): Uint8Array {
  return gzipSync(JSON.stringify({ bundleArchive: 1, files: Object.fromEntries(files) }), {
    level: 9,
  });
}

export function unpackBundle(archive: Uint8Array): BundleFiles {
  const parsed = JSON.parse(gunzipSync(archive).toString("utf8")) as {
    bundleArchive?: number;
    files?: Record<string, string>;
  };
  if (parsed.bundleArchive !== 1 || !parsed.files) throw new Error("Not a Bundle archive");
  const files: BundleFiles = new Map(Object.entries(parsed.files));
  for (const [path, text] of files) {
    if (
      typeof text !== "string" ||
      !/^[\w.-]+(\/[\w.-]+)*$/.test(path) ||
      path.split("/").includes("..")
    )
      throw new Error(`Bundle archive has an invalid file ${JSON.stringify(path)}`);
  }
  return files;
}
