/**
 * Make and model names for the catalog Sources (register, EEA). Government datasets spell
 * makes and models in upper case with many variants ("VOLKSWAGEN, VW", "ŠKODA"/"SKODA",
 * "ŠKODA AUTO", "VW GOLF", "C 220 CDI", "320D", "X 5"); the catalog needs one display
 * spelling per make and model so their ids do not fork. Matching listings to these names is
 * the Resolver's job; here we only choose the catalog's spelling, in the forms the Resolver's
 * alias groups know ("Volkswagen", "C-Class", "3 Series").
 */
import { slugify } from "@cca/vocabulary";

/**
 * Makes by slug, with their display spelling. A make the text starts with ("ŠKODA OCTAVIA",
 * "FORD-CNG-TECHNIK") is that make; other makes are title-cased.
 */
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
  // Companies and badges that stand for one make.
  quattro: "Audi",
  "gm-daewoo": "Daewoo",
  maruti: "Suzuki",
  "maruti-suzuki": "Suzuki",
  mcc: "Smart",
  "mcc-smart": "Smart",
  "micro-compact": "Smart",
  "micro-compact-car": "Smart",
  "micro-compact-car-smart": "Smart",
  // Title-cased makes, listed so a make the text starts with is recognised and a sub-brand
  // after it ("HONDA ACURA") is not taken for a model.
  ...Object.fromEntries(
    (
      "Abarth Acura Alpina Alpine Audi Bentley Brabus Bugatti Buick Cadillac Chevrolet Chrysler Dacia " +
      "Daewoo Daihatsu Dodge Ferrari Fiat Ford Genesis Honda Hummer Hyundai Infiniti Isuzu " +
      "Jaguar Jeep Lamborghini Lancia Lexus Lotus Maserati Mazda Mclaren Mitsubishi Nissan " +
      "Opel Peugeot Polestar Porsche Renault Rover Saab Smart Subaru Suzuki Tesla Toyota " +
      "Vauxhall Volvo Datsun Scion Lincoln Mercury Pontiac Holden Maybach GMC"
    )
      .split(" ")
      .map((make) => [slugify(make), make]),
  ),
};

/** Company-form words around a make: "ŠKODA AUTO A.S.", "TESLA MOTORS", "… S.P.A.". */
const COMPANY_SUFFIX =
  /^(?:AUTO|AUTOMOBILES?|MOTORS?|COMPANY|CARS|CARAVANS|GMBH|AG|SPA|AS|SRO|LTD|LIMITED|INC|CORP|CORPORATION|GROUP)$/;
const COMPANY_PREFIX = /^(?:AUTOMOBILI|AUTOMOBILES)$/;

/**
 * Companies that sell several makes, or a model under the company's name: the commercial
 * name's first word decides the make, else the company's name stays.
 */
const COMPANIES: Record<string, (first: string) => string | undefined> = {
  "jaguar-land-rover": (w) =>
    /^(?:RANGE|DISCOVERY|DEFENDER|FREELANDER|EVOQUE|VELAR)$/.test(w)
      ? "Land Rover"
      : /^(?:X[EFJK]R?\d?|[EFI]-?PACE|[FSX]-?TYPE)$/.test(w)
        ? "Jaguar"
        : undefined,
  "daimler-chrysler": daimlerChrysler,
  daimlerchrysler: daimlerChrysler,
  micro: (w) => (w === "SMART" ? "Smart" : undefined),
};

function daimlerChrysler(first: string): string | undefined {
  if (/^(?:PT|VOYAGER|CROSSFIRE|SEBRING|NEON|300C|300M)$/.test(first)) return "Chrysler";
  const letters = /^([A-Z]{1,3})\d{0,3}$/.exec(first)?.[1];
  return letters && MERCEDES_CLASSES.has(letters) ? "Mercedes-Benz" : undefined;
}

/**
 * The catalog's spelling of a make, or undefined when the text names none. The commercial
 * name, when given, tells which make a company of several means ("JAGUAR LAND ROVER
 * LIMITED" + "RANGE ROVER" → Land Rover).
 */
