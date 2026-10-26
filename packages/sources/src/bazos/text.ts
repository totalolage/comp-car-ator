/**
 * Reading Bazoš ad text. Bazoš has no structured car fields: make comes from the category,
 * everything else from the seller's title and description. Every reader here is precision
 * first: a value is returned only when the text states it in a recognised form and nothing
 * in the text contradicts it; otherwise it stays undefined.
 */
import type {
  Body,
  Drive,
  Fuel,
  PriceBasis,
  Seller,
  Transmission,
  YearMonth,
} from "@cca/vocabulary";

/** Why a title is not a car for sale, or null when it may be one. */
export function nonCarReason(title: string): "part" | "wanted" | "rental" | "damaged" | null {
  const t = normalize(title);
  if (has(t, WANTED)) return "wanted";
  if (has(t, RENTAL)) return "rental";
  if (has(t, DAMAGED)) return "damaged";
  if (has(t, PARTS_ANYWHERE)) return "part";
  const first = words(t).find((w) => !LEAD_WORDS.has(w));
  if (first !== undefined && PART_LEAD.test(first)) return "part";
  // "BMW X5 kola", "Škoda Kodiaq pravé přední světlo": a part noun and no engine spec. A
  // car's extra wheel sets ("2 sady kol", "+ zimní kola") do not count.
  const withoutExtras = t.replace(EXTRA_WHEELS, " ");
  if (has(withoutExtras, PART_NOUNS) && !has(withoutExtras, ENGINE_SPEC)) return "part";
  return null;
}

export interface MakeModel {
  make: string;
  model: string;
  trim?: string;
}

/**
 * Make and model as the title shows them. `categoryMake` is the make of the Bazoš category
 * the ad sits in (undefined for "Ostatní značky"); a title that starts with another known
 * make (a misfiled ad) takes that make. Null when no make or no model token is found.
 */
