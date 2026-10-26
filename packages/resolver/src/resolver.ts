import {
  type Body,
  type CatalogVariant,
  type GenerationId,
  type MakeId,
  type ModelId,
  slugify,
  type VariantId,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import {
  CHASSIS_CODES,
  FUEL_BADGES,
  LIFTBACKS,
  MAKE_GROUPS,
  MODEL_ALIASES,
  type ModelAliases,
} from "./aliases.ts";
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

/**
 * Register bodies that can be the car a listing's body names, tried when no Variant fits the
 * body itself. The register files cars by their EU type-approval body code, listing sites
 * by shape. Its "suv" is the off-road category, so an SUV without it is a wagon, MPV or
 * hatchback there, always the same car.
 */
const OFF_ROAD_STAND_INS: readonly Body[] = ["wagon", "mpv", "hatchback"];

/**
 * Body codes the register files one shape under: a liftback as a sedan, an MPV as a wagon.
 * A generation can also have both as real bodies (Mazda 3 sedan and hatchback, Golf Variant
 * and Golf Plus), so a code stands in only where the generation has no Variant of the stated
 * body, or for a liftback in LIFTBACKS. Coupés, convertibles, vans and pickups have none:
 * when none fits, the catalog lacks the car.
 */
const CODE_STAND_INS: Partial<Record<Body, Body>> = {
  hatchback: "sedan",
  sedan: "hatchback",
  mpv: "wagon",
  wagon: "mpv",
};

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
  /** The bodies each generation has Variants of. */
  generationBodies: Map<GenerationId, Set<Body>>;
  /** A liftback the register files as either sedan or hatchback (LIFTBACKS). */
  liftback: boolean;
}

/** Words that claim a generation for any make; a lone "I" or "V" only next to the model name. */
const GENERATION_CLAIM = /^(?:II|III|IV|V|VI|VII|VIII|IX|[Mm][Kk]\d{1,2})$/;
/** Engine layouts ("V6 TDI", "W12"), not chassis codes. */
const ENGINE_LAYOUT = /^[vw]\d{1,2}$/i;

