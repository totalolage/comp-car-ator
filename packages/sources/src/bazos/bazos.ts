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
 *   10,000 Kč, not damaged, not new (a title offering a new car with under 100 km), standing in
 *   Czechia (Bazoš also lists Slovak ads, as place "Slovensko"), year 2000 or later, odometer
 *   stated.
 * - full: per category, walk every page, then walk again from the top through today's ads
 *   (ads bumped or posted during the walk land there), and check the ads met cover the
 *   count the site reports. The category's ads are split by id into `parts` slices
 *   ("skoda;part=3/10"), each fetched and reported done in turn, so a census of the large
 *   categories (Škoda: ~31,000 ads) resumes part by part. A category whose walk cannot be
 *   reconciled reports no part done and fails the run at the end; the other categories
 *   still run. Each ad names its part (`ListingSeen.slice`, in both modes), so the parts that
 *   finish retire the ads they no longer list while Ford never finishes. A walk gives each
 *   known ad a ListingPriceSeen as it meets it, so one moved into another category stays live
 *   even when that walk is not taken or the run fails or is stopped later.
 * - incremental: per category, from the top, ad pages for the ads on each page read that are
 *   not in the Ledger and a ListingPriceSeen from the list row for those it knows, stopping
 *   after the first page dated wholly before the last run's day (yesterday, without a
 *   complete run yet).
 * - A list page can show fewer rows than its header counts, twice running: seen in Citroën
 *   mid-list, where the same page and its neighbours read later showed every row, so the
 *   site served it short; Ford and Mercedes pages lack an ad the site counts but never lists.
 *   Incremental reads the rows shown and goes on. A census walk cannot tell which ad such a
 *   page lacks, so it does not take the walk (see `collect`): a category where the site
 *   counts an ad it never lists stays out of the census, and the run fails naming it.
 * - robots.txt disallows search, sort and price-filter parameters; the adapter reads only
 *   category pages and ad pages.
 * - Limits: the count check is a sanity check, not proof. A census still misses an ad that
 *   the site moves into a category already walked, and one bumped twice within one walk
 *   (behind the walk, then behind the top-up) when an older ad met and removed before a
 *   count rose again makes up the number; the next census sees them again. Edits that do
 *   not bump an ad wait for a full run, a price change too. A known ad stays live while its
 *   list row is a candidate: a census walk proves it from the row (`meet`), so one whose ad
 *   page alone puts it out of scope (its text stops stating year or odometer, it is sold for
 *   parts) keeps the fields of its last ListingSeen until it is removed or its row leaves
 *   the scope. Reads a walk does not take (a page it steps back from, an uneven page's first
 *   read) prove nothing.
 *
 * Research notes: scrape-access.md (Bazoš row); behaviour verified live 2026-10-25.
 */
import {
  type IsoDate,
  type ListingPriceSeen,
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
/** Short pages a failure reason names before it only counts the rest. */
const PAGES_NAMED = 5;
const DAY_MS = 86_400_000;
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
  /** `/<category>/<offset>/` */
  path: string;
  /** Ads in the category, as the page header counts them. */
  total: number;
  /** 1-based positions of the page's first and last row, as the header states them. */
  from: number;
  to: number;
  /** Rows the header counts on this page. */
  expected: number;
  rows: Row[];
  /** Row blocks without an ad id. */
  idless: number;
  /** Whether the rows still did not match the header when the page was fetched again. */
  uneven: boolean;
}

