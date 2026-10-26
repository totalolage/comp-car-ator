/**
 * Make and model names for the catalog Sources (register, EEA). Government datasets spell
 * makes and models in upper case with many variants ("VOLKSWAGEN, VW", "ŠKODA"/"SKODA",
 * "C 220 CDI", "320D"); the catalog needs one display spelling per make and model so their ids
 * do not fork. Matching listings to these names is the Resolver's job; here we only choose
 * the catalog's spelling, in the forms the Resolver's alias groups know ("Volkswagen",
 * "C-Class", "3 Series").
 */
import { slugify } from "@cca/vocabulary";

/** Display spelling per make slug; other makes are title-cased. */
const MAKES: Record<string, string> = {
  skoda: "Škoda",
  volkswagen: "Volkswagen",
  vw: "Volkswagen",
  "volkswagen-vw": "Volkswagen",
  "mercedes-benz": "Mercedes-Benz",
  mercedes: "Mercedes-Benz",
  "mercedes-amg": "Mercedes-Benz",
  bmw: "BMW",
  "bmw-i": "BMW",
  mini: "Mini",
  "bmw-mini": "Mini",
  citroen: "Citroën",
  ds: "DS",
  "ds-automobiles": "DS",
  "alfa-romeo": "Alfa Romeo",
  alfa: "Alfa Romeo",
  "land-rover": "Land Rover",
  landrover: "Land Rover",
  "range-rover": "Land Rover",
  ssangyong: "SsangYong",
  kgm: "KGM",
  "kg-mobility": "KGM",
  mg: "MG",
  byd: "BYD",
  "rolls-royce": "Rolls-Royce",
  "aston-martin": "Aston Martin",
  "lynk-co": "Lynk & Co",
  vaz: "Lada",
  lada: "Lada",
  kia: "Kia",
  seat: "Seat",
  cupra: "Cupra",
};

/** The catalog's spelling of a make, or undefined when the text names none. */
export function makeName(raw: string): string | undefined {
  const slug = slugify(raw.split(/[,.;/]/).filter((s) => s.trim())[0] ?? "");
  const full = slugify(raw);
  if (!slug) return undefined;
  return MAKES[full] ?? MAKES[slug] ?? titleCase(raw.split(/[,;/]/)[0] ?? raw);
}

/** Words that end the model part of a commercial name: body, engine, drive and trim words. */
const NOISE = new Set(
  (
    "COMBI KOMBI VARIANT AVANT TOURING ESTATE SW BREAK SPORTSWAGON SPORTSTOURER TOURER " +
    "LIMOUSINE LIMUZINA SEDAN SALOON LIFTBACK HATCHBACK HB CABRIO CABRIOLET KABRIOLET COUPE " +
    "KUPE ROADSTER SPIDER SPYDER TARGA FASTBACK SHOOTING " +
    "TDI TSI TFSI FSI TGI ETSI MPI GTI GTD GTE RS VRS SCOUT CDI CRDI TDCI HDI BLUEHDI DCI TCE " +
    "PURETECH ECOBOOST CDTI JTD JTDM MULTIJET TURBO DIESEL BENZIN HYBRID PHEV HEV MHEV EV " +
    "4X4 4X2 AWD FWD RWD 4MOTION QUATTRO 4MATIC XDRIVE SDRIVE ALL4 4WD AUTOMAT DSG CVT " +
    "AMBITION STYLE ACTIVE COMFORT ELEGANCE CLASSIC TREND TRENDLINE COMFORTLINE HIGHLINE"
  ).split(" "),
);

/** Mercedes-Benz class letters: "C 220 CDI" is the C-Class. */
const MERCEDES_CLASSES = new Set(
  "A B C E S G V T X R M ML GL CL SL CLA CLS CLK GLA GLB GLC GLE GLK GLS SLC SLK EQA EQB EQC EQE EQS EQV".split(
    " ",
  ),
);