export function makeModelOf(title: string, categoryMake: string | undefined): MakeModel | null {
  // Words as shown, with where each ends in the title; separators and emoji are no words.
  const words = [...title.matchAll(/[^\s|•▶·,;:()[\]"]+/gu)]
    .map((m) => ({
      text: m[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}!´']+$/gu, ""),
      end: (m.index ?? 0) + m[0].length,
    }))
    .filter((word) => word.text !== "");
  const tokens = words.map((word) => word.text);
  let i = 0;
  while (i < tokens.length && isLeadWord(tokens[i] as string)) i++;
  let make = categoryMake;
  const found = findMake(tokens, i);
  if (found) {
    make = found.make;
    i = found.end;
  } else if (categoryMake === undefined) {
    return null;
  } else if (tokens.some((_, k) => k > i && findMake(tokens, k))) {
    // A make named later ("Ofuky oken Heko Kia Sorento"): the title starts with something
    // else, usually a part, so no model can be read.
    return null;
  }
  // "Š.FABIA", "VW.Golf": a make abbreviation glued to the model.
  let model = tokens[i];
  if (model && found === null && make) model = stripGluedMake(model, make) ?? model;
  const multi = MULTIWORD_MODELS.find((parts) =>
    parts.every((part, k) => normalize(tokens[i + k] ?? "") === part),
  );
  if (multi) {
    model = tokens.slice(i, i + multi.length).join(" ");
    i += multi.length - 1;
  }
  if (!make || !model || isLeadWord(model) || GENERIC_NOUNS.has(normalize(model))) return null;
  const trim = title
    .slice(words[i]?.end)
    .replace(/^[\s,;:|•▶·\-–/.]+|[\s,;:|•▶·\-–/]+$/gu, "")
    .replace(/\s+/g, " ");
  return trim ? { make, model, trim } : { make, model };
}

export interface CarFacts {
  /** Registration date when the text says so; otherwise the year of manufacture. */
  firstRegistration?: YearMonth;
  manufactureYear?: number;
  /** "Modelový rok"; only when the text states no other year. */
  modelYear?: number;
  odometerKm?: number;
  powerKw?: number;
  fuel?: Fuel;
  transmission?: Transmission;
  drive?: Drive;
  body?: Body;
  seller: Seller;
  priceBasis: PriceBasis;
  /** "předváděcí" (demonstrator), or a new car: next to no km, said new or made this year. */
  condition: "used" | "demo" | "new";
}

/** Facts stated in an ad's title and description. `thisYear` bounds plausible years. */
export function carFactsOf(title: string, description: string, thisYear: number): CarFacts {
  const t = normalize(title);
  const d = normalize(description);
  const year = yearOf(t, d, thisYear);
  const odometerKm = odometerOf(t, d);
  const both = `${t}\n${d}`;
  return {
    ...year,
    odometerKm,
    powerKw: powerOf(t, d),
    // Title and description together: a description can refine a title ("hybrid" there,
    // "plug-in hybrid" here), and a contradiction leaves the value unknown.
    fuel: fuelIn(both),
    transmission: transmissionIn(both),
    drive: has(both, AWD) ? "awd" : undefined,
    body: bodyIn(t),
    seller: sellerOf(both),
    priceBasis: priceBasisOf(both),
    condition: conditionOf(
      t,
      d,
      odometerKm,
      (year.manufactureYear ?? year.firstRegistration?.year) === thisYear,
    ),
  };
}

/** A description that sells the car for parts ("na náhradní díly"). */
export function sellsForParts(description: string): boolean {
  return PARTS_SALE.test(normalize(description));
}

const PARTS_SALE = w("na náhradní díly|na nahradni dily|na díly|na dily|rozprodám|rozprodej");

// --- year -------------------------------------------------------------------------------

const MONTHS: [RegExp, number][] = [
  [/^led/, 1],
  [/^úno/, 2],
  [/^bře/, 3],
  [/^dub/, 4],
  [/^kvě/, 5],
  [/^červen(ec|ce)/, 7],
  [/^červ/, 6],
  [/^srp/, 8],
  [/^zář/, 9],
  [/^říj/, 10],
  [/^lis/, 11],
  [/^pro/, 12],
];

const DATE_AFTER_CUE = String.raw`[\s:.\-–=]{0,4}(?:od\s*)?(?:(\d{1,2})\.\s?(\d{1,2})\.\s?((?:19|20)\d\d)|(\d{1,2})\s?[/.\-]\s?((?:19|20)\d\d)|(\p{L}+)\s((?:19|20)\d\d)|((?:19|20)\d\d))(?!\d)`;
const REGISTRATION = new RegExp(
  String.raw`(?:registrac\p{L}*|(?<!\p{L})reg\.|v provozu od|do provozu|uveden\p{L}* do provozu|jezdí od|provozu od|provoz od)${DATE_AFTER_CUE}`,
  "gu",
);
const MANUFACTURE = new RegExp(
  String.raw`(?<!modelov\p{L}* )(?:rok výroby|rok a měsíc výroby|měsíc a rok výroby|rok výr\.?|datum výroby|vyroben\p{L}*|výroba|(?<!\p{L})r\.\s?výroby|(?<!\p{L})r\.\s?v\.?|(?<!\p{L})rv\.?|z roku|(?<!\p{L})r\.(?=\s?\d{4})|(?<!\p{L})rok(?!\p{L}))${DATE_AFTER_CUE}`,
  "gu",
);
/** A year followed by its word: "2012 rok", "2012 r.v.". */
const YEAR_THEN_CUE = /(?<![\d/.])((?:19|20)\d\d)\s?(?:rok|r\.\s?v\.?|rv)(?!\p{L})/gu;
const MODEL_YEAR = /modelov\p{L}* rok\p{L}*[\s:.\-–=]{0,4}((?:19|20)\d\d)(?!\d)/gu;
/** "| 8/2021 |" in a title. */
const TITLE_MONTH_YEAR = /(?<![\d/.])\d{1,2}\/((?:19|20)\d\d)(?!\d)/gu;
/** A bare year in a title, not glued to letters or part of a date or range. */
const BARE_YEAR = /(?<![\p{L}\d/.-])((?:19|20)\d\d)(?![\d/.,]?\d)/gu;
/** Years that belong to something else: inspection, warranty, service, tyres. */
const YEAR_EXCLUDED =
  /(stk|tk|emise|záruk\p{L}*|garanc\p{L}*|servis\p{L}*|platn\p{L}*|do|pneu\p{L}*|baterii)\W{0,3}$/u;

function yearOf(
  title: string,
  description: string,
  thisYear: number,
): Pick<CarFacts, "firstRegistration" | "manufactureYear" | "modelYear"> {
  const plausible = (y: number) => y >= 1950 && y <= thisYear + 1;
  const registrations: YearMonth[] = [];
  const manufactured: number[] = [];
  for (const text of [title, description]) {
    for (const m of text.matchAll(REGISTRATION)) {
      const ym = yearMonthOf(m);
      if (ym && plausible(ym.year)) registrations.push(ym);
    }
    for (const m of text.matchAll(MANUFACTURE)) {
      const ym = yearMonthOf(m);
      if (ym && plausible(ym.year)) manufactured.push(ym.year);
    }
  }
  for (const text of [title, description]) {
    for (const m of text.matchAll(YEAR_THEN_CUE)) {
      if (plausible(Number(m[1]))) manufactured.push(Number(m[1]));
    }
  }
  for (const re of [BARE_YEAR, TITLE_MONTH_YEAR]) {
    for (const m of title.matchAll(re)) {
      const y = Number(m[1]);
      const before = title.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
      if (plausible(y) && !YEAR_EXCLUDED.test(before)) manufactured.push(y);
    }
  }
  const modelYears = new Set(
    [...description.matchAll(MODEL_YEAR), ...title.matchAll(MODEL_YEAR)]
      .map((m) => Number(m[1]))
      .filter(plausible),
  );
  const regYears = new Set(registrations.map((r) => r.year));
  const madeYears = new Set(manufactured);
  if (regYears.size === 1) {
    const year = registrations[0]?.year as number;
    // A car is made at most a year before it is registered; more means the text mixes cars.
    if ([...madeYears].some((y) => y > year || y < year - 1)) return {};
    const months = new Set(registrations.map((r) => r.month).filter((m) => m !== undefined));
    const month = months.size === 1 ? [...months][0] : undefined;
    return { firstRegistration: month ? { year, month } : { year } };
  }
  if (regYears.size === 0 && madeYears.size === 1) return { manufactureYear: manufactured[0] };
  if (regYears.size === 0 && madeYears.size === 0 && modelYears.size === 1) {
    return { modelYear: [...modelYears][0] };
  }
  return {};
}

function yearMonthOf(m: RegExpMatchArray): YearMonth | null {
  const [, d, dm, dy, mm, my, name, ny, y] = m;
  if (dy) return withMonth(Number(dy), Number(dm), d);
  if (my) return withMonth(Number(my), Number(mm));
  if (ny && name) {
    const month = MONTHS.find(([re]) => re.test(name))?.[1];
    return month ? { year: Number(ny), month } : { year: Number(ny) };
  }
  return y ? { year: Number(y) } : null;
}

function withMonth(year: number, month: number, day?: string): YearMonth | null {
  if (month < 1 || month > 12 || (day !== undefined && (Number(day) < 1 || Number(day) > 31))) {
    return null;
  }
  return { year, month };
}

// --- odometer ---------------------------------------------------------------------------

/** "52 300", "52.300", "52,300"; a comma with one or two digits is a decimal ("95,5 tkm"). */
const NUMBER = String.raw`(\d{1,3}(?:[ .,]\d{3})+|\d+)(?:,(\d{1,2})(?!\d))?`;
const KM_UNIT = String.raw`\s?(tis\.?\s?km|tis\.?\s?kilometr\p{L}*|tkm|t\.\s?km|km|kilometr\p{L}*)(?![\p{L}/])`;
/** Not inside another number ("1,5 km") nor a rate ("l/100 km"). */
const NOT_IN_NUMBER = String.raw`(?<![\d/])(?<!(?:^|\D)\d[.,])`;
const KM_VALUE = new RegExp(`${NOT_IN_NUMBER}${NUMBER}${KM_UNIT}`, "gu");
const KM_CUE = new RegExp(
  String.raw`(?:najet\p{L}*|(?<!\p{L})naj\.?|nájezd\p{L}*|naježděn\p{L}*|ujet\p{L}*|stav (?:tachometru|tacho|kilometrů|km)|tachometr\p{L}*|(?<!\p{L})tacho|počet (?:najetých )?(?:kilometrů|km)|(?<!\p{L})km\s?:)[^\d\n]{0,24}?${NOT_IN_NUMBER}${NUMBER}(?:${KM_UNIT}|\s?(tis)\.?)?`,
  "gu",
);
/** Words before a km figure that make it a service interval, warranty, range or trip. */
const KM_EXCLUDED =
  /(při|pri|přes|nad|pod|ve|výměn\p{L}*|měněn\p{L}*|rozvod\p{L}*|olej\p{L}*|servis\p{L}*|interval\p{L}*|dojezd\p{L}*|dosah\p{L}*|každ\p{L}*|záruk\p{L}*|garanc\p{L}*|nebo|alebo|za|do|až|limit\p{L}*|denně|den|ročně|baterii|spotřeb\p{L}*|cca za|po)[\s:.-]{0,3}$/u;

function odometerOf(title: string, description: string): number | undefined {
  // "136 xxx km": the seller hides the last digits; the figure is good to a thousand.
  const unmask = (text: string) => text.replace(/(?<!\d)(\d{1,3})\s?xxx(?!x)/g, "$1000");
  title = unmask(title);
  description = unmask(description);
  const fromTitle = kmValues(title, KM_VALUE, false);
  const cued = kmValues(description, KM_CUE, true);
  let candidates = [...fromTitle, ...cued];
  if (candidates.length === 0) {
    const loose = new Set(kmValues(description, KM_VALUE, false));
    if (loose.size === 1) candidates = [...loose];
  }
  return agreed(candidates);
}

function kmValues(text: string, re: RegExp, cued: boolean): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const [whole, int, frac, unit, bareTis] = m;
    if (!int) continue;
    const start = (m.index ?? 0) + (cued ? whole.search(/\d/) : 0);
    if (KM_EXCLUDED.test(text.slice(Math.max(0, start - 14), start))) continue;
    // "při nájezdu 81 455 km": a cue can itself follow an excluding word.
    if (cued && KM_EXCLUDED.test(text.slice(Math.max(0, (m.index ?? 0) - 14), m.index))) continue;
    const thousands = /^t/.test(unit ?? bareTis ?? "");
    // A cued figure without a unit is only an odometer when it is a plausible whole number.
    if (cued && !unit && !bareTis && Number(int.replace(/\D/g, "")) < 1000) continue;
    let km = Number(int.replace(/[ .,]/g, ""));
    if (frac !== undefined) {
      if (!thousands) continue; // "1,5 km" is a distance, not an odometer.
      km = Number(`${km}.${frac}`);
    }
    if (thousands) km = Math.round(km * 1000);
    if (km >= 0 && km <= 1_500_000) out.push(km);
  }
  return out;
}

/**
 * The value candidates agree on: all within 2 % (or 1,000 km) of each other, as a rounded
 * "95 tkm" title and "95 400 km" description do. The most precise one wins.
 */
function agreed(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max - min > Math.max(1000, 0.02 * max)) return undefined;
  return values.reduce((best, v) => (trailingZeros(v) < trailingZeros(best) ? v : best));
}

