/**
 * mobile.de (experimental): passenger cars standing in Germany, first registered in 2000 or
 * later, new cars included, damaged cars excluded.
 *
 * Experimental: Akamai lets only a real Chrome through, so every request needs T2
 * (`CCA_HTTP_BROWSER=patchright`, headed under `xvfb-run`; docs/adr/0005-fetch-tiers.md), and a
 * page takes seconds; documents go 15 s apart. The registry has it; no schedule runs it. A full
 * census of the ~1.2M listings is ~62,000 pages (some 11 days of runs, resumable through
 * SliceDone); narrow it with `makes` (from the ingest CLI: `CCA_MOBILEDE_MAKES`, see
 * registry.ts). Access research: docs/adr/0014-mobile-de-experimental.md.
 *
 * - Search pages embed their results in the Next.js flight data (`self.__next_f.push`):
 *   `searchResults { numResultsTotal, listings[] }` with the listing facts, one card per listing
 *   (`listing-container-<id>-…`) with its photos, VAT and online-since date, and the make
 *   taxonomy. A query serves 100 pages of 20 results (2,000); page 1 adds promoted listings that
 *   are not part of the paging and are skipped.
 * - Slices: Condition (`con`, NEW or USED; demo cars are USED listings marked Vorführfahrzeug or
 *   Tageszulassung), then price bands bisected on whole euros, neighbours sharing their bound
 *   (see `split`); with `makes`, a make per slice before the price bands. Price bands cover a
 *   slice by construction (every listing has a price), so they need no recount.
 *   Only a band of one or two euros over the cap splits by make, and that split is recounted like
 *   AutoScout24's: the site's totals move by tens of listings a minute, too fast to recount a
 *   make split of a large slice. A slice's key names its filters ("used;price=0-15624",
 *   "used;make=25200;price=9999-10000"), so a failed census resumes where it stopped.
 * - full: every slice's pages newest first, a SliceDone after each slice that yielded as many
 *   distinct listings as it reports (paged a second time if it came out short); slices done
 *   earlier in the census are skipped; slices still short, over the cap at one or two euros, or
 *   split into makes that miss results fail the run at the end.
 * - incremental: the same slices narrowed to listings online since the last run (`doc`, 1, 3,
 *   7 or 14 days; no window after a longer gap), newest first, each stopping at a page of
 *   listings known before the run.
 */
import type {
  Condition,
  Fuel,
  IsoDate,
  ListingSeen,
  Observation,
  PriceBasis,
  Seller,
  Transmission,
  VehicleDescriptor,
  YearMonth,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

export interface MobileDeOptions {
  /**
   * mobile.de make ids to cover (the site's `ms` taxonomy, e.g. 25200 = Volkswagen, 3500 = BMW).
   * Default: every make. Narrows `scope`, so a narrowed census never retires other makes.
   */
  makes?: readonly number[];
  /** Results any one query reaches, 1-2,000. Default 2,000 (the site's cap); tests lower it. */
  resultCap?: number;
}

const SEARCH = "https://suchen.mobile.de/fahrzeuge/search.html";
const DETAILS = "https://suchen.mobile.de/fahrzeuge/details.html";
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const RESULT_CAP = PAGE_SIZE * PAGE_LIMIT;
/** First price split; the open band above it is not bisected. */
const PRICE_TOP = 999_999;
/** The `doc` (online since) values the site offers, in days. */
const DOCS = [1, 3, 7, 14];
const DAY_MS = 86_400_000;
/**
 * A T2 page loads its scripts and images too. Akamai blocked a run after 39 documents ~6 s
 * apart; sessions of ~25 documents 10-15 s apart went through.
 */
const HOST_INTERVAL_MS = 15_000;

/** The site's `con` value per slice condition; demo listings come out of `used`. */
const CON = { new: "NEW", used: "USED" } as const;
type SliceCondition = keyof typeof CON;

export function mobiledeSource(options: MobileDeOptions = {}): Source {
  const makes = options.makes && [...new Set(options.makes)].sort((a, b) => a - b);
  if (makes?.some((make) => !Number.isInteger(make) || make < 1)) {
    throw new RangeError(`mobile-de makes must be site make ids, got ${options.makes?.join(",")}`);
  }
  const cap = options.resultCap ?? RESULT_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > RESULT_CAP) {
    throw new RangeError(`mobile-de resultCap must be a whole number from 1 to ${RESULT_CAP}`);
  }
  return {
    id: "mobile-de",
    scope: makes ? `makes:${makes.join(",")}` : undefined,
    harvest: (ctx) => new Harvest(ctx, makes, cap).run(),
  };
}

