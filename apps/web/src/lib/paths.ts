import { buildCatalog, categoryTree } from "./catalog.ts";

/** One static page per model in the Bundle. */
export async function modelPaths() {
  const catalog = await buildCatalog();
  const index = catalog.query({ limit: Number.MAX_SAFE_INTEGER }).facets.values.model;
  return index.map(({ value }) => ({ params: { id: value } }));
}

/** One catalog page per make: a node of the category tree. */
export async function makePaths() {
  const tree = await categoryTree();
  return tree.makes.map((make) => ({ params: { id: make.id } }));
}

/** One catalog page per body type: a node of the category tree. */
export async function bodyPaths() {
  const tree = await categoryTree();
  return tree.bodies.map(({ value }) => ({ params: { id: value } }));
}