function trailingZeros(n: number): number {
  let z = 0;
  for (let v = n; v > 0 && v % 10 === 0; v /= 10) z++;
  return z;
}

// --- power ------------------------------------------------------------------------------

const KW = /(?<!\d)(?<!\d[.,])(\d{2,3}(?:[.,]\d)?)\s?-?\s?kw(?!h|\p{L})/gu;
/** kW figures of chargers, electric motors and batteries, not the car's power. */
const KW_EXCLUDED =
  /(nabíj\p{L}*|nabij\p{L}*|dobíj\p{L}*|nabíječ\p{L}*|wallbox|max\.?|maximáln\p{L}*|(?<!\p{L})ac|(?<!\p{L})dc|elektromotor\p{L}*|rekuperac\p{L}*|palubní)[^\d\n]{0,14}$/u;

function powerOf(title: string, description: string): number | undefined {
  const inTitle = kwValues(title);
  if (inTitle.size === 1) return [...inTitle][0];
  if (inTitle.size > 1) return undefined;
  const inDescription = kwValues(description);
  return inDescription.size === 1 ? [...inDescription][0] : undefined;
}

function kwValues(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(KW)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
    if (KW_EXCLUDED.test(before)) continue;
    const kw = Number((m[1] as string).replace(",", "."));
    if (kw >= 15 && kw <= 800) out.add(kw);
  }
  return out;
}

