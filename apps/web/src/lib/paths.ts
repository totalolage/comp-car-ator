import { buildCatalog } from "./catalog.ts";

/** One static page per model in the Bundle. */
export async function modelPaths() {
  const catalog = await buildCatalog();
  const index = catalog.query({ limit: Number.MAX_SAFE_INTEGER }).facets.values.model;
  return index.map(({ value }) => ({ params: { id: value } }));
}
