/**
 * AutoScout24 (autoscout24.de, autoscout24.at): passenger-car listings first registered in
 * 2000 or later, new cars included, damaged cars and other countries' listings excluded.
 *
 * - Search pages `/lst?…` embed their results in `__NEXT_DATA__` (`props.pageProps`):
 *   `listings[]`, `numberOfResults`, `numberOfPages`, and the make taxonomy. A query serves
 *   4,000 results' worth of pages (80 of 50), and every page also carries a few sponsored
 *   listings of the same query (6 of 50), so it reaches fewer: about 3,500.
 * - The adapter slices its scope until every query is under that cap: by Condition (the
 *   site's `offer` filter, the only place demo cars are told apart), then make, then price
 *   band, bisected with inclusive bounds. A slice's key names its filters
 *   ("used;make=29;price=0-15624"), so a slice keeps its key across runs and a failed
 *   census resumes where it stopped.
 * - full: every slice's pages newest first, a SliceDone after each slice that yielded as
 *   many distinct listings as it reports (paged a second time if it came out short); slices
 *   done earlier in the census are skipped. A slice still short, still over the cap at a
 *   single price, or split into parts whose counts fall well short of its own fails the run
 *   at the end (after every other slice), so it is no census.
 * - incremental: the same slices, narrowed to listings online since the last run (`adage`,
 *   whole days up to 14; no window after a longer gap), newest first, each stopping at a
 *   page of known listings.
 *
 * Research notes: scrape-access.md (AutoScout24 rows); filters verified against the live
 * site 2026-10-25 (offer types partition the results, price bounds are inclusive).
 */
import type {
  Condition,
  Fuel,
  ListingSeen,
  Observation,
  PriceBasis,
  Seller,
  Transmission,
  VehicleDescriptor,
  YearMonth,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

export interface AutoScout24Options {
  /** DE searches autoscout24.de, AT autoscout24.at. */
  country: "DE" | "AT";
  /**
   * AutoScout24 make ids to cover (the site's taxonomy, e.g. 29 = Ford, 74 = Volkswagen).
   * Default: every make. Narrows `scope`, so a narrowed census never retires other makes.
   */
  makes?: readonly number[];
  /** Listings per page, 1-50. Default 50, the most the site serves. */
  pageSize?: number;
  /** Results any one query reaches, 1-4,000. Default 4,000 (the site's cap); tests lower it. */
  resultCap?: number;
}

const HOSTS = { DE: "https://www.autoscout24.de", AT: "https://www.autoscout24.at" };
const COUNTRY_CODES = { DE: "D", AT: "A" };

/**
 * The site's offer types per Condition. Tageszulassung (S) is dealer stock registered once
 * and unused: not new any more, not a used car either, so it counts with demonstrators.
 */
const OFFERS: Record<Condition, string> = { new: "N", demo: "D,S", used: "U,J,O" };
const CONDITIONS = Object.keys(OFFERS) as Condition[];

const MAX_PAGE_SIZE = 50;
const RESULT_CAP = 4_000;
/** First price split; the open band above it is not split further. */
const PRICE_TOP = 999_999;
/** The `adage` values the site offers, in days. */
const ADAGES = [1, 2, 3, 4, 5, 6, 7, 14];
const DAY_MS = 86_400_000;

export function autoscout24Source(options: AutoScout24Options): Source {
  const settings: Settings = {
    country: options.country,
    makes: options.makes && [...new Set(options.makes)].sort((a, b) => a - b),
    pageSize: whole("pageSize", options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE),
    cap: whole("resultCap", options.resultCap ?? RESULT_CAP, RESULT_CAP),
  };
  return {
    id: `autoscout24-${options.country.toLowerCase()}`,
    scope: settings.makes ? `makes:${settings.makes.join(",")}` : undefined,
    harvest: (ctx) => new Harvest(ctx, settings).run(),
  };
}

function whole(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`autoscout24 ${name} must be a whole number from 1 to ${max}`);
  }
  return value;
}

interface Settings {
  country: "DE" | "AT";
  makes: readonly number[] | undefined;
  pageSize: number;
  cap: number;
}

/** One query's filters. Condition is always set; the rest narrow it. */
interface Slice {
  condition: Condition;
  make?: number;
  /** Inclusive EUR bounds; no `to` means open above. */
  price?: { from: number; to?: number };
}

interface SearchPage {
  total: number;
  /** Pages the site paginates the query into, sponsored slots included. */
  pages: number;
  listings: Raw[];
  /** Make ids in the page's taxonomy. */
  makes: number[];
}

// biome-ignore lint/suspicious/noExplicitAny: site JSON, read defensively field by field.
type Raw = Record<string, any>;