// --- fuel, transmission, drive, body ----------------------------------------------------

type FuelFlag = "petrol" | "diesel" | "lpg" | "cng" | "hev" | "phev" | "bev" | "mild";

const FUEL_FLAGS: [FuelFlag, RegExp][] = [
  ["mild", w("mild[\\s-]?hybrid\\p{L}*|mhev|e-tsi")],
  // Not "bez možnosti plug-in nabíjení" (no plug-in charging).
  [
    "phev",
    /(?<!(?:bez|není|nie je|ne)(?: možnosti)? )(?<!\p{L})(?:plug[\s-]?in\p{L}*|phev|gte|e-hybrid)(?!\p{L})/u,
  ],
  ["hev", w("hybrid\\p{L}*|hev")],
  [
    "bev",
    w("elektromobil\\p{L}*|elektroaut\\p{L}*|bev|plně elektrick\\p{L}*|čistě elektrick\\p{L}*"),
  ],
  [
    "lpg",
    /(?<!(?:vhodn\p{L}*|připraven\p{L}*|příprav\p{L}*|možnost\p{L}*|lze|bez) (?:pro |na )?)(?<!\p{L})lpg(?!\p{L})/u,
  ],
  ["cng", w("cng|g-tec|tgi")],
  [
    "diesel",
    /(?<!\p{L})(?:tdi|tdci|hdi|bluehdi|crdi|dci|cdi|cdti|jtd|jtdm|multijet|d-4d|d4d|crd|tdv6|sdv6|td4|sd4|ecoblue|bluetec|nafta|naftov\p{L}*|diesel\p{L}*|dízl\p{L}*)(?!\p{L})|(?<![\p{L}\d])\d{2,3}x?d(?!\p{L})/u,
  ],
  [
    "petrol",
    /(?<!\p{L})(?:tsi|tfsi|fsi|mpi|htp|benzín\p{L}*|benzin\p{L}*|ecoboost|i-vtec|vtec|t-jet|tce|puretech|gdi|t-gdi|tgdi|vvt-i|vvti|twinair|multiair)(?!\p{L})|(?<![\p{L}\d])\d[.,]\di(?!\p{L})|(?<![\p{L}\d])\d{3}x?i(?!\p{L})/u,
  ],
];

