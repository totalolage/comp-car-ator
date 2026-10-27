import type { FuelWording } from "./hints.ts";

/**
 * Curated make and model aliases across CZ/DE/AT listing sites and catalog Sources.
 * Bump ALIASES_VERSION on every change: a new alias can move a Listing from Model to Variant
 * at the next snapshot.
 *
 * Each group lists slugs (`slugify` output) that name the same make or model. The first
 * entry is the group's key; it does not have to be the catalog's spelling, because catalog
 * names are looked up through the same groups. Slugs not in any group stand for themselves.
 */
export const ALIASES_VERSION = 7;

export const MAKE_GROUPS: readonly (readonly string[])[] = [
  ["volkswagen", "vw"],
  ["mercedes-benz", "mercedes", "mb", "mercedes-amg"],
  ["land-rover", "landrover"],
  ["alfa-romeo", "alfa"],
  ["ds", "ds-automobiles"],
  ["kgm", "ssangyong", "kg-mobility"],
  ["mini", "bmw-mini"],
];

/** Mercedes-Benz classes: "C 300", "C-Klasse", "C-Class", "Třída C" and "Třídy C" are one Model. */
const MERCEDES_CLASSES =
  "a b c e s g v t x r m ml gl cl sl cla cls clk gla glb glc gle glk gls slc slk eqa eqb eqc eqe eqs eqv".split(
    " ",
  );

/**
 * BMW series: "Řada 3", "3er", "3 Series", "Serie 3", a bare "3", engine badges "320", "320d",
 * "M340i", and the chassis codes some sites put in the model field ("E46", "F31"). A chassis
 * code still claims its generation.
 */
const BMW_SERIES: Readonly<Record<string, readonly string[]>> = {
  "1": ["e81", "e82", "e87", "e88", "f20", "f21", "f40"],
  "2": ["f22", "f23", "f44", "f45", "f46", "g42"],
  "3": ["e46", "e90", "e91", "e92", "e93", "f30", "f31", "f34", "g20", "g21"],
  "4": ["f32", "f33", "f36", "g22", "g23", "g26"],
  "5": ["e39", "e60", "e61", "f07", "f10", "f11", "g30", "g31", "g60", "g61"],
  "6": ["e63", "e64", "f06", "f12", "f13"],
  "7": ["e38", "e65", "e66", "f01", "f02", "g11", "g12"],
  "8": ["g14", "g15", "g16"],
};

/** Volkswagen vans named with their generation first ("T7 Multivan", "T6.1 Transporter"). */
const VW_VANS = ["multivan", "transporter", "caravelle", "california"].map((van) => [
  van,
  ...["t4", "t5", "t6", "t6-1", "t7"].map((t) => `${t}-${van}`),
]);

function classNames(c: string): string[] {
  return [c, `${c}-class`, `${c}-klasse`, `trida-${c}`, `tridy-${c}`, `${c}-trida`];
}

export interface ModelAliases {
  groups?: readonly (readonly string[])[];
  /**
   * Words that make a different Model when they follow this one ("Range Rover Sport" is not
   * a "Range Rover"). A listing naming one of these never falls back to the shorter Model.
   */
  submodels?: Readonly<Record<string, readonly string[]>>;
  /**
   * Model names written as an engine badge (BMW "118", "M550d") or with the make glued on
   * (DS "DS7"): the capture group plus `suffix` gives the model's slug or one in `groups`.
   */
  badge?: { pattern: RegExp; suffix: string };
  /**
   * Equipment packages written into the model field ("X5 M Sport", "1 M-Paket"): their words
   * name no Model, so the model name is read without them.
   */
  packages?: RegExp;
}

export const MODEL_ALIASES: Readonly<Record<string, ModelAliases>> = {
  "mercedes-benz": {
    // The M-Class is badged ML: "Třídy M" and "ML 350" are one Model.
    groups: MERCEDES_CLASSES.filter((c) => c !== "m").map((c) => [
      ...classNames(c),
      ...(c === "ml" ? classNames("m") : []),
    ]),
    // "C220d", "E400" written as one word.
    badge: { pattern: /^([a-z]{1,3})\d{2,3}[a-z]?$/, suffix: "" },
  },
  bmw: {
    groups: Object.entries(BMW_SERIES).map(([n, chassis]) => [
      `${n}-series`,
      n,
      `${n}er`,
      `rada-${n}`,
      `serie-${n}`,
      `series-${n}`,
      `${n}-reihe`,
      ...chassis,
    ]),
    // "M135i", "M550d": M Performance trims of their series. The M cars ("1 M", "M3", "X5 M")
    // are their own Models: a listing naming one never falls back to the series.
    badge: { pattern: /^m?([1-8])\d\d[a-z]{0,2}$/, suffix: "-series" },
    // The M Sport package is no M car: "X5 M Sport" is an X5, "1 M Sport" a 1 Series.
    packages: /(?<![a-z])m[ -]?(?:sport|sportpaket|paket|package|packet|pack|performance)\b/gi,
    submodels: {
      "1-series": ["m"],
      ...Object.fromEntries(["2", "3", "4", "5", "6", "8"].map((n) => [`${n}-series`, [`m${n}`]])),
      ...Object.fromEntries(["x3", "x4", "x5", "x6", "z3", "z4"].map((x) => [x, ["m"]])),
    },
  },
  // The catalog names DS models by number ("DS 7 Crossback" → 7 Crossback).
  ds: { badge: { pattern: /^ds-?(\d.*)$/, suffix: "" } },
  // Porsche's type codes stand for the 911 they approve ("991" is a 911 of the 991 type), and
  // each claims its generation (CHASSIS_CODES): the register keys the 911's generations by them.
  porsche: { groups: [["911", "996", "997", "991", "992"]] },
  "land-rover": {
    submodels: { "range-rover": ["sport", "velar", "evoque"], discovery: ["sport"] },
  },
  volkswagen: {
    groups: VW_VANS,
    submodels: { golf: ["plus", "sportsvan"], tiguan: ["allspace"], touran: ["cross"] },
  },
  citroen: { submodels: { c4: ["picasso", "cactus", "aircross", "x"] } },
  ford: { submodels: { focus: ["c-max"], tourneo: ["connect", "custom", "courier"] } },
  renault: { submodels: { megane: ["scenic", "e-tech"] } },
};

