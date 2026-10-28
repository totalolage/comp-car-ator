/** Node-only helpers (file system). Import from "@cca/bundle/node"; never from browser code. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { type BundleFile, type BundleFiles, type Loader, upgradeBundleFiles } from "./bundle.ts";

/**
 * Replaces `dir` with exactly these files. `gzip`: store each file gzipped as `<path>.gz`, the
 * form the website serves (`fetchLoader(url, { gzip: true })`), so its deployment holds
 * compressed bytes.
 */
export async function writeBundleFiles(
  dir: string,
  files: Iterable<BundleFile>,
  { gzip = false }: { gzip?: boolean } = {},
): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const target = join(dir, gzip ? `${path}.gz` : path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, gzip ? gzipSync(text, { level: 9 }) : text);
  }
}

/** Reads a Bundle directory as `writeBundleFiles` stored it, plain or gzipped. */
export function fsLoader(dir: string): Loader {
  const read = async (path: string) => {
    try {
      return await readFile(join(dir, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return async (path) => {
    const plain = await read(path);
    if (plain) return plain.toString("utf8");
    const gzipped = await read(`${path}.gz`);
    return gzipped && gunzipSync(gzipped).toString("utf8");
  };
}

/**
 * A whole Bundle as one gzipped JSON file, the form the ingest pipeline releases it in and the
 * web build downloads (docs/adr/0014-daily-ingest-pipeline.md). Streams: files are taken from
 * `files` one at a time and compressed into `to`, so a lazy `files` (the Publisher's) is never
 * held whole. Resolves once `to` has everything; rejects, and destroys `to`, if `files` throws.
 *
 * One file per line (JSON allows the line breaks), so `unpackBundle` never needs the whole
 * document as one string: a full Bundle is larger than the longest string V8 can hold.
 */
export async function packBundle(files: Iterable<BundleFile>, to: Writable): Promise<void> {
  // Byte mode with a small buffer: a slow `to` stops the reading after about one file,
  // instead of after 16 whole files as object mode would.
  const text = Readable.from(archiveText(files), { objectMode: false, highWaterMark: 1 << 20 });
  await pipeline(text, createGzip({ level: 9 }), to);
}

const HEAD = '{"bundleArchive":1,"files":{';
const TAIL = "}}";

function* archiveText(files: Iterable<BundleFile>): Generator<string> {
  yield HEAD;
  let separator = "\n";
  for (const [path, text] of files) {
    yield `${separator}${JSON.stringify(path)}:${JSON.stringify(text)}`;
    separator = "\n,";
  }
  yield `\n${TAIL}`;
}

/**
 * Reads `packBundle`'s archive, and the single-line archives written before it streamed.
 * Returns the files in the current Bundle format: a format-2 archive (one file per model) is
 * rewritten as it is read, so staging works across the format change.
 */
export function unpackBundle(archive: Uint8Array): BundleFiles {
  const text = gunzipSync(archive);
  const files: BundleFiles = new Map();
  const firstBreak = text.indexOf(0x0a);
  if (firstBreak === -1) {
    const parsed = JSON.parse(text.toString("utf8")) as {
      bundleArchive?: number;
      files?: Record<string, string>;
    };
    if (parsed.bundleArchive !== 1 || !parsed.files) throw new Error("Not a Bundle archive");
    for (const [path, content] of Object.entries(parsed.files)) files.set(path, content);
  } else {
    if (text.toString("utf8", 0, firstBreak) !== HEAD) throw new Error("Not a Bundle archive");
    // Line 1 is HEAD, then one file per line (each after the first led by its comma), then TAIL.
    let start = firstBreak + 1;
    for (let n = 0; ; n++) {
      const end = text.indexOf(0x0a, start);
      const line = text.toString("utf8", start, end === -1 ? text.length : end);
      if (end === -1) {
        if (line !== TAIL) throw new Error("Bundle archive is truncated");
        break;
      }
      const lead = n === 0 ? "" : ",";
      if (lead && !line.startsWith(lead))
        throw new Error(`Bundle archive line ${n + 2} is malformed`);
      const entry = Object.entries(JSON.parse(`{${line.slice(lead.length)}}`) as object);
      const [path, content] = entry[0] ?? [];
      if (entry.length !== 1 || typeof path !== "string" || typeof content !== "string")
        throw new Error(`Bundle archive line ${n + 2} is malformed`);
      files.set(path, content);
      start = end + 1;
    }
  }
  for (const [path, content] of files) {
    if (
      typeof content !== "string" ||
      !/^[\w.-]+(\/[\w.-]+)*$/.test(path) ||
      path.split("/").includes("..")
    )
      throw new Error(`Bundle archive has an invalid file ${JSON.stringify(path)}`);
  }
  upgradeBundleFiles(files);
  return files;
}
