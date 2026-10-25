/**
 * Auto ESA (autoesa.cz): the dealer group's own used-car stock, passenger cars first
 * registered in 2000 or later. Every car is used (the site sells no new or demo cars) and
 * the seller is the dealer.
 *
 * - Lists are server-rendered HTML (Nette), 19 cards a page (`?stranka=<page>`); the site
 *   offers no other page size. `/vsechna-auta` lists the whole stock, vans included, with
 *   filters `rok_od`/`rok_do` (year, inclusive) and the order `razeni`: 8 is newest in stock
 *   first, 7 oldest first (neither is in the site's own order menu, both verified live). A
 *   list reports its total ("Počet vozů") and last page; a page past the last repeats it.
 * - A card has the URL (`/<make>/<model>/<body>/<fuel>/<id>`), title, engine, kW, km and
 *   only the "Akční cena": a price "for businesses on selected financing products". The
 *   consumer price ("Cena v hotovosti", after any time-limited extra discount) is on the
 *   detail page alone, in its analytics record `dataexp_view_item` (`price_cash`, make,
 *   model, km, year, `car_category`), with the spec table (gearbox, seats, doors, colour,
 *   drive, CO2, STK), the VAT note and the gallery. So every listing is read from its detail
 *   page, in every mode: the Ledger keeps a listing's latest ListingSeen whole.
 * - The year ("Rok") is the year the car entered service: the page says so.
 * - A car whose detail page says "Užitkové" (a commercial vehicle) is outside the scope: it
 *   counts towards its slice but yields nothing; any other category than "Osobní" is a
 *   change of the site, rejected. A sold car's URL answers 200 with "Tento vůz je prodán":
 *   ListingGone.
 * - full: slices `year:<year>` from 2000, the current year open above (`year:<year>-`). A
 *   slice is paged to its end, oldest first (a car added meanwhile lands at the end), before
 *   any of its detail pages; a slice with fewer distinct listings than it reports is paged
 *   once more; still short, it stays not done, its listings come out after the other
 *   slices' and the run fails. Slices done earlier in the census are skipped.
 * - incremental: the list newest first, reading the cars not known before, up to a page
 *   with none. A van is never known, so a page with one does not stop the walk (vans are
 *   about 4% of the stock: the walk goes on a page or so further).
 *
 * Research notes: scrape-access.md (Autoesa row); lists, filters, orders and pages verified
 * against the live site 2026-10-25. robots.txt disallows only `/xml-feed`, which is unused.
 */
