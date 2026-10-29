/**
 * Sauto.cz: new, demo and used passenger cars from the site's JSON API.
 *
 * - Search `GET /api/v1/items/search` serves thin items (make/model, price, odometer, fuel,
 *   gearbox, a few photos, the dealer's premise) in `sorting_date` order, newest first;
 *   `sorting_date` moves to the last edit or top-up. Any one query reaches only its first
 *   10,000 results (`offset + limit <= 10000`, else HTTP 422 `too_high_offset`).
 * - Detail `GET /api/v1/items/{id}` adds what the Resolver and Pricing need (power, body,
 *   drive, seats, VAT deductibility, condition, every photo); 404 once the listing is removed.
 *   The Ledger stores each ListingSeen whole, so every listing yielded carries its detail.
 *
 * incremental: walks the newest-first order down to the last run (a day back on a first run),
 *   in price halves where it outgrows the 10,000-result window, and reads a detail for every
 *   listing on the way that the Ledger does not know, up to `budget`; past it the run fails
 *   and the next one resumes (see `incremental`).
 * full: a census sliced by condition and price band; a band over `sliceLimit` results is
 *   halved until each fits (2,000 by default: some 40 minutes of detail pages, well within
 *   one run). Slices done earlier in the census are skipped before any split. Each band
 *   yields SliceDone once one pass over it reaches the band's total; a band that stays
 *   short fails the run at its end.
 *
 * In scope: priced listings (not price by agreement) made in 2000 or later. Searches filter
 * the year (`vehicle_age_from`); listings that slip through are skipped.
 */
