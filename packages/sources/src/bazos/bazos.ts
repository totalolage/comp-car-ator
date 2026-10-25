/**
 * Bazoš (auto.bazos.cz): Czech classified ads for passenger cars, mostly private sellers.
 *
 * - Passenger cars sit in one category per make (`/skoda/`, `/bmw/` … plus `/ostatni/` for
 *   other makes); vans, trucks, damaged cars, parts and tyres have categories of their own,
 *   which the adapter leaves out. Make categories still hold misfiled parts, tyres and
 *   wanted ads, so each row's title is screened (text.ts).
 * - A category lists 20 ads per page at `/<category>/<offset>/`, ordered by when an ad was
 *   last bumped (paid TOP ads are re-bumped daily), not by id. Any offset works; offsets
 *   that are not a multiple of 20 answer HTTP 404 with the normal page. Pages are read 16
 *   apart so each overlaps the one before: a page that holds none of the previous page's
 *   ads means ads were removed above and the rest moved up, so the walk steps back instead
 *   of skipping the ads that moved past it.
 * - Ads have no structured car fields. A list row has title, price, place, date and a cut
 *   description; the ad page has the whole description, where odometer and year usually
 *   are (in a sample of 40 cars, list text stated the odometer for 20, ad pages for 37).
 *   The Ledger keeps what the last ListingSeen says, so every candidate ad gets its ad
 *   page, in both modes, rather than a mix of list and ad-page data. In scope: priced from
 *   10,000 Kč, not damaged, standing in Czechia (Bazoš also lists Slovak ads, as place
 *   "Slovensko"), year 2000 or later, odometer stated.
 * - full: per category, walk every page, then walk again from the top through today's ads
 *   (ads bumped or posted during the walk land there), and check the ads met cover the
 *   count the site reports. The category's ads are split by id into `parts` slices
 *   ("skoda;part=3/10"), each fetched and reported done in turn, so a census of the large
 *   categories (Škoda: ~31,000 ads) resumes part by part. A category whose walk cannot be
 *   reconciled reports no part done and fails the run at the end.
 * - incremental: per category, from the top, ad pages only for ads not in the Ledger and
 *   dated on or after the last run's day, stopping at the first page dated wholly before it.
 * - robots.txt disallows search, sort and price-filter parameters; the adapter reads only
 *   category pages and ad pages.
 * - Limits: the count check is a sanity check, not proof. A census still misses an ad that
 *   is bumped twice within one walk (behind the walk, then behind the top-up) or moved by
 *   the site into a category already walked; the next census sees it again. Edits that do
 *   not bump an ad wait for a full run. An ad whose text stops stating year or odometer
 *   leaves the scope and is retired like a removed one.
 *
 * Research notes: scrape-access.md (Bazoš row); behaviour verified live 2026-10-25.
 */