function fuelIn(text: string): Fuel | undefined {
  const flags = new Set<FuelFlag>();
  let rest = text;
  for (const [flag, re] of FUEL_FLAGS) {
    if (re.test(rest)) flags.add(flag);
    // A plug-in hybrid also says "hybrid"; a mild hybrid is no hybrid in the vocabulary.
    if (flag === "mild" || flag === "phev") rest = rest.replace(new RegExp(re.source, "gu"), " ");
  }
  flags.delete("mild");
  const only = (...allowed: FuelFlag[]) => [...flags].every((f) => allowed.includes(f));
  if (flags.size === 0) return undefined;
  if (flags.has("bev")) return flags.size === 1 ? "bev" : undefined;
  if (flags.has("phev")) return only("phev", "hev", "petrol", "diesel") ? "phev" : undefined;
  if (flags.has("hev")) return only("hev", "petrol") || only("hev", "diesel") ? "hev" : undefined;
  if (flags.has("lpg")) return only("lpg", "petrol") ? "lpg" : undefined;
  if (flags.has("cng")) return only("cng", "petrol") ? "cng" : undefined;
  if (flags.size === 1) return [...flags][0] as Fuel;
  return undefined;
}

const AUTOMATIC = w(
  "automat|automatem|automatu|automatic|dsg|s-tronic|s tronic|tiptronic|steptronic|multitronic|cvt|e-cvt|powershift|automatick\\p{L}* převod\\p{L}*|převod\\p{L}*:? automat\\p{L}*",
);
const MANUAL = w(
  "manuál|manuálem|manual|manuáln\\p{L}* převod\\p{L}*|převod\\p{L}*:? manuáln\\p{L}*|\\d-?\\s?stupňov\\p{L}* manuáln\\p{L}*",
);

function transmissionIn(text: string): Transmission | undefined {
  const auto = AUTOMATIC.test(text);
  const manual = MANUAL.test(text);
  if (auto === manual) return undefined;
  return auto ? "automatic" : "manual";
}

const AWD = w("4x4|4×4|4wd|awd|4motion|quattro|xdrive|4matic|allgrip|all4|q4|4xmotion");

const BODIES: [Body, RegExp][] = [
  ["wagon", w("combi|kombi|kombík|variant|avant|touring|sportswagon|caravan|sports tourer")],
  ["sedan", w("sedan|limuzína|limousine")],
  ["hatchback", w("hatchback")],
  ["coupe", w("kupé|coupe|coupé")],
  ["convertible", w("cabrio|kabrio|kabriolet|cabriolet|roadster")],
  ["suv", w("suv")],
  ["mpv", w("mpv|minivan")],
  ["pickup", w("pick-up|pickup")],
];

function bodyIn(title: string): Body | undefined {
  const found = BODIES.filter(([, re]) => re.test(title));
  return found.length === 1 ? found[0]?.[0] : undefined;
}

// --- seller, price basis, condition -----------------------------------------------------