/** One query's filters. Condition is always set; the rest narrow it. */
interface Slice {
  condition: SliceCondition;
  make?: number;
  /** Inclusive whole-euro bounds; no `to` means open above. */
  price?: { from: number; to?: number };
}

interface SearchPage {
  total: number;
  /** The page's results, promoted listings left out. */
  listings: Raw[];
  /** Card details by listing id. */
  cards: Map<string, Card>;
  /** Make ids in the page's taxonomy. */
  makes: number[];
}

interface Card {
  photos: string[];
  /** The card's price object: `grs` and, when VAT is shown, `nt` and `vat`. */
  price?: Raw;
  title?: string;
  subTitle?: string;
  onlineSince?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: site JSON, read defensively field by field.
type Raw = Record<string, any>;

class Harvest {
  private readonly ctx: HarvestContext;
  private readonly makes: readonly number[] | undefined;
  private readonly cap: number;
  private readonly full: boolean;
  /** Incremental `doc` filter; undefined in full runs and after a gap longer than offered. */
  private readonly doc: number | undefined;
  /** Slices this run could not harvest whole. */
  private readonly unfinished: string[] = [];
  /** Slices this run has started: neighbouring price bands can split into the same price. */
  private readonly started = new Set<string>();
  /** Incremental: whether each listing this run has met was known before it, as first met. */
  private readonly knownBefore = new Map<string, boolean>();

  constructor(ctx: HarvestContext, makes: readonly number[] | undefined, cap: number) {
    this.ctx = ctx;
    this.makes = makes;
    this.cap = cap;
    this.full = ctx.mode === "full";
    this.doc = this.full ? undefined : docSince(ctx);
  }

  async *run(): AsyncIterable<Observation> {
    if (!this.full && this.doc === undefined) {
      this.ctx.log.warn("mobile-de: last run over 14 days ago; searching without a time window");
    }
    for (const condition of Object.keys(CON) as SliceCondition[]) {
      if (this.makes) {
        for (const make of this.makes) yield* this.slice({ condition, make });
      } else {
        yield* this.slice({ condition });
      }
    }
    if (this.unfinished.length > 0) {
      const message = `mobile-de: slices not harvested whole: ${this.unfinished.join(" ")}`;
      if (this.full) throw new Error(message);
      this.ctx.log.warn(message);
    }
  }

  /**
   * Harvests one slice, or its sub-slices when it is over the cap. Only slices harvested whole
   * report SliceDone. `retry`: page a slice that comes out short once more (listings removed
   * while paging shift later ones onto pages already read).
   */
  private async *slice(slice: Slice, retry = this.full): AsyncGenerator<Observation> {
    const key = sliceKey(slice);
    if (this.full && this.ctx.checkpoint.sliceDoneAt(key) !== null) return;
    if (this.started.has(key)) return;
    this.started.add(key);
    const first = await this.page(slice, 1);
    const overCap = first.total > this.cap;
    const parts = overCap ? split(slice, first, this.makes === undefined) : null;
    if (parts) {
      for (const part of parts) yield* this.slice(part);
      // A make split is the only one that can miss listings; incremental is no census.
      const byMake = slice.make === undefined && parts[0]?.make !== undefined;
      if (this.full && byMake && !(await this.covered(slice, parts))) this.unfinished.push(key);
      return;
    }
    const outcome = yield* this.pages(slice, first);
    if (outcome === "short" && retry && !overCap) {
      this.ctx.log.warn("mobile-de: slice came out short; harvesting it again", { slice: key });
      this.started.delete(key);
      return yield* this.slice(slice, false);
    }
    // Incremental is no census: a short slice under the cap only means listings moved.
    const whole = outcome !== "short" || (!this.full && !overCap);
    if (!whole) this.unfinished.push(key);
    else if (this.full) yield { kind: "SliceDone", slice: key };
    this.ctx.log.info("mobile-de slice", { slice: key, results: first.total, outcome });
  }