class Harvest {
  private readonly ctx: HarvestContext;
  private readonly settings: Settings;
  private readonly full: boolean;
  /** Incremental `adage` filter; undefined in full runs and after a gap longer than offered. */
  private readonly adage: number | undefined;
  /** Slices this run could not harvest whole. */
  private readonly unfinished: string[] = [];
  /** Incremental: refs this run has yielded. */
  private readonly yielded = new Set<string>();

  constructor(ctx: HarvestContext, settings: Settings) {
    this.ctx = ctx;
    this.settings = settings;
    this.full = ctx.mode === "full";
    this.adage = this.full ? undefined : adageSince(ctx);
  }

  async *run(): AsyncIterable<Observation> {
    if (!this.full && this.adage === undefined) {
      this.ctx.log.warn("autoscout24: last run over 14 days ago; searching without a time window");
    }
    for (const condition of CONDITIONS) {
      if (this.settings.makes) {
        for (const make of this.settings.makes) yield* this.slice({ condition, make });
      } else {
        yield* this.slice({ condition });
      }
    }
    if (this.unfinished.length > 0) {
      const message = `autoscout24: slices not harvested whole: ${this.unfinished.join(" ")}`;
      if (this.full) throw new Error(message);
      this.ctx.log.warn(message);
    }
  }

  /**
   * Harvests one slice, or its sub-slices when it is over the cap, and returns its result
   * count. Only slices harvested whole report SliceDone; on resume a split slice is probed
   * again to find its parts, and a done part only for its count (`counted`). `retry`: page a
   * slice that comes out short once more (listings removed while paging shift later ones
   * onto pages already read).
   */
  private async *slice(
    slice: Slice,
    retry = this.full,
    counted = false,
  ): AsyncGenerator<Observation, number> {
    const key = sliceKey(slice);
    const done = this.full && this.ctx.checkpoint.sliceDoneAt(key) !== null;
    if (done && !counted) return 0;
    const first = await this.page(slice, 1);
    if (done) return first.total;
    const overCap = this.overCap(first);
    const parts = overCap ? split(slice, first) : null;
    if (parts) {
      let inParts = 0;
      for (const part of parts) inParts += yield* this.slice(part, this.full, true);
      // The parts partition the slice, so their counts add up to its own, give or take the
      // listings that came and went meanwhile; a bigger gap means a filter misses listings.
      if (first.total - inParts > Math.max(20, first.total * 0.02)) {
        this.ctx.log.warn("autoscout24: sub-slices miss results", {
          slice: key,
          results: first.total,
          inParts,
        });
        this.unfinished.push(key);
      }
      return first.total;
    }
    const outcome = yield* this.pages(slice, first);
    if (outcome === "short" && retry && !overCap) {
      this.ctx.log.warn("autoscout24: slice came out short; harvesting it again", { slice: key });
      return yield* this.slice(slice, false, counted);
    }
    // Incremental is no census: a short slice under the cap only means listings moved.
    const whole = outcome !== "short" || (!this.full && !overCap);
    if (!whole) this.unfinished.push(key);
    else if (this.full) yield { kind: "SliceDone", slice: key };
    this.ctx.log.info("autoscout24 slice", { slice: key, results: first.total, outcome });
    return first.total;
  }

  /**
   * Pages through a slice newest first. "stopped": incremental reached a page of known
   * listings; "complete": every listing the slice reports, and no more than the cap;
   * "short": anything less.
   */
  private async *pages(
    slice: Slice,
    first: SearchPage,
  ): AsyncGenerator<ListingSeen, "stopped" | "complete" | "short"> {
    const { cap, country } = this.settings;
    const seen = new Set<string>();
    let { total, pages } = first;
    for (let n = 1; n <= Math.min(pages, this.pageLimit); n++) {
      const page = n === 1 ? first : await this.page(slice, n);
      // A page past the end reports 0 results, so only full pages update the total.
      if (page.listings.length === 0) break;
      ({ total, pages } = page);
      // Known means known before this run: the Ledger records each listing as it is yielded,
      // and a page can repeat listings from earlier pages (sponsored placements).
      const known =
        !this.full &&
        page.listings.every((raw) => {
          const ref = refOf(raw);
          return !this.yielded.has(ref) && this.ctx.checkpoint.isKnown(ref);
        });
      for (const raw of page.listings) {
        seen.add(refOf(raw));
        if (!this.full) this.yielded.add(refOf(raw));
        yield toListingSeen(raw, slice.condition, country);
      }
      if (known) return "stopped";
    }
    return total <= cap && seen.size >= total ? "complete" : "short";
  }

  /** Pages any query is served: 4,000 results' worth, whatever the cap is set to. */
  private get pageLimit(): number {
    return Math.floor(RESULT_CAP / this.settings.pageSize);
  }

