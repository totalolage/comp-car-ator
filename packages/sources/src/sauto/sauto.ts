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
 * incremental: walks the whole newest-first order, in price halves where it outgrows the
 *   10,000-result window, one `sorting_date` fills a page, or a pass meets fewer listings than
 *   its band holds (Sauto's search replicas can disagree), then reads a detail for every
 *   listing it met moved since the last run (a day back on a first run), or without a date,
 *   that the Ledger does not know, up to `budget` search and detail calls; past it, or having met a
 *   listing without a date, the run fails and the next one resumes (see `incremental`).
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
/** Most results one search page serves: a larger `limit` gets HTTP 422 (2026-11-01). */
const PAGE_LIMIT = 1_000;
/**
 * Pages an incremental walk that lost its place pages back without getting further before it
 * fails: an order that shifted up more than this many pages between two searches is not followed.
 */
const BACKSTEPS = 3;
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
  /**
   * Results per search page, a whole number from 1 to 1,000, the most Sauto serves (else
   * `sautoSource` throws). Default 1,000: an incremental run walks the whole order. Incremental
   * pages overlap by a twentieth, at least one listing; pages of one or two never step on, so
   * their walk goes by price halves.
   */
  pageSize?: number;
  /** A full-run slice with more results than this is halved by price. Default 2,000. */
  sliceLimit?: number;
  /**
   * Search and detail requests an incremental run may make. Past it the run fails after
   * yielding what it read, and the next one retries. Default 2,400: some 40 minutes at 1/s.
   */
  budget?: number;
}

