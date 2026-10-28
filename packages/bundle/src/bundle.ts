import type { ModelId } from "@cca/vocabulary";
import { decodeTable, encodeTable, type Table } from "./columns.ts";
import {
  BUNDLE_FORMAT,
  type BundleContent,
  type BundleManifest,
  type CatalogIndex,
  type ListingEntry,
  type ListingRow,
  type ModelFile,
} from "./format.ts";

/** Bundle files by relative path ("manifest.json", "models/skoda/octavia/index.json"). */
export type BundleFiles = Map<string, string>;

/** One Bundle file: relative path and text. */
export type BundleFile = readonly [path: string, text: string];

/**
 * Where the reader gets file text from: the Loader seam (fetch in the browser, the file
 * system at build time and in Node, memory in tests). Resolves with the file's text, or
 * null when the file does not exist; rejects on any other failure.
 */
export type Loader = (path: string) => Promise<string | null>;

export class BundleFormatError extends Error {
  override name = "BundleFormatError";
}

/** The Bundle was replaced while a reader had it open (a new deploy); open it again. */
export class BundleChangedError extends Error {
  override name = "BundleChangedError";
}

const MANIFEST = "manifest.json";
const CATALOG = "catalog.json";
/** Full Listing rows per file: a page of the listing table touches a few files, not the model's thousands of rows. */
const ROWS_PER_FILE = 32;

/** A model's listing index; its rows are `models/<id>/<n>.json`, ROWS_PER_FILE each. */
function indexPath(id: ModelId): string {
  return `models/${id}/index.json`;
}

function rowsPath(id: ModelId, n: number): string {
  return `models/${id}/${n}.json`;
}

/**
 * How the long row lists sit in the files: as columnar Tables (./columns.ts), which keeps a
 * 50k-Variant catalog at a few MB. The reader turns them back into the decoded documents.
 * A model is split in two: its index (everything but the Listings' display fields, so a model
 * page can filter, sort and count from one small file) and its full rows in files of
 * `rowsPerFile`, in index order.
 */
type EncodedCatalog = Omit<CatalogIndex, "variants"> & { variants: Table };
type EncodedModelIndex = Omit<ModelFile, "listings" | "stats"> & {
  listings: Table;
  stats: Table;
  rowsPerFile: number;
  /** A hash of which Listing sits at which position with which entry; its rows files carry it too. */
  stamp: string;
};
type EncodedRows = { stamp: string; listings: Table };

/** A model as the reader returns it: the model file with its Listings as index entries. */
export interface ModelIndex extends Omit<ModelFile, "listings"> {
  /** Every Listing of the model file: active ones first, cheapest landed price first. */
  listings: ListingEntry[];
  /**
   * The full rows of entries from `listings`, in the given order. Loads only the files those
   * rows sit in, each once. Rejects for an entry that is not from this index, and with
   * `BundleChangedError` when a rows file belongs to a newer Bundle than the index.
   */
  rows(entries: readonly ListingEntry[]): Promise<ListingRow[]>;
}

/** Writer: encodes decoded documents into Bundle files. Pure; persisting them is the caller's job. */
export function encodeBundle(content: BundleContent): BundleFiles {
  return new Map(encodeBundleFiles(content.models, () => content));
}

/**
 * Streaming writer, for Bundles too large to hold decoded at once: encodes each model's files
 * as `models` yields it, then the catalog and manifest, which `index` returns once every model
 * is through (they summarise the models). Lazy: nothing is read before the first file is
 * asked for. Same files as `encodeBundle`.
 */
export function* encodeBundleFiles(
  models: Iterable<ModelFile>,
  index: () => Omit<BundleContent, "models">,
): Generator<BundleFile> {
  for (const model of models) yield* encodeModel(model);
  const { manifest, catalog } = index();
  const { variants, ...rest } = catalog;
  yield [CATALOG, json({ ...rest, variants: encodeTable(variants) } satisfies EncodedCatalog)];
  yield [MANIFEST, json(manifest)];
}

