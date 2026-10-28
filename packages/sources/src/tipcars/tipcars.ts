/**
 * TipCars (tipcars.com): Czech passenger-car listings, used ones made in 2000 or later and
 * every new or demo car.
 *
 * - Lists are server-rendered HTML, 20 listings a page (`?str=<page>-20`), newest first; the
 *   site serves no other order or page size outside its private API. Two lists cover the
 *   scope: `/ojete` (used, the site's category "O") and `/nove` (its category "N", "nové a
 *   předváděcí"). Filters are bare query keys: `2015-2015=` (year), `500000-599999kc=`
 *   (price, inclusive bounds).
 * - Each list card carries the site's own record as JSON (`data-measure-data-value`: id,
 *   category, make/model codes, year, kW, cc, km, price and its currency, doors, seats) next
 *   to the title, trim, shown price, the "bez DPH" line of VAT-deductible cars, seller and
 *   city; a page's ld+json ItemList adds the total and cover photos. Used listings come from
 *   the card alone. The price is the record's, in the seller's currency: the shown one is
 *   converted to Kč (a Dubai dealer's 10 830 EUR shows as 264 673 Kč).
 * - Only the detail page tells a demo car from a new one ("Stav: předváděcí vozidlo") and
 *   states gearbox, first registration, Euro class, colour, inspection and every photo. New
 *   and demo listings (a quarter of the scope) are therefore always read from their detail
 *   page, in every mode: the Ledger keeps a listing's latest ListingSeen whole, so a ref must
 *   come out with the same fields every run.
 * - full: slices `used:<year>` (the current year's slice is open above) and
 *   `new:<from>-<to>` (price bands; the last is open; the site's price filter leaves out
 *   listings without a price). A slice is paged to its end before any
 *   of its detail pages, so it is paged in minutes; then its listings, then SliceDone. Slices
 *   done earlier in the census are skipped. "Newest first" is by the date a listing was last
 *   updated, and dealers' feeds re-date listings all day: one re-dated while a pass reads
 *   further down jumps above it and is missed (a large used year, paged in some 15 minutes,
 *   came out 20 to 180 short of its count, every pass). So a slice short of the highest
 *   count its pages reported is paged again from the top, up to three passes, until the
 *   listings of all passes together reach that count; still short, it stays not done and the
 *   run fails after the other slices, so it is no census. Limit: a listing removed after one
 *   pass met it can stand in for one every pass missed; the Ledger retires a listing only
 *   after two censuses miss it.
 * - Out of scope: listings without a price ("Dohodou"), and cards of the site's "Ostatní"
 *   bucket (makes it does not list) that name no model.
 * - incremental: both lists newest first, yielding the listings not known before, each list
 *   stopping at a page with none in the scope.
 *
 * Research notes: scrape-access.md (TipCars row); lists, filters and pages verified against
 * the live site 2026-10-25. Cloudflare scores clients there, so every request starts at T1.
 */
