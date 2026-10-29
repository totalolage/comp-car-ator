/**
 * Sites that file a car only as "hybrid" leave its wording to tell a plug-in from a full or
 * mild one. Listing adapters share these rules so one listing title means the same fuel on
 * every site.
 */
import type { Fuel } from "@cca/vocabulary";

/** A word between letters, so digits may touch it: "1.5TSI", "2.5PHEV", "48V". */
const word = (alternation: string) =>
  new RegExp(`(?<![A-Za-z])(?:${alternation})(?![A-Za-z])`, "i");

// Unbounded, as sites write it: "Pluginhybrid", "2.5PHEV".
const PLUG_IN = /plug[\s-]?in|phev/i;
const MILD = word("m-?hev|mild[\\s-]?hybrid|e-?tsi|48\\s?v(?:olt)?");
const PETROL = word("e-?tsi|tsi|tfsi");
const DIESEL = word("tdi");

// "Golf 1,5eHybrid", "TFSI eHybridS line", but not BMW's full-hybrid "ActiveHybrid".
const E_HYBRID = /(?<![A-Za-z])e-?hybrid/i;
/** Škoda's plug-in badge keeps its case: "Octavia IV" is the fourth generation. */
const SKODA_IV = /(?<![A-Za-z0-9])iV(?![A-Za-z0-9])/;

/**
 * Badges one make owns, read only on that make: a Volkswagen GTE is a plug-in, an Opel GTE a
 * petrol car; a Volkswagen group "e-Hybrid" is a plug-in, a Stellantis one a 48 V mild hybrid;
 * Škoda's "e-TEC" is a mild hybrid, a Renault "E-Tec" a full hybrid.
 * Keyed by make as `makeKey` spells it.
 */
const PLUG_IN_BADGES: Readonly<Record<string, readonly RegExp[]>> = {
  volkswagen: [word("gte"), E_HYBRID],
  vw: [word("gte"), E_HYBRID],
  // "TFSI e" from 2019, "e-hybrid" since 2024.
  audi: [word("tfsi ?e"), E_HYBRID],
  skoda: [SKODA_IV, E_HYBRID],
  seat: [E_HYBRID],
  cupra: [E_HYBRID],
  porsche: [E_HYBRID],
  // BYD's DM-i and DM-p cars are all plug-ins.
  byd: [word("dm-?[ip]")],
};
const MILD_BADGES: Readonly<Record<string, readonly RegExp[]>> = {
  skoda: [word("e-?tec")],
  jeep: [E_HYBRID],
  "alfa romeo": [E_HYBRID],
  fiat: [E_HYBRID],
};

/** "Škoda", "SKODA", "Alfa-Romeo" → "skoda", "alfa romeo". */
const makeKey = (make: string) =>
  make
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, " ");

/**
 * The fuel a hybrid's wording states: "phev" for a plug-in ("PHEV", "Plug-in", or the make's
 * own badge: Škoda's "iV", Volkswagen's "GTE", the Volkswagen group's "e-Hybrid", Audi's
 * "TFSI e", BYD's "DM-i"); for a mild hybrid ("m-HEV", "eTSI", "48V", "mild hybrid",
 * Škoda's "e-TEC", Stellantis's "e-Hybrid") its combustion fuel, as the catalog lists it, taken from
 * `combustion` when the site states it or else from one engine code (TSI, TDI). Undefined when
 * the wording says neither, or contradicts itself (mild and plug-in, petrol and diesel codes).
 */
export function hybridFuel(
  text: string,
  make: string,
  combustion?: "petrol" | "diesel",
): Fuel | undefined {
  const key = makeKey(make);
  const plugIn = PLUG_IN.test(text) || (PLUG_IN_BADGES[key] ?? []).some((b) => b.test(text));
  const mild = MILD.test(text) || (MILD_BADGES[key] ?? []).some((b) => b.test(text));
  if (!mild) return plugIn ? "phev" : undefined;
  if (plugIn) return undefined;
  if (combustion) return combustion;
  const petrol = PETROL.test(text);
  if (petrol === DIESEL.test(text)) return undefined;
  return petrol ? "petrol" : "diesel";
}