function* encodeModel({ listings, stats, ...model }: ModelFile): Generator<BundleFile> {
  // Active and kept first, then cheapest (stable, so ties keep the model file's id order): a
  // model page opens on its cheapest active Listings, which then share the first rows file.
  const rows = [...listings].sort((a, b) => rank(a) - rank(b) || cheapness(a) - cheapness(b));
  // A page left open across a deploy holds the old index; a rows file of the new one could put
  // other Listings, or other prices, at its positions. The stamp lets the reader notice.
  const entries = encodeTable(rows.map(entry));
  const stamp = fnv1a(`${rows.map((l) => l.id).join("\n")}\n${JSON.stringify(entries)}`);
  const encoded: EncodedModelIndex = {
    ...model,
    listings: entries,
    stats: encodeTable(stats),
    rowsPerFile: ROWS_PER_FILE,
    stamp,
  };
  const id = model.model.id;
  yield [indexPath(id), json(encoded)];
  for (let n = 0; n * ROWS_PER_FILE < rows.length; n++) {
    const part = rows.slice(n * ROWS_PER_FILE, (n + 1) * ROWS_PER_FILE);
    yield [rowsPath(id, n), json({ stamp, listings: encodeTable(part) } satisfies EncodedRows)];
  }
}

/** 32-bit FNV-1a of the UTF-16 code units, as 8 hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function rank(l: ListingRow): number {
  return (l.gone ? 2 : 0) + (l.excluded ? 1 : 0);
}

function cheapness(l: ListingRow): number {
  return l.landed?.totalCzk ?? l.priceCzk;
}

function entry(l: ListingRow): ListingEntry {
  const e: ListingEntry = {
    variantId: l.variantId,
    market: l.market,
    source: l.source,
    condition: l.condition,
    year: l.year,
    odometerKm: l.odometerKm,
    body: l.body,
    fuel: l.fuel,
    powerKw: l.powerKw,
    transmission: l.transmission,
    priceCzk: l.priceCzk,
    landedCzk: l.landed?.totalCzk,
    firstSeen: l.firstSeen,
    gone: l.gone,
    daysOnMarket: l.daysOnMarket,
    excluded: l.excluded,
  };
  // Absent stays absent (the codec stores no undefined).
  for (const key of Object.keys(e) as (keyof ListingEntry)[])
    if (e[key] === undefined) delete e[key];
  return e;
}

export interface BundleReader {
  readonly manifest: BundleManifest;
  /** Loaded once, then cached. */
  catalog(): Promise<CatalogIndex>;
  /** Null for an unknown model. Cached per model. */
  model(id: ModelId): Promise<ModelIndex | null>;
}

/**
 * Reader: opens a Bundle through a Loader. Rejects with BundleFormatError when the manifest
 * is missing or was written in a format this reader does not understand.
 */
export async function openBundle(loader: Loader): Promise<BundleReader> {
  const manifestText = await loader(MANIFEST);
  if (manifestText === null) throw new BundleFormatError("Bundle has no manifest.json");
  const manifest = JSON.parse(manifestText) as BundleManifest;
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new BundleFormatError(
      `Bundle format ${String(manifest.format)} is not readable (reader is format ${BUNDLE_FORMAT})`,
    );
  }
  let catalog: Promise<CatalogIndex> | undefined;
  const models = new Map<ModelId, Promise<ModelIndex | null>>();
  return {
    manifest,
    catalog() {
      catalog ??= loader(CATALOG).then((text) => {
        if (text === null) throw new BundleFormatError("Bundle has no catalog.json");
        const { variants, ...rest } = JSON.parse(text) as EncodedCatalog;
        return { ...rest, variants: decodeTable(variants) };
      });
      return catalog;
    },
    model(id) {
      let model = models.get(id);
      if (!model) {
        model = loader(indexPath(id)).then((text) =>
          text === null ? null : readModel(id, JSON.parse(text) as EncodedModelIndex, loader),
        );
        // A failed load is not cached, so the next call retries.
        model.catch(() => models.delete(id));
        models.set(id, model);
      }
      return model;
    },
  };
}

