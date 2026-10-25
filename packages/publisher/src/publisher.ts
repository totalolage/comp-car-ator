import {
  type BundleContent,
  type BundleFiles,
  encodeBundle,
  type ListingRow,
  type ModelFile,
  type NewPrice,
  type UsedStats,
  type VariantRow,
} from "@cca/bundle";
import type { Ledger, LedgerListing, LedgerSnapshot } from "@cca/ledger";
import { landedPrice } from "@cca/pricing";
import {
  type CatalogVariant,
  daysBetween,
  type FxTable,
  type IsoDate,
  MARKETS,
  type ModelId,
  type Money,
  pragueDate,
  type VariantId,
  type YearMonth,
} from "@cca/vocabulary";
import { historySampler } from "./history.ts";
import { type Fences, fences, isOutlier, priceCells, quantiles } from "./statistics.ts";

/** Gone Listings stay in model files this many days, then only feed `history`. */
const GONE_KEPT_DAYS = 30;
const PHOTOS_KEPT = 3;

export interface PublishOptions {
  /** Publish time; also the valuation day for landed prices. */
  now: Date;
  /** Transport-to-CZ assumption for landed prices, CZK. */
  transportCzk?: number;
}

/**
 * Publisher's interface: turns the Ledger's current state into Bundle files. Pure apart
 * from reading the Ledger; deterministic for a given Ledger state and `now` (byte-identical
 * files). Rules for statistics, outliers, new prices and compaction: docs/adr/0010-publisher-statistics.md.
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
  const history = historySampler(today);

  // One streaming pass: model-file rows for active and recently gone Listings, history
  // samples for every used Listing ever seen.
  const rowsByModel = new Map<ModelId, ListingRow[]>();
  for (const listing of snapshot.listings()) {
    if (listing.resolution.status === "unmatched") continue;
    const modelId = listing.resolution.modelId;
    if (listing.condition === "used") {
      history.add(
        modelId,
        listing.market,
        listing.firstSeen,
        listing.gone,
        listing.priceHistory.map((h) => ({ date: h.date, priceCzk: toCzk(h.price, fx) })),
      );
    }
    if (listing.gone !== null && daysBetween(listing.gone, today) > GONE_KEPT_DAYS) continue;
    const row = listingRow(listing, fx, today, transportCzk);
    if (row) push(rowsByModel, modelId, row);
  }

  const listPrices = currentListPrices(snapshot, fx, today);
  const variantsByModel = groupBy(snapshot.catalog, (v) => v.modelId);
  const variantRows: VariantRow[] = [];
  const models: ModelFile[] = [];
  const listingCounts = new Map<ModelId, number>();
  for (const [modelId, variants] of [...variantsByModel].sort(byKey)) {
    const rows = (rowsByModel.get(modelId) ?? []).sort((a, b) => compare(a.id, b.id));
    const active = rows.filter((l) => !l.gone);
    markOutliers(rows, active);
    const used = groupBy(
      active.filter((l) => l.condition === "used" && l.variantId !== null),
      (l) => l.variantId as VariantId,
    );
    const dealerNew = groupBy(active.filter(isDealerNewCz), (l) => l.variantId as VariantId);
    variants.sort((a, b) => compare(a.id, b.id));
    for (const variant of variants) {
      variantRows.push(
        variantRow(
          variant,
          used.get(variant.id) ?? [],
          newPrice(listPrices.get(variant.id), dealerNew.get(variant.id)),
        ),
      );
    }
    listingCounts.set(modelId, active.filter((l) => l.condition === "used").length);
    models.push(modelFile(variants, rows, active, history.history(modelId)));
  }

  const makes = new Map(snapshot.catalog.map((v) => [v.makeId, v.make]));
  return {
    manifest: {
      format: 2,
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
        listings: models.reduce((n, m) => n + m.listings.length, 0),
      },
    },
    catalog: {
      makes: [...makes].sort(byKey).map(([id, name]) => ({ id, name })),
      models: models.map((m) => ({
        id: m.model.id,
        makeId: m.model.makeId,
        name: m.model.name,
        listingCount: listingCounts.get(m.model.id) ?? 0,
      })),
      variants: variantRows,
    },
    models,
  };
}

/**
 * Current CZ list prices per Variant (gross CZK): per offer, the latest edition already in
 * force today, unless it has expired. An expired edition is never replaced by an older one.
 */
function currentListPrices(
  snapshot: LedgerSnapshot,
  fx: FxTable,
  today: IsoDate,
): Map<VariantId, number[]> {
  const current = new Map<string, LedgerSnapshot["listPrices"][number]>();
  for (const listPrice of snapshot.listPrices) {
    if (listPrice.market !== "CZ" || listPrice.validFrom > today) continue;
    const seen = current.get(listPrice.offer);
    if (!seen || seen.validFrom < listPrice.validFrom) current.set(listPrice.offer, listPrice);
  }
  const prices = new Map<VariantId, number[]>();
  for (const listPrice of current.values()) {
    if (listPrice.validTo !== undefined && listPrice.validTo < today) continue;
    if (listPrice.resolution.status !== "matched") continue;
    const czk = toCzk(listPrice.price, fx);
    if (czk !== null) push(prices, listPrice.resolution.variantId, czk);
  }
  return prices;
}

