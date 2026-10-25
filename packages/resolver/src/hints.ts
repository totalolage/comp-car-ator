import type { Body, Fuel, Transmission } from "@cca/vocabulary";

/** What a listing's free text (model and trim) says about the car, when it says it once. */
export interface Hints {
  body?: Body;
  fuel?: Fuel;
  transmission?: Transmission;
  powerKw?: number;
  /** Words with their case kept and diacritics stripped, for generation names ("IV", "Mk8"). */
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
    word(
      "combi|kombi|variant|avant|touring|sports ?tourer|sportswagon|estate|sw|shooting ?brake",
    ),
  ],
  ["convertible", word("cabrio|cabriolet|roadster|spider|spyder")],
];

const FUEL: [Fuel, RegExp][] = [
  [
    "diesel",
    word(
      "tdi|tdci|cdi|crdi|hdi|bluehdi|dci|cdti|jtd|jtdm|multijet|m-jet|d-4d|td4|sd4|tdv6|sdv6|diesel|nafta|\\d+d",
    ),
  ],
  ["petrol", word("e?tsi|tfsi|fsi|mpi|tce|puretech|ecoboost|t-gdi|gdi|benzin")],
];

const TRANSMISSION: [Transmission, RegExp][] = [
  [
    "automatic",
    // "Aut." is automatic, but "Aut.klima" is climate control.
    /(?<![a-z0-9])(?:\d?dsg|automat[a-z]*|autm|aut(?!\.?[a-z])|at|s-? ?tronic|tiptronic|steptronic|multitronic|pdk|cvt|dct|edc|eat\d|\dg-?tronic)(?![a-z0-9])/,
  ],
  ["manual", word("manual[a-z]*|schaltgetriebe|\\d?mt\\d?|\\dman")],
];

const KW = /(?<![\d.,])(\d{2,3}) ?kw(?![a-z])/g;
const PS = /(?<![\d.,])(\d{2,4}) ?(?:ps|hp|koni|kone)(?![a-z])/g;
const PS_TO_KW = 0.73549875;

/**
 * Reads the hints in listing text. A hint the text states two conflicting ways
 * ("DSG ... Schaltgetriebe", "110 kW ... 22 kW") is dropped rather than guessed.
 */
export function readHints(text: string): Hints {
  const folded = fold(text);
  const lower = folded.toLowerCase();
  const powers = [
    ...[...lower.matchAll(KW)].map((m) => Number(m[1])),
    ...[...lower.matchAll(PS)].map((m) => Math.round(Number(m[1]) * PS_TO_KW)),
  ];
  return {
    body: only(BODY, lower),
    fuel: only(FUEL, lower),
    transmission: only(TRANSMISSION, lower),
    powerKw: powers.every((p) => Math.abs(p - (powers[0] as number)) <= 3) ? powers[0] : undefined,
    words: folded.replace(/\bmk\s+(\d)/gi, "mk$1").split(/[^A-Za-z0-9]+/).filter(Boolean),
  };
}

function only<T>(table: [T, RegExp][], text: string): T | undefined {
  const found = table.filter(([, pattern]) => pattern.test(text));
  return found.length === 1 ? found[0]?.[0] : undefined;
}
