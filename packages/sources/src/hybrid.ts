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
/** Škoda's plug-in badge keeps its case: "Octavia IV" is the fourth generation. */
const SKODA_IV = /(?<![A-Za-z0-9])iV(?![A-Za-z0-9])/;
/**
 * The Volkswagen group's plug-in badge ("e-Hybrid", Audi's "TFSI e-hybrid"); Jeep's and Alfa
 * Romeo's "e-Hybrid" is a 48 V mild hybrid.
 */
const E_HYBRID = /e-?hybrid/i;
const SKODA = ["skoda", "škoda"];
const E_HYBRID_MAKES = new Set(["volkswagen", "vw", "audi", ...SKODA, "seat", "cupra", "porsche"]);
const MILD = word("m-?hev|mild[\\s-]?hybrid|e-?tsi|48\\s?v(?:olt)?");
const PETROL = word("e-?tsi|tsi|tfsi");
const DIESEL = word("tdi");

/**
 * The fuel a hybrid's wording states: "phev" for a plug-in ("PHEV", "Plug-in", Škoda's "iV",
 * the Volkswagen group's "e-Hybrid"); for a mild hybrid ("m-HEV", "eTSI", "48V", "mild
 * hybrid") its combustion fuel, as the catalog lists it, taken from `combustion` when the
 * site states it or else from one engine code (TSI, TDI). Undefined when the wording says
 * neither, or contradicts itself (mild and plug-in, petrol and diesel codes).
 */
export function hybridFuel(
  text: string,
  make: string,
  combustion?: "petrol" | "diesel",
): Fuel | undefined {
  const key = make.trim().toLowerCase();
  const plugIn =
    PLUG_IN.test(text) ||
    (SKODA.includes(key) && SKODA_IV.test(text)) ||
    (E_HYBRID_MAKES.has(key) && E_HYBRID.test(text));
  if (!MILD.test(text)) return plugIn ? "phev" : undefined;
  if (plugIn) return undefined;
  if (combustion) return combustion;
  const petrol = PETROL.test(text);
  if (petrol === DIESEL.test(text)) return undefined;
  return petrol ? "petrol" : "diesel";
}
