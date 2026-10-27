import type { ModelId } from "@cca/vocabulary";
import { decodeTable, encodeTable, type Table } from "./columns.ts";
import {
  BUNDLE_FORMAT,
  type BundleContent,
  type BundleManifest,
  type CatalogIndex,
  type ModelFile,
} from "./format.ts";

/** Bundle files by relative path ("manifest.json", "models/skoda/octavia.json"). */
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

const MANIFEST = "manifest.json";
const CATALOG = "catalog.json";

function modelPath(id: ModelId): string {
  return `models/${id}.json`;
}

/**
 * How the long row lists sit in the files: as columnar Tables (./columns.ts), which keeps a
 * 50k-Variant catalog at a few MB. The reader turns them back into the decoded documents.
 */
type EncodedCatalog = Omit<CatalogIndex, "variants"> & { variants: Table };
type EncodedModel = Omit<ModelFile, "listings" | "stats"> & { listings: Table; stats: Table };

/** Writer: encodes decoded documents into Bundle files. Pure; persisting them is the caller's job. */
export function encodeBundle(content: BundleContent): BundleFiles {
  return new Map(encodeBundleFiles(content.models, () => content));
}

/**
 * Streaming writer, for Bundles too large to hold decoded at once: encodes each model file as
 * `models` yields it, then the catalog and manifest, which `index` returns once every model
 * is through (they summarise the models). Lazy: nothing is read before the first file is
 * asked for. Same files as `encodeBundle`.
 */
export function* encodeBundleFiles(
  models: Iterable<ModelFile>,
  index: () => Omit<BundleContent, "models">,
): Generator<BundleFile> {
  for (const { listings, stats, ...model } of models) {
    const encoded: EncodedModel = {
      ...model,
      listings: encodeTable(listings),
      stats: encodeTable(stats),
    };
    yield [modelPath(model.model.id), json(encoded)];
  }
  const { manifest, catalog } = index();
  const { variants, ...rest } = catalog;
  yield [CATALOG, json({ ...rest, variants: encodeTable(variants) } satisfies EncodedCatalog)];
  yield [MANIFEST, json(manifest)];
}

export interface BundleReader {
  readonly manifest: BundleManifest;
  /** Loaded once, then cached. */
  catalog(): Promise<CatalogIndex>;
  /** Null for an unknown model. Cached per model. */
  model(id: ModelId): Promise<ModelFile | null>;
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
  const models = new Map<ModelId, Promise<ModelFile | null>>();
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
        model = loader(modelPath(id)).then((text) => {
          if (text === null) return null;
          const { listings, stats, ...rest } = JSON.parse(text) as EncodedModel;
          return { ...rest, listings: decodeTable(listings), stats: decodeTable(stats) };
        });
        models.set(id, model);
      }
      return model;
    },
  };
}

/** Loader over in-memory files, e.g. straight from `encodeBundle` in tests. */
export function memoryLoader(files: Iterable<BundleFile>): Loader {
  const byPath = new Map(files);
  return async (path) => byPath.get(path) ?? null;
}

/**
 * Loader over HTTP, relative to `baseUrl`. 404 means missing. `baseUrl` must be absolute;
 * in the browser resolve the path first: `fetchLoader(new URL("/bundle/", location.href))`.
 */
export function fetchLoader(baseUrl: string | URL, fetchImpl: typeof fetch = fetch): Loader {
  return async (path) => {
    const response = await fetchImpl(new URL(path, baseUrl));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Bundle fetch ${path} failed: HTTP ${response.status}`);
    return response.text();
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