import {
  type Body,
  type Drive,
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

export interface AutoesaOptions {
  /**
   * Most list pages one walk reads: the list in incremental runs, each slice in full runs,
   * where a slice with more pages fails the run. Default unlimited. For bounded recordings
   * and smoke runs.
   */
  maxPages?: number;
  /**
   * Full runs harvest only these slices (keys as in SliceDone, e.g. "year:2001"). Narrows
   * `scope` to them, so a partial census never retires other listings. For bounded
   * recordings and smoke runs.
   */
  slices?: readonly string[];
}

const BASE = "https://www.autoesa.cz";
const FIRST_YEAR = 2000;
const NEWEST_FIRST = "8";
const OLDEST_FIRST = "7";

interface Slice {
  key: string;
  filter: string;
}

export function autoesaSource(options: AutoesaOptions = {}): Source {
  const only = options.slices && [...new Set(options.slices)].sort();
  return {
    id: "autoesa",
    scope: only ? `slices:${only.join(",")}` : "all",
    harvest: (ctx) => new Harvest(ctx, options.maxPages ?? Number.POSITIVE_INFINITY, only).run(),
  };
}

class Harvest {
  /** Refs whose detail page was read this run, so a listing seen twice costs one request. */
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
      if (this.only) throw new Error("Autoesa slices narrow full runs only");
      yield* this.incremental();
      return;
    }
    // A short slice's listings come out after every slice that is done: the Ledger counts the
    // Observations before a SliceDone towards that slice, and a rejected one among a short
    // slice's would keep the next slice not done.
    const short: { slice: Slice; cards: Card[] }[] = [];
    for (const slice of this.slices()) {
      if (this.ctx.checkpoint.sliceDoneAt(slice.key)) continue;
      // Page the slice before any detail page, so it is paged in a minute or two and few
      // listings move under it.
      const { cards, complete } = await this.census(slice);
      if (!complete) {
        short.push({ slice, cards });
        continue;
      }
      for (const card of cards) yield* this.listing(card);
      yield { kind: "SliceDone", slice: slice.key };
    }
    for (const { cards } of short) {
      for (const card of cards) yield* this.listing(card);
    }
    if (short.length > 0) {
      const keys = short.map((s) => s.slice.key).join(", ");
      throw new Error(`Autoesa slices yielded fewer listings than reported: ${keys}`);
    }
  }

  private slices(): Slice[] {
    const thisYear = Number(pragueDate(this.ctx.now).slice(0, 4));
    const all: Slice[] = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) {
      all.push({ key: `year:${year}`, filter: `rok_od=${year}&rok_do=${year}` });
    }
    // Open above, as the incremental list is: a year ahead of the calendar is still a car
    // of the scope.
    all.push({ key: `year:${thisYear}-`, filter: `rok_od=${thisYear}` });
    if (!this.only) return all;
    const unknown = this.only.filter((key) => !all.some((s) => s.key === key));
    if (unknown.length > 0) throw new Error(`Unknown Autoesa slices: ${unknown.join(", ")}`);
    return all.filter((s) => this.only?.includes(s.key));
  }

  /**
   * Every card of a slice, paged twice when the first pass has fewer distinct listings than
   * the slice reports (a listing removed meanwhile shifts the next one onto a page already
   * read). A pass is complete when it alone reaches the highest total any of its pages
   * reported; the cards of both passes come out either way.
   */
  private async census(slice: Slice): Promise<{ cards: Card[]; complete: boolean }> {
    const cards = new Map<string, Card>();
    for (let pass = 1; pass <= 2; pass++) {
      const keys = new Set<string>();
      let reported = 0;
      for await (const page of this.pages(`${slice.filter}&razeni=${OLDEST_FIRST}`, true)) {
        reported = Math.max(reported, page.total);
        for (const card of page.cards) {
          keys.add(card.key);
          if (!cards.has(card.key)) cards.set(card.key, card);
        }
      }
      if (keys.size >= reported) return { cards: [...cards.values()], complete: true };
      this.ctx.log.warn("autoesa slice came out short", {
        slice: slice.key,
        pass,
        distinct: keys.size,
        reported,
      });
    }
    return { cards: [...cards.values()], complete: false };
  }

  /** New listings, newest first, up to the first page with none. */
  private async *incremental(): AsyncIterable<Observation> {
    const filter = `rok_od=${FIRST_YEAR}&razeni=${NEWEST_FIRST}`;
    for await (const page of this.pages(filter, false)) {
      let fresh = 0;
      for (const card of page.cards) {
        if (card.ref && this.wasKnown(card.ref)) continue;
        // Any card not known before counts, a listing read earlier this run, a van, a sold or
        // a broken one included: the walk stops only at a page of known listings.
        fresh++;
        yield* this.listing(card);
      }
      if (fresh === 0) return;
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
   * A list's pages from the first to the last any of them reports (or `maxPages`; a full walk
   * then throws). A page that loses its pagination cannot cut the walk short.
   */
  private async *pages(filter: string, full: boolean) {
    let last = 1;
    for (let n = 1; ; n++) {
      if (n > this.maxPages) {
        if (full) throw new Error(`Autoesa ?${filter} has more than ${this.maxPages} pages`);
        return;
      }
      const url = `${BASE}/vsechna-auta?${filter}${n > 1 ? `&stranka=${n}` : ""}`;
      const page = parseListPage(await this.get(url), url, n);
      this.ctx.log.info("autoesa page", { url, cards: page.cards.length, total: page.total });
      last = Math.max(last, page.lastPage);
      yield page;
      if (page.cards.length === 0 || n >= last) return;
    }
  }

  private async *listing(card: Card): AsyncIterable<ListingSeen | ListingGone> {
    if (!card.ref) {
      this.ctx.log.warn("autoesa card without a listing URL", { href: card.url });
      yield rejected(card.url);
      return;
    }
    if (this.done.has(card.ref)) return;
    this.done.add(card.ref);
    const page = await this.ctx.http.get(this.request(card.url));
    if (page.status === 404 || page.status === 410) {
      yield { kind: "ListingGone", ref: card.ref };
      return;
    }
    if (page.status !== 200)
      throw new Error(`Autoesa returned HTTP ${page.status} for ${card.url}`);
    const detail = parseDetailPage(page.body);
    if (detail === "sold") {
      yield { kind: "ListingGone", ref: card.ref };
      return;
    }
    if (!detail) {
      this.ctx.log.warn("autoesa detail without its record", { ref: card.ref, url: card.url });
      yield rejected(card.url);
      return;
    }
    if (detail.category === COMMERCIAL) {
      // No ListingSeen: the scope is passenger cars.
      this.ctx.log.info("autoesa listing outside the scope", { ref: card.ref });
      return;
    }
    if (detail.category !== PASSENGER) {
      this.ctx.log.warn("autoesa detail of an unknown category", {
        ref: card.ref,
        category: detail.category,
      });
      yield rejected(card.url);
      return;
    }
    const seen = toListingSeen(card, detail);
    if (!Number.isFinite(seen.price.amount)) {
      this.ctx.log.warn("autoesa detail without a cash price", { ref: card.ref, url: card.url });
    }
    yield seen;
  }

  private async get(url: string): Promise<string> {
    this.ctx.signal.throwIfAborted();
    const page = await this.ctx.http.get(this.request(url));
    if (page.status !== 200) throw new Error(`Autoesa returned HTTP ${page.status} for ${url}`);
    return page.body;
  }

  private request(url: string) {
    return { url, locale: "cs" as const, signal: this.ctx.signal };
  }
}