  /** A query is over the cap with too many results, or as many pages as it can be served. */
  private overCap(page: SearchPage): boolean {
    return page.total > this.settings.cap || page.pages >= this.pageLimit;
  }

  private async page(slice: Slice, n: number): Promise<SearchPage> {
    this.ctx.signal.throwIfAborted();
    const url = this.url(slice, n);
    const page = await this.ctx.http.get({
      url,
      locale: "de",
      minTier: "T1",
      signal: this.ctx.signal,
    });
    if (page.status !== 200) throw new Error(`AutoScout24 returned HTTP ${page.status} for ${url}`);
    return parseSearchPage(page.body, url);
  }

  private url(slice: Slice, page: number): string {
    const params = new URLSearchParams({
      atype: "C",
      cy: COUNTRY_CODES[this.settings.country],
      fregfrom: "2000",
      damaged_listing: "exclude",
      ocs_listing: "exclude",
      offer: OFFERS[slice.condition],
      sort: "age",
      desc: "1",
      size: String(this.settings.pageSize),
      page: String(page),
    });
    if (slice.make !== undefined) params.set("mmmv", `${slice.make}|||`);
    if (slice.price) {
      params.set("pricefrom", String(slice.price.from));
      if (slice.price.to !== undefined) params.set("priceto", String(slice.price.to));
    }
    if (this.adage !== undefined) params.set("adage", String(this.adage));
    return `${HOSTS[this.settings.country]}/lst?${params}`;
  }
}

/** Sub-slices that partition `slice`: makes, then price bands, then halves of a band. */
function split(slice: Slice, page: SearchPage): Slice[] | null {
  if (slice.make === undefined) {
    return page.makes.length > 0 ? page.makes.map((make) => ({ ...slice, make })) : null;
  }
  if (!slice.price) {
    return [
      { ...slice, price: { from: 0, to: PRICE_TOP } },
      { ...slice, price: { from: PRICE_TOP + 1 } },
    ];
  }
  const { from, to } = slice.price;
  if (to === undefined || from >= to) return null;
  const mid = Math.floor((from + to) / 2);
  return [
    { ...slice, price: { from, to: mid } },
    { ...slice, price: { from: mid + 1, to } },
  ];
}

/** "used", "new;make=29", "demo;make=29;price=0-15624", "used;make=74;price=1000000-". */
function sliceKey(slice: Slice): string {
  const parts: string[] = [slice.condition];
  if (slice.make !== undefined) parts.push(`make=${slice.make}`);
  if (slice.price) parts.push(`price=${slice.price.from}-${slice.price.to ?? ""}`);
  return parts.join(";");
}

/**
 * The shortest `adage` covering the days since the last run, with an hour of slack; 1 on
 * the first run; undefined when the gap is longer than any `adage`.
 */
function adageSince(ctx: HarvestContext): number | undefined {
  const last = ctx.checkpoint.lastRunAt;
  if (!last) return 1;
  const days = Math.ceil((ctx.now.getTime() - last.getTime() + 3_600_000) / DAY_MS);
  return ADAGES.find((adage) => adage >= days);
}

function parseSearchPage(html: string, url: string): SearchPage {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let props: Raw | undefined;
  try {
    props = match ? JSON.parse(match[1] as string)?.props?.pageProps : undefined;
  } catch {
    props = undefined;
  }
  if (!props || !Array.isArray(props.listings) || !Number.isInteger(props.numberOfResults)) {
    throw new Error(`AutoScout24 page changed: no listings in __NEXT_DATA__ at ${url}`);
  }
  const makes = Object.values((props.taxonomy?.makes ?? {}) as Record<string, Raw>)
    .map((make) => Number(make?.value))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  const pages = Number.isInteger(props.numberOfPages) ? props.numberOfPages : 1;
  return { total: props.numberOfResults, pages, listings: props.listings, makes };
}

function refOf(raw: Raw): string {
  return typeof raw?.id === "string" ? raw.id.trim() : "";
}

/**
 * Missing ref, make, model or price make the ListingSeen one the Ledger rejects, so a
 * broken parse keeps its slice not done instead of passing for a listing that is gone.
 */