export function makeName(raw: string, commercialName = ""): string | undefined {
  // "VOLKSWAGEN, VW", "ŠKODA/SKODA": the first spelling.
  const first = raw.split(/[,;/]/).find((s) => s.trim()) ?? "";
  const words = first.trim().split(/\s+/).filter(Boolean);
  const bare = (w: string) => upper(w).replace(/\./g, "");
  while (words.length > 1 && COMPANY_SUFFIX.test(bare(words.at(-1) as string))) words.pop();
  while (words.length > 1 && COMPANY_PREFIX.test(bare(words[0] as string))) words.shift();
  const text = words.join(" ");
  const slug = slugify(text);
  if (!slug) return undefined;
  const company = COMPANIES[slug];
  if (company) return company(modelTokens(commercialName)[0] ?? "") ?? titleCase(text);
  const known = MAKES[slug] ?? MAKES[slugify(first.split(".")[0] ?? "")];
  if (known) return known;
  // "ŠKODA OCTAVIA", "MINI COOPER", "LADA-VAZ": a make the text starts with, unless the rest
  // names another make ("JAGUAR LAND ROVER", "MG ROVER": a company of both).
  const parts = slug.split("-");
  for (let n = parts.length - 1; n >= 1; n--) {
    const make = MAKES[parts.slice(0, n).join("-")];
    if (!make) continue;
    const rest = parts.slice(n);
    const other = rest.some((_, i) =>
      rest.some((_, j) => {
        const m = j >= i ? MAKES[rest.slice(i, j + 1).join("-")] : undefined;
        return m !== undefined && m !== make;
      }),
    );
    return other ? titleCase(text) : make;
  }
  return titleCase(text);
}

/**
 * Words that end the model part of a commercial name: body, engine, drive and trim words.
 * Performance trims ("GTI", "RS", "Scout") stay: some also name models, so the register
 * Source folds them only into models it lists them for.
 */
const NOISE = new Set(
  (
    "COMBI KOMBI VARIANT AVANT TOURING ESTATE SW BREAK SPORTSWAGON SPORTSTOURER TOURER " +
    "LIMOUSINE LIMUZINA SEDAN SALOON LIFTBACK HATCHBACK HB CABRIO CABRIOLET KABRIOLET COUPE " +
    "KUPE ROADSTER SPIDER SPYDER TARGA FASTBACK SHOOTING " +
    "TDI TSI TFSI FSI TGI ETSI MPI CDI CRDI TDCI HDI BLUEHDI DCI TCE " +
    "PURETECH ECOBOOST CDTI JTD JTDM MULTIJET TURBO DIESEL BENZIN HYBRID PHEV HEV MHEV EV " +
    "4X4 4X2 AWD FWD RWD 4MOTION QUATTRO 4MATIC XDRIVE SDRIVE ALL4 4WD AUTOMAT DSG CVT " +
    "AMBITION STYLE ACTIVE COMFORT ELEGANCE CLASSIC TREND TRENDLINE COMFORTLINE HIGHLINE"
  ).split(" "),
);

/** Trim words that end a model only after its first word ("ID.5 PRO"; "PRO CEED" stays). */
const LATER_NOISE = new Set("PRO GTX KW PS".split(" "));

/** Mercedes-Benz class letters: "C 220 CDI" is the C-Class. */
const MERCEDES_CLASSES = new Set(
  "A B C E S G V T X R M ML GL CL SL CLA CLS CLK GLA GLB GLC GLE GLK GLS SLC SLK EQA EQB EQC EQE EQS EQV".split(
    " ",
  ),
);

/** Lexus series: "RX450H", "IS 250" are the RX and the IS. */
const LEXUS = /^(CT|ES|GS|GX|HS|IS|LBX|LC|LM|LS|LX|NX|RC|RX|RZ|SC|UX)(\d{3}[A-Z]{0,2})?$/;

