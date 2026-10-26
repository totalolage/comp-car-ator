/**
 * Deterministic synthetic Ledger input for scale tests and the measured run
 * (scripts/scale.ts): a catalog of `variants` Variants and `listings` Listings over `days`
 * daily runs, with Zipf-skewed model popularity, three Markets, price changes, gone Listings
 * and a few outliers. Not used by `publish`.
 */
import type { RunInfo } from "@cca/ledger";
import type {
  Body,
  Condition,
  Fuel,
  IsoDate,
  Market,
  Observation,
  Seller,
  Transmission,
  VariantSpec,
} from "@cca/vocabulary";

export interface SyntheticOptions {
  listings: number;
  variants: number;
  /** Daily runs ending on `end` (inclusive). */
  days: number;
  end: IsoDate;
  seed?: number;
}

export interface SyntheticRun {
  run: RunInfo;
  observations: Observation[];
}

const VARIANTS_PER_GENERATION = 10;
const GENERATIONS_PER_MODEL = 2;
const MODELS_PER_MAKE = 12;
const MEAN_LIFE_DAYS = 60;
const BODIES: Body[] = ["hatchback", "wagon", "sedan", "suv"];
const FUELS: Fuel[] = ["petrol", "diesel", "hev", "bev"];
const TRANSMISSIONS: Transmission[] = ["manual", "automatic"];
const SOURCES: Record<Market, { id: string; currency: "CZK" | "EUR" }> = {
  CZ: { id: "sauto", currency: "CZK" },
  DE: { id: "autoscout24-de", currency: "EUR" },
  AT: { id: "autoscout24-at", currency: "EUR" },
};
const EUR_CZK = 24.5;

interface Listing {
  ref: string;
  market: Market;
  condition: Condition;
  seller: Seller;
  variant: VariantSpec;
  /** Breaks Resolution: 0 = matched, 1 = model only (power off), 2 = unknown make. */
  resolution: 0 | 1 | 2;
  year: number;
  odometerKm: number;
  start: number;
  /** Day it is reported gone, or past the end. */
  end: number;
  prices: { day: number; amount: number }[];
}

/** Runs in recording order: catalog and FX first, then one run per Source and day. */
export function* syntheticRuns(options: SyntheticOptions): Generator<SyntheticRun> {
  const random = mulberry32(options.seed ?? 1);
  const endYear = Number(options.end.slice(0, 4));
  const variants = catalog(options.variants, endYear);
  const models = Math.ceil(variants.length / (VARIANTS_PER_GENERATION * GENERATIONS_PER_MODEL));
  const pickModel = zipf(models, 0.9, random);
  const endDay = Date.parse(`${options.end}T00:00:00Z`) / 86_400_000;
  const firstDay = endDay - options.days + 1;
  const dayDate = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
  const runAt = (day: number) => new Date(`${dayDate(day)}T06:00:00Z`);

  yield {
    run: { source: "register", mode: "full", startedAt: runAt(firstDay) },
    observations: variants.map((variant) => ({ kind: "CatalogEntry", variant })),
  };
  yield {
    run: { source: "cnb", mode: "incremental", startedAt: runAt(firstDay) },
    observations: [
      { kind: "FxRate", currency: "EUR", validFor: dayDate(firstDay), czkPerUnit: EUR_CZK },
    ],
  };

  // Listings stay compact until their run is yielded, so a large Ledger fits in memory.
  const events = new Map<number, [listing: Listing, amount: number | null][]>();
  const emit = (day: number, listing: Listing, amount: number | null) => {
    const list = events.get(day);
    if (list) list.push([listing, amount]);
    else events.set(day, [[listing, amount]]);
  };
  for (let i = 0; i < options.listings; i++) {
    const listing = syntheticListing(i, variants, pickModel(), random, firstDay, endDay, endYear);
    for (const { day, amount } of listing.prices) emit(day, listing, amount);
    if (listing.end <= endDay) emit(listing.end, listing, null);
  }

  for (let day = firstDay; day <= endDay; day++) {
    const today = events.get(day) ?? [];
    events.delete(day);
    for (const market of ["CZ", "DE", "AT"] as const) {
      yield {
        run: { source: SOURCES[market].id, mode: "incremental", startedAt: runAt(day) },
        observations: today
          .filter(([listing]) => listing.market === market)
          .map(([listing, amount]) => observation(listing, amount)),
      };
    }
  }
}

function observation(listing: Listing, amount: number | null): Observation {
  if (amount === null) return { kind: "ListingGone", ref: listing.ref };
  const { currency } = SOURCES[listing.market];
  return {
    kind: "ListingSeen",
    ref: listing.ref,
    url: `https://example.test/${listing.market}/${listing.ref}`,
    market: listing.market,
    condition: listing.condition,
    vehicle: {
      make: listing.resolution === 2 ? "Unknownmake" : listing.variant.make,
      model: listing.variant.model,
      ...(listing.condition === "new" ? {} : { firstRegistration: { year: listing.year } }),
      manufactureYear: listing.year,
      body: listing.variant.body,
      fuel: listing.variant.fuel,
      powerKw: listing.variant.powerKw + (listing.resolution === 1 ? 40 : 0),
      transmission: listing.variant.transmissions?.[0],
      trim: "Style",
    },
    odometerKm: listing.odometerKm,
    price: { amount: currency === "EUR" ? Math.round(amount / EUR_CZK) : amount, currency },
    priceBasis: "gross",
    seller: listing.seller,
    location: { city: "Brno" },
    photos: Array.from(
      { length: 12 },
      (_, p) => `https://img.example.test/${listing.ref}/${p}.jpg`,
    ),
  };
}