import {
  type IsoDate,
  type ListingSeen,
  type Observation,
  pragueDate,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";
import { CATEGORY_MAKES, carFactsOf, makeModelOf, nonCarReason, sellsForParts } from "./text.ts";

export interface BazosOptions {
  /**
   * Category slugs to cover ("skoda", "bmw", "ostatni"…). Default: every passenger-car
   * category. Narrows `scope`, so a narrowed census never retires other categories.
   */
  categories?: readonly string[];
  /** Slices per category in full runs, by ad id. Default 10. */
  parts?: number;
}

export const BAZOS_CATEGORIES = Object.keys(CATEGORY_MAKES);

const HOST = "https://auto.bazos.cz";
/** Offset step between list pages; the remaining 4 rows overlap the previous page. */
const STRIDE = 16;
/** Times one walk may step back before it gives up on keeping its place. */
const MAX_STEPS_BACK = 20;
const MIN_PRICE = 10_000;
const MAX_PRICE = 50_000_000;
const MIN_YEAR = 2000;
/** Price texts that mean "no price stated". */
const NO_PRICE =
  /^(dohodou|v textu|nabídněte|zdarma|nerozhoduje|na dotaz|info v textu|cena v textu|k jednání)$/i;
/** The place Bazoš shows for ads from Slovakia, outside the CZ market. */
const SLOVAKIA = "Slovensko";

export function bazosSource(options: BazosOptions = {}): Source {
  const categories = options.categories && [...new Set(options.categories)].sort();
  for (const slug of categories ?? []) {
    if (!BAZOS_CATEGORIES.includes(slug)) throw new RangeError(`bazos: unknown category ${slug}`);
  }
  const parts = options.parts ?? 10;
  if (!Number.isInteger(parts) || parts < 1 || parts > 100) {
    throw new RangeError("bazos parts must be a whole number from 1 to 100");
  }
  return {
    id: "bazos",
    scope: categories ? `categories:${categories.join(",")}` : undefined,
    harvest: (ctx) => new Harvest(ctx, categories ?? BAZOS_CATEGORIES, parts).run(),
  };
}

/** One ad as a category page lists it. */
interface Row {
  id: string;
  /** `/inzerat/<id>/<slug>.php` */
  path: string;
  title: string;
  /** Whole CZK; null when no price is stated ("Dohodou"). */
  price: number | null;
  date?: IsoDate;
  city?: string;
  postcode?: string;
  /** Why the row could not be read, when it has an id but not the rest. */
  malformed?: string;
}

interface ListPage {
  /** Ads in the category, as the page header counts them. */
  total: number;
  /** 1-based positions of the page's first and last row, as the header states them. */
  from: number;
  to: number;
  rows: Row[];
  /** Row blocks without an ad id. */
  idless: number;
}

/** The list moved under a walk more than it can follow. */
class LostPlace extends Error {
  constructor(category: string, offset: number) {
    super(`bazos: lost its place in ${category} at offset ${offset}`);
    this.name = "LostPlace";
  }
}

interface Stats {
  rows: number;
  candidates: number;
  details: number;
  seen: number;
  gone: number;
  outOfScope: number;
  malformed: number;
}

class Harvest {
  private readonly ctx: HarvestContext;
  private readonly categories: readonly string[];
  private readonly parts: number;
  private readonly full: boolean;
  private readonly today: IsoDate;
  private readonly thisYear: number;
  private readonly unfinished: string[] = [];
  /** Full runs: slices with an ad the parser could not read. */
  private readonly unreadable = new Set<string>();
  /** Whether each ad this run has met was known before the run, as first met. */
  private readonly knownBefore = new Map<string, boolean>();
  private stats: Stats = emptyStats();

  constructor(ctx: HarvestContext, categories: readonly string[], parts: number) {
    this.ctx = ctx;
    this.categories = categories;
    this.parts = parts;
    this.full = ctx.mode === "full";
    this.today = pragueDate(ctx.now);
    this.thisYear = Number(this.today.slice(0, 4));
  }

  async *run(): AsyncIterable<Observation> {
    for (const category of this.categories) {
      this.stats = emptyStats();
      if (this.full) yield* this.census(category);
      else yield* this.incremental(category);
      this.ctx.log.info("bazos category", { category, ...this.stats });
    }
    const problems = [
      this.unfinished.length > 0 && `categories not harvested whole: ${this.unfinished.join(" ")}`,
      this.unreadable.size > 0 && `slices with unreadable ads: ${[...this.unreadable].join(" ")}`,
    ].filter(Boolean);
    if (problems.length === 0) return;
    const message = `bazos: ${problems.join("; ")}`;
    // A full run that completed with rejected ads would end the census without applying
    // it, so the next run would start over; failing it keeps the done slices for a resume.
    if (this.full) throw new Error(message);
    this.ctx.log.warn(message);
  }

  private async *census(category: string): AsyncGenerator<Observation> {
    const parts = Array.from({ length: this.parts }, (_, part) => part).filter(
      (part) => this.ctx.checkpoint.sliceDoneAt(partKey(category, part, this.parts)) === null,
    );
    if (parts.length === 0) return;
    const rows = await this.collect(category);
    if (!rows) {
      this.unfinished.push(category);
      return;
    }
    for (const part of parts) {
      const slice = partKey(category, part, this.parts);
      const before = this.stats.malformed;
      for (const row of rows.values()) {
        if (Number(row.id) % this.parts === part) yield* this.observe(category, row);
      }
      // The Ledger does not count a slice with a rejected ad as done.
      if (this.stats.malformed > before) this.unreadable.add(slice);
      yield { kind: "SliceDone", slice };
    }
  }

  /**
   * Every ad in a category, by id: one walk over all pages, then one over today's ads,
   * which catches ads bumped from below the walk to above it. The site's count must not
   * exceed the ads met; a walk that falls short or loses its place is redone once. Null
   * when the category cannot be harvested whole.
   */
  private async collect(category: string): Promise<Map<string, Row> | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rows = new Map<string, Row>();
      let idless = 0;
      let total = 0;
      try {
        for await (const page of this.pages(category)) {
          for (const row of page.rows) rows.set(row.id, row);
          idless += page.idless;
        }
        let first = true;
        for await (const page of this.pages(category)) {
          if (first) total = page.total;
          first = false;
          for (const row of page.rows) rows.set(row.id, row);
          idless += page.idless;
          if (page.rows.every((row) => row.date !== undefined && row.date < this.today)) break;
        }
      } catch (error) {
        if (!(error instanceof LostPlace)) throw error;
        this.ctx.log.warn(error.message, { attempt });
        continue;
      }
      if (idless > 0) {
        // An ad without an id cannot be told apart from a gone one, so no census here.
        this.ctx.log.warn("bazos: list rows without an ad id", { category, idless });
        return null;
      }
      if (rows.size >= total) {
        this.stats.rows = rows.size;
        return rows;
      }
      this.ctx.log.warn("bazos: walk met fewer ads than the site counts", {
        category,
        met: rows.size,
        total,
        attempt,
      });
    }
    return null;
  }

  /**
   * New ads, from the top. An ad dated before the last run's day was listed during that run,
   * which recorded it or found it out of scope, so only unknown ads dated on or after that
   * day get their ad page, and the walk ends at the first page dated wholly before it (the
   * ads there are known or out of scope). Known-ness alone cannot end it: TOP ads, known
   * and re-bumped daily, fill the first pages, and out-of-scope ads never become known.
   * Without a last run every unknown ad is fetched.
   */
  private async *incremental(category: string): AsyncGenerator<Observation> {
    const cutoff = this.ctx.checkpoint.lastRunAt && pragueDate(this.ctx.checkpoint.lastRunAt);
    const isOld = (row: Row) => cutoff !== null && row.date !== undefined && row.date < cutoff;
    const handled = new Set<string>();
    try {
      for await (const page of this.pages(category)) {
        // Known means known before this run; taken for every row before any is yielded.
        const fresh = page.rows.filter((row) => {
          if (isOld(row) || handled.has(row.id)) return false;
          if (!row.malformed && !this.isCandidate(category, row)) return false;
          if (this.knewBefore(row.id)) return false;
          handled.add(row.id);
          return true;
        });
        this.stats.rows += page.rows.length;
        for (const row of fresh) yield* this.observe(category, row);
        if (page.rows.every(isOld)) return;
      }
    } catch (error) {
      if (!(error instanceof LostPlace)) throw error;
      this.unfinished.push(category);
      this.ctx.log.warn(error.message);
    }
  }

  /**
   * A category's pages from the top, each overlapping the one before by a few rows. Ends
   * at the page whose header reaches the count. Throws LostPlace when ads keep moving up
   * past the overlap faster than the walk can step back.
   */
  private async *pages(category: string): AsyncGenerator<ListPage> {
    let offset = 0;
    let previous: Set<string> | null = null;
    let stepsBack = 0;
    for (;;) {
      const page = await this.listPage(category, offset);
      if (previous && !page.rows.some((row) => previous?.has(row.id))) {
        if (offset === 0 || ++stepsBack > MAX_STEPS_BACK) throw new LostPlace(category, offset);
        offset = Math.max(0, offset - STRIDE);
        continue;
      }
      yield page;
      if (page.to >= page.total) return;
      previous = new Set(page.rows.map((row) => row.id));
      offset += STRIDE;
    }
  }

  /** A list page whose rows match its header; a page cut short is fetched once more. */
  private async listPage(category: string, offset: number): Promise<ListPage> {
    const url = offset === 0 ? `${HOST}/${category}/` : `${HOST}/${category}/${offset}/`;
    for (let attempt = 1; ; attempt++) {
      this.ctx.signal.throwIfAborted();
      const response = await this.ctx.http.get({ url, signal: this.ctx.signal });
      // Offsets off the 20-grid answer 404 with the normal page; the header tells them apart.
      if (response.status !== 200 && response.status !== 404) {
        throw new Error(`Bazoš returned HTTP ${response.status} for ${url}`);
      }
      const page = parseListPage(response.body, url);
      const expected = Math.max(0, Math.min(page.to, page.total) - page.from + 1);
      if (page.rows.length + page.idless === expected) return page;
      const message = `Bazoš list page has ${page.rows.length + page.idless} rows, its header ${expected}: ${url}`;
      if (attempt === 2) throw new Error(message);
      this.ctx.log.warn(message);
    }
  }

  /**
   * A candidate is worth a detail page: priced, standing in Czechia, a car by its title, not
   * older than 2000.
   */
  private isCandidate(category: string, row: Row): boolean {
    if (row.malformed || row.price === null || row.city === SLOVAKIA) return false;
    if (row.price < MIN_PRICE || row.price > MAX_PRICE) return false;
    if (nonCarReason(row.title) !== null) return false;
    if (!makeModelOf(row.title, CATEGORY_MAKES[category])) return false;
    const year = yearIn(carFactsOf(row.title, "", this.thisYear));
    return year === undefined || year >= MIN_YEAR;
  }

  /** The Observation for one listed ad, from its detail page; nothing when out of scope. */
  private async *observe(category: string, row: Row): AsyncGenerator<Observation> {
    const url = `${HOST}${row.path}`;
    if (row.malformed) {
      this.stats.malformed++;
      yield rejected(row.id, url, row.malformed, this.ctx);
      return;
    }
    if (!this.isCandidate(category, row)) return;
    this.stats.candidates++;
    this.ctx.signal.throwIfAborted();
    const page = await this.ctx.http.get({ url, signal: this.ctx.signal });
    this.stats.details++;
    const detail = parseDetail(page, row.id);
    if (detail === "gone") {
      this.stats.gone++;
      yield { kind: "ListingGone", ref: row.id };
      return;
    }
    if (typeof detail === "string") {
      this.stats.malformed++;
      yield rejected(row.id, url, detail, this.ctx);
      return;
    }
    const listing = this.toListingSeen(category, row, url, detail);
    if (listing) {
      this.stats.seen++;
      yield listing;
    } else {
      this.stats.outOfScope++;
    }
  }

  private toListingSeen(
    category: string,
    row: Row,
    url: string,
    detail: Detail,
  ): ListingSeen | null {
    const price = detail.price === undefined ? row.price : detail.price;
    if (price === null || price < MIN_PRICE || price > MAX_PRICE) return null;
    const title = detail.title || row.title;
    if (nonCarReason(title) !== null || sellsForParts(detail.description)) return null;
    const names = makeModelOf(title, CATEGORY_MAKES[category]);
    if (!names) return null;
    const facts = carFactsOf(title, detail.description, this.thisYear);
    const year = yearIn(facts);
    if (year === undefined || year < MIN_YEAR || facts.odometerKm === undefined) return null;
    const vehicle: VehicleDescriptor = {
      ...names,
      sourceTaxonomy: { make: category },
      firstRegistration: facts.firstRegistration,
      manufactureYear: facts.manufactureYear,
      modelYear: facts.modelYear,
      body: facts.body,
      fuel: facts.fuel,
      powerKw: facts.powerKw,
      transmission: facts.transmission,
      drive: facts.drive,
    };
    return {
      kind: "ListingSeen",
      ref: row.id,
      url,
      market: "CZ",
      condition: facts.condition,
      vehicle: dropUndefined(vehicle),
      odometerKm: facts.odometerKm,
      price: { amount: price, currency: "CZK" },
      priceBasis: facts.priceBasis,
      seller: facts.seller,
      ...(row.city || row.postcode
        ? { location: dropUndefined({ city: row.city, postcode: row.postcode }) }
        : {}),
      photos: detail.photos,
    };
  }

  private knewBefore(ref: string): boolean {
    let known = this.knownBefore.get(ref);
    if (known === undefined) {
      known = this.ctx.checkpoint.isKnown(ref);
      this.knownBefore.set(ref, known);
    }
    return known;
  }
}