// ---------------------------------------------------------------------------------------
// List pages

/** One list card: the listing's URL and the site's slugs in it. */
interface Card {
  /** The listing id, or "" when the card's link is not a listing URL. */
  ref: string;
  /** Distinct per listing; per card position for a card without a ref. */
  key: string;
  url: string;
  slugs: { make: string; model: string; body: string; fuel: string };
}

interface ListPage {
  total: number;
  lastPage: number;
  cards: Card[];
}

const LISTING_PATH = /^\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)$/;

function parseListPage(html: string, url: string, n: number): ListPage {
  const total = /Počet vozů(?:&nbsp;|\s)*<strong>(\d+)<\/strong>/.exec(html)?.[1];
  if (total === undefined) throw new Error(`Autoesa page changed: no "Počet vozů" at ${url}`);
  const pagination = between(html, 'id="snippet--paginationTop"', "</ul>") ?? "";
  // A page links to the pages around it; the first page's link has no `stranka`.
  const lastPage = Math.max(
    n,
    ...[...pagination.matchAll(/stranka=(\d+)/g)].map((m) => Number(m[1])),
  );
  const cards = [...html.matchAll(/<a href="([^"]*)"\s+class="car_item"[\s>]/g)].map((m, i) => {
    const href = decode(m[1] as string);
    const path = LISTING_PATH.exec(href);
    const ref = path?.[5] ?? "";
    return {
      ref,
      key: ref || `#${n}:${i}`,
      url: path ? `${BASE}${href}` : href,
      slugs: {
        make: path?.[1] ?? "",
        model: path?.[2] ?? "",
        body: path?.[3] ?? "",
        fuel: path?.[4] ?? "",
      },
    } satisfies Card;
  });
  if (n === 1 && lastPage === 1 && cards.length < Number(total)) {
    throw new Error(`Autoesa page changed: no pagination for ${total} listings at ${url}`);
  }
  return { total: Number(total), lastPage, cards };
}

// ---------------------------------------------------------------------------------------
// Detail pages

const PASSENGER = "Osobní";
const COMMERCIAL = "Užitkové";

interface Detail {
  /** The site's vehicle category: "Osobní" (passenger) or "Užitkové" (commercial). */
  category: string;
  record: Raw;
  /** The "Základní údaje" table: label → value. */
  specs: Record<string, string>;
  vatDeductible: boolean;
  photos: string[];
}

type Raw = Record<string, unknown>;

/** The page's details, "sold" for the site's sold-car page, undefined when unreadable. */
function parseDetailPage(html: string): Detail | "sold" | undefined {
  if (/id="isCarSold"\s+type="hidden"\s+value="true"/.test(html)) return "sold";
  const json = between(html, "var dataexp_view_item = ", "};");
  let record: Raw | undefined;
  try {
    record = json ? (JSON.parse(`${json}}`) as Raw) : undefined;
  } catch {
    record = undefined;
  }
  if (!record || !text(record.car_category)) return undefined;
  const table = between(html, 'id="zakladni_udaje"', "</ul>") ?? "";
  const specs: Record<string, string> = {};
  for (const m of table.matchAll(/<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>/g)) {
    const value = clean(m[2]);
    // Labels lose their markup without a space: "Emise CO<small>2</small>" is "Emise CO2".
    if (value) specs[clean((m[1] as string).replace(/<[^>]*>/g, ""))] = value;
  }
  const id = text(record.product_id);
  const photos = new Set<string>();
  for (const m of html.matchAll(/<a href="(\/files\/cars\/(\d+)\/[^"]+\.jpg[^"]*)"/g)) {
    if (m[2] === id) photos.add(`${BASE}${decode(m[1] as string)}`);
  }
  return {
    category: text(record.car_category),
    record,
    specs,
    vatDeductible: html.includes("Možnost odpočtu DPH"),
    photos: [...photos],
  };
}

// ---------------------------------------------------------------------------------------
// Mapping