import {
  type Body,
  type Condition,
  type Fuel,
  type ListingGone,
  type ListingSeen,
  type Observation,
  pragueDate,
  type Seller,
  type Transmission,
  type VehicleDescriptor,
  type YearMonth,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

export interface TipcarsOptions {
  /**
   * Most list pages one walk reads: per list in incremental runs, per slice in full runs,
   * where a slice with more pages fails the run. Default unlimited. For bounded recordings
   * and smoke runs.
   */
  maxPages?: number;
  /**
   * Full runs harvest only these slices (keys as in SliceDone, e.g. "used:2001"). Narrows
   * `scope` to them, so a partial census never retires other listings. For bounded
   * recordings and smoke runs.
   */
  slices?: readonly string[];
}

const BASE = "https://www.tipcars.com";
const PAGE_SIZE = 20;
/** Most times a full run pages one slice before it leaves the slice not done. */
const PASSES = 3;
const FIRST_YEAR = 2000;
/** The site's make code for its "Ostatní" (other makes) bucket. */
const OTHER_MAKE = "XX";
/** Lower edges of the new/demo price bands (CZK); the last band is open. */
const NEW_PRICE_EDGES = [
  0, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_200_000, 1_500_000, 2_000_000,
  3_000_000,
];

interface Slice {
  key: string;
  list: "ojete" | "nove";
  filter: string;
}

export function tipcarsSource(options: TipcarsOptions = {}): Source {
  const only = options.slices && [...new Set(options.slices)].sort();
  return {
    id: "tipcars",
    scope: only ? `slices:${only.join(",")}` : "all",
    harvest: (ctx) => new Harvest(ctx, options.maxPages ?? Number.POSITIVE_INFINITY, only).run(),
  };
}

class Harvest {
  /** Refs handled this run, so a listing seen twice costs one detail page. */
  private readonly done = new Set<string>();
  /** `isKnown` as of a ref's first sighting: the Ledger may record this run's listings as we go. */
  private readonly knownBefore = new Map<string, boolean>();
  private readonly ctx: HarvestContext;
  private readonly maxPages: number;
  private readonly only: readonly string[] | undefined;

  constructor(ctx: HarvestContext, maxPages: number, only: readonly string[] | undefined) {
    this.ctx = ctx;
    this.maxPages = maxPages;
    this.only = only;
  }

  async *run(): AsyncIterable<Observation> {
    if (this.ctx.mode === "incremental") {
      if (this.only) throw new Error("TipCars slices narrow full runs only");
      yield* this.incremental("ojete", `${FIRST_YEAR}-=`);
      yield* this.incremental("nove", "");
      return;
    }
    const short: string[] = [];
    for (const slice of this.slices()) {
      if (this.ctx.checkpoint.sliceDoneAt(slice.key)) continue;
      // Page the slice before any detail page, so it is paged in minutes and few listings
      // move under it.
      const { cards, complete } = await this.census(slice);
      for (const card of cards) yield* this.listing(card);
      if (complete) yield { kind: "SliceDone", slice: slice.key };
      else short.push(slice.key);
    }
    if (short.length > 0) {
      throw new Error(`TipCars slices yielded fewer listings than reported: ${short.join(", ")}`);
    }
  }

  private slices(): Slice[] {
    const thisYear = Number(pragueDate(this.ctx.now).slice(0, 4));
    const all: Slice[] = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) {
      all.push({ key: `used:${year}`, list: "ojete", filter: `${year}-${year}=` });
    }
    // Open above, as the incremental list is: a year ahead of the calendar is a typo or a
    // model year, still a used car of the scope.
    all.push({ key: `used:${thisYear}-`, list: "ojete", filter: `${thisYear}-=` });
    NEW_PRICE_EDGES.forEach((from, i) => {
      const next = NEW_PRICE_EDGES[i + 1];
      const to = next === undefined ? "" : String(next - 1);
      all.push({ key: `new:${from}-${to}`, list: "nove", filter: `${from}-${to}kc=` });
    });
    if (!this.only) return all;
    const unknown = this.only.filter((key) => !all.some((s) => s.key === key));
    if (unknown.length > 0) throw new Error(`Unknown TipCars slices: ${unknown.join(", ")}`);
    return all.filter((s) => this.only?.includes(s.key));
  }

  /**
   * Every card of a slice, paged again (up to PASSES times) while the passes so far have
   * fewer distinct listings than the highest total any of their pages reported. A listing
   * re-dated while a pass reads further down jumps above it and is missed; the next pass,
   * starting at the top, meets it there. The cards of every pass come out either way.
   */
  private async census(slice: Slice): Promise<{ cards: Card[]; complete: boolean }> {
    const cards = new Map<string, Card>();
    let reported = 0;
    for (let pass = 1; pass <= PASSES; pass++) {
      for await (const page of this.pages(slice.list, slice.filter, true)) {
        reported = Math.max(reported, page.total);
        for (const card of page.cards) if (!cards.has(card.ref)) cards.set(card.ref, card);
      }
      if (cards.size >= reported) return { cards: [...cards.values()], complete: true };
      this.ctx.log.warn("tipcars slice came out short", {
        slice: slice.key,
        pass,
        distinct: cards.size,
        reported,
      });
    }
    return { cards: [...cards.values()], complete: false };
  }

  /**
   * New listings of one list, newest first, up to the first page with none in the scope: a
   * card outside it never becomes known, so it cannot keep the walk going.
   */
  private async *incremental(list: Slice["list"], filter: string): AsyncIterable<Observation> {
    for await (const page of this.pages(list, filter, false)) {
      const fresh = page.cards.filter((card) => !this.wasKnown(card.ref));
      for (const card of fresh) yield* this.listing(card);
      if (!fresh.some((card) => outOfScope(card) === null)) return;
    }
  }

  private wasKnown(ref: string): boolean {
    let known = this.knownBefore.get(ref);
    if (known === undefined) {
      known = this.ctx.checkpoint.isKnown(ref);
      this.knownBefore.set(ref, known);
    }
    return known;
  }

  /**
   * A list's pages from the first to its last, an empty first page included (or `maxPages`;
   * a full walk then throws).
   */
  private async *pages(list: Slice["list"], filter: string, full: boolean) {
    for (let n = 1; ; n++) {
      if (n > this.maxPages) {
        if (full)
          throw new Error(`TipCars /${list}?${filter} has more than ${this.maxPages} pages`);
        return;
      }
      const query = [n > 1 ? `str=${n}-${PAGE_SIZE}` : "", filter].filter(Boolean).join("&");
      const url = `${BASE}/${list}${query ? `?${query}` : ""}`;
      const page = parseListPage(await this.get(url), url);
      this.ctx.log.info("tipcars page", { url, cards: page.cards.length, total: page.total });
      if (page.cards.length > 0 || n === 1) yield page;
      if (page.cards.length === 0 || n * PAGE_SIZE >= page.total) return;
    }
  }

  private async *listing(card: Card): AsyncIterable<ListingSeen | ListingGone> {
    if (!card.ref || !card.category) {
      // Without the site's record the card's condition is unknown.
      this.ctx.log.warn("tipcars card without its record", { ref: card.ref, url: card.url });
      yield rejected(card);
      return;
    }
    if (this.done.has(card.ref)) return;
    this.done.add(card.ref);
    const outside = outOfScope(card);
    if (outside) {
      this.ctx.log.info(`tipcars listing ${outside}`, { ref: card.ref });
      return;
    }
    if (!card.currency) {
      this.ctx.log.warn("tipcars price in an unknown currency", {
        ref: card.ref,
        code: card.record.price_currency,
      });
    }
    if (card.category !== "N") {
      yield toListingSeen(card);
      return;
    }
    const page = await this.ctx.http.get(this.request(card.url));
    if (page.status === 404 || page.status === 410) {
      yield { kind: "ListingGone", ref: card.ref };
      return;
    }
    if (page.status !== 200)
      throw new Error(`TipCars returned HTTP ${page.status} for ${card.url}`);
    const detail = parseDetailPage(page.body);
    if (!detail.condition) {
      this.ctx.log.warn("tipcars detail without a known Stav", { ref: card.ref, url: card.url });
      yield rejected(card);
      return;
    }
    yield toListingSeen(card, detail);
  }

  private async get(url: string): Promise<string> {
    this.ctx.signal.throwIfAborted();
    const page = await this.ctx.http.get(this.request(url));
    if (page.status !== 200) throw new Error(`TipCars returned HTTP ${page.status} for ${url}`);
    return page.body;
  }

  private request(url: string) {
    return { url, minTier: "T1" as const, locale: "cs" as const, signal: this.ctx.signal };
  }
}

