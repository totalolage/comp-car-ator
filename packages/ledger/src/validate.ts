import {
  BODIES,
  CONDITIONS,
  DRIVES,
  FUELS,
  MARKETS,
  type Observation,
  PRICE_BASES,
  SELLERS,
  TRANSMISSIONS,
} from "@cca/vocabulary";

/** Returns why an Observation breaks the vocabulary's invariants, or null when it is valid. */
export function invalidReason(o: Observation): string | null {
  switch (o.kind) {
    case "FxRate":
      if (!isCurrency(o.currency)) return "currency must be ISO 4217";
      if (!isDate(o.validFor)) return "validFor must be YYYY-MM-DD";
      if (!isPositive(o.czkPerUnit)) return "czkPerUnit must be > 0";
      return null;
    case "ListingSeen":
      if (!nonEmpty(o.ref)) return "ref is empty";
      if (!nonEmpty(o.url)) return "url is empty";
      if (!oneOf(MARKETS, o.market)) return `unknown market ${o.market}`;
      if (!oneOf(CONDITIONS, o.condition)) return `unknown condition ${o.condition}`;
      if (!oneOf(PRICE_BASES, o.priceBasis)) return `unknown priceBasis ${o.priceBasis}`;
      if (!oneOf(SELLERS, o.seller)) return `unknown seller ${o.seller}`;
      if (!isMoney(o.price)) return "price must be a finite amount >= 0 with an ISO currency";
      if (o.sellerExtras !== undefined) {
        if (!isMoney(o.sellerExtras) || o.sellerExtras.currency !== o.price.currency) {
          return "sellerExtras must be a finite amount >= 0 in the price's currency";
        }
        if (!oneOf(PRICE_BASES, o.sellerExtras.basis)) {
          return `unknown sellerExtras basis ${o.sellerExtras.basis}`;
        }
      }
      if (o.odometerKm !== undefined && !(Number.isFinite(o.odometerKm) && o.odometerKm >= 0)) {
        return "odometerKm must be >= 0";
      }
      if (!Array.isArray(o.photos)) return "photos must be an array";
      return vehicleReason(o.vehicle);
    case "ListingGone":
      return nonEmpty(o.ref) ? null : "ref is empty";
    case "CatalogEntry": {
      const v = o.variant;
      if (!v || !nonEmpty(v.make) || !nonEmpty(v.model)) return "variant make/model is empty";
      if (!v.generation || !nonEmpty(v.generation.slug) || !nonEmpty(v.generation.name)) {
        return "variant generation slug/name is empty";
      }
      if (!oneOf(BODIES, v.body)) return `unknown body ${v.body}`;
      if (!oneOf(FUELS, v.fuel)) return `unknown fuel ${v.fuel}`;
      if (!oneOf(TRANSMISSIONS, v.transmission)) return `unknown transmission ${v.transmission}`;
      if (!isPositive(v.powerKw)) return "powerKw must be > 0";
      if (!v.years || !Number.isInteger(v.years.from)) return "years.from must be a year";
      return null;
    }
    case "VariantFacts":
      return factsReason(o.facts) ?? vehicleReason(o.vehicle);
    case "ListPrice":
      if (!nonEmpty(o.ref)) return "ref is empty";
      if (!oneOf(MARKETS, o.market)) return `unknown market ${o.market}`;
      if (!isMoney(o.price)) return "price must be a finite amount >= 0 with an ISO currency";
      if (!isDate(o.validFrom)) return "validFrom must be YYYY-MM-DD";
      if (o.validTo !== undefined && !(isDate(o.validTo) && o.validTo >= o.validFrom)) {
        return "validTo must be YYYY-MM-DD, not before validFrom";
      }
      return vehicleReason(o.vehicle);
    case "SliceDone":
      return nonEmpty(o.slice) ? null : "slice is empty";
    default:
      return `unknown kind ${String((o as { kind?: unknown }).kind)}`;
  }
}

const NUMERIC_FACTS = new Set([
  "engineCc",
  "seats",
  "doors",
  "euroClass",
  "consumptionL100km",
  "consumptionKwh100km",
  "co2GKm",
  "massKg",
  "lengthMm",
]);

function factsReason(facts: unknown): string | null {
  if (!facts || typeof facts !== "object") return "facts must be an object";
  for (const [field, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    if (field === "drive") {
      if (!oneOf(DRIVES, value)) return `unknown drive ${String(value)}`;
    } else if (!NUMERIC_FACTS.has(field)) {
      return `unknown fact ${field}`;
    } else if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      return `fact ${field} must be a finite number >= 0`;
    }
  }
  return null;
}

function vehicleReason(v: { make?: unknown; model?: unknown } | undefined): string | null {
  if (!v || !nonEmpty(v.make) || !nonEmpty(v.model)) return "vehicle make/model is empty";
  return null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function isCurrency(value: unknown): boolean {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

function isDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isMoney(value: { amount?: unknown; currency?: unknown } | undefined): boolean {
  return (
    !!value &&
    typeof value.amount === "number" &&
    Number.isFinite(value.amount) &&
    value.amount >= 0 &&
    isCurrency(value.currency)
  );
}