/** Mini models a trim word comes with ("COUNTRYMAN COOPER S", "JCW CLUBMAN"). */
const MINI_MODELS = new Set(["COUNTRYMAN", "CLUBMAN", "PACEMAN", "ACEMAN"]);

/**
 * Makes whose lists name different models ("A3, S3": the A3 and its S model; "SX4, S-CROSS"):
 * which one a vehicle is cannot be told, so the list stays the name.
 */
const LISTS_MODELS = new Set(["audi", "suzuki"]);

/** Makes whose models are numbers ("Mazda 2", "DS 7"), which some rows glue onto the make. */
const NUMBERED_MAKES = new Set(["mazda", "ds", "jaecoo", "omoda"]);

/** Misspellings seen in the register, by make slug. */
const TYPOS: Record<string, Record<string, string>> = {
  "land-rover": { RAGNE: "RANGE", RNGE: "RANGE" },
  skoda: { KODIAK: "KODIAQ" },
  volkswagen: { PASAT: "PASSAT", CADY: "CADDY" },
  hyundai: { TUSCON: "TUCSON" },
};

/**
 * The model part of a commercial name, before engine, body and trim words, in the catalog's
 * spelling ("OCTAVIA COMBI 2.0 TDI" → "Octavia", "C 220 CDI" → "C-Class", "320D" →
 * "3 Series", "Q4 40 E-TRON" → "Q4 e-tron"). Undefined when nothing is left. Words this
 * cannot tell from part of a model name stay ("Golf GTI", "Tiguan Allspace", "e-tron GT"); the
 * caller folds only those it knows to be versions of a shorter model, and keeps the rest apart.
 */
export function modelName(make: string, raw: string): string | undefined {
  const makeSlug = slugify(make);
  const tokens = modelTokens(raw, LISTS_MODELS.has(makeSlug)).map((t) => TYPOS[makeSlug]?.[t] ?? t);
  // Some rows repeat the make ("ŠKODA OCTAVIA", "LYNK & CO 01"), or glue it onto a model
  // number ("MAZDA2", "JAECOO7") where the make names models by number.
  const prefix = (n: number) => slugify(tokens.slice(0, n).join(" "));
  const repeats = (n: number) =>
    tokens.length > n && (prefix(n) === makeSlug || (n === 1 && MAKES[prefix(1)] === make));
  for (let n = 1; n <= 3; n++) {
    if (repeats(n)) {
      tokens.splice(0, n);
      break;
    }
  }
  const glued = NUMBERED_MAKES.has(makeSlug)
    ? new RegExp(`^${makeSlug}(\\d{1,3})([A-Z]*)$`, "i").exec(tokens[0] ?? "")
    : null;
  if (glued) tokens[0] = `${glued[1]}${isNoise(glued[2] as string) ? "" : glued[2]}`;
  joinSplitNames(tokens);

  if (makeSlug === "mercedes-benz") {
    // "AMG C 43" is a C-Class; "AMG GT" a model of its own.
    if (tokens[0] === "AMG" && tokens.length > 1) {
      const cls = mercedesClass(tokens.slice(1));
      if (cls) return cls;
    }
    // "VITO 110 CDI", "AMG GT 63 S": engine and power numbers end the model.
    return mercedesClass(tokens) ?? named(make, tokens, (t) => /^\d{2,3}[A-Z]*\+?$/.test(t));
  }
  if (makeSlug === "bmw") return bmw(tokens);
  if (makeSlug === "lexus") {
    const series = LEXUS.exec(tokens[0] ?? "");
    if (series) {
      const rest = tokens.slice(1).filter((t, i) => !(i === 0 && /^\d{3}[A-Z]{0,2}$/.test(t)));
      const more = named(make, rest);
      return more ? `${series[1]} ${more}` : series[1];
    }
  }
  if (makeSlug === "mini") {
    const model = tokens.find((t) => MINI_MODELS.has(t));
    if (model) return displayToken(make, model);
  }
  if (makeSlug === "audi") {
    // "Q4 SPORTBACK 40 E-TRON", "Q6 SUV E-TRON", "A6 SB E-TRON": power and body letters out.
    const kept = tokens
      .map((t) => (t === "SB" ? "SPORTBACK" : t))
      .filter((t, i) => i === 0 || !(/^\d{2}$/.test(t) || t === "SUV"));
    return named(make, kept);
  }
  // Škoda's and Volkswagen's electric power badges: "ENYAQ 80X", "PEAQ 90".
  const badge = makeSlug === "skoda" || makeSlug === "volkswagen" ? /^\d{2}X?$/ : undefined;
  return named(make, tokens, badge && ((t) => badge.test(t)));
}

