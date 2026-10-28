/**
 * Sites that file a car only as "hybrid" leave its wording to tell a plug-in from a full or
 * mild one. Listing adapters share these rules so one listing title means the same fuel on
 * every site.
 */
import type { Fuel } from "@cca/vocabulary";

const bounded = (alternation: string, flags = "i") =>
  new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, flags);

// "Pluginhybrid" runs on, so only the start is bounded.
const PLUG_IN = /(?<![A-Za-z0-9])(?:plug[\s-]?in|phev)/i;
/** Škoda's plug-in badge keeps its case: "Octavia IV" is the fourth generation. */
const SKODA_IV = bounded("iV", "");
/** The Volkswagen group's plug-in badge; Jeep's and Alfa Romeo's "e-Hybrid" is a 48 V mild one. */
const E_HYBRID = bounded("e-?hybrid");
const E_HYBRID_MAKES = new Set(["volkswagen", "vw", "seat", "cupra", "porsche"]);
const MILD = bounded("m-?hev|mild[\\s-]?hybrid|e-?tsi|48\\s?v");
const PETROL = bounded("e-?tsi|tsi|tfsi");
const DIESEL = bounded("tdi");

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
  const plugIn =
    PLUG_IN.test(text) ||
    SKODA_IV.test(text) ||
    (E_HYBRID_MAKES.has(make.trim().toLowerCase()) && E_HYBRID.test(text));
  if (!MILD.test(text)) return plugIn ? "phev" : undefined;
  if (plugIn) return undefined;
  if (combustion) return combustion;
  const petrol = PETROL.test(text);
  if (petrol === DIESEL.test(text)) return undefined;
  return petrol ? "petrol" : "diesel";
}
