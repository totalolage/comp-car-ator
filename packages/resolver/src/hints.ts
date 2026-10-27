import type { Body, Fuel, Transmission } from "@cca/vocabulary";

/** What a listing's free text (model and trim) says about the car, when it says it once. */
export interface Hints {
  body?: Body;
  fuel?: Fuel;
  /**
   * The fuels the text's hybrid or electric wording leaves open ("Plug-in Hybrid" → phev,
   * "Hybrid" → hev or phev). Undefined when the text has no such wording.
   */
  fuels?: readonly Fuel[];
  transmission?: Transmission;
  powerKw?: number;
  /**
   * Words with their case kept and diacritics stripped, for generation names ("IV", "Mk8").
   * Lower-case Roman numerals of two or more letters are upper-cased ("iv" → "IV"); mixed
   * case ("iV", "iX") is a badge or a model name and stays as written.
   */
  words: string[];
}

/** NFKD without combining marks: "Škoda" → "Skoda". */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

const word = (alternation: string) => new RegExp(`(?<![a-z0-9])(?:${alternation})(?![a-z0-9])`);

const BODY: [Body, RegExp][] = [
  [
    "wagon",
    word("combi|kombi|variant|avant|touring|sports ?tourer|sports?wagon|estate|sw|shooting ?brake"),
  ],
  ["convertible", word("cabrio|cabriolet|roadster|spider|spyder")],
];

const FUEL: [Fuel, RegExp][] = [
  [
    "diesel",
    word(
      "tdi|tdci|cdi|crdi|hdi|bluehdi|dci|cdti|jtd|jtdm|multijet|m-jet|d-4d|td4|sd4|tdv6|sdv6|diesel|nafta|\\d{2,3}d|\\d[.,]\\dd",
    ),
  ],
  ["petrol", word("e?tsi|tfsi|fsi|mpi|tce|puretech|ecoboost|t-gdi|gdi|benzin")],
];

/** Wording about propulsion and the fuels it allows. */
export type FuelWording = readonly [allowed: readonly Fuel[], pattern: RegExp];

/**
 * Hybrid and electric wording, with the fuels each allows; a text naming several allows what
 * they share. Mild hybrids ("eTSI", "mHEV") are catalogued under their combustion fuel. One
 * make's badges ("GTE", "iV") are in aliases.ts: an Opel GTE is a petrol car.
 */
const ELECTRIFIED: FuelWording[] = [
  [["phev"], word("plug-? ?in|phev|e-?hybrid")],
  [["bev"], word("bev|ev")],
  [["hev"], word("hev|full ?hybrid|voll-?hybrid[a-z]*|self-? ?charging")],
  [["hev", "phev"], word("(?<!mild[- ]?)hybrid[a-z]*")],
  [["hev", "phev", "bev", "reev"], word("elektro|elektroauto|elektromotor|elektrisch")],
  [["petrol", "diesel", "hev"], word("mhev|mild[- ]?hybrid|48 ?v|etsi")],
];

const TRANSMISSION: [Transmission, RegExp][] = [
  [
    "automatic",
    // "Automatik", "Aut." are the gearbox; "Automatická klimatizace", "Aut. klima" are not.
    word(
      `\\d?dsg|autm|at|s-? ?tronic|tiptronic|steptronic|multitronic|pdk|cvt|dct|edc|eat\\d|\\dg-?tronic|(?:automat[a-z]*|aut(?!\\.[a-z]))(?![a-z0-9])(?![.\\s]*(?:klim|clim))`,
    ),
  ],
  ["manual", word("manual[a-z]*|schaltgetriebe|\\d?mt\\d?|\\dman")],
];

const KW = /(?<![\d.,])(\d{2,3}) ?kw(?![a-z])/g;
const PS = /(?<![\d.,])(\d{2,4}) ?(?:ps|hp|koni|kone)(?![a-z])/g;
const PS_TO_KW = 0.73549875;

/**
 * Reads the hints in listing text. A hint the text states two conflicting ways
 * ("DSG ... Schaltgetriebe", "110 kW ... 22 kW") is dropped rather than guessed. Next to
 * hybrid or electric wording an engine code says nothing about fuel: a "1.4 TSI Plug-in
 * Hybrid" is not a petrol car. `badges` is the make's own wording, matched with case kept.
 */
export function readHints(text: string, badges: readonly FuelWording[] = []): Hints {
  const folded = fold(text);
  const lower = folded.toLowerCase();
  const powers = [
    ...[...lower.matchAll(KW)].map((m) => Number(m[1])),
    ...[...lower.matchAll(PS)].map((m) => Math.round(Number(m[1]) * PS_TO_KW)),
  ];
  const fuels = [
    ...ELECTRIFIED.filter(([, pattern]) => pattern.test(lower)),
    ...badges.filter(([, pattern]) => pattern.test(folded)),
  ]
    .map(([allowed]) => allowed)
    .reduce<readonly Fuel[] | undefined>(
      (open, allowed) => (open ?? allowed).filter((f) => allowed.includes(f)),
      undefined,
    );
  return {
    body: only(BODY, lower),
    fuel: fuels ? (fuels.length === 1 ? fuels[0] : undefined) : only(FUEL, lower),
    fuels,
    transmission: only(TRANSMISSION, lower),
    powerKw: powers.every((p) => Math.abs(p - (powers[0] as number)) <= 3) ? powers[0] : undefined,
    words: folded
      .replace(/\bmk\s+(\d)/gi, "mk$1")
      // "Euro VI" is an emission class, not generation VI.
      .replace(/\beu(?:ro)?\s*-?\s*[0-9IVX]+[a-z]*\b/gi, " ")
      // Displacements ("2.0d", "1,6TDI") would split into code-like words ("0d").
      .replace(/\b\d[.,]\d[a-z]*\b/gi, " ")
      // "I. majitel" is the first owner, not generation I.
      .replace(/\b[IVX]+\.\s*maj[a-z]*/gi, " ")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => (/^(?:ii|iii|iv|vi|vii|viii|ix)$/.test(w) ? w.toUpperCase() : w)),
  };
}

function only<T>(table: [T, RegExp][], text: string): T | undefined {
  const found = table.filter(([, pattern]) => pattern.test(text));
  return found.length === 1 ? found[0]?.[0] : undefined;
}