/**
 * Matching rule (docs/adr/0002-variant-definition.md):
 * 1. Make and model through slugs and the alias groups in aliases.ts; the longest model
 *    name that prefixes the listing's model wins ("Golf Variant" is a Golf).
 * 2. Fields the descriptor leaves undefined are read from its model and trim text when the
 *    text states them once: power ("110kW", "150 PS"), transmission ("DSG"), body ("Combi"),
 *    fuel ("TDI"), and a generation name ("VIII", "Mk8"). Stated fields win over text.
 *    Hybrid or electric wording ("Plug-in Hybrid", "mHEV", and the make's own badges in
 *    aliases.ts: Volkswagen "GTE", Škoda "iV") limits the fuel to what it allows, stated or
 *    not, and an engine code next to it ("TSI") says nothing about fuel.
 * 3. A Variant fits when every known field agrees: fuel and body equal, power within 3 kW,
 *    transmission among the Variant's stated `transmissions` (a filter, not identity: a
 *    Variant that states none fits any gearbox), year inside the Variant's production years
 *    (manufacture year exactly, registration or model year ±1), and generation equal when
 *    the text names one. When no Variant fits every field with the stated body, the register
 *    bodies that can be that car stand in for it (an SUV filed as a wagon, a liftback as a
 *    sedan; see standsIn); a body is never dropped.
 * 4. One fitting Variant is a match only if fuel and power are known and the text names at
 *    most one generation, all of them known to the catalog ("Octavia III" when the catalog
 *    has only the IV is not evidence for the IV). A word claims a generation when it is a
 *    Roman numeral ("IV", "iv", not Škoda's "iV") or "Mk7", a lone upper-case "I" or "V" right
 *    after the model name (alias or catalog spelling) or as the first trim word, or one of the
 *    make's chassis codes in aliases.ts ("W212", whether or not the catalog has it). Otherwise, or when several fit, the listing resolves to the Model.
 *    Fitting Variants are never ranked.
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
        generationBodies: new Map(),
        liftback: LIFTBACKS[makeKey]?.includes(modelKey) === true,
      };
      models.set(modelKey, model);
    }
    model.variants.push(variant);
    const bodies = model.generationBodies.get(variant.generationId) ?? new Set<Body>();
    model.generationBodies.set(variant.generationId, bodies.add(variant.body));
    if (!model.generationWords.has(variant.generationId)) {
      model.generationWords.set(variant.generationId, generationWords(variant));
    }
  }

  return {
    resolve(vehicle) {
      const makeKey = makeKeyOf(slugify(vehicle.make));
      const models = makes.get(makeKey);
      if (!models) return { status: "unmatched", reason: "unknown-make" };
      const found = findModel(makeKey, models, vehicle.model);
      if (!found) return { status: "unmatched", reason: "unknown-model" };
      const { model, name } = found;

      const hints = readHints(`${vehicle.model} ${vehicle.trim ?? ""}`, FUEL_BADGES[makeKey]);
      const fuel = vehicle.fuel ?? hints.fuel;
      const transmission = vehicle.transmission ?? hints.transmission;
      const body = vehicle.body ?? hints.body;
      const powerKw =
        vehicle.powerKw !== undefined && vehicle.powerKw > 0 ? vehicle.powerKw : hints.powerKw;
      // A lone "I" or "V" names a generation only right after the model name as the listing
      // spells it ("C-Klasse I") or as the first trim word. A lower-case "i" or "v" never does:
      // it stays a word that matches no generation ("v záruce" is "under warranty").
      const nameEnd = readHints(name).words.length;
      const modelWords = readHints(vehicle.model).words.length;
      const words = hints.words.filter(
        (w, i) => (w !== "I" && w !== "V") || i === nameEnd || i === modelWords,
      );
      const named = [...model.generationWords]
        .filter(([, names]) => names.some((name) => words.includes(name)))
        .map(([id]) => id);
      const known = new Set([...model.generationWords.values()].flat());
      const chassis = CHASSIS_CODES[makeKey];
      const claims = (w: string) => {
        if (model.nameWords.has(w.toLowerCase())) return false;
        if (w === "I" || GENERATION_CLAIM.test(w)) return true;
        // "C220" in a C-Class listing is an engine badge, "W212" a chassis code.
        const letters = w.match(/^[a-z]+/i)?.[0].toLowerCase();
        return (
          chassis?.test(w) === true &&
          !ENGINE_LAYOUT.test(w) &&
          (letters === undefined || !model.nameWords.has(letters))
        );
      };
      const unknownGeneration = words.some((w) => claims(w) && !known.has(w));

      const fitting = (fitsBody: (v: CatalogVariant) => boolean) =>
        model.variants.filter(
          (v) =>
            fitsYear(v, vehicle) &&
            (fuel === undefined || v.fuel === fuel) &&
            (hints.fuels === undefined || hints.fuels.includes(v.fuel)) &&
            (transmission === undefined ||
              v.transmissions === undefined ||
              v.transmissions.includes(transmission)) &&
            fitsBody(v) &&
            (powerKw === undefined || Math.abs(v.powerKw - powerKw) <= POWER_TOLERANCE_KW) &&
            (named.length === 0 || named.includes(v.generationId)),
        );
      let fits = fitting((v) => body === undefined || v.body === body);
      if (fits.length === 0 && body !== undefined) {
        fits = fitting((v) => standsIn(model, body, v));
      }
      const only = fits.length === 1 ? fits[0] : undefined;
      const evidence =
        fuel !== undefined &&
        powerKw !== undefined &&
        generationSlugs(named) <= 1 &&
        !unknownGeneration;
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

/**
 * The longest model name that prefixes `text`, and that prefix as written ("C-Klasse" of
 * "C-Klasse I"), so its words count the way the hints count them ("3.0 CSL" is one word).
 */
function findModel(
  makeKey: string,
  models: Map<string, Model>,
  text: string,
): { model: Model; name: string } | undefined {
  const folded = fold(text);
  const spans = [...folded.matchAll(/[A-Za-z0-9]+/g)];
  const tokens = spans.map(([token]) => token.toLowerCase());
  for (let length = tokens.length; length > 0; length--) {
    const key = modelKeyOf(makeKey, tokens.slice(0, length).join("-"));
    const model = models.get(key);
    if (!model) continue;
    const rest = tokens.slice(length);
    const isOther = (SUBMODELS.get(makeKey)?.get(key) ?? []).some((word) =>
      rest.some((_, i) => rest.slice(0, i + 1).join("") === word),
    );
    const last = spans[length - 1] as RegExpExecArray;
    return isOther ? undefined : { model, name: folded.slice(0, last.index + last[0].length) };
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

/** Whether Variant `v` can be the car a listing states as `stated` (OFF_ROAD_STAND_INS, CODE_STAND_INS). */
function standsIn(model: Model, stated: Body, v: CatalogVariant): boolean {
  if (stated === "suv") return OFF_ROAD_STAND_INS.includes(v.body);
  if (CODE_STAND_INS[stated] !== v.body) return false;
  const liftback = model.liftback && (stated === "hatchback" || stated === "sedan");
  return liftback || model.generationBodies.get(v.generationId)?.has(stated) !== true;
}

/** Distinct generations named; two catalog spellings of one model share generation slugs. */
function generationSlugs(ids: GenerationId[]): number {
  return new Set(ids.map((id) => id.slice(id.lastIndexOf("/") + 1))).size;
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