// ---------------------------------------------------------------------------------------
// List pages

/** One list card, parsed but not yet mapped. Fields the card lacks stay undefined. */
interface Card {
  ref: string;
  url: string;
  category?: string;
  title: string;
  trim?: string;
  record: Raw;
  price?: number;
  currency?: string;
  /** "Dohodou": the card shows no price (its record says 0). */
  priceOnRequest: boolean;
  vatDeductible: boolean;
  sellerText?: string;
  cover?: string;
}

interface ListPage {
  total: number;
  cards: Card[];
}

type Raw = Record<string, unknown>;

function parseListPage(html: string, url: string): ListPage {
  const itemList = ldJson(html).find((d) => d["@type"] === "ItemList");
  if (!itemList || !Number.isInteger(itemList.numberOfItems)) {
    throw new Error(`TipCars page changed: no ld+json ItemList at ${url}`);
  }
  const items = new Map<string, Raw>();
  // An array, or an object keyed by position when it skips cards: it leaves out listings
  // without photos, so it serves only cover photos and the total.
  for (const element of asArray(itemList.itemListElement)) {
    const item = (element as Raw)?.item as Raw | undefined;
    if (typeof item?.url === "string") items.set(item.url, item);
  }
  const marker = 'data-listing-item-id-value="';
  const chunks = html.split(marker).slice(1);
  const cards = chunks.map((chunk) => {
    const record = attrJson(chunk, "data-measure-data-value");
    const data = (Array.isArray(record) ? record[1] : undefined) as Raw | undefined;
    const path = attr(chunk, "data-offer-listing-url-param") ?? "";
    const absolute = path ? new URL(path, BASE).href : "";
    const item = items.get(absolute);
    const priceBlock = between(chunk, 'class="advertisement-name__price"', "</section>") ?? "";
    const seller = attrJson(chunk, "data-contact-phone-detail-value") as Raw | undefined;
    return {
      ref: chunk.slice(0, chunk.indexOf('"')),
      url: absolute,
      category: text(data?.category) || undefined,
      title: clean(between(chunk, 'class="advertisement-name__title"', "</h3>")?.split("<h3>")[1]),
      trim: clean(between(chunk, '<p class="text-M">', "</p>")) || undefined,
      record: data ?? {},
      price: whole(data?.price),
      currency: CURRENCIES.get(text(data?.price_currency)),
      priceOnRequest: data?.price === 0 && /Dohodou/i.test(priceBlock),
      vatDeductible: /bez(?:&nbsp;|\s)+DPH/.test(priceBlock),
      sellerText: text(seller?.description) || undefined,
      cover: text(item?.image) || undefined,
    } satisfies Card;
  });
  return { total: itemList.numberOfItems as number, cards };
}