  /**
   * Whether the make `parts` of a one- or two-euro slice reach every result of it: counted between
   * two counts of the slice and reaching the higher, three attempts (as AutoScout24's).
   */
  private async covered(slice: Slice, parts: readonly Slice[]): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = (await this.page(slice, 1)).total;
      let inParts = 0;
      for (const part of parts) inParts += (await this.page(part, 1)).total;
      const after = (await this.page(slice, 1)).total;
      if (inParts >= Math.max(before, after)) return true;
      this.ctx.log.warn("mobile-de: make slices miss results", {
        slice: sliceKey(slice),
        results: [before, after],
        inParts,
        attempt,
      });
    }
    return false;
  }

  /**
   * Pages through a slice newest first. "stopped": incremental reached a page of known
   * listings; "complete": every listing the slice reports, and no more than the cap; "short":
   * anything less.
   */
  private async *pages(
    slice: Slice,
    first: SearchPage,
  ): AsyncGenerator<ListingSeen, "stopped" | "complete" | "short"> {
    const seen = new Set<string>();
    let total = first.total;
    for (let n = 1; n <= Math.min(Math.ceil(total / PAGE_SIZE), PAGE_LIMIT); n++) {
      const page = n === 1 ? first : await this.page(slice, n);
      // A page past the end has no results, so only pages with results update the total.
      if (page.listings.length === 0) break;
      total = page.total;
      // Known means known before this run: each listing's status is taken when the run first
      // meets it, before any is yielded (the Ledger records them as they are yielded).
      const known = !this.full && page.listings.map((raw) => this.knewBefore(raw)).every(Boolean);
      for (const raw of page.listings) {
        const ref = refOf(raw);
        seen.add(ref);
        yield toListingSeen(raw, page.cards.get(ref), slice);
      }
      if (known) return "stopped";
    }
    return total <= this.cap && seen.size >= total ? "complete" : "short";
  }

  private knewBefore(raw: Raw): boolean {
    const ref = refOf(raw);
    let known = this.knownBefore.get(ref);
    if (known === undefined) {
      known = this.ctx.checkpoint.isKnown(ref);
      this.knownBefore.set(ref, known);
    }
    return known;
  }

  private async page(slice: Slice, n: number): Promise<SearchPage> {
    this.ctx.signal.throwIfAborted();
    const url = this.url(slice, n);
    const page = await this.ctx.http.get({
      url,
      locale: "de",
      minTier: "T2",
      hostIntervalMs: HOST_INTERVAL_MS,
      signal: this.ctx.signal,
    });
    if (page.status !== 200) throw new Error(`mobile.de returned HTTP ${page.status} for ${url}`);
    return parseSearchPage(page.body, url);
  }

  private url(slice: Slice, page: number): string {
    const params = new URLSearchParams({
      isSearchRequest: "true",
      s: "Car",
      vc: "Car",
      cn: "DE",
      con: CON[slice.condition],
      dam: "false",
      fr: "2000:",
      sb: "doc",
      od: "down",
    });
    if (slice.make !== undefined) params.set("ms", String(slice.make));
    if (slice.price) {
      const { from, to } = slice.price;
      params.set("p", `${from}:${to ?? ""}`);
    }
    if (this.doc !== undefined) params.set("doc", String(this.doc));
    if (page > 1) params.set("pageNumber", String(page));
    return `${SEARCH}?${params}`;
  }
}

/**
 * Sub-slices that cover `slice`: price bands, then halves of a band sharing their middle euro
 * (the site compares whole euros: `p=0:122.99` reads as 0-12,299 €, "." being its thousands
 * separator; shared bounds leave no gap for prices with cents, and a listing on a bound simply
 * comes twice). A band of one or two euros is not halved (halves would leave out a price with
 * cents between the two); it, or the open top band, splits by the page's makes when `byMake`,
 * else not at all.
 */
function split(slice: Slice, page: SearchPage, byMake: boolean): Slice[] | null {
  if (!slice.price) {
    return [
      { ...slice, price: { from: 0, to: PRICE_TOP } },
      { ...slice, price: { from: PRICE_TOP } },
    ];
  }
  const { from, to } = slice.price;
  if (to !== undefined && to - from >= 2) {
    const mid = Math.floor((from + to) / 2);
    return [
      { ...slice, price: { from, to: mid } },
      { ...slice, price: { from: mid, to } },
    ];
  }
  if (byMake && slice.make === undefined && page.makes.length > 0) {
    return page.makes.map((make) => ({ ...slice, make }));
  }
  return null;
}

/** "new", "used;price=0-15624", "used;make=25200;price=9999-10000", "new;price=999999-". */
function sliceKey(slice: Slice): string {
  const parts: string[] = [slice.condition];
  if (slice.make !== undefined) parts.push(`make=${slice.make}`);
  if (slice.price) parts.push(`price=${slice.price.from}-${slice.price.to ?? ""}`);
  return parts.join(";");
}

/**
 * The shortest `doc` covering the days since the last run, with an hour of slack; 1 on the
 * first run; undefined when the gap is longer than any `doc`.
 */
