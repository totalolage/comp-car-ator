/**
 * Build-time access to the staged Bundle (public/bundle/). Pages render their first paint
 * from it; islands then open the same Bundle over fetch.
 */
import { join } from "node:path";
import { fsLoader } from "@cca/bundle/node";
import { type Catalog, openCatalog } from "@cca/catalog";

let catalog: Promise<Catalog> | undefined;

/** Astro runs builds from apps/web, so the staged Bundle is relative to the working directory. */
export function buildCatalog(): Promise<Catalog> {
  catalog ??= openCatalog(fsLoader(join(process.cwd(), "public/bundle")));
  return catalog;
}
