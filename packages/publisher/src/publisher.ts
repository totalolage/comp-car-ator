import {
  type BundleContent,
  type BundleFiles,
  encodeBundle,
  type ListingRow,
  type ModelFile,
  ODOMETER_BANDS,
  type OdometerBand,
  type Quantiles,
  type UsedStats,
  type VariantRow,
} from "@cca/bundle";
import type { Ledger, LedgerListing } from "@cca/ledger";
import { landedPrice } from "@cca/pricing";
import {
  type CatalogVariant,
  daysBetween,
  type FxTable,
  type IsoDate,
  type Market,
  type ModelId,
  type Money,
  pragueDate,
  type YearMonth,
} from "@cca/vocabulary";

export interface PublishOptions {
  /** Publish time; also the valuation day for landed prices. */
  now: Date;
  /** Transport-to-CZ assumption for landed prices, CZK. */
  transportCzk?: number;
}

/**
 * Publisher's interface: turns the Ledger's current state into Bundle files. Pure apart
 * from reading the Ledger; deterministic for a given Ledger state and `now`.
 *
 * Listings the Resolver cannot place on a known model are left out (Wave 1 stream 11 will
 * shrink that set). Listings whose currency has no FX rate are left out too.
 */
export function publish(ledger: Ledger, options: PublishOptions): BundleFiles {
  return encodeBundle(buildContent(ledger, options));
}