function docSince(ctx: HarvestContext): number | undefined {
  const last = ctx.checkpoint.lastRunAt;
  if (!last) return 1;
  const days = Math.ceil((ctx.now.getTime() - last.getTime() + 3_600_000) / DAY_MS);
  return DOCS.find((doc) => doc >= days);
}

function parseSearchPage(html: string, url: string): SearchPage {
  const rows = flightRows(html);
  let results: Raw | undefined;
  let makes: number[] = [];
  const cards = new Map<string, Card>();
  for (const row of rows) {
    walk(row, (node) => {
      if (Array.isArray(node)) {
        const key = node[0] === "$" ? node[2] : undefined;
        const id = typeof key === "string" ? /^listing-container-(\d+)-/.exec(key)?.[1] : undefined;
        if (id && !cards.has(id)) cards.set(id, cardOf(node[3]));
        return !id;
      }
      if (!results && Array.isArray(node.listings) && Number.isInteger(node.numResultsTotal)) {
        results = node;
      }
      if (makes.length === 0 && Array.isArray(node.makes) && node.makes[0]?.i !== undefined) {
        makes = node.makes
          .map((make: Raw) => Number(make?.i))
          .filter((id: number) => Number.isInteger(id) && id > 0)
          .sort((a: number, b: number) => a - b);
      }
      return true;
    });
  }
  if (!results) throw new Error(`mobile.de page changed: no searchResults in the page at ${url}`);
  const listings = (results.listings as Raw[]).filter(
    (raw) => raw?.type === "regular" || raw?.type === "eyecatcher",
  );
  return { total: results.numResultsTotal, listings, cards, makes };
}

/** The RSC rows (`<id>:<json>`) of the page's Next.js flight data that are JSON. */
function flightRows(html: string): unknown[] {
  let flight = "";
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try {
      const chunk = JSON.parse(match[1] as string);
      if (chunk[0] === 1 && typeof chunk[1] === "string") flight += chunk[1];
    } catch {
      // Not a data chunk.
    }
  }
  const rows: unknown[] = [];
  for (const line of flight.split("\n")) {
    const payload = /^[\da-f]+:([[{].*)$/.exec(line)?.[1];
    if (!payload) continue;
    try {
      rows.push(JSON.parse(payload));
    } catch {
      // A row this parser does not read.
    }
  }
  return rows;
}

/** Depth-first over arrays and objects; `visit` returns false to skip a node's children. */
function walk(node: unknown, visit: (node: Raw | unknown[]) => boolean): void {
  if (node === null || typeof node !== "object") return;
  if (!visit(node as Raw | unknown[])) return;
  for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, visit);
}