function partKey(category: string, part: number, parts: number): string {
  return `${category};part=${part}/${parts}`;
}

function yearIn(facts: {
  firstRegistration?: { year: number };
  manufactureYear?: number;
  modelYear?: number;
}) {
  return facts.firstRegistration?.year ?? facts.manufactureYear ?? facts.modelYear;
}

/**
 * A ListingSeen the Ledger rejects (no price, no make): an ad the parser could not read
 * stays out of the Ledger and keeps its slice from counting as done, while the harvest goes
 * on with the other ads.
 */
function rejected(ref: string, url: string, reason: string, ctx: HarvestContext): ListingSeen {
  ctx.log.warn("bazos: unreadable ad", { ref, reason });
  return {
    kind: "ListingSeen",
    ref,
    url,
    market: "CZ",
    condition: "used",
    vehicle: { make: "", model: "" },
    price: { amount: Number.NaN, currency: "CZK" },
    priceBasis: "unknown",
    seller: "unknown",
    photos: [],
  };
}

function emptyStats(): Stats {
  return { rows: 0, candidates: 0, details: 0, seen: 0, gone: 0, outOfScope: 0, malformed: 0 };
}

// --- parsing ----------------------------------------------------------------------------

const ROW_START = '<div class="inzeraty inzeratyflex">';
const HEADER = /Zobrazeno\s+(\d+)\s*-\s*(\d+)\s+inzerát\p{L}*\s+z\s+(\d[\d\s]*\d|\d)/u;

