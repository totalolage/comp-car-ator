import type { GenerationId, MakeId, ModelId, VariantId, VariantSpec } from "./catalog.ts";

/** Lower-case ASCII slug: diacritics stripped, runs of other characters become "-". */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function makeIdOf(make: string): MakeId {
  return slugify(make);
}

/** `skoda/octavia` */
export function modelIdOf(make: string, model: string): ModelId {
  return `${makeIdOf(make)}/${slugify(model)}`;
}

/** `skoda/octavia/mk4` */
export function generationIdOf(
  spec: Pick<VariantSpec, "make" | "model" | "generation">,
): GenerationId {
  return `${modelIdOf(spec.make, spec.model)}/${slugify(spec.generation.slug)}`;
}

/**
 * The Variant identity (docs/adr/0002-variant-definition.md), e.g.
 * `skoda/octavia/mk4/wagon-diesel-110kw`. Path-shaped so it works as a URL.
 */
export function variantIdOf(spec: VariantSpec): VariantId {
  const tail = [spec.body, spec.fuel, `${Math.round(spec.powerKw)}kw`].join("-");
  return `${generationIdOf(spec)}/${tail}`;
}
