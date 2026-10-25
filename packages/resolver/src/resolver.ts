import {
  type CatalogVariant,
  type GenerationId,
  type MakeId,
  type ModelId,
  slugify,
  type VariantId,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import { MAKE_GROUPS, MODEL_ALIASES, type ModelAliases } from "./aliases.ts";
import { fold, readHints } from "./hints.ts";

/**
 * Where a raw vehicle descriptor lands in the catalog.
 * - matched: exactly one Variant fits, and the descriptor states fuel and power.
 * - model: the model is known but the evidence does not single out one Variant: several fit,
 *   or fuel or power is unknown (`ambiguous`), or none fits (`no-variant`). The listing still
 *   belongs on the model page.
 * - unmatched: make or model unknown to the catalog.
 */
export type Resolution =
  | { status: "matched"; makeId: MakeId; modelId: ModelId; variantId: VariantId }
  | { status: "model"; makeId: MakeId; modelId: ModelId; reason: "ambiguous" | "no-variant" }
  | { status: "unmatched"; reason: "unknown-make" | "unknown-model" };

/**
 * The Resolver's interface: build once per catalog, then resolve many descriptors.
 * Pure and deterministic for a given catalog; catalog order does not matter.
 */
export interface Resolver {
  /**
   * `source` is the SourceId the descriptor came from; it namespaces
   * `vehicle.sourceTaxonomy` ids (Sauto's make id 93 means nothing to AutoScout24).
   */
  resolve(vehicle: VehicleDescriptor, source?: string): Resolution;
}

/** Power within this many kW counts as the same Variant (kW/PS rounding, ADR 0002). */
const POWER_TOLERANCE_KW = 3;

interface Model {
  /** Smallest catalog ModelId in the alias group, for a Model-level Resolution. */
  modelId: ModelId;
  makeId: MakeId;
  variants: CatalogVariant[];
  /** Words that name each of the model's generations ("IV", "mk4", "PD"). */
  generationWords: Map<GenerationId, string[]>;
  /** Lower-case words of the catalog's model name ("v", "class" for "V-Class"). */
  nameWords: Set<string>;
}

/** Words a listing uses to claim a generation, whatever the catalog calls its generations. */
const GENERATION_CLAIM = /^(?:II|III|IV|V|VI|VII|VIII|IX|[Mm][Kk]\d{1,2})$/;

/**
 * Matching rule (docs/adr/0002-variant-definition.md):
 * 1. Make and model through slugs and the alias groups in aliases.ts; the longest model
 *    name that prefixes the listing's model wins ("Golf Variant" is a Golf).
 * 2. Fields the descriptor leaves undefined are read from its model and trim text when the
 *    text states them once: power ("110kW", "150 PS"), transmission ("DSG"), body ("Combi"),
 *    fuel ("TDI"), and a generation name ("VIII", "Mk8"). Stated fields win over text.
 * 3. A Variant fits when every known field agrees: fuel, transmission and body equal, power
 *    within 3 kW, year inside the Variant's production years (manufacture year exactly,
 *    registration or model year ±1), and generation equal when the text names one.
 * 4. One fitting Variant is a match only if fuel and power are known and the text names at
 *    most one generation, all of them known to the catalog ("Octavia III" when the catalog
 *    has only the IV is not evidence for the IV). Otherwise, or when several fit, the listing
 *    resolves to the Model. Fitting Variants are never ranked.
 * TODO(wave1-stream11): per-source `sourceTaxonomy` aliases once a Source needs them.
 */
export function createResolver(catalog: readonly CatalogVariant[]): Resolver {
  const makes = new Map<string, Map<string, Model>>();
  const sorted = [...catalog].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const variant of sorted) {
    const makeKey = makeKeyOf(variant.makeId);
    const models = makes.get(makeKey) ?? new Map<string, Model>();
    makes.set(makeKey, models);
    const modelKey = modelKeyOf(makeKey, variant.modelId.slice(variant.makeId.length + 1));
    let model = models.get(modelKey);
    if (!model) {
      model = {
        modelId: variant.modelId,
        makeId: variant.makeId,
        variants: [],
        generationWords: new Map(),
        nameWords: new Set(split(variant.model).map((w) => w.toLowerCase())),
      };
      models.set(modelKey, model);
    }
    model.variants.push(variant);
    if (!model.generationWords.has(variant.generationId)) {
      model.generationWords.set(variant.generationId, generationWords(variant));
    }
  }

  return {
    resolve(vehicle) {
      const makeKey = makeKeyOf(slugify(vehicle.make));
      const models = makes.get(makeKey);
      if (!models) return { status: "unmatched", reason: "unknown-make" };
      const model = findModel(makeKey, models, vehicle.model);
      if (!model) return { status: "unmatched", reason: "unknown-model" };

      const hints = readHints(`${vehicle.model} ${vehicle.trim ?? ""}`);
      const fuel = vehicle.fuel ?? hints.fuel;
      const transmission = vehicle.transmission ?? hints.transmission;
      const body = vehicle.body ?? hints.body;
      const powerKw =
        vehicle.powerKw !== undefined && vehicle.powerKw > 0 ? vehicle.powerKw : hints.powerKw;
      const words = new Set(hints.words);
      const named = [...model.generationWords]
        .filter(([, names]) => names.some((name) => words.has(name)))
        .map(([id]) => id);
      const known = new Set([...model.generationWords.values()].flat());
      const unknownGeneration = hints.words.some(
        (w) => GENERATION_CLAIM.test(w) && !known.has(w) && !model.nameWords.has(w.toLowerCase()),
      );

      const fits = model.variants.filter(
        (v) =>
          fitsYear(v, vehicle) &&
          (fuel === undefined || v.fuel === fuel) &&
          (transmission === undefined || v.transmission === transmission) &&
          (body === undefined || v.body === body) &&
          (powerKw === undefined || Math.abs(v.powerKw - powerKw) <= POWER_TOLERANCE_KW) &&
          (named.length === 0 || named.includes(v.generationId)),
      );
      const only = fits.length === 1 ? fits[0] : undefined;
      const evidence =
        fuel !== undefined && powerKw !== undefined && named.length <= 1 && !unknownGeneration;
      if (only && evidence) {
        return {
          status: "matched",
          makeId: only.makeId,
          modelId: only.modelId,
          variantId: only.id,
        };
      }
      return {
        status: "model",
        makeId: model.makeId,
        modelId: model.modelId,
        reason: fits.length === 0 ? "no-variant" : "ambiguous",
      };
    },
  };
}

