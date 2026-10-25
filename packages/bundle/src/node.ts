/** Node-only helpers (file system). Import from "@cca/bundle/node"; never from browser code. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