/** The list moved under a walk more than it can follow. */
class LostPlace extends Error {
  readonly reason: string;
  constructor(category: string, offset: number) {
    super(`bazos: lost its place in ${category} at offset ${offset}`);
    this.name = "LostPlace";
    this.reason = `lost its place at offset ${offset}`;
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
  /** Known ads given a ListingPriceSeen from their list row. */
  prices: number;
}

class Harvest {
  private readonly ctx: HarvestContext;
  private readonly categories: readonly string[];
  private readonly parts: number;
  private readonly full: boolean;
  private readonly today: IsoDate;
  private readonly thisYear: number;
  /** Categories not harvested whole, each with why. */
  private readonly unfinished = new Map<string, string[]>();
  /** Full runs: slices with an ad the parser could not read. */
  private readonly unreadable = new Set<string>();
  /** Whether each ad this run has met was known before the run, as first met. */
  private readonly knownBefore = new Map<string, boolean>();
  /** Ads this run has given an Observation, or is reading the ad page of. */
  private readonly sighted = new Set<string>();
  /** Ads this run has given a rejected sighting (`reject`). */
  private readonly rejectedAds = new Set<string>();
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
      this.unfinished.size > 0 &&
        `categories not harvested whole: ${[...this.unfinished]
          .map(([category, reasons]) => `${category} (${reasons.join("; ")})`)
          .join(", ")}`,
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
    const rows = yield* this.collect(category);
    if (typeof rows === "string") {
      this.unfinish(category, rows);
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
   * which catches ads bumped from below the walk to above it. A walk that loses its place,
   * meets a page whose rows do not match its header (when fetched again too), or whose ads
   * do not reconcile with the site's counts is redone once. Otherwise, why the category
   * cannot be harvested whole.
   *
   * A page short of its header lacks an ad, and nothing tells which: the ad a neighbouring
   * page shows at a place the short page claims may have moved there between the two reads,
   * and an ad the site counts but never lists (seen live 2026-10-28 on Ford and Mercedes
   * pages, 19 of 20 rows) lies on no page. Taking the count lower by the rows such pages
   * lack would let an ad met on a neighbour stand in for one the walk missed, so no walk
   * with such a page is taken. A page with more rows than its header is not taken either.
   *
   * An ad met and removed later in the walk must not stand in for one the walk missed, so
   * - the ads met must cover the highest count any page reported, which includes an ad
   *   removed after that page,
   * - and the ads met, less those the walk over today's ads proves gone, must cover the
   *   count when that walk began. Gone: ads met dated today that it did not meet (every ad
   *   dated today is above its end).
   * An ad removed before a count rose again is not caught by either, so the check narrows
   * the gap without closing it (see Limits). The known ads met go out as met (`meet`).
   */
  private async *collect(
    category: string,
  ): AsyncGenerator<ListingPriceSeen | ListingSeen, Map<string, Row> | string> {
    let reason = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rows = new Map<string, Row>();
      const datedToday = new Set<string>();
      const toppedUp = new Set<string>();
      /** Pages whose rows did not match their header, when fetched again too. */
      const uneven: ListPage[] = [];
      let idless = 0;
      let highest = 0;
      let final = 0;
      try {
        for await (const page of this.pages(category)) {
          highest = Math.max(highest, page.total);
          for (const row of page.rows) {
            rows.set(row.id, row);
            if (row.date === this.today) datedToday.add(row.id);
          }
          idless += page.idless;
          if (page.uneven) uneven.push(page);
          yield* this.meet(category, page.rows);
        }
        let first = true;
        for await (const page of this.pages(category)) {
          if (first) final = page.total;
          first = false;
          highest = Math.max(highest, page.total);
          for (const row of page.rows) {
            rows.set(row.id, row);
            toppedUp.add(row.id);
          }
          idless += page.idless;
          if (page.uneven) uneven.push(page);
          yield* this.meet(category, page.rows);
          if (page.rows.every((row) => row.date !== undefined && row.date < this.today)) break;
        }
      } catch (error) {
        if (!(error instanceof LostPlace)) throw error;
        this.ctx.log.warn(error.message, { attempt });
        reason = error.reason;
        continue;
      }
      if (idless > 0) {
        // An ad without an id cannot be told apart from a gone one, so no census here.
        this.ctx.log.warn("bazos: list rows without an ad id", { category, idless });
        return `${idless} list rows without an ad id`;
      }
      const gone = [...datedToday].filter((id) => !toppedUp.has(id)).length;
      const covered = rows.size >= highest && rows.size - gone >= final;
      if (uneven.length === 0 && covered) {
        this.stats.rows = rows.size;
        return rows;
      }
      const reasons: string[] = [];
      if (uneven.length > 0) {
        this.ctx.log.warn("bazos: walk met a list page whose rows do not match its header", {
          category,
          pages: uneven.map(rowsOf),
          attempt,
        });
        reasons.push(`pages whose rows do not match their header: ${named(uneven)}`);
      }
      if (!covered) {
        this.ctx.log.warn("bazos: walk met fewer ads than the site counts", {
          category,
          met: rows.size,
          gone,
          highest,
          final,
          attempt,
        });
        reasons.push(
          rows.size < highest
            ? `met ${rows.size} ads of ${highest} counted`
            : `met ${rows.size} ads, ${gone} since gone, of ${final} counted`,
        );
      }
      reason = reasons.join("; ");
    }
    return reason;
  }

