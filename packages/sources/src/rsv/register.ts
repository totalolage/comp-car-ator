/**
 * One row of the register export (`RSV_vypis_vozidel_<date>.csv`, schema
 * https://download.dataovozidlech.cz/schema/vypisvozidel) mapped onto the vocabulary's value
 * sets. A row is one vehicle ever registered in CZ, including scrapped and exported ones.
 */
import type { Body, Drive, Fuel } from "@cca/vocabulary";
import { makeName, modelName } from "../catalog-names.ts";

/** The columns this adapter reads; a missing one means the export changed. */
export const COLUMNS = {
  firstRegistration: "Datum 1. registrace",
  category: "Kategorie vozidla",
  make: "Tovární značka",
  type: "Typ",
  typeCode: "Typ kód",
  commercialName: "Obchodní označení",
  power: "Max. výkon [kW] / [min⁻¹]",
  fuel: "Palivo",
  engineCc: "Zdvihový objem [cm³]",
  electric: "Plně elektrické vozidlo",
  hybrid: "Hybridní vozidlo",
  hybridClass: "Třída hybridního vozidla",
  euro: "Stupeň plnění emisní úrovně",
  co2: "CO2 město /mimo město/kombinované [g.km-1]",
  specificCo2: "Specifické CO2",
  consumption: "Spotřeba město /mimo město/kombinovaná [l.100km⁻¹]",
  electricConsumption: "Spotřeba el. mobil [Wh/km] – Z",
  bodyKind: "Druh vozidla 2. ř.",
  bodyType: "Druh (typ)",
  seats: "Počet míst celkem / k sezení / k stání",
  dimensions: "Celková délka/šířka/výška [mm]",
  mass: "Provozní hmotnost",
  axles: "Počet náprav - z toho poháněných",
  manufactureYear: "Rok výroby",
} as const;

export type Columns = Record<keyof typeof COLUMNS, number>;

export function columnsOf(header: string[]): Columns {
  const index = new Map(header.map((name, i) => [name.trim(), i]));
  const columns = {} as Columns;
  for (const [key, name] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    const i = index.get(name);
    if (i === undefined) throw new Error(`Register export changed: no column "${name}"`);
    columns[key] = i;
  }
  return columns;
}

/** A passenger car as the register states it, before aggregation into Variants. */
export interface RegisterVehicle {
  make: string;
  /** Commercial name cut to its model part ("Octavia"); merged further across rows later. */
  model: string;
  /** Type-approval type ("5E", "NX", "204"): one per generation for most makes. */
  type: string;
  body: Body;
  fuel: Fuel;
  powerKw: number;
  /** Year of manufacture, else of first registration anywhere (CZ or abroad). */
  year: number;
  engineCc?: number;
  seats?: number;
  euroClass?: number;
  co2GKm?: number;
  consumptionL100km?: number;
  consumptionKwh100km?: number;
  massKg?: number;
  lengthMm?: number;
  drive?: Drive;
}

/** Why a passenger-car row cannot be used; rows outside scope return "skip" instead. */
export type Rejection =
  | "short-row"
  | "no-make"
  | "no-model"
  | "no-type"
  | "no-power"
  | "unknown-fuel"
  | "unknown-body"
  | "no-year";