function buildContent(ledger: Ledger, { now, transportCzk }: PublishOptions): BundleContent {
  const snapshot = ledger.snapshot();
  const today = pragueDate(now);
  const fx = snapshot.fx;

  const listingsByModel = new Map<ModelId, ListingRow[]>();
  for (const listing of snapshot.listings()) {
    const row = listingRow(listing, fx, today, transportCzk);
    if (!row || listing.resolution.status === "unmatched") continue;
    const modelId = listing.resolution.modelId;
    listingsByModel.set(modelId, [...(listingsByModel.get(modelId) ?? []), row]);
  }

  // Current CZ new prices: per offer, the latest edition already in force today.
  const current = new Map<string, (typeof snapshot.listPrices)[number]>();
  for (const listPrice of snapshot.listPrices) {
    if (listPrice.market !== "CZ" || listPrice.validFrom > today) continue;
    const seen = current.get(listPrice.offer);
    if (!seen || seen.validFrom < listPrice.validFrom) current.set(listPrice.offer, listPrice);
  }
  const newPrices = new Map<string, number[]>();
  for (const listPrice of current.values()) {
    if (listPrice.resolution.status !== "matched") continue;
    const czk = toCzk(listPrice.price, fx);
    if (czk === null) continue;
    const id = listPrice.resolution.variantId;
    newPrices.set(id, [...(newPrices.get(id) ?? []), czk]);
  }

  const variantsByModel = groupBy(snapshot.catalog, (v) => v.modelId);
  const variantRows: VariantRow[] = [];
  const models: ModelFile[] = [];
  for (const [modelId, variants] of [...variantsByModel].sort(byKey)) {
    const listings = (listingsByModel.get(modelId) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    for (const variant of variants.sort((a, b) => a.id.localeCompare(b.id))) {
      const prices = newPrices.get(variant.id);
      variantRows.push(
        variantRow(
          variant,
          listings.filter((l) => l.variantId === variant.id && isActiveUsed(l)),
          prices,
        ),
      );
    }
    models.push(modelFile(variants, listings, today));
  }

  const makes = new Map(snapshot.catalog.map((v) => [v.makeId, v.make]));
  const listingCount = models.reduce((n, m) => n + m.listings.length, 0);
  return {
    manifest: {
      format: 1,
      generatedAt: now.toISOString(),
      fx,
      sources: snapshot.sources.map((s) => ({
        id: s.id,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
      })),
      counts: {
        makes: makes.size,
        models: models.length,
        variants: variantRows.length,
        listings: listingCount,
      },
    },
    catalog: {
      makes: [...makes].sort(byKey).map(([id, name]) => ({ id, name })),
      models: models.map((m) => ({
        id: m.model.id,
        makeId: m.model.makeId,
        name: m.model.name,
        listingCount: m.listings.filter(isActiveUsed).length,
      })),
      variants: variantRows,
    },
    models,
  };
}

function listingRow(
  listing: LedgerListing,
  fx: FxTable,
  today: IsoDate,
  transportCzk: number | undefined,
): ListingRow | null {
  const priceCzk = toCzk(listing.price, fx);
  if (priceCzk === null) return null;
  const v = listing.vehicle;
  const landed = landedPrice(
    {
      price: listing.price,
      market: listing.market,
      seller: listing.seller,
      priceBasis: listing.priceBasis,
      condition: listing.condition,
      firstRegistration: v.firstRegistration,
      odometerKm: listing.odometerKm,
      fuel: v.fuel,
      euroClass: v.euroClass,
      inspectionValid: inspectionValid(listing.inspectionValidUntil, today),
    },
    { fx, today, transportCzk },
  );
  const started =
    listing.listedAt && listing.listedAt < listing.firstSeen ? listing.listedAt : listing.firstSeen;
  return omitUndefined({
    id: listing.id,
    source: listing.source,
    url: listing.url,
    market: listing.market,
    condition: listing.condition,
    variantId: listing.resolution.status === "matched" ? listing.resolution.variantId : null,
    title: [v.make, v.model, v.trim].filter(Boolean).join(" "),
    year: v.firstRegistration?.year ?? v.manufactureYear,
    month: v.firstRegistration?.month,
    odometerKm: listing.odometerKm,
    body: v.body,
    fuel: v.fuel,
    powerKw: v.powerKw,
    transmission: v.transmission,
    price: listing.price,
    priceCzk,
    landed: landed.ok ? landed.landed : null,
    seller: listing.seller,
    location:
      [listing.location?.city, listing.location?.region].filter(Boolean).join(", ") || undefined,
    photos: listing.photos,
    firstSeen: listing.firstSeen,
    lastSeen: listing.lastSeen,
    gone: listing.gone ?? undefined,
    daysOnMarket: daysBetween(started, listing.gone ?? today),
    priceHistory: listing.priceHistory.flatMap((h) => {
      const czk = toCzk(h.price, fx);
      return czk === null ? [] : [{ date: h.date, price: h.price, priceCzk: czk }];
    }),
  });
}

function variantRow(
  variant: CatalogVariant,
  listings: ListingRow[],
  newPrices?: number[],
): VariantRow {
  return omitUndefined({
    id: variant.id,
    makeId: variant.makeId,
    modelId: variant.modelId,
    generationId: variant.generationId,
    make: variant.make,
    model: variant.model,
    generation: variant.generation.name,
    years: variant.years,
    body: variant.body,
    fuel: variant.fuel,
    powerKw: variant.powerKw,
    transmission: variant.transmission,
    drive: variant.drive,
    engineCc: variant.engineCc,
    seats: variant.seats,
    doors: variant.doors,
    euroClass: variant.euroClass,
    consumptionL100km: variant.consumptionL100km,
    consumptionKwh100km: variant.consumptionKwh100km,
    co2GKm: variant.co2GKm,
    massKg: variant.massKg,
    lengthMm: variant.lengthMm,
    newPriceCzk: newPrices?.length
      ? { min: Math.min(...newPrices), max: Math.max(...newPrices) }
      : undefined,
    used: usedStats(listings),
  });
}

function usedStats(listings: ListingRow[]): UsedStats | null {
  if (listings.length === 0) return null;
  const years = listings.flatMap((l) => (l.year === undefined ? [] : [l.year]));
  const markets: Partial<Record<Market, number>> = {};
  const sources: Record<string, number> = {};
  for (const l of listings) {
    markets[l.market] = (markets[l.market] ?? 0) + 1;
    sources[l.source] = (sources[l.source] ?? 0) + 1;
  }
  return {
    count: listings.length,
    priceCzk: quantiles(listings.map((l) => l.priceCzk)) as Quantiles,
    landedCzk: quantiles(listings.flatMap((l) => (l.landed ? [l.landed.totalCzk] : []))),
    odometerKm: quantiles(
      listings.flatMap((l) => (l.odometerKm === undefined ? [] : [l.odometerKm])),
    ),
    years: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
    markets,
    sources,
    groups: [...groupBy(listings, (l) => `${l.market}|${l.source}`)].sort(byKey).map(([, ls]) => {
      const first = ls[0] as ListingRow;
      const prices = ls.map((l) => l.priceCzk);
      const kms = ls.flatMap((l) => (l.odometerKm === undefined ? [] : [l.odometerKm]));
      const ys = ls.flatMap((l) => (l.year === undefined ? [] : [l.year]));
      return {
        market: first.market,
        source: first.source,
        count: ls.length,
        priceCzk: { min: Math.min(...prices), max: Math.max(...prices) },
        odometerKm: kms.length ? { min: Math.min(...kms), max: Math.max(...kms) } : null,
        years: ys.length ? { min: Math.min(...ys), max: Math.max(...ys) } : null,
      };
    }),
  };
}

function modelFile(variants: CatalogVariant[], listings: ListingRow[], today: IsoDate): ModelFile {
  const first = variants[0] as CatalogVariant;
  const generations = new Map(
    variants.map((v) => [
      v.generationId,
      omitUndefined({
        id: v.generationId,
        name: v.generation.name,
        from: v.generation.from,
        to: v.generation.to,
      }),
    ]),
  );
  const active = listings.filter(isActiveUsed);
  const byYear = groupBy(
    active.filter((l) => l.year !== undefined),
    (l) => l.year as number,
  );
  const byBand = groupBy(
    active.filter((l) => l.odometerKm !== undefined),
    (l) => odometerBand(l.odometerKm as number),
  );
  return {
    model: { id: first.modelId, makeId: first.makeId, make: first.make, name: first.model },
    generations: [...generations.values()].sort((a, b) => a.from - b.from),
    variantIds: variants.map((v) => v.id),
    listings,
    stats: {
      byYear: [...byYear].sort(byKey).map(([year, ls]) => ({
        year,
        count: ls.length,
        medianCzk: median(ls.map((l) => l.priceCzk)),
      })),
      byOdometerBand: ODOMETER_BANDS.filter((band) => byBand.has(band)).map((band) => {
        const ls = byBand.get(band) as ListingRow[];
        return { band, count: ls.length, medianCzk: median(ls.map((l) => l.priceCzk)) };
      }),
    },
    history: priceHistory(
      listings.filter((l) => l.condition === "used"),
      today,
    ),
  };
}

/**
 * Median asking price of the model's used listings active on each day something changed
 * (a listing appeared, went, or changed price). Converted at today's rate so the line
 * shows price moves, not FX moves. TODO(wave1-stream12): per-generation lines, sampling.
 */
function priceHistory(listings: ListingRow[], today: IsoDate): ModelFile["history"] {
  const days = new Set<IsoDate>([today]);
  for (const l of listings) {
    days.add(l.firstSeen);
    if (l.gone) days.add(l.gone);
    for (const h of l.priceHistory) days.add(h.date);
  }
  return [...days]
    .filter((d) => d <= today)
    .sort()
    .flatMap((day) => {
      const prices = listings.flatMap((l) => {
        if (l.firstSeen > day || (l.gone && l.gone <= day)) return [];
        const point = l.priceHistory.filter((h) => h.date <= day).at(-1);
        if (!point) return [];
        return [point.priceCzk];
      });
      return prices.length ? [{ date: day, count: prices.length, medianCzk: median(prices) }] : [];
    });
}

/** True/false when the shown inspection date decides it; undefined (unknown) otherwise. */
function inspectionValid(until: YearMonth | undefined, today: IsoDate): boolean | undefined {
  if (!until) return undefined;
  const thisYear = Number(today.slice(0, 4));
  if (until.month === undefined) return until.year === thisYear ? undefined : until.year > thisYear;
  return until.year * 12 + until.month >= thisYear * 12 + Number(today.slice(5, 7));
}

function isActiveUsed(l: ListingRow): boolean {
  return !l.gone && l.condition === "used";
}

function odometerBand(km: number): OdometerBand {
  if (km < 50_000) return "0-50k";
  if (km < 100_000) return "50-100k";
  if (km < 150_000) return "100-150k";
  if (km < 200_000) return "150-200k";
  return "200k+";
}

function toCzk(money: Money, fx: FxTable): number | null {
  if (money.currency === "CZK") return Math.round(money.amount);
  const rate = fx[money.currency];
  return rate ? Math.round(money.amount * rate.czkPerUnit) : null;
}

function quantiles(values: number[]): Quantiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return Math.round(
      (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo),
    );
  };
  return { min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), max: at(1) };
}

function median(values: number[]): number {
  return (quantiles(values) as Quantiles).median;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function byKey<K extends string | number>(a: [K, unknown], b: [K, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** Drops undefined fields so the JSON stays compact and stable. */
function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