function parseListPage(html: string, url: string): ListPage {
  const header = HEADER.exec(html.replace(/&nbsp;| /g, " "));
  if (!header) throw new Error(`Bazoš list page changed (no result count): ${url}`);
  const [, from, to, total] = header as unknown as [string, string, string, string];
  const page: ListPage = {
    total: Number(total.replace(/\D/g, "")),
    from: Number(from),
    to: Number(to),
    rows: [],
    idless: 0,
  };
  const blocks = html.split(ROW_START).slice(1);
  for (const block of blocks) {
    const row = parseRow(block);
    if (row) page.rows.push(row);
    else page.idless++;
  }
  return page;
}

function parseRow(block: string): Row | null {
  const link = /<a href="(\/inzerat\/(\d+)\/[^"]*)"/.exec(block);
  if (!link) return null;
  const [, path, id] = link as unknown as [string, string, string];
  const title = /<h2 class=nadpis><a [^>]*>([\s\S]*?)<\/a>/.exec(block);
  const priceCell = /<div class="inzeratycena">([\s\S]*?)<\/div>/.exec(block);
  const row: Row = { id, path, title: "", price: null };
  const date = /\[(\d{1,2})\.(\d{1,2})\.\s?(\d{4})\]/.exec(block);
  if (date) row.date = `${date[3]}-${pad(date[2])}-${pad(date[1])}`;
  const place = /<div class="inzeratylok">([\s\S]*?)<\/div>/.exec(block);
  if (place) {
    const [city, postcode] = (place[1] as string).split(/<br\s*\/?>/i).map((s) => text(s));
    if (city) row.city = city;
    if (postcode && /^\d{3}\s?\d{2}$/.test(postcode)) row.postcode = postcode.replace(/\s/g, "");
  }
  row.title = text(title?.[1] ?? "");
  const price = priceCell ? priceOf(text(priceCell[1] as string)) : "malformed";
  if (!row.title) row.malformed = "no title";
  else if (price === "malformed") row.malformed = `unreadable price ${text(priceCell?.[1] ?? "")}`;
  else row.price = price;
  return row;
}