export function readVehicle(
  row: string[],
  c: Columns,
  minYear: number,
): RegisterVehicle | Rejection | "skip" {
  if (row.length <= c.manufactureYear || row.length <= c.typeCode) return "short-row";
  const category = (row[c.category] ?? "").trim().toUpperCase();
  if (category !== "M1" && category !== "M1G") return "skip";
  const year = integer(row[c.manufactureYear]) ?? yearOf(row[c.firstRegistration]);
  if (year === undefined) return "no-year";
  if (year < minYear) return "skip";

  const identity = identityOf(row[c.make], row[c.typeCode], row[c.type], row[c.commercialName]);
  if (typeof identity === "string") return identity;
  const { make, model, type } = identity;
  const powerKw = Math.round(firstNumber(row[c.power]) ?? 0);
  if (!(powerKw > 0 && powerKw < 1500)) return "no-power";
  const fuel = fuelOf(row[c.fuel], row[c.electric], row[c.hybrid], row[c.hybridClass]);
  if (!fuel) return "unknown-fuel";
  const body = bodyOf(row[c.bodyKind], row[c.bodyType], category);
  if (!body) return "unknown-body";

  const cc = firstNumber(row[c.engineCc]);
  const consumption = numbers(row[c.consumption])[2];
  const electric = firstNumber(row[c.electricConsumption]);
  return {
    make,
    model,
    type,
    body,
    fuel,
    powerKw,
    year,
    engineCc: fuel === "bev" ? undefined : positiveInt(cc),
    seats: positiveInt(firstNumber(row[c.seats]), 10),
    euroClass: euroOf(row[c.euro]),
    co2GKm: positiveInt(firstNumber(row[c.specificCo2]) ?? numbers(row[c.co2])[2], 1000),
    consumptionL100km: fuel === "bev" ? undefined : round1(consumption, 40),
    consumptionKwh100km: electric && electric > 50 && electric < 500 ? electric / 10 : undefined,
    massKg: positiveInt(firstNumber(row[c.mass]), 5000),
    lengthMm: positiveInt(firstNumber(row[c.dimensions]), 7000, 2000),
    drive: driveOf(row[c.axles]),
  };
}

/**
 * Rows repeat a few thousand spellings millions of times, so the text mappings are cached
 * per distinct input (a few MB for the whole export).
 */
function memo<A extends (string | undefined)[], R>(fn: (...args: A) => R): (...args: A) => R {
  const cache = new Map<string, R>();
  return (...args) => {
    const key = args.join("\u0001");
    let value = cache.get(key);
    if (value === undefined && !cache.has(key)) {
      value = fn(...args);
      cache.set(key, value);
    }
    return value as R;
  };
}

const identityOf = memo(
  (
    rawMake: string | undefined,
    code: string | undefined,
    text: string | undefined,
    commercialName: string | undefined,
  ): { make: string; model: string; type: string } | Rejection => {
    const make = makeName(rawMake ?? "");
    if (!make) return "no-make";
    const type = typeOf(code, text);
    if (!type) return "no-type";
    // Some commercial names repeat the type ("GOLF 1J AZD"): the model ends before it.
    const named = modelName(make, commercialName ?? "");
    const words = named?.split(" ") ?? [];
    const cut = words.findIndex((w, i) => i > 0 && w.toUpperCase() === type);
    const model = cut > 0 ? words.slice(0, cut).join(" ") : named;
    return model ? { make, model, type } : "no-model";
  },
);

/**
 * The type-approval type. "Typ kód" holds it on recent rows ("5E"); older rows only have
 * the free-text "Typ" ("ŠKODA OCTAVIA STBFQX01FM5 TMB / 1U"), whose part after " / " is it.
 */
function typeOf(code: string | undefined, text: string | undefined): string | undefined {
  const fromCode = (code ?? "").trim();
  const fromText = (text ?? "").split(" / ").at(-1)?.trim() ?? "";
  // "211 K", "E15UT - ZRE151", "1J AXR": the type is the first word.
  const type = (fromCode || fromText).toUpperCase().split(/\s+/)[0] ?? "";
  // Longer codes are national variant codes of pre-EU approvals ("ALHX0SGSC4"), not types.
  return /^[A-Z0-9][A-Z0-9-]{0,5}$/.test(type) ? type : undefined;
}

/**
 * Register fuel codes: BA (benzín, with octane: "BA 95 B"), NM (nafta motorová), LPG, CNG/ZP
 * (zemní plyn), EL (elektřina), H/VODÍK. Bi-fuel rows list two ("BA 95 B + LPG"). The hybrid
 * flag with class OVC-HEV is a plug-in, NOVC-HEV a hybrid without a plug.
 */