  /**
   * Proof that the known ads among the list rows a census walk takes are live, as the walk
   * meets them, once a run: a ListingPriceSeen from a candidate's row, or for an unreadable
   * row the rejected sighting it would get in its part (which keeps that part out of the
   * census, as there). So an ad that moved here from a part that finishes is not missed
   * there, even when this walk is not taken or the run fails or is stopped later. Whether the
   * ad is still in scope its ad page tells after the walk, in the parts not done yet, so a
   * known ad listed as a candidate stays live (see Limits).
   */
  private *meet(category: string, rows: readonly Row[]): Iterable<ListingPriceSeen | ListingSeen> {
    for (const row of rows) {
      if (this.sighted.has(row.id)) continue;
      if (row.malformed) {
        if (!this.knewBefore(row.id)) continue;
        this.sighted.add(row.id);
        // Out of the parts loop, so its part is marked here.
        this.unreadable.add(this.partOf(category, row));
        yield* this.reject(category, row, row.malformed);
        continue;
      }
      if (row.price === null || !this.isCandidate(category, row) || !this.knewBefore(row.id))
        continue;
      this.sighted.add(row.id);
      this.stats.prices++;
      yield {
        kind: "ListingPriceSeen",
        ref: row.id,
        price: { amount: row.price, currency: "CZK" },
      };
    }
  }

  /**
   * New ads, from the top: every candidate on a page read that the Ledger did not know before
   * this run gets its ad page, whatever its date, so an ad the last run could not read is
   * tried again. Every candidate it knew gets a ListingPriceSeen with its row's price (a row
   * stating none gets nothing), so the price of every ad bumped since the last run lands
   * daily without an ad page. The walk ends after the first page dated wholly before the last
   * run's day: that run listed those ads, so the ones below are known, out of scope, or left
   * for the next full run. Known-ness alone cannot end it: TOP ads, known and re-bumped daily,
   * fill the first pages, and out-of-scope ads never become known, so the pages read each
   * time cost a few repeat ad pages for those. Without a last run the walk ends after the
   * first page dated wholly before yesterday: reading every page of every category takes
   * hours, so that run would never complete and give the next one its day, and a full run
   * reads the ads below anyway.
   *
   * The walk goes no deeper for the prices of ads not bumped: the 145,390 ads listed on
   * 2026-10-29 are some 9,100 pages at 16 new rows a page, about 175 minutes at the 1.15 s a
   * request takes, more than the 150 minutes the run may have (apps/ingest schedule) before
   * the ad pages for new ads. Their prices come from the weekly census. Whether editing an
   * ad's price bumps it is unverified (no older row in a 2026-10-29 sample was comparable).
   */
  private async *incremental(category: string): AsyncGenerator<Observation> {
    const { lastRunAt } = this.ctx.checkpoint;
    const cutoff = pragueDate(lastRunAt ?? new Date(this.ctx.now.getTime() - DAY_MS));
    const isOld = (row: Row) => row.date !== undefined && row.date < cutoff;
    const handled = new Set<string>();
    try {
      for await (const page of this.pages(category)) {
        // Known means known before this run; taken for every row before any is yielded.
        const fresh: Row[] = [];
        const prices: ListingPriceSeen[] = [];
        for (const row of page.rows) {
          if (handled.has(row.id)) continue;
          if (!row.malformed && !this.isCandidate(category, row)) continue;
          if (!this.knewBefore(row.id)) {
            handled.add(row.id);
            fresh.push(row);
          } else if (row.price !== null) {
            // A candidate's list price is the one its ad page shows, which its ListingSeen
            // carries, so a known ad's price is kept daily without its ad page. A malformed
            // row has none; the same ad on the next page may.
            handled.add(row.id);
            prices.push({
              kind: "ListingPriceSeen",
              ref: row.id,
              price: { amount: row.price, currency: "CZK" },
            });
          }
        }
        this.stats.rows += page.rows.length;
        // The rows shown are read; one left out may wait for the next full run.
        if (page.uneven)
          this.unfinish(category, `page whose rows do not match its header: ${rowsOf(page)}`);
        this.stats.prices += prices.length;
        yield* prices;
        for (const row of fresh) yield* this.observe(category, row);
        if (page.rows.every(isOld)) return;
      }
    } catch (error) {
      if (!(error instanceof LostPlace)) throw error;
      this.unfinish(category, error.reason);
      this.ctx.log.warn(error.message);
    }
  }

  private unfinish(category: string, reason: string): void {
    const reasons = this.unfinished.get(category) ?? [];
    reasons.push(reason);
    this.unfinished.set(category, reasons);
  }