const PRIVATE = w(
  "soukrom\\p{L}* (?:osoba|prodej|prodejce|inzerent)|nejsem (?:auto)?bazar|nejsem překupník|nejsem autobazar ani překupník|prodávám (?:své|svůj|naše|náš)|prodám (?:své|svůj|naše|náš|vlastní)",
);
/**
 * A trader's wording. VAT deduction or a company name alone is no cue: firms sell their own
 * cars too.
 */
const DEALER = w(
  "leasing\\p{L}*|na splátky|financování|autobazar\\p{L}*|autosalon\\p{L}*|nabízíme|prodáváme|protiúčt\\p{L}*|výkup\\p{L}* vozidel",
);

function sellerOf(text: string): Seller {
  const isPrivate = PRIVATE.test(text);
  // "nejsem autobazar" is a private cue that also contains a dealer word.
  const isDealer = DEALER.test(text.replace(new RegExp(PRIVATE.source, "gu"), " "));
  if (isPrivate === isDealer) return "unknown";
  return isPrivate ? "private" : "dealer";
}

const GROSS = w(
  "odpočet dph|odpočt\\p{L}* dph|možnost odpočtu dph|možný odpočet dph|lze odečíst dph|dph lze odečíst|odpočitateln\\p{L}* dph|vč\\.\\s?dph|včetně dph",
);
const NOT_GROSS = w(
  "bez dph|\\+\\s?dph|plus dph|nelze odečíst|nelze odpočet|nelze uplatnit|bez možnosti odpočtu|bez odpočtu|není možn\\p{L}* odpoč\\p{L}*|nejde odečíst|neplátce dph|nejsem plátce",
);

function priceBasisOf(text: string): PriceBasis {
  return GROSS.test(text) && !NOT_GROSS.test(text) ? "gross" : "unknown";
}

const DEMO = w("předváděc\\p{L}*");
const NEW_CAR = w("nový vůz|nové vozidlo|nové auto|nový automobil|skladov\\p{L}* vůz");

/**
 * New takes next to no km plus the seller calling the car new, in the title or the
 * description, or a car made this year. The km bound keeps used ads that say "koupen jako
 * nový vůz" or "důvod prodeje: nové auto"; wording about parts ("nové pneumatiky") is no cue.
 */
function conditionOf(
  title: string,
  description: string,
  odometerKm: number | undefined,
  madeThisYear: boolean,
): CarFacts["condition"] {
  if (DEMO.test(title)) return "demo";
  if (odometerKm === undefined || odometerKm >= 100) return "used";
  return NEW_CAR.test(title) || NEW_CAR.test(description) || madeThisYear ? "new" : "used";
}

// --- non-car titles ---------------------------------------------------------------------

const WANTED = w(
  "hledám|hledáme|koupím|koupíme|sháním|poptávám|vykoupím|vykoupíme|výkup\\p{L}*|vykupuji|vykupujeme",
);
const RENTAL = w("pronájem|pronajmu|pronajmeme|půjčovn\\p{L}*|zapůjčen\\p{L}*|operativní leasing");
const DAMAGED = w(
  "havarovan\\p{L}*|bouran\\p{L}*|nepojízdn\\p{L}*|po nehodě|poškozen\\p{L}*|vyhořel\\p{L}*|po kroupách",
);
const PARTS_ANYWHERE = w(
  "díl|díly|dílů|dily|dilu|náhradní|nahradni|rozprod\\p{L}*|vrakovišt\\p{L}*|na díly",
);
/** Words a car title starts with that say it is a part. */
const PART_LEAD =
  /^(?:kola|kolo|disky|disk|alu|alukola|pneu\p{L}*|zimní|letní|sada|sady|světl\p{L}*|motor|motory|převodov\p{L}*|klíč\p{L}*|koberc\p{L}*|koberečk\p{L}*|nárazník\p{L}*|blatník\p{L}*|kapot\p{L}*|dveře|sedadl\p{L}*|sedačk\p{L}*|trojsedačk\p{L}*|zrcátk\p{L}*|maska|autorádio|rádio|navigace|střešní|nosič\p{L}*|poklice|výfuk\p{L}*|turbo|vstřik\p{L}*|tlumič\p{L}*|brzd\p{L}*|baterie|autobaterie|nabíječk\p{L}*|levé|levý|levá|pravé|pravý|pravá|přední|zadní|originál\p{L}*|řídící|řídicí|jednotka|čelní|volant|airbag\p{L}*|kabel\p{L}*|čidlo|filtr\p{L}*|poloos\p{L}*|kardan|držák\p{L}*|těsnění|chladič|alternátor|startér|kompresor|tažné|lišt\p{L}*|spoiler\p{L}*|kryt\p{L}*|mlhov\p{L}*)$/u;