const fuelOf = memo(function fuelOf(
  raw: string | undefined,
  electric: string | undefined,
  hybrid: string | undefined,
  hybridClass: string | undefined,
): Fuel | undefined {
  const text = (raw ?? "").toUpperCase();
  if (electric?.trim() === "true") return "bev";
  if (hybrid?.trim() === "true") {
    const cls = (hybridClass ?? "").toUpperCase().replace(/\s/g, "");
    if (cls.startsWith("OVC")) return "phev";
    if (cls.startsWith("NOVC")) return "hev";
    return undefined;
  }
  if (/\bLPG\b|\bPB\b/.test(text)) return "lpg";
  if (/\bCNG\b|\bZP\b|\bLNG\b/.test(text)) return "cng";
  if (/^\s*(?:EL|ELEKTR)/.test(text)) return "bev";
  if (/VOD[IÍ]K|\bH2?\b/.test(text)) return "hydrogen";
  if (/\bNM\b|NAFTA|DIESEL/.test(text)) return "diesel";
  if (/\bBA\b|BENZ|\bE85\b/.test(text)) return "petrol";
  return undefined;
});

/**
 * Body from the EU body code or its Czech text: AA sedan, AB hatchback, AC kombi, AD kupé,
 * AE kabriolet, AF víceúčelové (MPV). The register has no SUV code; off-road category M1G
 * makes one.
 */
const bodyOf = memo(function bodyOf(
  kind: string | undefined,
  type: string | undefined,
  category: string,
): Body | undefined {
  if (category === "M1G") return "suv";
  const text = `${kind ?? ""} ${type ?? ""}`.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
  if (/\bAA\b|SEDAN|LIMUZ/.test(text)) return "sedan";
  if (/\bAB\b|HATCHBACK|LIFTBACK/.test(text)) return "hatchback";
  if (/\bAC\b|KOMBI|STATION WAGON/.test(text)) return "wagon";
  if (/\bAD\b|KUPE|COUPE/.test(text)) return "coupe";
  if (/\bAE\b|KABRIO|CABRIO|ROADSTER/.test(text)) return "convertible";
  if (/\bAF\b|VICEUCEL/.test(text)) return "mpv";
  return undefined;
});

const driveOf = memo(function driveOf(raw: string | undefined): Drive | undefined {
  const text = (raw ?? "").toUpperCase();
  const [axles, driven] = numbers(text);
  if (axles === 2 && driven === 2) return "awd";
  if (/PŘEDNÍ|PREDNI/.test(text)) return "fwd";
  if (/ZADNÍ|ZADNI/.test(text)) return "rwd";
  return undefined;
});

/** "EURO 6", "EURO 6D-TEMP", "EURO VI" → 6. */
const euroOf = memo(function euroOf(raw: string | undefined): number | undefined {
  const match = /EURO\s*([0-7]|VI{0,2}|IV|I{1,3})\b/i.exec(raw ?? "");
  if (!match) return undefined;
  const value = (match[1] as string).toUpperCase();
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII"].indexOf(value);
  return roman >= 0 ? roman + 1 : Number(value);
});

function yearOf(raw: string | undefined): number | undefined {
  const match = /^(\d{4})-\d{2}-\d{2}/.exec((raw ?? "").trim());
  return match ? Number(match[1]) : undefined;
}

function integer(raw: string | undefined): number | undefined {
  const value = Number((raw ?? "").trim());
  return Number.isInteger(value) && value > 1900 ? value : undefined;
}

/** All numbers in a "110 / 6000"-style field, in order; blanks and "0" stay as NaN/0. */
function numbers(raw: string | undefined): number[] {
  return (raw ?? "").split("/").map((part) => Number.parseFloat(part.trim().replace(",", ".")));
}

function firstNumber(raw: string | undefined): number | undefined {
  const value = numbers(raw)[0];
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function positiveInt(value: number | undefined, below = Infinity, above = 0): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > above && value < below
    ? Math.round(value)
    : undefined;
}

function round1(value: number | undefined, below: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < below
    ? Math.round(value * 10) / 10
    : undefined;
}