const MAKE_KEYS = keyIndex(MAKE_GROUPS);
const MODEL_KEYS = new Map(
  Object.entries(MODEL_ALIASES).map(([make, aliases]) => [make, keyIndex(aliases.groups ?? [])]),
);
/** Submodel words by model key, compacted like model keys ("c-max" → "cmax"). */
const SUBMODELS = new Map(
  Object.entries(MODEL_ALIASES).map(([make, aliases]) => [
    make,
    new Map(
      Object.entries(aliases.submodels ?? {}).map(([model, words]) => [
        modelKeyOf(make, model),
        words.map((w) => w.replace(/-/g, "")),
      ]),
    ),
  ]),
);

function keyIndex(groups: readonly (readonly string[])[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups) for (const slug of group) index.set(slug, group[0] as string);
  return index;
}

function makeKeyOf(slug: string): string {
  return MAKE_KEYS.get(slug) ?? slug;
}

/** The alias-group key of a model slug; separators do not count ("ID.3" = "ID3"). */
function modelKeyOf(makeKey: string, slug: string): string {
  const aliases: ModelAliases | undefined = MODEL_ALIASES[makeKey];
  const keys = MODEL_KEYS.get(makeKey);
  const badge = aliases?.badge && slug.match(aliases.badge.pattern);
  const named = badge ? `${badge[1]}${aliases?.badge?.suffix}` : slug;
  return (keys?.get(named) ?? named).replace(/-/g, "");
}

function findModel(makeKey: string, models: Map<string, Model>, text: string): Model | undefined {
  const tokens = slugify(text).split("-").filter(Boolean);
  for (let length = tokens.length; length > 0; length--) {
    const key = modelKeyOf(makeKey, tokens.slice(0, length).join("-"));
    const model = models.get(key);
    if (!model) continue;
    const rest = tokens.slice(length);
    const isOther = (SUBMODELS.get(makeKey)?.get(key) ?? []).some((word) =>
      rest.some((_, i) => rest.slice(0, i + 1).join("") === word),
    );
    return isOther ? undefined : model;
  }
  return undefined;
}

/**
 * Words that name a generation: its slug and the words of its name that are not the model's
 * name ("Octavia IV" → "IV"). Roman numerals and single letters must match in upper case
 * ("iV" is Škoda's plug-in badge, not generation IV); bare numbers never name a generation.
 */
function generationWords(variant: CatalogVariant): string[] {
  const modelWords = new Set(split(variant.model).map((w) => w.toLowerCase()));
  const words = [variant.generation.slug, ...split(variant.generation.name)].filter(
    (w) => !/^\d+$/.test(w) && !modelWords.has(w.toLowerCase()),
  );
  return [
    ...new Set(
      words.flatMap((w) =>
        /^[IVX]+$/i.test(w) || w.length === 1
          ? [w.toUpperCase()]
          : [w, w.toLowerCase(), w.toUpperCase(), capitalize(w)],
      ),
    ),
  ];
}

function split(text: string): string[] {
  return fold(text)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Manufacture year must fall inside the Variant's production years. Registration lags
 * production and model years lead it, so those get a year either side.
 */
function fitsYear(variant: CatalogVariant, vehicle: VehicleDescriptor): boolean {
  const { from, to = Number.POSITIVE_INFINITY } = variant.years;
  if (vehicle.manufactureYear !== undefined) {
    return from <= vehicle.manufactureYear && vehicle.manufactureYear <= to;
  }
  const year = vehicle.firstRegistration?.year ?? vehicle.modelYear;
  return year === undefined || (from - 1 <= year && year <= to + 1);
}