const PART_NOUNS = w(
  "kola|kol|kolo|disky|pneu|pneumatiky|světlo|světla|světlomet\\p{L}*|motor|převodovka|převodovku|klíč|klíče|koberce|koberečky|nárazník|blatník|kapota|dveře|sedadla|sedačky|zrcátko|maska|autorádio|poklice|výfuk|vstřiky|tlumiče|kotouče|alternátor|startér|chladič|kardan|poloosy|volant|airbag|nosič|nosiče",
);
const EXTRA_WHEELS =
  /(?:\d\s?(?:x|×)?\s?|\+\s?)(?:sad\p{L}*\s)?(?:(?:zimní|letní|alu)\s)?(?:kol\p{L}*|pneu\p{L}*)/gu;
const ENGINE_SPEC =
  /\d\s?-?\s?kw(?!h)|(?<![\d.,])\d[.,]\d(?![\d.,])|(?<!\p{L})(?:tdi|tsi|tdci|hdi|crdi|dci|cdi|mpi|fsi|tfsi)(?!\p{L})/u;

/** A word that may precede the make: a sales word, or a year ("2017 KIA SEDONA"). */
function isLeadWord(token: string): boolean {
  const t = normalize(token);
  return LEAD_WORDS.has(t) || /^(?:19|20)\d\d,?$/.test(t);
}

/** Title words that name no model ("Prodej auta"). */
const GENERIC_NOUNS = new Set(["auto", "auta", "vůz", "vozidlo", "automobil", "osobní", "osobák"]);

/** Words that may precede the make in a title. */
const LEAD_WORDS = new Set([
  "prodám",
  "prodam",
  "prodej",
  "prodáme",
  "nabízím",
  "nabizim",
  "super",
  "top",
  "krásná",
  "krásný",
  "krásné",
  "pěkná",
  "pěkný",
  "pěkné",
  "zachovalá",
  "zachovalý",
  "zachovalé",
  "nová",
  "nový",
  "nové",
  "benzínová",
  "benzínový",
  "naftová",
  "naftový",
  "levně",
  "sleva",
  "akce",
  "rezervováno",
  "rezervace",
  "prodáno",
  "a",
  "v",
  "čr",
]);

// --- makes ------------------------------------------------------------------------------

/** Display make and the title spellings that name it, longest first within a make. */
const MAKES: [string, string[]][] = [
  ["Alfa Romeo", ["alfa romeo", "alfaromeo", "alfa", "alfu"]],
  ["Audi", ["audi"]],
  ["BMW", ["bmw"]],
  ["Chevrolet", ["chevrolet"]],
  ["Citroën", ["citroën", "citroen"]],
  ["Dacia", ["dacia", "dacii"]],
  ["Fiat", ["fiat"]],
  ["Ford", ["ford"]],
  ["Honda", ["honda", "hondu"]],
  ["Hyundai", ["hyundai"]],
  ["Kia", ["kia", "kiu"]],
  ["Mazda", ["mazda", "mazdu"]],
  ["Mercedes-Benz", ["mercedes-benz", "mercedes benz", "mercedes", "mb"]],
  ["Mitsubishi", ["mitsubishi"]],
  ["Nissan", ["nissan"]],
  ["Opel", ["opel"]],
  ["Peugeot", ["peugeot"]],
  ["Renault", ["renault"]],
  ["Seat", ["seat"]],
  ["Škoda", ["škoda", "skoda", "škodu", "skodu"]],
  ["Suzuki", ["suzuki"]],
  ["Toyota", ["toyota", "toyotu"]],
  ["Volkswagen", ["volkswagen", "vw"]],
  ["Volvo", ["volvo"]],
  // "Ostatní značky"
  ["Abarth", ["abarth"]],
  ["Aiways", ["aiways"]],
  ["Alpine", ["alpine"]],
  ["Aston Martin", ["aston martin"]],
  ["Bentley", ["bentley"]],
  ["BYD", ["byd"]],
  ["Cadillac", ["cadillac"]],
  ["Chrysler", ["chrysler"]],
  ["Cupra", ["cupra", "cupru"]],
  ["Daewoo", ["daewoo"]],
  ["Daihatsu", ["daihatsu"]],
  ["Dodge", ["dodge"]],
  ["DS", ["ds automobiles", "ds"]],
  ["Ferrari", ["ferrari"]],
  ["Genesis", ["genesis"]],
  ["Hummer", ["hummer"]],
  ["Infiniti", ["infiniti"]],
  ["Isuzu", ["isuzu"]],
  ["Jaguar", ["jaguar"]],
  ["Jeep", ["jeep"]],
  ["Lada", ["lada", "ladu"]],
  ["Lamborghini", ["lamborghini"]],
  ["Lancia", ["lancia"]],
  ["Land Rover", ["land rover", "landrover"]],
  ["Lexus", ["lexus"]],
  ["Lincoln", ["lincoln"]],
  ["Lotus", ["lotus"]],
  ["Lynk & Co", ["lynk & co", "lynk&co"]],
  ["Maserati", ["maserati"]],
  ["MG", ["mg"]],
  ["Mini", ["mini"]],
  ["Polestar", ["polestar"]],
  ["Porsche", ["porsche"]],
  ["Rolls-Royce", ["rolls-royce", "rolls royce"]],
  ["Rover", ["rover"]],
  ["Saab", ["saab"]],
  ["Smart", ["smart"]],
  ["SsangYong", ["ssangyong", "ssang yong"]],
  ["Subaru", ["subaru"]],
  ["Tesla", ["tesla", "teslu"]],
];