function priceOf(shown: string): number | null | "malformed" {
  if (NO_PRICE.test(shown)) return null;
  const m = /^(\d[\d\s.]*)\s?Kč$/.exec(shown);
  if (!m) return "malformed";
  return Number((m[1] as string).replace(/[\s.]/g, ""));
}

interface Detail {
  title: string;
  description: string;
  photos: string[];
  /** Price on the detail page; undefined when it shows none we can read. */
  price?: number | null;
}

/** An ad's detail page, "gone" when the site says the ad is removed, or why it is unreadable. */
function parseDetail(
  page: { url: string; status: number; body: string },
  id: string,
): Detail | "gone" | string {
  if (!page.url.startsWith(`${HOST}/inzerat/${id}/`)) {
    // A removed ad redirects to a search page on the site; anything else is no answer.
    if (page.url.startsWith(`${HOST}/inzeraty/`)) return "gone";
    throw new Error(`Bazoš ad ${id} redirected to ${page.url}`);
  }
  const title = /<h1 class=nadpisdetail>([\s\S]*?)<\/h1>/i.exec(page.body);
  if (!title) {
    if (page.status === 404 || page.status === 410) return "gone";
    if (page.status !== 200) throw new Error(`Bazoš returned HTTP ${page.status} for ${page.url}`);
    return "detail page without a title";
  }
  const description = /<div class=popisdetail>([\s\S]*?)<\/div>/.exec(page.body);
  if (!description) return "detail page without a description";
  const photos = [...page.body.matchAll(/data-flickity-lazyload="([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  const detail: Detail = {
    title: text(title[1] as string),
    description: text(description[1] as string),
    photos: [...new Set(photos)],
  };
  const price = /Cena:[\s\S]{0,80}?<b>([\s\S]*?)<\/b>/.exec(page.body);
  if (price) {
    const value = priceOf(text(price[1] as string));
    if (value !== "malformed") detail.price = value;
  }
  return detail;
}

/** Plain text of an HTML fragment: tags dropped, line breaks kept, entities decoded. */
function text(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function pad(n: string | undefined): string {
  return (n ?? "").padStart(2, "0");
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