/**
 * Volkswagen Group platform codes ("5G" Golf VII, "8V" A3, "5E" Octavia III); "5D" is the
 * door count and "4M" 4Motion.
 */
const VW_GROUP = "(?![2-5]d$|4m$)[1-9][a-z]";
const VW_GROUP_CODE = new RegExp(`^${VW_GROUP}$`, "i");

/**
 * The shapes of each make's chassis codes, so a listing naming one ("W212", "F30") claims a
 * generation whether or not the catalog has it. Keyed by make group key; makes without an
 * entry claim generations by Roman numeral or "Mk7" only.
 */
export const CHASSIS_CODES: Readonly<Record<string, RegExp>> = {
  volkswagen: new RegExp(`^(?:${VW_GROUP}|[bt]\\d)$`, "i"),
  skoda: VW_GROUP_CODE,
  seat: VW_GROUP_CODE,
  cupra: VW_GROUP_CODE,
  audi: new RegExp(`^(?:${VW_GROUP}|[b-d]\\d)$`, "i"),
  bmw: /^[efgu]\d\d$/i,
  // The 911's type codes, the register's generation slugs for it.
  porsche: /^(?:964|99[1-367])$/,
  "mercedes-benz": /^[acrsvwx]\d{3}$/i,
  "land-rover": /^l\d{3}$/i,
  hyundai: /^[a-z]{2}\d$/i,
  kia: /^[a-z]{2}\d$/i,
};

const badge = (word: string) => new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`, "i");

/**
 * Electrified badges one make owns, with the fuels each allows ("GTE" is a plug-in
 * Volkswagen but a petrol Opel). Read only in that make's listings, with case kept: Škoda's
 * "iV" is the badge, "IV" and "iv" a generation. Keyed by make group key.
 */
export const FUEL_BADGES: Readonly<Record<string, readonly FuelWording[]>> = {
  volkswagen: [[["phev"], badge("gte")]],
  skoda: [[["phev", "bev"], /(?<![A-Za-z0-9])iV(?![A-Za-z0-9])/]],
  audi: [[["hev", "phev", "bev", "reev"], badge("e-?tron")]],
  renault: [[["hev", "phev", "bev", "reev"], badge("e-?tech")]],
};

/**
 * Liftbacks the register files under either sedan (AA) or hatchback (AB) within one
 * generation, so a listing's "hatchback" may be the catalog's sedan and the other way round.
 * Keyed by make group key; model keys as the Resolver compacts them ("a5").
 */
export const LIFTBACKS: Readonly<Record<string, readonly string[]>> = {
  skoda: ["octavia", "superb"],
  audi: ["a5", "a7", "s5", "s7", "rs5", "rs7"],
};

/**
 * Generations whose hatchbacks the register files under the wagon code, so a listing's
 * "hatchback" may be the catalog's wagon. Every Golf VIII (CD), hatchback or estate, is an
 * "AC KOMBI": its wagon Variants run 4286-4292 mm long (the hatchback) beside 4635 mm (the
 * Variant estate), and it has no hatchback Variant. The ID.3 has no estate, yet all but one of
 * its E1 Variants are wagons, 4261-4265 mm long. Keyed by make group key, model key as the
 * Resolver compacts it, and generation slug; elsewhere a generation's wagons can be real
 * estates whose hatchbacks the catalog lacks (Golf VI 5K), so absence is no evidence.
 */
export const HATCHBACK_WAGONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  volkswagen: { golf: ["mk8"], id3: ["e1"] },
};

/**
 * Generation names listings use that the catalog's generations lack: the register keys a
 * type Wikidata does not date by its code ("Octavia 5E"), while listings write "Octavia III".
 * A type the register keeps across two generations names both (Fabia 5J: II and III), so
 * either numeral is no stronger evidence than none. Keyed by make group key, model key and
 * generation slug; a slug that later changes (Wikidata dates the type) just stops matching.
 */
export const GENERATION_NAMES: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>
> = {
  skoda: {
    octavia: { "1u": ["I"], "5e": ["III"], nx: ["IV"] },
    fabia: { "6y": ["I"], "5j": ["II", "III"], pj: ["IV"] },
    superb: { "3u": ["I"], "3t": ["II", "III"], nz: ["IV"] },
    kodiaq: { ns: ["I"], ps: ["II"] },
  },
};