const SPELLINGS = MAKES.flatMap(([make, names]) =>
  names.map((name) => ({ make, words: name.split(" ") })),
).sort((a, b) => b.words.length - a.words.length);

/** Model names of more than one word, as title tokens. */
const MULTIWORD_MODELS = [
  "grand cherokee",
  "grand vitara",
  "grand scenic",
  "grand espace",
  "grand c-max",
  "grand tourneo",
  "grand c4 picasso",
  "grand c4 spacetourer",
  "grand santa fe",
  "santa fe",
  "land cruiser",
  "range rover sport",
  "range rover evoque",
  "range rover velar",
  "range rover",
  "discovery sport",
  "model s",
  "model 3",
  "model x",
  "model y",
  "rav 4",
  "cx 5",
  "up!",
].map((name) => name.split(" "));

/** A make named within the first three tokens from `start`. */
function findMake(tokens: string[], start: number): { make: string; end: number } | null {
  for (let i = start; i < Math.min(tokens.length, start + 3); i++) {
    for (const { make, words } of SPELLINGS) {
      const slice = tokens
        .slice(i, i + words.length)
        .map((t) => normalize(t).replace(/[.,]+$/, ""));
      if (slice.length === words.length && slice.every((t, k) => t === words[k])) {
        return { make, end: i + words.length };
      }
    }
    // Only lead words may come before the make; stop at the first real word.
    if (!isLeadWord(tokens[i] as string)) break;
  }
  return null;
}

/** "Š.FABIA" → "FABIA" when "Š." abbreviates the category's make. */
function stripGluedMake(token: string, make: string): string | null {
  const m = /^([\p{L}]{1,3})\.(\p{L}.*)$/u.exec(token);
  if (!m) return null;
  return normalize(make).startsWith(normalize(m[1] as string)) ? (m[2] as string) : null;
}

/** The make of a category slug ("skoda" → "Škoda"); undefined for "ostatni". */
export function categoryMake(slug: string): string | undefined {
  return CATEGORY_MAKES[slug];
}

export const CATEGORY_MAKES: Record<string, string | undefined> = {
  alfa: "Alfa Romeo",
  audi: "Audi",
  bmw: "BMW",
  chevrolet: "Chevrolet",
  citroen: "Citroën",
  dacia: "Dacia",
  fiat: "Fiat",
  ford: "Ford",
  honda: "Honda",
  hyundai: "Hyundai",
  kia: "Kia",
  mazda: "Mazda",
  mercedes: "Mercedes-Benz",
  mitsubishi: "Mitsubishi",
  nissan: "Nissan",
  opel: "Opel",
  peugeot: "Peugeot",
  renault: "Renault",
  seat: "Seat",
  skoda: "Škoda",
  suzuki: "Suzuki",
  toyota: "Toyota",
  volkswagen: "Volkswagen",
  volvo: "Volvo",
  ostatni: undefined,
};

// --- helpers ----------------------------------------------------------------------------

/** Lower case, single spaces, no non-breaking spaces; keeps diacritics. */
export function normalize(text: string): string {
  return text
    .replace(/[   ]/g, " ")
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A whole-word alternation: no letter directly before or after. */
function w(alternation: string): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${alternation})(?!\\p{L})`, "u");
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}