/** An item the adapter cannot map comes out without a ref, as a ListingSeen the Ledger rejects. */
function rejected(url: string): ListingSeen {
  return {
    kind: "ListingSeen",
    ref: "",
    url,
    market: "CZ",
    condition: "used",
    vehicle: { make: "", model: "" },
    price: { amount: Number.NaN, currency: "" },
    priceBasis: "unknown",
    seller: "dealer",
    photos: [],
  };
}

/** A detail without a cash price gives a ListingSeen the Ledger rejects (price NaN). */
function toListingSeen(card: Card, detail: Detail): ListingSeen {
  const r = detail.record;
  const s = detail.specs;
  const make = text(r.make);
  const model = text(r.type);
  const year = whole(s.Rok) ?? whole(r.manufature_year);
  const price = whole(r.price_cash);
  const vehicle: VehicleDescriptor = dropUndefined({
    make,
    model,
    trim: trimOf(text(r.title), make, model),
    sourceTaxonomy: { make: card.slugs.make, model: card.slugs.model },
    // "Označení rok udává rok uvedení vozidla do provozu."
    firstRegistration: year ? { year } : undefined,
    body: BODY_SLUGS[card.slugs.body],
    fuel: fuel(s.Palivo ?? text(r.fuel_type), text(r.title)),
    powerKw: whole(s.Výkon),
    transmission: transmission(s.Převodovka),
    drive: drive(s.Pohon),
    seats: whole(s["Počet míst"]),
    doors: whole(s["Počet dveří"]),
    co2GKm: whole(/^(\d+)\s*g\/km/.exec(s["Emise CO2"] ?? "")?.[1]),
    color: s.Barva,
  });
  const km = r.mileage;
  return dropUndefined({
    kind: "ListingSeen",
    ref: card.ref,
    url: card.url,
    market: "CZ",
    condition: "used",
    vehicle,
    odometerKm: typeof km === "number" && Number.isInteger(km) && km >= 0 ? km : undefined,
    price: { amount: price ?? Number.NaN, currency: text(r.local_currency) },
    // "Možnost odpočtu DPH": the price shown includes VAT a business buyer can deduct. The
    // site says nothing about the others' VAT, so it is not taken for the margin scheme.
    priceBasis: detail.vatDeductible ? "gross" : "unknown",
    seller: "dealer",
    photos: detail.photos,
    inspectionValidUntil: monthYear(/(\d{1,2})\/(\d{4})/.exec(s.STK ?? "")),
  }) as ListingSeen;
}

/** The title is "<make> <model> <engine> <equipment>"; the rest after make and model is trim. */
function trimOf(title: string, make: string, model: string): string | undefined {
  const prefix = `${make} ${model}`;
  if (!title.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
  return title.slice(prefix.length).trim() || undefined;
}

/** URL body slugs, the site's "Karoserie" values. */
const BODY_SLUGS: Record<string, Body> = {
  kombi: "wagon",
  hatchback: "hatchback",
  liftback: "hatchback",
  sedan: "sedan",
  mpv: "mpv",
  suv: "suv",
  kabriolet: "convertible",
  kupe: "coupe",
  minibus: "van",
  van: "van",
  "pick-up": "pickup",
  skrin: "other",
  valnik: "other",
  sklapec: "other",
  "chladici-mrazici": "other",
};

/**
 * The site's "Palivo" values. "hybridní" does not tell a full or mild hybrid from a plug-in,
 * so it stays undefined unless the title marks a plug-in ("PHEV", "Plug-in", Škoda "iV").
 */
function fuel(value: string, title: string): Fuel | undefined {
  const v = value.toLowerCase();
  if (v.startsWith("lpg")) return "lpg";
  if (v.startsWith("cng")) return "cng";
  if (v.startsWith("hybrid")) return /plug-in|phev|\biV\b/i.test(title) ? "phev" : undefined;
  return ({ benzín: "petrol", nafta: "diesel", elektro: "bev" } as Record<string, Fuel>)[v];
}

/** "automat/7", "manual/6". */
function transmission(value?: string): Transmission | undefined {
  if (!value) return undefined;
  if (value.startsWith("aut")) return "automatic";
  if (value.startsWith("manu")) return "manual";
  return undefined;
}

/** "4x4" is all-wheel drive; "4x2" does not say which axle. */
function drive(value?: string): Drive | undefined {
  return value === "4x4" ? "awd" : undefined;
}

function monthYear(m: RegExpExecArray | null): YearMonth | undefined {
  if (!m) return undefined;
  const month = Number(m[1]);
  return month >= 1 && month <= 12 ? { year: Number(m[2]), month } : undefined;
}

// ---------------------------------------------------------------------------------------
// Markup helpers

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

/** A positive whole number from a number or the digits of a text ("110 kW", "126 405 km"). */
function whole(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : Number(text(value).replace(/\D/g, "") || Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