/** Manufacturer list prices win; otherwise kept Czech dealer Listings of new cars. */
function newPrice(listPrices?: number[], dealerNew?: ListingRow[]): NewPrice | undefined {
  if (listPrices?.length) {
    return { ...range(listPrices), source: "list", count: listPrices.length };
  }
  const landed = (dealerNew ?? []).flatMap((l) => (l.landed ? [l.landed.totalCzk] : []));
  if (landed.length) return { ...range(landed), source: "dealer", count: landed.length };
  return undefined;
}

function isDealerNewCz(l: ListingRow): boolean {
  return (
    l.market === "CZ" &&
    l.condition === "new" &&
    l.seller === "dealer" &&
    l.variantId !== null &&
    !l.excluded
  );
}

/**
 * The outlier rule: cohorts are resolution target (Variant, or the model) × Market ×
 * Condition over active Listings; gone Listings in the file are judged by their cohort's
 * fences too, so the flag means the same thing everywhere.
 */
function markOutliers(rows: ListingRow[], active: ListingRow[]): void {
  const cohort = (l: ListingRow) => `${l.variantId ?? ""}|${l.market}|${l.condition}`;
  const cohortFences = new Map<string, Fences | null>();
  for (const [key, ls] of groupBy(active, cohort)) {
    cohortFences.set(key, fences(ls.map((l) => l.priceCzk)));
  }
  for (const row of rows) {
    if (isOutlier(row.priceCzk, cohortFences.get(cohort(row)) ?? null)) row.excluded = true;
  }
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
      sellerExtras: listing.sellerExtras,
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
    sellerExtras: listing.sellerExtras && {
      amount: listing.sellerExtras.amount,
      currency: listing.sellerExtras.currency,
    },
    priceCzk,
    landed: landed.ok ? landed.landed : null,
    seller: listing.seller,
    location:
      [listing.location?.city, listing.location?.region].filter(Boolean).join(", ") || undefined,
    photos: listing.photos.slice(0, PHOTOS_KEPT),
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
  activeUsed: ListingRow[],
  newPriceCzk: NewPrice | undefined,
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
    newPriceCzk,
    used: usedStats(activeUsed),
  });
}

function usedStats(listings: ListingRow[]): UsedStats | null {
  if (listings.length === 0) return null;
  const kept = listings.filter((l) => !l.excluded);
  const years = listings.flatMap((l) => (l.year === undefined ? [] : [l.year]));
  const byMarket: UsedStats["byMarket"] = {};
  const markets: UsedStats["markets"] = {};
  for (const market of MARKETS) {
    const count = listings.filter((l) => l.market === market).length;
    if (count) markets[market] = count;
    const prices = quantiles(kept.filter((l) => l.market === market).map((l) => l.priceCzk));
    if (prices) byMarket[market] = prices;
  }
  const bySource = groupBy(listings, (l) => l.source);
  return {
    count: listings.length,
    priceCzk: quantiles(kept.map((l) => l.priceCzk)),
    landedCzk: quantiles(kept.flatMap((l) => (l.landed ? [l.landed.totalCzk] : []))),
    odometerKm: quantiles(kept.flatMap((l) => (l.odometerKm === undefined ? [] : [l.odometerKm]))),
    byMarket,
    years: years.length ? range(years) : null,
    markets,
    sources: Object.fromEntries([...bySource].sort(byKey).map(([id, ls]) => [id, ls.length])),
    groups: [...groupBy(listings, (l) => `${l.market}|${l.source}`)].sort(byKey).map(([, ls]) => {
      const first = ls[0] as ListingRow;
      const kms = ls.flatMap((l) => (l.odometerKm === undefined ? [] : [l.odometerKm]));
      const ys = ls.flatMap((l) => (l.year === undefined ? [] : [l.year]));
      return {
        market: first.market,
        source: first.source,
        count: ls.length,
        priceCzk: range(ls.map((l) => l.priceCzk)),
        odometerKm: kms.length ? range(kms) : null,
        years: ys.length ? range(ys) : null,
      };
    }),
  };
}

function modelFile(
  variants: CatalogVariant[],
  rows: ListingRow[],
  active: ListingRow[],
  history: ModelFile["history"],
): ModelFile {
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
  return {
    model: { id: first.modelId, makeId: first.makeId, make: first.make, name: first.model },
    generations: [...generations.values()].sort((a, b) => a.from - b.from || compare(a.id, b.id)),
    variantIds: variants.map((v) => v.id),
    listings: rows,
    stats: priceCells(active.filter((l) => !l.excluded)),
    history,
  };
}

/** True/false when the shown inspection date decides it; undefined (unknown) otherwise. */
function inspectionValid(until: YearMonth | undefined, today: IsoDate): boolean | undefined {
  if (!until) return undefined;
  const thisYear = Number(today.slice(0, 4));
  if (until.month === undefined) return until.year === thisYear ? undefined : until.year > thisYear;
  return until.year * 12 + until.month >= thisYear * 12 + Number(today.slice(5, 7));
}

function toCzk(money: Money, fx: FxTable): number | null {
  if (money.currency === "CZK") return Math.round(money.amount);
  const rate = fx[money.currency];
  return rate ? Math.round(money.amount * rate.czkPerUnit) : null;
}

function range(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
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
  return compare(a[0], b[0]);
}

/** Code-unit order: unlike localeCompare, the same on every machine. */
function compare<K extends string | number>(a: K, b: K): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Drops undefined fields so the JSON stays compact and stable. */
function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