/**
 * The record's `price_currency` codes, as the detail page names them. Any other code leaves
 * the currency undefined, so the listing comes out as one the Ledger rejects.
 */
const CURRENCIES = new Map([
  ["A", "CZK"],
  ["L", "EUR"],
]);

// ---------------------------------------------------------------------------------------
// Detail pages (new and demo listings)

interface Detail {
  /** Absent when the page states neither "nové" nor "předváděcí". */
  condition?: Condition;
  make?: string;
  model?: string;
  seller: Seller;
  photos: string[];
  city?: string;
  postcode?: string;
  boxes: Record<string, string>;
  euroClass?: number;
}

function parseDetailPage(html: string): Detail {
  const product = ldJson(html).find((d) => d["@type"] === "Product");
  const offer = product?.offers as Raw | undefined;
  const seller = offer?.seller as Raw | undefined;
  const address = seller?.address as Raw | undefined;
  const description = attr(html, "content", '<meta data-helmet name="description"') ?? "";
  const state = /Stav: ([^.]+)\./.exec(description)?.[1]?.toLowerCase() ?? "";
  const boxes: Record<string, string> = {};
  for (const m of html.matchAll(/detail-box__info-icon">([^<:]+):<\/div>([^<]*)<\/div>/g)) {
    const value = clean(m[2]);
    if (value && value !== "neuvedeno") boxes[clean(m[1])] = value;
  }
  const emission = /detail-box__subtitle">Emise<\/div>\s*<ul>\s*<li>([^<]+)<\/li>/.exec(html);
  return {
    condition: state.includes("předváděcí") ? "demo" : state.startsWith("nov") ? "new" : undefined,
    make: text((product?.brand as Raw | undefined)?.name) || undefined,
    model: text(product?.model) || undefined,
    seller:
      seller?.["@type"] === "Organization"
        ? "dealer"
        : seller?.["@type"] === "Person"
          ? "private"
          : "unknown",
    photos: asArray(product?.image)
      .map((image) => text((image as Raw)?.url))
      .filter(Boolean),
    city: text(address?.addressLocality) || undefined,
    postcode: text(address?.postalCode).replace(/\s/g, "") || undefined,
    boxes,
    euroClass: euroClass(clean(emission?.[1])),
  };
}

// ---------------------------------------------------------------------------------------
// Mapping

/**
 * Why a card is outside the scope, or null. The scope is priced listings ("Dohodou" is not)
 * of a named make and model. The site files makes it does not list under "Ostatní", whose
 * cards name no model (title "Ostatní", the rest in the trim); the Ledger takes no listing
 * without one, and a guess from the trim would be a guess.
 */
function outOfScope(card: Card): string | null {
  if (card.priceOnRequest) return "without a price";
  if (text(card.record.manufacturer) === OTHER_MAKE && !splitTitle(card.title)[1]) {
    return "of an unnamed make and model";
  }
  return null;
}

/** A card the adapter cannot map comes out without a ref, as a ListingSeen the Ledger rejects. */
function rejected(card: Card): ListingSeen {
  return toListingSeen({ ...card, ref: "" });
}

/**
 * A card without a ref, price or title becomes a ListingSeen the Ledger rejects, so a broken
 * parse keeps its slice not done instead of passing for a listing that is gone.
 */
function toListingSeen(card: Card, detail?: Detail): ListingSeen {
  const r = card.record;
  const [make, model] =
    detail?.make && detail.model ? [detail.make, detail.model] : splitTitle(card.title);
  const box = detail?.boxes ?? {};
  const [body, fuel] = slugSpecs(card.url, box.palivo);
  const vehicle: VehicleDescriptor = dropUndefined({
    make,
    model,
    trim: card.trim,
    sourceTaxonomy: dropUndefined({
      make: text(r.manufacturer) || undefined,
      model: text(r.model) || undefined,
    }),
    // The card has one year: of manufacture ("vyrobeno"), or of first registration ("v
    // provozu od") when the seller gave only that, as about half of the used listings sampled
    // do. Only the detail page says which; consumers read either as the listing's year.
    firstRegistration: yearMonth(box["v provozu od"]),
    manufactureYear: detail ? whole(box.vyrobeno) : whole(r.made_year),
    body,
    fuel,
    powerKw: r.engine_power_unit === "A" ? whole(r.engine_power) : undefined,
    transmission: transmission(box.převodovka),
    engineCc: whole(r.engine_capacity),
    seats: whole(r.seats),
    doors: whole(r.doors),
    euroClass: detail?.euroClass,
    color: box.barva,
  });
  // The card names the seller, then " • " and its locality when it has one.
  const city = detail?.city ?? card.sellerText?.split(" • ")[1];
  return dropUndefined({
    kind: "ListingSeen",
    ref: card.ref,
    url: card.url,
    market: "CZ",
    condition: detail?.condition ?? "used",
    vehicle,
    odometerKm:
      r.odometer_unit === "A" && typeof r.odometer === "number" && r.odometer >= 0
        ? r.odometer
        : undefined,
    price: { amount: card.price ?? Number.NaN, currency: card.currency ?? "" },
    priceBasis: card.vatDeductible ? "gross" : "unknown",
    seller: detail?.seller ?? "unknown",
    location:
      city || detail?.postcode ? dropUndefined({ city, postcode: detail?.postcode }) : undefined,
    photos: detail?.photos.length ? detail.photos : card.cover ? [card.cover] : [],
    inspectionValidUntil: yearMonth(box.STK),
  }) as ListingSeen;
}

/** Makes whose name has a space; any other title is "<make> <model>". */
const MULTI_WORD_MAKES = [
  "Alfa Romeo",
  "Aston Martin",
  "Great Wall",
  "Land Rover",
  "Lynk & Co",
  "DS Automobiles",
];

function splitTitle(title: string): [string, string] {
  const make =
    MULTI_WORD_MAKES.find((m) => title.toLowerCase().startsWith(`${m.toLowerCase()} `)) ??
    title.split(" ")[0] ??
    "";
  return [title.slice(0, make.length), title.slice(make.length).trim()];
}

/** URL path `/make-model/[body/]fuel/slug-id.html`: body and fuel slugs in the site's words. */
const BODY_SLUGS: Record<string, Body> = {
  hatchback: "hatchback",
  liftback: "hatchback",
  sedan: "sedan",
  limuzina: "sedan",
  kombi: "wagon",
  suv: "suv",
  terenni: "suv",
  cuv: "suv",
  mpv: "mpv",
  kupe: "coupe",
  kabriolet: "convertible",
  roadster: "convertible",
  "pick-up": "pickup",
  van: "van",
  minibus: "van",
  ostatni: "other",
};
const FUEL_SLUGS: Record<string, Fuel> = {
  benzin: "petrol",
  nafta: "diesel",
  elektro: "bev",
  lpg: "lpg",
  cng: "cng",
  vodik: "hydrogen",
};

function slugSpecs(url: string, fuelText?: string): [Body | undefined, Fuel | undefined] {
  const segments = url ? new URL(url).pathname.split("/").slice(2, -1) : [];
  const body = segments.map((s) => BODY_SLUGS[s]).find(Boolean);
  const fuel = segments.map((s) => FUEL_SLUGS[s]).find(Boolean) ?? hybrid(fuelText);
  return [body, fuel];
}

/**
 * Hybrid URLs ("hybridni", "hybridni-benzin") do not tell a plug-in from a full or mild
 * hybrid; the detail page's "palivo" text may.
 */
function hybrid(fuelText = ""): Fuel | undefined {
  const t = fuelText.toLowerCase();
  if (t.includes("plug-in")) return "phev";
  return t.startsWith("hybrid") ? "hev" : undefined;
}

function transmission(value?: string): Transmission | undefined {
  if (!value) return undefined;
  if (value.startsWith("aut")) return "automatic";
  if (value.startsWith("manu")) return "manual";
  return undefined;
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

/** "plní 'euro vi'" or "euro 6d" → 6. */
function euroClass(value: string): number | undefined {
  const m = /euro\s*([ivx]+|\d)/i.exec(value);
  if (!m?.[1]) return undefined;
  const n = ROMAN[m[1].toLowerCase()] ?? Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : undefined;
}

function yearMonth(value?: string): YearMonth | undefined {
  const m = /^(?:(\d{1,2})\/)?(\d{4})$/.exec(value ?? "");
  if (!m) return undefined;
  const month = m[1] ? Number(m[1]) : undefined;
  return dropUndefined({ year: Number(m[2]), month: month && month <= 12 ? month : undefined });
}

// ---------------------------------------------------------------------------------------
// Markup helpers

function ldJson(html: string): Raw[] {
  const out: Raw[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const value = JSON.parse(m[1] as string);
      if (value && typeof value === "object") out.push(value);
    } catch {
      // A broken block is skipped; the ones the adapter needs are checked by their callers.
    }
  }
  return out;
}

/** The decoded value of the first `name="…"` attribute (after `after`, when given). */
function attr(html: string, name: string, after = ""): string | undefined {
  const start = after ? html.indexOf(after) : 0;
  if (start < 0) return undefined;
  const m = new RegExp(` ${name}="([^"]*)"`).exec(html.slice(start));
  return m ? decode(m[1] as string) : undefined;
}

function attrJson(html: string, name: string): unknown {
  const value = attr(html, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function between(html: string, start: string, end: string): string | undefined {
  const i = html.indexOf(start);
  if (i < 0) return undefined;
  const j = html.indexOf(end, i + start.length);
  return j < 0 ? undefined : html.slice(i + start.length, j);
}

/** Text content: tags dropped, entities decoded, whitespace collapsed. */
function clean(html?: string): string {
  if (!html) return "";
  return decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function whole(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : Number(text(value).replace(/\D/g, "") || Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !("@type" in value)) return Object.values(value);
  return value === undefined ? [] : [value];
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