function catalog(count: number, endYear: number): VariantSpec[] {
  const variants: VariantSpec[] = [];
  for (let i = 0; i < count; i++) {
    const g = Math.floor(i / VARIANTS_PER_GENERATION);
    const m = Math.floor(g / GENERATIONS_PER_MODEL);
    const make = Math.floor(m / MODELS_PER_MAKE);
    const k = i % VARIANTS_PER_GENERATION;
    const newer = g % GENERATIONS_PER_MODEL === 1;
    const from = newer ? endYear - 5 : endYear - 13;
    const electric = FUELS[Math.floor(k / 2) % FUELS.length] === "bev";
    variants.push({
      make: `Make${make}`,
      model: `Model${m}`,
      generation: {
        slug: newer ? "mk2" : "mk1",
        name: newer ? "II" : "I",
        from,
        ...(newer ? {} : { to: endYear - 6 }),
      },
      body: BODIES[k % BODIES.length] as Body,
      fuel: FUELS[Math.floor(k / 2) % FUELS.length] as Fuel,
      // 20 kW apart, so ±3 kW Resolution never confuses neighbours.
      powerKw: 60 + 20 * k,
      transmissions: [TRANSMISSIONS[k % 2] as Transmission],
      years: newer ? { from } : { from, to: endYear - 6 },
      // Full specs, as register + EEA data give, so the catalog's size is realistic.
      drive: k % 5 === 4 ? "awd" : "fwd",
      seats: 5,
      doors: 5,
      euroClass: 6,
      ...(electric
        ? { consumptionKwh100km: 15 + (k % 4) }
        : {
            engineCc: 999 + 250 * (k % 6),
            consumptionL100km: 4 + (k % 5) * 0.4,
            co2GKm: 95 + 9 * (k % 5),
          }),
      massKg: 1_200 + 37 * k,
      lengthMm: 4_100 + 23 * (m % 20),
    });
  }
  return variants;
}

function syntheticListing(
  i: number,
  variants: VariantSpec[],
  model: number,
  random: () => number,
  firstDay: number,
  endDay: number,
  endYear: number,
): Listing {
  const perModel = VARIANTS_PER_GENERATION * GENERATIONS_PER_MODEL;
  const variant = variants[
    Math.min(model * perModel + Math.floor(random() * perModel), variants.length - 1)
  ] as VariantSpec;
  const r = random();
  const market: Market = r < 0.5 ? "CZ" : r < 0.9 ? "DE" : "AT";
  const c = random();
  const condition: Condition = c < 0.85 ? "used" : c < 0.95 ? "new" : "demo";
  const from = variant.years.from;
  const to = variant.years.to ?? endYear;
  const year = condition === "used" ? from + Math.floor(random() * (to - from + 1)) : endYear;
  const age = endYear - year;
  const odometerKm =
    condition === "new"
      ? 10
      : condition === "demo"
        ? 3_000 + Math.floor(random() * 9_000)
        : Math.round((age + random()) * (8_000 + random() * 17_000));
  const newPrice = 300_000 + variant.powerKw * 5_000;
  let amount = Math.round(
    newPrice * 0.85 ** age * Math.max(0.3, 1 - odometerKm / 600_000) * (0.85 + random() * 0.3),
  );
  const o = random();
  if (o < 0.005) amount = 1;
  else if (o < 0.01) amount *= 10;
  const start = firstDay + Math.floor(random() * (endDay - firstDay + 1));
  const life = Math.max(1, Math.round(-Math.log(1 - random()) * MEAN_LIFE_DAYS));
  const prices = [{ day: start, amount }];
  if (random() < 0.3 && start + 20 < Math.min(start + life, endDay + 1)) {
    prices.push({ day: start + 20, amount: Math.round(amount * 0.95) });
  }
  const s = random();
  return {
    ref: `L${i}`,
    market,
    condition,
    seller: random() < 0.8 || condition !== "used" ? "dealer" : "private",
    variant,
    resolution: s < 0.9 ? 0 : s < 0.98 ? 1 : 2,
    year,
    odometerKm,
    start,
    end: start + life,
    prices,
  };
}

/** Zipf-distributed index in [0, n). */
function zipf(n: number, exponent: number, random: () => number): () => number {
  const cumulative: number[] = [];
  let total = 0;
  for (let k = 1; k <= n; k++) {
    total += 1 / k ** exponent;
    cumulative.push(total);
  }
  return () => {
    const target = random() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