  /**
   * A category's pages from the top, each overlapping the one before by a few rows. Ends
   * at the page whose header reaches the count. Throws LostPlace when ads keep moving up
   * past the overlap faster than the walk can step back, or a page shows none of its rows.
   */
  private async *pages(category: string): AsyncGenerator<ListPage> {
    let offset = 0;
    let previous: Set<string> | null = null;
    let stepsBack = 0;
    for (;;) {
      const page = await this.listPage(category, offset);
      // A page showing none of its rows leaves the walk nowhere to go on from.
      if (page.uneven && page.rows.length === 0) throw new LostPlace(category, offset);
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

  /**
   * A list page; one whose rows do not match its header is fetched once more, then taken as
   * it is, marked uneven.
   */
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
      if (page.rows.length + page.idless === page.expected) return page;
      const message = `Bazoš list page has ${page.rows.length + page.idless} rows, its header ${page.expected}: ${url}`;
      this.ctx.log.warn(message);
      if (attempt === 2) return { ...page, uneven: true };
    }
  }

  /**
   * A candidate is worth a detail page: priced, standing in Czechia, a car by its title, not
   * older than 2000 nor new.
   */
  private isCandidate(category: string, row: Row): boolean {
    if (row.malformed || row.price === null || row.city === SLOVAKIA) return false;
    if (row.price < MIN_PRICE || row.price > MAX_PRICE) return false;
    if (nonCarReason(row.title) !== null) return false;
    if (!makeModelOf(row.title, CATEGORY_MAKES[category])) return false;
    const facts = carFactsOf(row.title, "", this.thisYear);
    const year = yearIn(facts);
    return facts.condition !== "new" && (year === undefined || year >= MIN_YEAR);
  }

  /** The Observation for one listed ad, from its detail page; nothing when out of scope. */
  private async *observe(category: string, row: Row): AsyncGenerator<Observation> {
    const url = `${HOST}${row.path}`;
    const slice = this.partOf(category, row);
    if (row.malformed) {
      this.sighted.add(row.id);
      yield* this.reject(category, row, row.malformed);
      return;
    }
    if (!this.isCandidate(category, row)) return;
    this.sighted.add(row.id);
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
      yield* this.reject(category, row, detail);
      return;
    }
    const listing = this.toListingSeen(category, row, url, detail);
    if (listing) {
      this.stats.seen++;
      yield { ...listing, slice };
    } else {
      this.stats.outOfScope++;
    }
  }

  /** The part a census harvests an ad in, in both modes (ListingSeen.slice). */
  private partOf(category: string, row: Row): string {
    return partKey(category, Number(row.id) % this.parts, this.parts);
  }

  /**
   * An ad that cannot be read, as a ListingSeen the Ledger rejects, naming its part; once a
   * run (a known ad's unreadable row comes out as the walk meets it, `meet`).
   */
  private *reject(category: string, row: Row, reason: string): Iterable<ListingSeen> {
    if (this.rejectedAds.has(row.id)) return;
    this.rejectedAds.add(row.id);
    this.stats.malformed++;
    const url = `${HOST}${row.path}`;
    yield { ...rejected(row.id, url, reason, this.ctx), slice: this.partOf(category, row) };
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
    // The scope is used cars; a demonstrator counts as one, a new car does not.
    if (facts.condition === "new") return null;
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

/** A page by its rows shown and its header's: `/ford/960/ 19 of 20`. */
function rowsOf(page: ListPage): string {
  return `${page.path} ${page.rows.length + page.idless} of ${page.expected}`;
}

/** The first few pages, each once (both walks read some), then how many more. */
function named(pages: readonly ListPage[]): string {
  const shown = [...new Set(pages.map(rowsOf))];
  const more = shown.length - PAGES_NAMED;
  return shown.slice(0, PAGES_NAMED).join(", ") + (more > 0 ? ` and ${more} more` : "");
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
  return {
    rows: 0,
    candidates: 0,
    details: 0,
    seen: 0,
    gone: 0,
    outOfScope: 0,
    malformed: 0,
    prices: 0,
  };
}

// --- parsing ----------------------------------------------------------------------------

const ROW_START = '<div class="inzeraty inzeratyflex">';
const HEADER = /Zobrazeno\s+(\d+)\s*-\s*(\d+)\s+inzerát\p{L}*\s+z\s+(\d[\d\s]*\d|\d)/u;

function parseListPage(html: string, url: string): ListPage {
  const header = HEADER.exec(html.replace(/&nbsp;| /g, " "));
  if (!header) throw new Error(`Bazoš list page changed (no result count): ${url}`);
  const [, from, to, total] = header as unknown as [string, string, string, string];
  const page: ListPage = {
    path: url.slice(HOST.length),
    total: Number(total.replace(/\D/g, "")),
    from: Number(from),
    to: Number(to),
    expected: 0,
    rows: [],
    idless: 0,
    uneven: false,
  };
  page.expected = Math.max(0, Math.min(page.to, page.total) - page.from + 1);
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