function cardOf(props: unknown): Card {
  const card: Card = { photos: [] };
  walk(props, (node) => {
    if (Array.isArray(node)) return true;
    const src = text(node.src);
    if (/^(?:https?:)?\/?\/?img\.classistatic\.de\//.test(src)) {
      // The bare image URL answers 400; a size rule (one the site's pages use) serves it.
      const bare = src.replace(/^(?:https?:)?\/\//, "").replace(/\?.*$/, "");
      const photo = `https://${bare}?rule=mo-1024`;
      if (!card.photos.includes(photo)) card.photos.push(photo);
    }
    if (!card.price && node.adId !== undefined && node.price?.grs) card.price = node.price;
    if (!card.title && /-title$/.test(text(node.testId)) && text(node.title)) {
      card.title = text(node.title);
      card.subTitle = text(node.subTitle) || undefined;
    }
    if (!card.onlineSince && node["data-testid"] === "online-since") {
      card.onlineSince = /(\d{2})\.(\d{2})\.(\d{4})/.exec(JSON.stringify(node.children))?.[0];
    }
    return true;
  });
  return card;
}

function refOf(raw: Raw): string {
  const id = raw?.id;
  return typeof id === "number" || typeof id === "string" ? String(id).trim() : "";
}

/**
 * Missing ref, make, model or price make the ListingSeen one the Ledger rejects, so a broken
 * parse keeps its slice not done instead of passing for a listing that is gone.
 */
function toListingSeen(raw: Raw, card: Card | undefined, slice: Slice): ListingSeen {
  const attr: Raw = raw?.attr ?? {};
  const ref = refOf(raw);
  const model = text(raw?.model?.localized);
  // The card's subtitle is the seller's version text ("for two 122 PS Neuzustand").
  const trim = card?.subTitle && card.subTitle !== model ? card.subTitle : undefined;
  const fuel = fuelOf(text(attr.ft), card?.title ?? "");
  const consumption = text(attr.csmpt);
  const vehicle: VehicleDescriptor = {
    make: text(raw?.make?.localized),
    model,
    trim,
    sourceTaxonomy: slice.make === undefined ? undefined : { make: String(slice.make) },
    firstRegistration: yearMonth(attr.fr),
    fuel,
    powerKw: germanNumber(/([\d.]+)\s*kW\b/.exec(text(attr.pw))?.[1]),
    transmission: TRANSMISSIONS[text(attr.tr)],
    engineCc: germanNumber(/^([\d.]+)\s*cm/.exec(text(attr.cc))?.[1]),
    seats: germanNumber(text(attr.sc) || undefined),
    euroClass: germanNumber(/^Euro\s*(\d)/i.exec(text(attr.emc))?.[1]),
    ...(fuel === "bev"
      ? { consumptionKwh100km: germanNumber(/^([\d.,]+)\s*kWh/.exec(consumption)?.[1]) }
      : { consumptionL100km: germanNumber(/^([\d.,]+)\s*l\//.exec(consumption)?.[1]) }),
    co2GKm: germanNumber(/^([\d.,]+)\s*g\b/.exec(text(attr.emiss))?.[1]),
    color: text(attr.ecol) || undefined,
  };
  return dropUndefined({
    kind: "ListingSeen",
    ref,
    url: ref ? `${DETAILS}?id=${ref}` : "",
    market: "DE",
    condition: conditionOf(slice.condition, text(attr.subc)),
    vehicle: dropUndefined(vehicle),
    odometerKm: germanNumber(/^([\d.]+)\s*km/.exec(text(attr.ml))?.[1]),
    price: { amount: priceOf(raw?.price?.grs?.amount), currency: "EUR" },
    priceBasis: priceBasisOf(card?.price),
    seller: SELLERS[text(raw?.contact?.enumType)] ?? "unknown",
    location: dropUndefined({
      city: text(attr.loc) || undefined,
      postcode: text(attr.z) || undefined,
    }),
    photos: card?.photos ?? [],
    listedAt: isoDate(card?.onlineSince),
    inspectionValidUntil: yearMonth(attr.gi),
  });
}

/** Vorführfahrzeug and Tageszulassung (registered once, unused) count as demo cars. */
function conditionOf(slice: SliceCondition, registration: string): Condition {
  if (slice === "new") return "new";
  return registration === "Vorführfahrzeug" || registration === "Tageszulassung" ? "demo" : "used";
}

const TRANSMISSIONS: Record<string, Transmission> = {
  Schaltgetriebe: "manual",
  Automatik: "automatic",
  Halbautomatik: "automatic",
};

/** `contact.enumType`; private sellers are FSBO (for sale by owner). */
const SELLERS: Record<string, Seller> = { DEALER: "dealer", FSBO: "private" };

const FUELS: Record<string, Fuel> = {
  Benzin: "petrol",
  Diesel: "diesel",
  Elektro: "bev",
  "Autogas (LPG)": "lpg",
  "Erdgas (CNG)": "cng",
  Wasserstoff: "hydrogen",
  "Ethanol (FFV, E85 etc.)": "other",
  "Andere Kraftstoffart": "other",
};

/** Hybrids cover HEV and PHEV; only a title that says plug-in tells them apart. */
function fuelOf(label: string, title: string): Fuel | undefined {
  if (label.startsWith("Hybrid")) {
    return /plug-?in|phev|e-?hybrid/i.test(title) ? "phev" : undefined;
  }
  return FUELS[label];
}

/** A card that shows a net price beside the gross one is a dealer showing VAT. */
function priceBasisOf(price: Raw | undefined): PriceBasis {
  return typeof price?.nt?.amount === "number" ? "gross" : "unknown";
}

function priceOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

/** "03/2011" → { year: 2011, month: 3 }; "Neu" and anything else → undefined. */
function yearMonth(value: unknown): YearMonth | undefined {
  const match = /^(\d{2})\/(\d{4})$/.exec(text(value));
  if (!match) return undefined;
  const month = Number(match[1]);
  return { year: Number(match[2]), ...(month >= 1 && month <= 12 ? { month } : {}) };
}

/** "26.10.2026" (German time, the same day as Prague's) → "2026-10-26". */
function isoDate(value: string | undefined): IsoDate | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

/** German-formatted "35.047", "5,0" → 35047, 5. Undefined unless finite and >= 0. */
function germanNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