import {
  type Body,
  type Condition,
  type Fuel,
  type ListingGone,
  type ListingSeen,
  type Observation,
  pragueDate,
  type Transmission,
  type VehicleDescriptor,
  type YearMonth,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

const API = "https://www.sauto.cz/api/v1/items";
const SITE = "https://www.sauto.cz";
/** Passenger cars. */
const CATEGORY = 838;
/** Results one query can reach: `offset + limit` may not exceed it. */
const WINDOW = 10_000;
/** Incremental runs re-check listings changed this long before the last run's start. */
const SINCE_MARGIN_MS = 2 * 3_600_000;
/** How far back an incremental run without a last run looks: a day, as a daily run would. */
const FIRST_RUN_LOOKBACK_MS = 24 * 3_600_000;
/**
 * Most results in one full-run slice, by default: its detail pages take about 40 minutes
 * (1 request a second), so a run cut off at its time limit loses little of a slice.
 */
const SLICE_LIMIT = 2_000;
/** Upper bound of the bisected price bands, CZK; one open band above it. */
const PRICE_TOP = 2 ** 27;
/** Earliest year in scope, of manufacture or else first registration (`vehicle_age_from`). */
const FIRST_YEAR = 2000;

/** Sauto `condition_seo` values in scope; damaged cars and veterans are left out. */
const CONDITIONS = { nove: "new", predvadeci: "demo", ojete: "used" } as const;
type ConditionSeo = keyof typeof CONDITIONS;
const CONDITION_SEOS = Object.keys(CONDITIONS) as ConditionSeo[];
/** `condition_cb.value` → Condition. */
const CONDITION_CODES: Record<number, Condition> = { 1: "new", 2: "used", 4: "demo" };

export interface SautoOptions {
  /**
   * Narrow the harvest to one make or model, as Sauto's `manufacturer_model_seo` filter
   * ("skoda", "skoda:octavia"). Also names the Source's `scope`.
   */
  manufacturerModel?: string;
  /** Results per search page. Default 100. */
  pageSize?: number;
  /** A full-run slice with more results than this is halved by price. Default 2,000. */
  sliceLimit?: number;
  /**
   * Detail pages an incremental run may read. Past it the run fails after yielding what it
   * read, and the next one picks up the rest. Default 2,400: some 40 minutes.
   */
  budget?: number;
}

export function sautoSource(options: SautoOptions = {}): Source {
  const pageSize = options.pageSize ?? 100;
  const sliceLimit = Math.min(options.sliceLimit ?? SLICE_LIMIT, WINDOW - pageSize);
  const budget = options.budget ?? 2_400;
  const filter = options.manufacturerModel;
  return {
    id: "sauto",
    ...(filter ? { scope: filter } : {}),
    async *harvest(ctx: HarvestContext): AsyncIterable<Observation> {
      const run = new Run(ctx, filter, pageSize);
      yield* ctx.mode === "incremental" ? run.incremental(budget) : run.full(sliceLimit);
    },
  };
}

/** Prices `from` up to but excluding `to` (open when `to` is absent), CZK. */
interface Band {
  from: number;
  to?: number;
}

interface Query {
  conditions: ConditionSeo[];
  band?: Band;
  offset: number;
}

class Run {
  /** Refs already yielded in this run: pages overlap and bumped listings shift between them. */
  private readonly done = new Set<string>();
  private readonly ctx: HarvestContext;
  private readonly filter: string | undefined;
  private readonly pageSize: number;

  constructor(ctx: HarvestContext, filter: string | undefined, pageSize: number) {
    this.ctx = ctx;
    this.filter = filter;
    this.pageSize = pageSize;
  }

  /**
   * The listings moved up the order since the last run (a day back on a first run). Top-ups
   * move some 5,000 older listings a day (95 of the newest 100 on 2026-10-28), so a detail
   * page each would take longer than the hour the run may have. A known listing gets a
   * ListingPriceSeen from its search item instead, so its price changes land daily (an edit
   * moves it up). Details go only to the listings the Ledger does not know: those created
   * since the last run first, then older ones (published days after they were drafted, back
   * after their removal, or not yet reached by the census), newest first, up to `budget`.
   * Past it the run fails once it has yielded what it read, so `lastRunAt` stays and the next
   * run walks from the same point, skipping the listings now known. Nothing moved up is
   * dropped: it is read, or the run fails. (A first run has no last run to hold: what it
   * leaves, like what moved before its day, waits for the census.)
   */
  async *incremental(budget: number): AsyncIterable<Observation> {
    const { checkpoint, now } = this.ctx;
    const from = checkpoint.lastRunAt
      ? checkpoint.lastRunAt.getTime() - SINCE_MARGIN_MS
      : now.getTime() - FIRST_RUN_LOOKBACK_MS;
    const since = pragueLocal(new Date(from));
    const created: Item[] = [];
    const older: Item[] = [];
    const met = new Set<string>();
    for await (const item of this.moved(since)) {
      if (isSkipped(item)) continue;
      const ref = refOf(item);
      if (ref !== undefined) {
        if (met.has(ref)) continue;
        met.add(ref);
        if (checkpoint.isKnown(ref)) {
          // The search price is the field the detail's ListingSeen carries, so a known
          // listing's price is kept daily without its detail page.
          if (typeof item.price === "number") {
            yield { kind: "ListingPriceSeen", ref, price: { amount: item.price, currency: "CZK" } };
          }
          continue;
        }
      }
      (text(item.create_date) >= since ? created : older).push(item);
    }
    const unknown = [...created, ...older];
    for (const item of unknown.slice(0, budget)) yield* this.listing(item);
    this.ctx.log.info("sauto incremental read the unknown listings moved up", {
      created: created.length,
      older: older.length,
    });
    if (unknown.length > budget) {
      throw new Error(
        `Sauto incremental left ${unknown.length - budget} of ${unknown.length} unknown listings for the next run (budget ${budget})`,
      );
    }
  }

  /**
   * Search items sorted since `since`, newest first, with repeats. A query whose order holds
   * more than the 10,000-result window above `since` is walked again in price halves, each
   * with a window of its own (listings without a price drop out, as they are skipped anyway).
   * Pages overlap by a twentieth: a listing removed meanwhile shifts the rest up, and the
   * overlap keeps the one shifted onto a page already read. A page that does not repeat the
   * last listing of the one before has lost its place, so the walk fails rather than skip.
   */
  private async *moved(since: string, band?: Band): AsyncIterable<Item> {
    const overlap = Math.floor(this.pageSize / 20);
    let last: string | undefined;
    for (let offset = 0; ; offset += this.pageSize - overlap) {
      if (offset + this.pageSize > WINDOW) {
        const halves = band ? halve(band) : [{ from: 0, to: PRICE_TOP }, { from: PRICE_TOP }];
        if (!halves) {
          throw new Error(
            `Sauto incremental: band ${band?.from}-${band?.to ?? ""} cannot be split`,
          );
        }
        for (const half of halves) yield* this.moved(since, half);
        return;
      }
      const page = await this.search({ conditions: CONDITION_SEOS, band, offset });
      if (overlap > 0 && last !== undefined && !page.items.some((i) => refOf(i) === last)) {
        throw new Error(`Sauto incremental lost its place in the order at offset ${offset}`);
      }
      let more = false;
      for (const item of page.items) {
        // Skipped listings never become known, so only their timestamp keeps the walk going.
        if (text(item.sorting_date) < since) continue;
        more = true;
        yield item;
      }
      if (!more || page.items.length < this.pageSize || offset + this.pageSize >= page.total)
        return;
      last = refOf(page.items[page.items.length - 1] ?? {});
    }
  }

  /** The census: every band, then a failure naming the bands that came out short. */
  async *full(limit: number): AsyncIterable<Observation> {
    const short: string[] = [];
    for (const condition of CONDITION_SEOS) {
      yield* this.band(condition, { from: 0, to: PRICE_TOP }, limit, short);
      yield* this.band(condition, { from: PRICE_TOP }, limit, short);
    }
    if (short.length > 0) {
      throw new Error(`Sauto slices yielded fewer results than reported: ${short.join(", ")}`);
    }
  }

  /**
   * One full-run slice: a condition and price band. Halves the band while the query holds
   * more than `limit` results, so every leaf can be paged to the end. A leaf that comes out
   * short still yields its listings, but no SliceDone; its key goes to `short`.
   */
  private async *band(
    condition: ConditionSeo,
    band: Band,
    limit: number,
    short: string[],
  ): AsyncIterable<Observation> {
    const slice = `${CONDITIONS[condition]}/${band.from}-${band.to ?? ""}`;
    if (this.ctx.checkpoint.sliceDoneAt(slice)) {
      this.ctx.log.info("sauto slice already done in this census", { slice });
      return;
    }
    const first = await this.search({ conditions: [condition], band, offset: 0 });
    if (first.total > limit) {
      const halves = halve(band);
      if (!halves) {
        throw new Error(`Sauto slice ${slice} holds ${first.total} results and cannot be split`);
      }
      for (const half of halves) yield* this.band(condition, half, limit, short);
      return;
    }
    // Page the whole band before the slow detail requests, so the order barely moves under us.
    const { items, complete } = await this.census(slice, { conditions: [condition], band }, first);
    for (const item of items) {
      if (isSkipped(item)) continue;
      yield* this.listing(item, CONDITIONS[condition]);
    }
    if (complete) yield { kind: "SliceDone", slice };
    else short.push(slice);
  }

  /**
   * Every search item of a leaf band, paged once more when a pass has fewer distinct results
   * than the band reports (a listing removed meanwhile shifts the next one onto a page already
   * read). A pass is complete when it alone reaches the highest total its pages reported;
   * skipped listings count, as the total counts them. The items of both passes come out, each
   * as last served, so a listing priced or dated into scope by the second pass is not skipped.
   * Consecutive pages overlap a little in case deletions shift the order up.
   */
  private async census(
    slice: string,
    band: Omit<Query, "offset">,
    first: Page,
  ): Promise<{ items: Item[]; complete: boolean }> {
    const items = new Map<string, Item>();
    const step = this.pageSize - Math.min(5, Math.floor(this.pageSize / 4));
    for (let pass = 1; pass <= 2; pass++) {
      const distinct = new Set<string>();
      let offset = 0;
      let page = pass === 1 ? first : await this.search({ ...band, offset });
      let reported = 0;
      for (;;) {
        reported = Math.max(reported, page.total);
        for (const [i, item] of page.items.entries()) {
          // A malformed entry has no id: its place stands in for it.
          const key = refOf(item) ?? `@${offset + i}`;
          distinct.add(key);
          items.set(key, item);
        }
        if (page.items.length < this.pageSize || offset + step >= page.total) break;
        offset += step;
        if (offset + this.pageSize > WINDOW) {
          throw new Error(`Sauto slice ${slice} grew past the ${WINDOW}-result window`);
        }
        page = await this.search({ ...band, offset });
      }
      if (distinct.size >= reported) return { items: [...items.values()], complete: true };
      this.ctx.log.warn("sauto slice came out short", {
        slice,
        pass,
        distinct: distinct.size,
        reported,
      });
    }
    return { items: [...items.values()], complete: false };
  }

  /**
   * The listing behind one search item, with its detail. A malformed item still comes out,
   * as a ListingSeen the Ledger rejects, so a broken parse keeps its slice not done and its
   * census from inferring absence. `condition` is the slice's, for details that omit theirs.
   */
  private async *listing(
    item: Item,
    condition?: Condition,
  ): AsyncIterable<ListingSeen | ListingGone> {
    const ref = refOf(item);
    if (!ref) {
      this.ctx.log.warn("sauto item without an id", { name: item.name });
      yield toListingSeen("", item, {}, condition);
      return;
    }
    if (this.done.has(ref)) return;
    this.done.add(ref);
    const page = await this.get(`${API}/${ref}`);
    if (page.status === 404) {
      yield { kind: "ListingGone", ref };
      return;
    }
    if (page.status !== 200) throw new Error(`Sauto returned HTTP ${page.status} for ${page.url}`);
    const detail = (parseJson(page.body, page.url) as { result?: Item }).result;
    if (!detail || typeof detail !== "object") {
      throw new Error(`Sauto detail without a result: ${page.url}`);
    }
    if (detail.status !== undefined && detail.status !== "active") {
      yield { kind: "ListingGone", ref };
      return;
    }
    const conditionCode = codeOf(detail.condition_cb);
    if (conditionCode !== undefined && !CONDITION_CODES[conditionCode]) {
      this.ctx.log.info("sauto listing out of scope", { ref, condition: conditionCode });
      return;
    }
    // The search filters the year; a detail that dates the listing earlier still drops it.
    const year = yearOf({ ...item, ...detail });
    if (year !== undefined && year < FIRST_YEAR) {
      this.ctx.log.info("sauto listing out of scope", { ref, year });
      return;
    }
    yield toListingSeen(ref, item, detail, condition);
  }

  private async search(query: Query): Promise<Page> {
    const params = new URLSearchParams({
      category_id: String(CATEGORY),
      condition_seo: query.conditions.join(","),
      operating_lease: "false",
      vehicle_age_from: String(FIRST_YEAR),
      limit: String(this.pageSize),
      offset: String(query.offset),
    });
    if (this.filter) params.set("manufacturer_model_seo", this.filter);
    if (query.band) {
      params.set("price_from", String(query.band.from));
      // `price_to` is inclusive, and 0 means no bound.
      if (query.band.to !== undefined) params.set("price_to", String(query.band.to - 1));
    }
    const page = await this.get(`${API}/search?${params}`);
    const body = parseJson(page.body, page.url) as {
      pagination?: { total?: unknown };
      results?: unknown;
    };
    if (page.status !== 200 || !Array.isArray(body.results)) {
      throw new Error(`Sauto search returned HTTP ${page.status} without results: ${page.url}`);
    }
    const total = body.pagination?.total;
    if (typeof total !== "number") throw new Error(`Sauto search without a total: ${page.url}`);
    // A malformed entry keeps its place as an empty item, so page lengths stay true.
    const items = body.results.map((r) => (r && typeof r === "object" ? r : {}) as Item);
    return { total, items };
  }

  private async get(url: string) {
    this.ctx.signal.throwIfAborted();
    const page = await this.ctx.http.get({
      url,
      locale: "cs",
      headers: { accept: "application/json" },
      signal: this.ctx.signal,
    });
    this.ctx.log.info("sauto fetched", { url, status: page.status });
    return page;
  }
}

interface Page {
  total: number;
  items: Item[];
}

/** A price band's two halves, or undefined when it cannot be split. */
function halve(band: Band): [Band, Band] | undefined {
  const mid = band.to === undefined ? band.from * 2 : Math.floor((band.from + band.to) / 2);
  // Never down to [0, 1): `price_to=0` would drop the bound.
  if (mid <= band.from || (band.from === 0 && mid <= 1)) return undefined;
  return [
    { from: band.from, to: mid },
    { ...band, from: mid },
  ];
}

function parseJson(body: string, url: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Sauto returned a non-JSON page for ${url}`);
  }
}

/** The fields this adapter reads from search items and details (both use one shape). */
interface Item {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  manufacturer_cb?: unknown;
  model_cb?: unknown;
  additional_model_name?: unknown;
  condition_cb?: unknown;
  price?: unknown;
  price_by_agreement?: unknown;
  price_is_vat_deductible?: unknown;
  price_is_without_vat?: unknown;
  tachometer?: unknown;
  manufacturing_date?: unknown;
  in_operation_date?: unknown;
  fuel_cb?: unknown;
  gearbox_cb?: unknown;
  vehicle_body_cb?: unknown;
  drive_cb?: unknown;
  engine_power?: unknown;
  engine_volume?: unknown;
  capacity?: unknown;
  doors?: unknown;
  average_gas_mileage?: unknown;
  average_electric_mileage?: unknown;
  color_cb?: unknown;
  locality?: unknown;
  images?: unknown;
  premise?: unknown;
  create_date?: unknown;
  sorting_date?: unknown;
  stk_date?: unknown;
}

const BODIES: Record<number, Body> = {
  1: "hatchback",
  2: "sedan",
  4: "convertible",
  5: "coupe",
  6: "wagon",
  7: "van",
  8: "mpv",
  9: "suv",
  12: "pickup",
  60: "suv", // terénní (off-road)
  78: "hatchback", // liftback
  103: "convertible", // roadster
  104: "suv", // CUV
};

/** `fuel_cb.value` → Fuel, except 5 (hybridní): see `fuelOf`. */
const FUELS: Record<number, Fuel> = {
  1: "petrol",
  2: "diesel",
  3: "lpg",
  4: "bev",
  6: "cng",
  7: "other", // ethanol
  8: "other",
  9: "hydrogen",
};
const HYBRID = 5;

/** `gearbox_cb.value` → Transmission; 2 (poloautomatická, automated manual) is two-pedal. */
const TRANSMISSIONS: Record<number, Transmission> = { 1: "manual", 2: "automatic", 3: "automatic" };

const DRIVES = { 2: "awd", 9: "fwd", 10: "rwd" } as const;

/**
 * Detail fields win over the search item's. `ref` "" marks an item without an id; like a
 * missing make, model, price or condition it makes the ListingSeen one the Ledger rejects.
 */
function toListingSeen(
  ref: string,
  item: Item,
  detail: Item,
  sliceCondition: Condition | undefined,
): ListingSeen {
  const d: Item = { ...item, ...detail };
  const make = codebook(d.manufacturer_cb);
  const model = codebook(d.model_cb);
  const trim = text(d.additional_model_name).trim() || undefined;
  const fuel = fuelOf(d.fuel_cb, trim);
  const vehicle: VehicleDescriptor = {
    make: make?.name ?? "",
    model: model?.name ?? "",
    trim,
    sourceTaxonomy: { make: make?.value, model: model?.value },
    firstRegistration: yearMonth(d.in_operation_date),
    manufactureYear: yearMonth(d.manufacturing_date)?.year,
    body: lookup(BODIES, d.vehicle_body_cb),
    fuel,
    powerKw: positive(d.engine_power),
    transmission: lookup(TRANSMISSIONS, d.gearbox_cb),
    drive: lookup(DRIVES, d.drive_cb),
    engineCc: positive(d.engine_volume),
    seats: positive(d.capacity),
    doors: positive(d.doors),
    ...(fuel === "bev"
      ? { consumptionKwh100km: positive(d.average_electric_mileage) }
      : { consumptionL100km: positive(d.average_gas_mileage) }),
    color: codebook(d.color_cb)?.name,
  };
  const conditionCode = codeOf(d.condition_cb);
  const condition =
    (conditionCode !== undefined && CONDITION_CODES[conditionCode]) || sliceCondition;
  const locality = (d.locality ?? {}) as Record<string, unknown>;
  const location = prune({
    region: text(locality.region) || undefined,
    city: text(locality.municipality) || undefined,
    postcode: text(locality.zip) || undefined,
  });
  const listedAt = text(d.create_date).slice(0, 10);
  return prune({
    kind: "ListingSeen",
    ref,
    url: ref && make && model ? `${SITE}/osobni/detail/${make.seo}/${model.seo}/${ref}` : "",
    market: "CZ",
    condition: condition ?? ("unknown" as Condition),
    vehicle: prune(vehicle),
    odometerKm: typeof d.tachometer === "number" ? d.tachometer : undefined,
    price: { amount: typeof d.price === "number" ? d.price : Number.NaN, currency: "CZK" },
    // `price` is the headline, VAT included. A seller who prices without VAT has the site
    // add 21% to `price_original` for it and show the net (`price_without_vat`) below it.
    priceBasis:
      d.price_is_without_vat === true || d.price_is_vat_deductible === true ? "gross" : "unknown",
    seller: d.premise ? "dealer" : "private",
    location: Object.keys(location).length > 0 ? location : undefined,
    photos: photos(detail.images ?? item.images),
    listedAt: /^\d{4}-\d{2}-\d{2}$/.test(listedAt) ? listedAt : undefined,
    inspectionValidUntil: yearMonth(d.stk_date),
  });
}

/** Hybridní covers HEV and PHEV; only a trim that says plug-in tells them apart. */
function fuelOf(value: unknown, trim: string | undefined): Fuel | undefined {
  const code = codeOf(value);
  if (code !== HYBRID) return code === undefined ? undefined : FUELS[code];
  return /plug-?in|phev|e-?hybrid/i.test(trim ?? "") ? "phev" : undefined;
}

function refOf(item: Item): string | undefined {
  return Number.isSafeInteger(item.id) && (item.id as number) > 0 ? String(item.id) : undefined;
}

/** Price by agreement: the listing shows no price, so it has nothing to compare. */
function isUnpriced(item: Item): boolean {
  return item.price_by_agreement === true || item.price === null || item.price === 0;
}

/** The year `vehicle_age_from` filters on: of manufacture, else of first registration. */
function yearOf(item: Item): number | undefined {
  return yearMonth(item.manufacturing_date)?.year ?? yearMonth(item.in_operation_date)?.year;
}

function isTooOld(item: Item): boolean {
  const year = yearOf(item);
  return year !== undefined && year < FIRST_YEAR;
}

/**
 * An item with an id that is out of scope: no ListingSeen. Malformed items (no id) are not
 * skipped; they come out as an observation the Ledger rejects (see `listing`).
 */
function isSkipped(item: Item): boolean {
  return refOf(item) !== undefined && (isUnpriced(item) || isTooOld(item));
}

function codebook(value: unknown): { name: string; seo: string; value?: string } | undefined {
  const cb = value as { name?: unknown; seo_name?: unknown; value?: unknown } | null | undefined;
  const name = text(cb?.name).trim();
  if (!name) return undefined;
  return {
    name,
    seo: text(cb?.seo_name),
    value: typeof cb?.value === "number" ? String(cb.value) : undefined,
  };
}

function codeOf(value: unknown): number | undefined {
  const code = (value as { value?: unknown } | null | undefined)?.value;
  return typeof code === "number" ? code : undefined;
}

function lookup<T>(table: Record<number, T>, value: unknown): T | undefined {
  const code = codeOf(value);
  return code === undefined ? undefined : table[code];
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** "2015-07-01" → { year: 2015, month: 7 }. */
function yearMonth(value: unknown): YearMonth | undefined {
  const match = /^(\d{4})-(\d{2})/.exec(text(value));
  if (!match) return undefined;
  const month = Number(match[2]);
  return { year: Number(match[1]), ...(month >= 1 && month <= 12 ? { month } : {}) };
}

function photos(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => text((image as { url?: unknown } | null)?.url))
    .filter((url) => url !== "")
    .map((url) => (url.startsWith("//") ? `https:${url}` : url));
}

/** `sorting_date` format: Prague wall-clock time, "2026-10-25T13:40:05". */
function pragueLocal(instant: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${pragueDate(instant)}T${time}`;
}

/** Drops undefined fields, so observations compare and serialize cleanly. */
function prune<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