export function sautoSource(options: SautoOptions = {}): Source {
  const pageSize = options.pageSize ?? PAGE_LIMIT;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_LIMIT) {
    throw new Error(
      `Sauto pageSize must be a whole number from 1 to ${PAGE_LIMIT}, not ${pageSize}`,
    );
  }
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
  /**
   * Refs a short incremental pass missed and a walk of its price halves met: as likely as not
   * a listing one of Sauto's search replicas still shows as it was before an edit (see `walk`),
   * so its search item may be stale, and its detail is read whatever the item says.
   */
  private readonly suspects = new Set<string>();
  private readonly ctx: HarvestContext;
  private readonly filter: string | undefined;
  private readonly pageSize: number;
  private requests = 0;
  private budget = Number.POSITIVE_INFINITY;

  constructor(ctx: HarvestContext, filter: string | undefined, pageSize: number) {
    this.ctx = ctx;
    this.filter = filter;
    this.pageSize = pageSize;
  }

  /**
   * The listings moved up the order since the last run (a day back on a first run), and the
   * listings in scope without a well-formed `sorting_date` the walk meets, wherever Sauto sorts
   * them: no date shows whether one moved, nor where it stands in the order. Such a listing is
   * read, but then the run fails, keeping `lastRunAt`: the walk checks its coverage by dates, and
   * by counts that one undated listing arriving could make up for another moving unseen (a sweep of
   * the whole scope on 2026-11-01 met none). Nor can a count show the walk met an undated listing
   * that moved, when a listing with an old date comes in below the top as it moves. The cutoff
   * never bars an undated listing, though: one the walk missed stays eligible for every later run,
   * which reads it (and fails) when its walk meets it, or reads it in its window once an edit dates
   * it. Top-ups move some 5,000 older
   * listings a day (95 of the newest 100 on 2026-10-28), so a detail page each would take
   * longer than the hour the run may have. A known listing gets a ListingPriceSeen from its
   * search item instead, so its price changes land daily (an edit moves it up). Details go
   * only to the listings the Ledger does not know: those created since the last run or older
   * ones (published days after they were drafted, back after their removal, or not yet
   * reached by the census), and to two kinds whose search item may come from a search replica
   * that has not applied an edit yet (see `walk`): suspects, met first or again, and listings
   * met again at another date. A listing only ever met as a lagging replica's item, dated before the cutoff, shows
   * nothing to tell it from the rest, and waits for the census or its next edit. The run walks the whole order before any detail (some 110,000
   * listings took 173 searches of 1,000 and five minutes on 2026-11-01), so the order barely
   * moves under the walk, and no cutoff ends it before a listing it cannot date. Every price
   * comes out as met; the details follow, newest first (undated first, as any may be the
   * newest). A walk that fails still reads the listings it met, then fails the run. Searches
   * and details share `budget`. Past it the run fails, so `lastRunAt` stays and the next run
   * walks again, skipping the listings now known. Nothing moved up before the run began is
   * dropped: it is read, or the run fails; what moves up during the walk is in the next run's
   * window. (A listing that comes in with an old date, as a draft published late, is read when
   * the walk meets it since the cutoff; one dated before the next run's cutoff and coming in
   * where the walk has passed waits for the census. A first run has no last run to hold: what
   * it leaves, like what moved before its day, waits for the census too.)
   */
  async *incremental(budget: number): AsyncIterable<Observation> {
    this.budget = budget;
    const { checkpoint, now } = this.ctx;
    const from = checkpoint.lastRunAt
      ? checkpoint.lastRunAt.getTime() - SINCE_MARGIN_MS
      : now.getTime() - FIRST_RUN_LOOKBACK_MS;
    const since = pragueLocal(new Date(from));
    // The date each listing was first met at: one met again at another date may be served by a
    // search replica that has not applied its edit, so its detail is read (see `walk`).
    const met = new Map<string, string | undefined>();
    const unknown: Item[] = [];
    // Listings met without a well-formed date, in scope or not: none can be placed or counted on.
    const undated = new Set<string>();
    let failure: { error: unknown } | undefined;
    try {
      for await (const items of this.walk(since)) {
        for (const item of items) {
          if (dateOf(item) === undefined) undated.add(refOf(item) ?? "without an id");
          if (isSkipped(item)) continue;
          const ref = refOf(item);
          if (ref !== undefined) {
            if (met.has(ref)) {
              if (met.get(ref) !== dateOf(item) || this.suspects.has(ref)) unknown.push(item);
              continue;
            }
            met.set(ref, dateOf(item));
            if (checkpoint.isKnown(ref) && !this.suspects.has(ref)) {
              if (typeof item.price === "number") {
                yield {
                  kind: "ListingPriceSeen",
                  ref,
                  price: { amount: item.price, currency: "CZK" },
                };
              }
              continue;
            }
          }
          unknown.push(item);
        }
      }
    } catch (error) {
      if (this.ctx.signal.aborted) throw error;
      failure = { error };
    }
    const newest = (item: Item) => dateOf(item) ?? "\uffff";
    unknown.sort((a, b) => (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0));
    try {
      for (const item of unknown) yield* this.listing(item);
    } catch (error) {
      throw failure ? failure.error : error;
    }
    if (failure) throw failure.error;
    if (undated.size > 0) {
      throw new Error(
        `Sauto incremental met ${undated.size} ${undated.size === 1 ? "listing" : "listings"} without a well-formed sorting_date (${[...undated].slice(0, 5).join(", ")}): read, but no date or count shows the walk met every listing around them`,
      );
    }
  }

  /**
   * Every search item (of `band`, of every price when absent), newest first, page by page with
   * repeats, keeping those dated `since` or later and those without a well-formed date. The
   * order is by `sorting_date` alone: listings arrive at its top (created, edited, topped up)
   * or leave it, and listings sharing a `sorting_date` may come in any order, page to page. So
   * the walk keeps `reached`, a date it has met every listing dated after, and takes a page as
   * following on only when the page's first dated listing is dated after `reached`: every
   * listing dated `reached` or earlier is then on this page or past it, whichever listing left
   * or swapped places meanwhile. The next page starts `overlap` (a twentieth) above the first
   * listing dated like this page's last, so it repeats that whole tie and a few above it, and
   * a few removals meanwhile still leave a later date at its top (counting from the last dated
   * listing above the tie, when one between has no date). A page that starts at or below
   * `reached` has lost its place: the order shifted up past the overlap (the 2026-10-31 and
   * 2026-11-01 runs lost it 36 to 72 seconds after the page before, at offsets 5225 and 285,
   * reading details between pages). The walk then pages back, at most BACKSTEPS times without
   * getting further, and fails rather than skip. A tie filling nearly a page cannot be stepped
   * over; the query is walked again in price halves, as is one whose order outgrows the
   * 10,000-result window, each half with a window of its own (listings without a price drop
   * out, as they are skipped anyway; the halves share their middle price, so a listing stored
   * at a fraction of a crown falls in one). Only a well-formed date counts towards the walk's
   * place (a full page with none goes to price halves too), and a page whose dates are not
   * newest first fails the run. The walk goes to the end of every band, so a listing without a
   * date that stays put is met wherever it sits, and a page shorter than its total says fails
   * it. Dates cannot show where an undated listing moved, so each pass over a band must also
   * meet as many listings as its first page reported: if listings come in only at the top the
   * pass has left (as one that arrives, or moves when it is edited or topped up, does),
   * whatever the pass meets beyond its first page was in the band as it began, and meeting that
   * many means meeting them all (a
   * listing entering below the top can stand in for an undated one that moved: meeting an
   * undated one fails the run, but one with an old date cannot be told from the rest, so the
   * moved one stays eligible for a later run; see `incremental`). A pass falls short when a
   * listing is removed or topped up from below the walk meanwhile, and also, steadily, when
   * Sauto's search replicas disagree: each request goes to one of at least two, the same URL
   * always to the same one, and one may lag an edit for hours, still showing the listing at its
   * old date further down (2026-11-10: listing 211268217 dated 2026-11-10T08:35:14 at 384 on one,
   * 2026-11-06T11:03:53 at 1221 on the other; 12 such listings in band 327680-393216, batches
   * edited the same second). The replicas agreed on every total and on which listings a band
   * holds. A pass that reads the listing's new place from the lagging replica and its old place
   * from the other meets neither, and walking the same URLs again meets neither again. So a
   * short pass walks the band's price halves instead, each with its own pass and check, down to
   * bands one page holds: one page comes from one replica, which holds each listing once. A band
   * that cannot be split fails the run. A listing the short pass missed and the halves met is a
   * suspect: its item may be the lagging replica's, dated before `since` though edited since, so
   * it is kept whatever its date and its detail is read (see `incremental`). Every page size
   * overlaps by at least one listing, so no step goes unchecked; pages of one or two never step
   * on, and walk price halves.
   */
  private async *walk(
    since: string,
    band?: Band,
    missedBy: readonly ReadonlySet<string>[] = [],
  ): AsyncIterable<Item[]> {
    const short = yield* this.pass(since, band, missedBy);
    if (!short) return;
    const { met, of, seen } = short;
    this.ctx.log.warn("sauto incremental band came out short; walking its price halves", {
      band: bandName(band),
      met,
      of,
    });
    yield* this.halves(since, band, `a pass over it met ${met} of its ${of} listings`, [
      ...missedBy,
      seen,
    ]);
  }

  /**
   * One pass of `walk`; when it falls short of its first page's total, what it met (`seen`, by
   * ref) and of how many. `missedBy` holds what each short pass enclosing this one met: a listing
   * one of them missed is kept whatever its date, and marked a suspect.
   */
  private async *pass(
    since: string,
    band: Band | undefined,
    missedBy: readonly ReadonlySet<string>[],
  ): AsyncGenerator<Item[], { met: number; of: number; seen: ReadonlySet<string> } | undefined> {
    const overlap = Math.max(1, Math.floor(this.pageSize / 20));
    // Every listing the pass met; a malformed entry has no id, so its place stands in for it.
    const seen = new Set<string>();
    let reached: string | undefined;
    let backsteps = 0;
    let held = 0;
    for (let offset = 0; ; ) {
      if (offset + this.pageSize > WINDOW) {
        yield* this.halves(since, band, `its order outgrows the ${WINDOW}-result window`, missedBy);
        return;
      }
      const page = await this.search({ conditions: CONDITION_SEOS, band, offset });
      if (offset === 0 && page.total > WINDOW - this.pageSize) {
        yield* this.halves(since, band, `its ${page.total} results outgrow the window`, missedBy);
        return;
      }
      if (offset === 0 && reached === undefined) held = page.total;
      for (const [i, item] of page.items.entries()) seen.add(refOf(item) ?? `@${offset + i}`);
      const dates = page.items.map(dateOf);
      const dated = dates.filter((date) => date !== undefined);
      if (dated.some((date, i) => i > 0 && date > (dated[i - 1] as string))) {
        throw new Error(
          `Sauto incremental: the search page at offset ${offset} is not newest first`,
        );
      }
      const first = dated[0];
      if (reached !== undefined && !(first !== undefined && first > reached)) {
        if (backsteps >= BACKSTEPS || offset === 0) {
          throw new Error(`Sauto incremental lost its place in the order at offset ${offset}`);
        }
        backsteps++;
        this.ctx.log.warn("sauto incremental lost its place; paging back", { offset, backsteps });
        offset = Math.max(0, offset - (this.pageSize - overlap));
        continue;
      }
      yield page.items.filter((item, i) => {
        const ref = refOf(item);
        const missed = ref !== undefined && missedBy.some((met) => !met.has(ref));
        if (missed) this.suspects.add(ref);
        const date = dates[i];
        return missed || date === undefined || date >= since;
      });
      if (offset + page.items.length >= page.total) {
        return seen.size < held ? { met: seen.size, of: held, seen } : undefined;
      }
      if (page.items.length < this.pageSize) {
        throw new Error(
          `Sauto incremental: the search page at offset ${offset} holds ${page.items.length} of the ${page.total - offset} results past it`,
        );
      }
      const last = dated.at(-1);
      if (last === undefined) {
        const why = `no listing on its page at offset ${offset} is dated`;
        this.ctx.log.info("sauto incremental walks price halves", { offset, why });
        yield* this.halves(since, band, why, missedBy);
        return;
      }
      if (reached === undefined || last < reached) {
        reached = last;
        backsteps = 0;
      }
      // The next page starts `overlap` above the last listing dated after the tie, so a few
      // removals meanwhile still leave it there.
      const tie = dates.indexOf(last);
      const above = dates.findLastIndex((date, i) => i < tie && date !== undefined);
      const step = above + 1 - overlap;
      if (above < 0 || step <= 0) {
        const why = `${page.items.length - tie} listings dated ${last} fill its page`;
        this.ctx.log.info("sauto incremental walks price halves", { offset, why });
        yield* this.halves(since, band, why, missedBy);
        return;
      }
      offset += step;
    }
  }

  /** `walk` over each price half of `band` (of every price when absent). */
  private async *halves(
    since: string,
    band: Band | undefined,
    why: string,
    missedBy: readonly ReadonlySet<string>[],
  ): AsyncIterable<Item[]> {
    const halves = band
      ? halveSharing(band)
      : [{ from: 0, to: PRICE_TOP + 1 }, { from: PRICE_TOP }];
    if (!halves) {
      throw new Error(`Sauto incremental: band ${bandName(band)} cannot be split, and ${why}`);
    }
    for (const half of halves) yield* this.walk(since, half, missedBy);
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
    if (this.requests >= this.budget) {
      throw new Error(
        `Sauto incremental request budget ${this.budget} exhausted; remaining freshness scope must be retried`,
      );
    }
    this.requests++;
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

/** `from-to` of a band, `-` for every price. */
function bandName(band: Band | undefined): string {
  return band ? `${band.from}-${band.to ?? ""}` : "-";
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

/**
 * Halves of `band` that share its middle price (the lower one ends at it, inclusive), so a
 * listing priced between two whole crowns cannot fall between them. Undefined once a half
 * would be no narrower than `band`.
 */
function halveSharing(band: Band): [Band, Band] | undefined {
  const mid = band.to === undefined ? band.from * 2 : Math.floor((band.from + band.to) / 2);
  // The open band doubles its floor: past a safe integer it stops splitting.
  if (
    !Number.isSafeInteger(mid) ||
    mid <= band.from ||
    (band.to !== undefined && mid + 1 >= band.to)
  )
    return undefined;
  return [
    { from: band.from, to: mid + 1 },
    { ...band, from: mid },
  ];
}

/** A `sorting_date` as the site writes it ("2026-10-25T10:00:00"), or undefined. */
function dateOf(item: Item): string | undefined {
  const date = text(item.sorting_date);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date) ? date : undefined;
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
