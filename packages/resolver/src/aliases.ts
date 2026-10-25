/**
 * Curated make and model aliases across CZ/DE/AT listing sites and catalog Sources.
 * Bump ALIASES_VERSION on every change: a new alias can move a Listing from Model to Variant
 * at the next snapshot.
 *
 * Each group lists slugs (`slugify` output) that name the same make or model. The first
 * entry is the group's key; it does not have to be the catalog's spelling, because catalog
 * names are looked up through the same groups. Slugs not in any group stand for themselves.
 */
export const ALIASES_VERSION = 1;

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

/** BMW series: "Řada 3", "3er", "3 Series", "Serie 3", and engine badges "320", "320d". */
const BMW_SERIES = ["1", "2", "3", "4", "5", "6", "7", "8"];

export interface ModelAliases {
  groups?: readonly (readonly string[])[];
  /**
   * Words that make a different Model when they follow this one ("Range Rover Sport" is not
   * a "Range Rover"). A listing naming one of these never falls back to the shorter Model.
   */
  submodels?: Readonly<Record<string, readonly string[]>>;
  /**
   * Engine-badge model names (BMW "118", "530"; checked on the first model token): the
   * capture group plus `suffix` gives a slug in `groups`.
   */
  badge?: { pattern: RegExp; suffix: string };
}

export const MODEL_ALIASES: Readonly<Record<string, ModelAliases>> = {
  "mercedes-benz": {
    groups: MERCEDES_CLASSES.map((c) => [
      c,
      `${c}-class`,
      `${c}-klasse`,
      `trida-${c}`,
      `tridy-${c}`,
      `${c}-trida`,
    ]),
    // "C220d", "E400" written as one word.
    badge: { pattern: /^([a-z]{1,3})\d{2,3}[a-z]?$/, suffix: "" },
  },
  bmw: {
    groups: BMW_SERIES.map((n) => [
      `${n}-series`,
      `${n}er`,
      `rada-${n}`,
      `serie-${n}`,
      `series-${n}`,
      `${n}-reihe`,
    ]),
    badge: { pattern: /^([1-8])\d\d[a-z]{0,2}$/, suffix: "-series" },
  },
  "land-rover": {
    submodels: { "range-rover": ["sport", "velar", "evoque"], discovery: ["sport"] },
  },
  volkswagen: {
    submodels: { golf: ["plus", "sportsvan"], tiguan: ["allspace"], touran: ["cross"] },
  },
  citroen: { submodels: { c4: ["picasso", "cactus", "aircross", "x"] } },
  ford: { submodels: { focus: ["c-max"], tourneo: ["connect", "custom", "courier"] } },
  renault: { submodels: { megane: ["scenic", "e-tech"] } },
};
