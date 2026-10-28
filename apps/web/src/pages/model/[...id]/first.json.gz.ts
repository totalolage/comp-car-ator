/**
 * A model's first listing page for the model page island (lib/listing-view.ts `firstPage`),
 * gzipped like the staged Bundle so the island reads it with `fetchLoader(…, { gzip: true })`.
 * One per model with Listings, shared by both locales.
 */
import { gzipSync } from "node:zlib";
import type { APIRoute } from "astro";
import { buildCatalog } from "../../../lib/catalog.ts";
import { firstPage } from "../../../lib/listing-view.ts";
import { listingModelPaths } from "../../../lib/paths.ts";

export const getStaticPaths = listingModelPaths;

export const GET: APIRoute = async ({ params }) => {
  const view = await (await buildCatalog()).model(params.id as string);
  if (!view) throw new Error(`Model ${params.id} has no model file`);
  const json = JSON.stringify(await firstPage(view));
  return new Response(gzipSync(json, { level: 9 }), {
    headers: { "content-type": "application/gzip" },
  });
};
