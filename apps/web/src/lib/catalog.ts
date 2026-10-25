/**
 * Build-time access to the staged Bundle (public/bundle/). Pages render their first paint
 * from it; islands then open the same Bundle over fetch.
 */
import { join } from "node:path";
import { fsLoader } from "@cca/bundle/node";
import { type Catalog, openCatalog } from "@cca/catalog";
import type { Body, MakeId, ModelId } from "@cca/vocabulary";

let catalog: Promise<Catalog> | undefined;

/** Astro runs builds from apps/web, so the staged Bundle is relative to the working directory. */
export function buildCatalog(): Promise<Catalog> {
  catalog ??= openCatalog(fsLoader(join(process.cwd(), "public/bundle")));
  return catalog;
}

/** The category tree in the site header: make → model, and body type. Counts are Variants. */
export interface CategoryTree {
  makes: {
    id: MakeId;
    name: string;
    count: number;
    models: { id: ModelId; name: string; count: number }[];
  }[];
  bodies: { value: Body; count: number }[];
  variants: number;
  listings: number;
  generatedAt: string;
}

let tree: Promise<CategoryTree> | undefined;

export function categoryTree(): Promise<CategoryTree> {
  tree ??= buildCatalog().then((c) => {
    const all = c.query({ limit: Number.MAX_SAFE_INTEGER });
    const makes = new Map<MakeId, CategoryTree["makes"][number]>();
    const models = new Map<ModelId, { id: ModelId; name: string; count: number }>();
    for (const v of all.rows) {
      let make = makes.get(v.makeId);
      if (!make) {
        make = { id: v.makeId, name: v.make, count: 0, models: [] };
        makes.set(v.makeId, make);
      }
      make.count++;
      let model = models.get(v.modelId);
      if (!model) {
        model = { id: v.modelId, name: v.model, count: 0 };
        models.set(v.modelId, model);
        make.models.push(model);
      }
      model.count++;
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "cs");
    for (const make of makes.values()) make.models.sort(byName);
    return {
      makes: [...makes.values()].sort(byName),
      bodies: all.facets.values.body.map(({ value, count }) => ({ value: value as Body, count })),
      variants: c.manifest.counts.variants,
      listings: c.manifest.counts.listings,
      generatedAt: c.manifest.generatedAt,
    };
  });
  return tree;
}