/**
 * The words of a commercial name, upper case, without diacritics and, unless `keepList`, the
 * alternative names after the first.
 */
function modelTokens(raw: string, keepList = false): string[] {
  // "TUCSON, IX35", "KONA, KAUAI", "TRANSIT/TOURNEO": one car under its market names, so the
  // first name ("1,6" and "S/T" stay).
  const first = keepList ? raw : (raw.split(/(?<!\d),|,(?!\d)|;|\/(?=[^\s/]{2})/)[0] ?? "");
  const tokens = first
    // "CEE'D", "CEE´D": the apostrophe goes ("Ceed", as Kia now spells it).
    .replace(/['´`’]/g, "")
    // Hyundai/Kia "I 30" is the i30.
    .replace(/\b(I[XO]?) (\d{2})/gi, "$1$2")
    // ... and "I30CW" its wagon.
    .replace(/\b(I[XO]?\d{2})(?:CW|SW)\b/gi, "$1")
    // Volkswagen "ID.BUZZ", "ID BUZZ": "ID." and the model word.
    .replace(/\bID(?:\.|\.? )(?=[A-Z]{2})/gi, "ID. ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[„“"()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Punctuation alone (".", "- FIESTA") names nothing and would mint an empty id slug; inside
  // a name it stays ("TOWN & COUNTRY").
  const named = (token: string) => slugify(token) !== "";
  return tokens.slice(tokens.findIndex(named), tokens.findLastIndex(named) + 1);
}

/**
 * Names split by a space: "X 5", "C 5", "RAV 4", "XC 60" are X5, C5, RAV4, XC60; "500 L"
 * the 500L. Only the first two words, and only short letter and number parts.
 */
function joinSplitNames(tokens: string[]): void {
  const [a, b] = tokens;
  // Letters that are not a word ("XC", "GT", "C"; and Toyota's RAV): "EVO 5" stays.
  const letters = /^(?:[A-Z]{1,2}|[^AEIOUY\d]{3}|RAV)$/.test(a ?? "");
  const lettersNumber = letters && /^\d{1,2}$/.test(b ?? "");
  const numberLetter = /^\d{2,3}$/.test(a ?? "") && /^[A-Z]$/.test(b ?? "");
  if (a && b && (lettersNumber || numberLetter)) {
    // Mazda writes "CX-5", "MX-5".
    tokens.splice(0, 2, /^[CM]X$/.test(a) ? `${a}-${b}` : a + b);
  }
}

function mercedesClass(tokens: string[]): string | undefined {
  const first = tokens[0] ?? "";
  const joined = /^([A-Z]{1,3})(\d{2,3})[A-Z]*\+?$/.exec(first);
  const letters = joined ? joined[1] : first;
  const spaced = !joined && /^\d{2,3}[A-Z]*\+?$/.test(tokens[1] ?? "");
  if (letters && MERCEDES_CLASSES.has(letters) && (joined || spaced || tokens.length === 1)) {
    return letters.length === 1 ? `${letters}-Class` : letters;
  }
  const trida = first === "TRIDA" || first === "TRIDY" ? tokens[1] : undefined;
  if (trida && MERCEDES_CLASSES.has(trida)) return trida.length === 1 ? `${trida}-Class` : trida;
  return undefined;
}

/**
 * BMW: "320D", "3", "3 ER REIHE", "RADA 3", "M 135 I" are the 3 and 1 Series; "I4 EDRIVE35",
 * "IX XDRIVE40", "X3 20D" the i4, iX and X3.
 */
function bmw(tokens: string[]): string | undefined {
  if (tokens[0] === "M" && /^\d/.test(tokens[1] ?? "")) tokens.splice(0, 2, `M${tokens[1]}`);
  if (/^(?:RADA|SERIE|SERIES|REIHE)$/.test(tokens[0] ?? "") && /^[1-8]$/.test(tokens[1] ?? "")) {
    tokens.shift();
  }
  const first = tokens[0] ?? "";
  // "1 M COUPE" is the 1 M, its own Model; "1 M SPORT" is a 1 Series with the M package.
  if (first === "1" && tokens[1] === "M" && !/^(?:SPORT|PA[CK])/.test(tokens[2] ?? "")) {
    return "1 M";
  }
  const series =
    /^M?([1-8])\d{2}[A-Z]{0,3}$/.exec(first) ?? /^([1-8])(?:ER|-?SERIES?)?$/.exec(first);
  if (series) return `${series[1]} Series`;
  const electric = /^I(X?\d?)(S?)$/.exec(first);
  if (electric) tokens[0] = `i${electric[1]}${electric[2] ? "s" : ""}`;
  return named("BMW", tokens, (t) => /^(?:[SXE]DRIVE\d*[A-Z]*|M\d{2}[A-Z]?|\d{2}[A-Z]?)$/.test(t));
}

/**
 * The words up to the first noise word, displayed; `later` adds a make's own noise words
 * after the first word. Undefined when no letter or digit is left.
 */
function named(
  make: string,
  tokens: string[],
  later?: (token: string) => boolean,
): string | undefined {
  const kept: string[] = [];
  for (const [i, token] of tokens.entries()) {
    if (isNoise(token)) break;
    if (i > 0 && (LATER_NOISE.has(token) || later?.(token))) break;
    kept.push(token);
  }
  // "TRANSIT - 2.0 TDCI": punctuation before a noise word ends nothing.
  while (kept.length > 0 && slugify(kept.at(-1) as string) === "") kept.pop();
  if (!kept.some((t) => /[A-Z0-9]/i.test(t))) return undefined;
  return kept.map((t) => displayToken(make, t)).join(" ");
}

function isNoise(token: string): boolean {
  return (
    NOISE.has(token.replace(/[.,!]+$/, "")) ||
    /^\d[.,]\d{1,2}[A-Z]*$/.test(token) || // 1.6, 2.0TDI
    /^\d{2,3}(?:KW|PS|HP|K)$/.test(token) ||
    /^\d{1,2}V$/.test(token) // 16V
  );
}

/**
 * "OCTAVIA" → "Octavia", "T-ROC" → "T-Roc", "X3" and "ID.3" stay, Hyundai "I30" → "i30";
 * words without a vowel are initials ("TT", "C-HR", "XC").
 */
function displayToken(make: string, token: string): string {
  const makeSlug = slugify(make);
  if ((makeSlug === "hyundai" || makeSlug === "kia") && /^I[XO]?\d{2}[A-Z]?$/.test(token)) {
    return token.toLowerCase();
  }
  if (token === "E-TRON") return "e-tron";
  if (token === "AMG" || token === "GTI" || token === "GTE") return token;
  if (/^i/.test(token) || /\d/.test(token) || /^[A-Z]{1,3}\.$/.test(token)) return token;
  return token
    .split(/(?=[-'])|(?<=[-'])/)
    .map((part) =>
      part.length > 1 && /[AEIOUY]/.test(part) ? part[0] + part.slice(1).toLowerCase() : part,
    )
    .join("");
}

function upper(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** "BMW ALPINA" → "BMW Alpina": known makes keep their spelling, other words are title-cased. */
function titleCase(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map(
      (word) =>
        MAKES[slugify(word)] ??
        (word.length <= 2 ? word.toUpperCase() : word[0] + word.slice(1).toLowerCase()),
    )
    .join(" ");
}
