import type { Body, Drive, Fuel, Transmission } from "./vehicle.ts";

export type MakeId = string;
export type ModelId = string;
export type GenerationId = string;
export type VariantId = string;

/**
 * The technical definition of one catalog Variant, as a catalog Source states it.
 * Identity is make + model + generation + body + fuel + power + transmission
 * (docs/adr/0002-variant-definition.md); every other field is a spec.
 */
export interface VariantSpec {
  /** Display name, e.g. "Škoda". */
  make: string;
  /** Display name, e.g. "Octavia". */
  model: string;
  generation: {
    /** Slug, unique within the model and stable across runs, e.g. "mk4". */
    slug: string;
    /** Display name, e.g. "Octavia IV". */
    name: string;
    from: number;
    /** Absent while still in production. */
    to?: number;
  };
  body: Body;
  fuel: Fuel;
  powerKw: number;
  transmission: Transmission;
  /** Production years of this Variant (within the generation). */
  years: { from: number; to?: number };
  drive?: Drive;
  engineCc?: number;
  seats?: number;
  doors?: number;
  euroClass?: number;
  consumptionL100km?: number;
  consumptionKwh100km?: number;
  co2GKm?: number;
  massKg?: number;
  lengthMm?: number;
}

/** A Variant as it lives in the catalog: its spec plus derived ids. */
export interface CatalogVariant extends VariantSpec {
  id: VariantId;
  makeId: MakeId;
  modelId: ModelId;
  generationId: GenerationId;
}