function readModel(id: ModelId, encoded: EncodedModelIndex, loader: Loader): ModelIndex {
  const { listings, stats, rowsPerFile, stamp, ...rest } = encoded;
  const entries = decodeTable<ListingEntry>(listings);
  const position = new Map(entries.map((e, i) => [e, i]));
  const files = new Map<number, Promise<ListingRow[]>>();
  const file = (n: number) => {
    let rows = files.get(n);
    if (!rows) {
      rows = loader(rowsPath(id, n)).then((text) => {
        if (text === null) throw new BundleFormatError(`Bundle has no ${rowsPath(id, n)}`);
        const file = JSON.parse(text) as EncodedRows;
        if (file.stamp !== stamp)
          throw new BundleChangedError(`${rowsPath(id, n)} is from another Bundle than its index`);
        return decodeTable<ListingRow>(file.listings);
      });
      rows.catch(() => files.delete(n));
      files.set(n, rows);
    }
    return rows;
  };
  return {
    ...rest,
    stats: decodeTable(stats),
    listings: entries,
    async rows(wanted) {
      const at = wanted.map((e) => {
        const i = position.get(e);
        if (i === undefined) throw new Error(`Listing entry is not from ${id}'s index`);
        return i;
      });
      const loaded = new Map<number, ListingRow[]>();
      await Promise.all(
        [...new Set(at.map((i) => Math.floor(i / rowsPerFile)))].map(async (n) => {
          loaded.set(n, await file(n));
        }),
      );
      return at.map(
        (i) => loaded.get(Math.floor(i / rowsPerFile))?.[i % rowsPerFile] as ListingRow,
      );
    },
  };
}

/**
 * Rewrites a format-2 Bundle's files (one file per model) into the current format, in place;
 * leaves any other Bundle alone. Only `unpackBundle` uses it, so the web build can stage a
 * Data release published before format 3.
 * TODO(page-weight): delete once the newest Data release is format 3.
 */
export function upgradeBundleFiles(files: BundleFiles): void {
  const manifestText = files.get(MANIFEST);
  if (manifestText === undefined) return;
  const manifest = JSON.parse(manifestText) as Omit<BundleManifest, "format"> & { format: number };
  if (manifest.format !== 2) return;
  for (const [path, text] of [...files]) {
    if (!/^models\/.+\.json$/.test(path)) continue;
    files.delete(path);
    const { listings, stats, ...rest } = JSON.parse(text) as Omit<
      ModelFile,
      "listings" | "stats"
    > & {
      listings: Table;
      stats: Table;
    };
    for (const [p, t] of encodeModel({
      ...rest,
      listings: decodeTable(listings),
      stats: decodeTable(stats),
    }))
      files.set(p, t);
  }
  files.set(MANIFEST, json({ ...manifest, format: BUNDLE_FORMAT }));
}

/** Loader over in-memory files, e.g. straight from `encodeBundle` in tests. */
export function memoryLoader(files: Iterable<BundleFile>): Loader {
  const byPath = new Map(files);
  return async (path) => byPath.get(path) ?? null;
}

/**
 * Loader over HTTP, relative to `baseUrl`. 404 means missing. `baseUrl` must be absolute;
 * in the browser resolve the path first: `fetchLoader(new URL("/bundle/", location.href))`.
 * `gzip`: the Bundle was stored with `writeBundleFiles(dir, files, { gzip: true })`, so each
 * file is fetched as `<path>.gz` and inflated here (unless the host already did).
 */
export function fetchLoader(
  baseUrl: string | URL,
  { gzip = false, fetch: fetchImpl = fetch }: { gzip?: boolean; fetch?: typeof fetch } = {},
): Loader {
  return async (path) => {
    const response = await fetchImpl(new URL(gzip ? `${path}.gz` : path, baseUrl));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Bundle fetch ${path} failed: HTTP ${response.status}`);
    if (!gzip) return response.text();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
    const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(inflated).text();
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