function toListingSeen(raw: Raw, condition: Condition, country: "DE" | "AT"): ListingSeen {
  const v: Raw = raw?.vehicle ?? {};
  const details = detailsOf(raw?.vehicleDetails);
  const version = text(v.modelVersionInput);
  // Vans and other models outside the site's car taxonomy have no model; the listing then
  // shows only make + version text, so that text is the model as shown.
  const model = text(v.model) || version;
  const trim = text(v.model) ? version || undefined : undefined;
  const fuel = fuelOf(raw?.tracking?.fuelType, version);
  const consumption = details.water_drop ?? details.lightning_bolt;
  const vehicle: VehicleDescriptor = {
    make: text(v.make),
    model,
    trim,
    sourceTaxonomy: {
      make: taxonomyId(raw?.tracking?.modelTaxonomy, "make_id"),
      model: v.modelId == null ? undefined : String(v.modelId),
    },
    firstRegistration: yearMonth(raw?.tracking?.firstRegistration),
    fuel,
    powerKw: germanNumber(/([\d.]+)\s*kW\b/.exec(details.speedometer ?? "")?.[1]),
    transmission: TRANSMISSIONS[text(v.transmission)],
    engineCc: number(text(v.engineDisplacementInCCM).replace(/\D/g, "")),
    ...(fuel === "bev"
      ? { consumptionKwh100km: germanNumber(/^([\d.,]+)\s*kWh/.exec(consumption ?? "")?.[1]) }
      : { consumptionL100km: germanNumber(/^([\d.,]+)\s*l\//.exec(consumption ?? "")?.[1]) }),
    co2GKm: germanNumber(/^([\d.,]+)\s*g\/km/.exec(details.leaf ?? "")?.[1]),
  };
  const ref = refOf(raw);
  const url = text(raw?.url);
  return dropUndefined({
    kind: "ListingSeen",
    ref,
    url: url ? new URL(url, HOSTS[country]).href : "",
    market: country,
    condition,
    vehicle: dropUndefined(vehicle),
    odometerKm: number(raw?.tracking?.mileage),
    price: { amount: priceOf(raw?.price?.priceRaw), currency: "EUR" },
    priceBasis: priceBasisOf(raw?.price?.vatLabel),
    seller: SELLERS[text(raw?.seller?.type)] ?? "unknown",
    location: dropUndefined({
      city: text(raw?.location?.city) || undefined,
      postcode: text(raw?.location?.zip) || undefined,
    }),
    photos: Array.isArray(raw?.images)
      ? raw.images.filter(
          (image: unknown) => typeof image === "string" && /^https?:\/\//.test(image),
        )
      : [],
  });
}

const TRANSMISSIONS: Record<string, Transmission> = {
  Schaltgetriebe: "manual",
  Automatik: "automatic",
  Halbautomatik: "automatic",
};

const SELLERS: Record<string, Seller> = { Dealer: "dealer", PrivateSeller: "private" };

/** `tracking.fuelType` codes; 2 = Elektro/Benzin and 3 = Elektro/Diesel are hybrids. */
const FUELS: Record<string, Fuel> = {
  b: "petrol",
  d: "diesel",
  e: "bev",
  l: "lpg",
  c: "cng",
  h: "hydrogen",
  m: "other",
  o: "other",
};

/** Hybrid codes cover HEV and PHEV; only a version text that says plug-in tells them apart. */
function fuelOf(code: unknown, version: string): Fuel | undefined {
  const value = text(code).toLowerCase();
  if (value === "2" || value === "3") {
    return /plug-?in|phev|e-?hybrid/i.test(version) ? "phev" : undefined;
  }
  return FUELS[value];
}

/** Dealers that can show VAT label the price "inkl. MwSt."; anything else does not say. */
function priceBasisOf(label: unknown): PriceBasis {
  const value = text(label).toLowerCase();
  if (/inkl\.?\s*mwst/.test(value)) return "gross";
  if (/(exkl\.?|zzgl\.?|netto|ohne)\s*mwst/.test(value)) return "net";
  return "unknown";
}

function priceOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

/** Shown details by icon name: speedometer "105 kW (143 PS)", leaf "246 g/km (komb.)"... */
function detailsOf(value: unknown): Record<string, string> {
  const details: Record<string, string> = {};
  if (!Array.isArray(value)) return details;
  for (const item of value) {
    const icon = text(item?.iconName);
    if (icon && !(icon in details)) details[icon] = text(item?.data);
  }
  return details;
}

/** "07-2011" → { year: 2011, month: 7 }; "new" and anything else → undefined. */
function yearMonth(value: unknown): YearMonth | undefined {
  const match = /^(\d{2})-(\d{4})$/.exec(text(value));
  if (!match) return undefined;
  const month = Number(match[1]);
  return { year: Number(match[2]), ...(month >= 1 && month <= 12 ? { month } : {}) };
}

/** "[make_id:29, model_group_id:15862, …];" → "29" for "make_id". */
function taxonomyId(value: unknown, field: string): string | undefined {
  return new RegExp(`${field}:(\\d+)`).exec(text(value))?.[1];
}

/** German-formatted "1.030", "9,30" → 1030, 9.3. */
function germanNumber(value: string | undefined): number | undefined {
  return number(value?.replace(/\./g, ""));
}

/** "229000", "9,30" → finite number >= 0, else undefined. */
function number(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