/**
 * The model part of a commercial name, before engine, body and trim words, in the catalog's
 * spelling ("OCTAVIA COMBI 2.0 TDI" → "Octavia", "C 220 CDI" → "C-Class", "320D" →
 * "3 Series"). Undefined when nothing is left. Variants of one model that this cannot tell
 * from separate models ("Octavia Scout" vs "Tiguan Allspace") are merged by the caller.
 */
export function modelName(make: string, raw: string): string | undefined {
  const tokens = raw
    // "CEE'D", "CEE´D": the apostrophe goes ("Ceed", as Kia now spells it).
    .replace(/['´`’]/g, "")
    // Hyundai/Kia "I 30" is the i30.
    .replace(/\b(I[XO]?) (\d{2})/gi, "$1$2")
    // ... and "I30CW" its wagon.
    .replace(/\b(I[XO]?\d{2})(?:CW|SW)\b/gi, "$1")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[„“"()]/g, " ")
    .split(/\s+/)
    // Punctuation alone (".", "-") names nothing and would mint an empty id slug.
    .filter((token) => slugify(token) !== "");
  const makeSlug = slugify(make);
  // Some rows repeat the make ("ŠKODA OCTAVIA", "MERCEDES-BENZ C 220").
  while (tokens.length > 1 && makeName(tokens[0] as string) === make) tokens.shift();
  if (makeSlug === "mercedes-benz") return mercedes(tokens);
  if (makeSlug === "bmw") {
    const series = /^M?([1-8])\d{2}[A-Z]{0,3}$/.exec(tokens[0] ?? "");
    if (series) return `${series[1]} Series`;
    const spelled = /^([1-8])(?:ER|-?SERIES?)$/.exec(tokens[0] ?? "");
    if (spelled) return `${spelled[1]} Series`;
  }
  const kept: string[] = [];
  for (const token of tokens) {
    if (isNoise(token)) break;
    kept.push(token);
  }
  if (kept.length === 0) return undefined;
  return kept.map((t) => displayToken(make, t)).join(" ");
}

function mercedes(tokens: string[]): string | undefined {
  const first = tokens[0] ?? "";
  const joined = /^([A-Z]{1,3})(\d{2,3})[A-Z]*$/.exec(first);
  const letters = joined ? joined[1] : first;
  const spaced = !joined && /^\d{2,3}[A-Z]*$/.test(tokens[1] ?? "");
  if (letters && MERCEDES_CLASSES.has(letters) && (joined || spaced || tokens.length === 1)) {
    return letters.length === 1 ? `${letters}-Class` : letters;
  }
  const trida = first === "TRIDA" || first === "TRIDY" ? tokens[1] : undefined;
  if (trida && MERCEDES_CLASSES.has(trida)) return trida.length === 1 ? `${trida}-Class` : trida;
  const kept: string[] = [];
  for (const token of tokens) {
    if (isNoise(token)) break;
    kept.push(token);
  }
  return kept.length > 0 ? kept.map((t) => displayToken("Mercedes-Benz", t)).join(" ") : undefined;
}

function isNoise(token: string): boolean {
  return (
    NOISE.has(token.replace(/[.,!]+$/, "")) ||
    /^\d[.,]\d{1,2}[A-Z]*$/.test(token) || // 1.6, 2.0TDI
    /^\d{2,3}(?:KW|PS|HP|K)$/.test(token) ||
    /^\d{1,2}V$/.test(token) // 16V
  );
}

/** "OCTAVIA" → "Octavia", "T-ROC" → "T-Roc", "X3" and "ID.3" stay, Hyundai "I30" → "i30". */
function displayToken(make: string, token: string): string {
  const makeSlug = slugify(make);
  if ((makeSlug === "hyundai" || makeSlug === "kia") && /^I[XO]?\d{2}[A-Z]?$/.test(token)) {
    return token.toLowerCase();
  }
  if (/\d/.test(token)) return token;
  return token
    .split(/(?=[-'])|(?<=[-'])/)
    .map((part) => (part.length > 1 ? part[0] + part.slice(1).toLowerCase() : part))
    .join("");
}

function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0] + word.slice(1).toLowerCase()))
    .join(" ");
}
