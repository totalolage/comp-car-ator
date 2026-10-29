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
 * - full: a census of slices `used:<year>` (the current year's slice is open above) and
 *   `new` (the new list). A slice is paged to its end before any of its detail pages, then
 *   its listings come out, then SliceDone; slices done earlier in the census are skipped. A
 *   slice is done when one pass alone meets as many distinct listings as its pages report:
 *   passes are never pooled, since a listing gone and another arrived between two passes
 *   would let their union reach the count without one every pass missed. A short slice is
 *   paged once more.
 * - Paging is by offset, and the site sometimes serves a listing at the foot of one page and
 *   the head of the next, which pushes another off both, the same way on every pass (2017
 *   under 200,000 Kč: 682 reported, 681 met on each of two passes); slices of 68 to 405
 *   listings were whole on every pass. So a slice reporting more than 400 listings (20
 *   pages), or one still short over more than one page, is split by price, dearest first:
 *   the new list into fixed bands (`new:500000-599999`), a used year at 1,000,000 Kč
 *   (`used:2017:0-999999`), an open band [from, ∞) at 2·from, a closed one in the middle at
 *   whole Kč. A split slice is done when each part is, a recount finds no listing outside
 *   them, and the distinct listings harvested for it (from its parts, the proofs below and
 *   the parts done earlier in the census, paged again) are at least as many as it reports at
 *   the end. That count is taken at the end, not at the start: a listing sold before its
 *   part was paged leaves nothing to harvest. Prices mostly drop, so a listing that drops
 *   into a part not yet harvested is still met; one that rises into a part already done
 *   balances the recount without coming out, but leaves the count by ref short: a year then
 *   gets the whole pass below, a price band stays not done. A new or demo listing of a part
 *   done earlier in the census comes out again only if no run of the census read it whole:
 *   a SliceDone `listing:<ref>` after its part's SliceDone marks one that was. Limit: the
 *   count by ref is necessary, not sufficient: a used listing harvested and then sold still
 *   counts, so it can stand in for one that rose into a part already done within the same
 *   minutes.
 * - The price filter returns no "Dohodou" card, and on 2026-10-28 left out 177 used and 185
 *   new or demo cards with an ordinary price, not even returned by a band around their own
 *   price. So when a year's (or the new list's) parts miss listings, the slice is paged whole
 *   once more and each listing that pass meets but no part did must be proven: online, of the
 *   slice's year (or new or demo) and at the price its card showed when its detail page is
 *   read, and, after a final recount, not met by one whole pass over the band around that
 *   price (±1 Kč; ±1% for a price in another currency, filtered at its conversion), and still
 *   online and as first read (year, new or demo, price) after that. A "Dohodou" one must still
 *   show no price; its band is 0-1 Kč. The slice is done when the proven ones are exactly as
 *   many as that recount misses and the count by ref covers the slice; otherwise
 *   it stays not done and the run fails after the other slices, naming the slice, the
 *   shortfall and why, so it is no census. A listing gone meanwhile fails its proof, so it
 *   cannot stand in for one no pass met. Limits: a listing whose price becomes filterable
 *   (or stops being), or that goes, within the minutes between the recount and its checks can
 *   still pass; a listing pushed off the whole pass by the paging fault leaves its slice not
 *   done.
 * - Out of scope: listings without a price ("Dohodou"), and cards of the site's "Ostatní"
 *   bucket (makes it does not list) that name no model.
 * - incremental: both lists newest first, yielding the listings not known before, each list
 *   stopping at a page with none in the scope; then a price sweep over both lists to their
 *   ends (`sweep`). A known listing met on either gets a ListingPriceSeen from its card's
 *   record (amount and currency as its ListingSeen carries them; on 2026-10-29 nine cards, one
 *   in EUR and seven showing "bez DPH", matched their detail pages), so every known listing's
 *   price history is daily. That is some 3,400 pages a day, which TipCars' incremental limit
 *   (`catchUpMinutes`, apps/ingest/src/schedule.ts) is sized for.
 *
 * Research notes: scrape-access.md (TipCars row); lists, filters and pages verified against
 * the live site 2026-10-25. Cloudflare scores clients there, so every request starts at T1.
 */
import {
  type Body,
  type Condition,
  type Fuel,
  type ListingGone,
  type ListingPriceSeen,
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
   * Most list pages one walk reads: per list in incremental runs (no page past it, price
   * sweep included), per slice in full runs, where a slice with more pages fails the run.
   * Default unlimited. For bounded recordings and smoke runs.
   */
  maxPages?: number;
  /**
   * Full runs harvest only these slices (top-level keys, e.g. "used:2001", with the parts
   * they split into). Narrows `scope` to them, so a partial census never retires other
   * listings. For bounded recordings and smoke runs.
   */
  slices?: readonly string[];
  /** Most listings a slice may report before it is split by price. Default 400; tests lower it. */
  sliceCap?: number;
  /**
   * Most requests an incremental run spends past the new listings on its price sweep
   * (`sweep`). Default 3,800, about 108 minutes; 0 turns the sweep off.
   */
  priceSweep?: number;
}

const BASE = "https://www.tipcars.com";
const PAGE_SIZE = 20;
/** Most times a full run pages one slice before it leaves the slice not done. */
const PASSES = 2;
/** Listings a slice may report before it is split by price (20 pages). */
const SLICE_CAP = 400;
const FIRST_YEAR = 2000;
/** The site's make code for its "Ostatní" (other makes) bucket. */
const OTHER_MAKE = "XX";
/** Lower edges of the new/demo price bands (CZK); the last band is open. */
const NEW_PRICE_EDGES = [
  0, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_200_000, 1_500_000, 2_000_000,
  3_000_000,
];
/** Where a used year is first split by price; the band above it is open. */
const USED_PRICE_SPLIT = 1_000_000;
/** An open price band from this price up is not split further. */
const OPEN_PRICE_LIMIT = 100_000_000;
/**
 * Requests a day's price sweep may spend: 3,800 at about 1.7 s a list page is 108 minutes,
 * which leaves the lists' heads and new listings' detail pages some 12 minutes of TipCars'
 * 120-minute incremental limit (apps/ingest/src/schedule.ts). Both lists took 3,410 pages on
 * 2026-10-29, so the cap leaves them room to grow by a tenth.
 */
const PRICE_SWEEP = 3_800;

/** One query of the census. */
type Response = Awaited<ReturnType<HarvestContext["http"]["get"]>>;

/** A listing that may be one no price filter returns, with its price band or why it is no proof. */
interface Candidate {
  card: Card;
  band: Slice | string;
}

interface Slice {
  list: "ojete" | "nove";
  /** A used slice's years, both inclusive; no `to` means open above. */
  year?: { from: number; to?: number };
  /** Whole-Kč bounds, both inclusive, as the site filters; no `to` means open above. */
  price?: { from: number; to?: number };
}

/** A list's head as the incremental walked it. */
interface Head {
  slice: Slice;
  /** Pages the walk read from the first. */
  read: number;
  total: number;
}

interface Settings {
  maxPages: number;
  cap: number;
  only: readonly string[] | undefined;
  priceSweep: number;
}

export function tipcarsSource(options: TipcarsOptions = {}): Source {
  const only = options.slices && [...new Set(options.slices)].sort();
  const settings: Settings = {
    maxPages: options.maxPages ?? Number.POSITIVE_INFINITY,
    cap: options.sliceCap ?? SLICE_CAP,
    only,
    priceSweep: options.priceSweep ?? PRICE_SWEEP,
  };
  return {
    id: "tipcars",
    scope: only ? `slices:${only.join(",")}` : "all",
    harvest: (ctx) => new Harvest(ctx, settings).run(),
  };
}

class Harvest {
  /** Refs handled this run, so a listing seen twice costs one detail page. */
  private readonly done = new Set<string>();
  /** `isKnown` as of a ref's first sighting: the Ledger may record this run's listings as we go. */
  private readonly knownBefore = new Map<string, boolean>();
  /** Slices this run left not done, with why when it is not plain. */
  private readonly short: string[] = [];
  /** Refs that came out as ListingGone this run: no slice counts them as harvested. */
  private readonly gone = new Set<string>();
  /** Refs of new or demo listings that came out whole from their detail page this run. */
  private readonly detailed = new Set<string>();
  /** Refs whose `listing:<ref>` mark (see `marks`) this run has yielded. */
  private readonly marked = new Set<string>();
  /** Slices skipped as done earlier in the census, in the order met, until a split takes them. */
  private readonly skipped: Slice[] = [];
  /** Requests this run has made. */
  private requests = 0;
  private readonly ctx: HarvestContext;
  private readonly maxPages: number;
  private readonly cap: number;
  private readonly only: readonly string[] | undefined;
  private readonly priceSweep: number;

  constructor(ctx: HarvestContext, settings: Settings) {
    this.ctx = ctx;
    this.maxPages = settings.maxPages;
    this.cap = settings.cap;
    this.only = settings.only;
    this.priceSweep = settings.priceSweep;
  }

  async *run(): AsyncIterable<Observation> {
    if (this.ctx.mode === "incremental") {
      if (this.only) throw new Error("TipCars slices narrow full runs only");
      const used = yield* this.incremental({ list: "ojete", year: { from: FIRST_YEAR } });
      const fresh = yield* this.incremental({ list: "nove" });
      yield* this.sweep([used, fresh]);
      return;
    }
    for (const slice of this.slices()) yield* this.slice(slice);
    if (this.short.length > 0) {
      throw new Error(
        `TipCars slices yielded fewer listings than reported: ${this.short.join(", ")}`,
      );
    }
  }

  private slices(): Slice[] {
    const thisYear = Number(pragueDate(this.ctx.now).slice(0, 4));
    const all: Slice[] = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) {
      all.push({ list: "ojete", year: { from: year, to: year } });
    }
    // Open above, as the incremental list is: a year ahead of the calendar is a typo or a
    // model year, still a used car of the scope.
    all.push({ list: "ojete", year: { from: thisYear } });
    all.push({ list: "nove" });
    if (!this.only) return all;
    const unknown = this.only.filter((key) => !all.some((s) => sliceKey(s) === key));
    if (unknown.length > 0) throw new Error(`Unknown TipCars slices: ${unknown.join(", ")}`);
    return all.filter((s) => this.only?.includes(sliceKey(s)));
  }

  /**
   * Harvests one slice, or its price parts (see `split`) when it reports more than the cap
   * or when its passes come out short over more than one page. Reports SliceDone when the
   * slice, or its parts and their cover of it (`covered`), are done; a done one is skipped.
   * Returns the refs it harvested when done (a skipped one none: `again` pages it), else null.
   */
  private async *slice(slice: Slice): AsyncGenerator<Observation, Set<string> | null> {
    const key = sliceKey(slice);
    if (this.ctx.checkpoint.sliceDoneAt(key)) {
      this.skipped.push(slice);
      return new Set();
    }
    const first = await this.page(slice, 1);
    const parts = split(slice);
    let harvested: Set<string> | null = null;
    if (parts && first.total > this.cap) {
      harvested = yield* this.parts(slice, parts);
    } else {
      // Page the slice before any detail page, so few listings move under it.
      const { cards, pass, reported } = await this.census(slice, first);
      for (const card of cards) yield* this.listing(card);
      if (pass) harvested = this.live(pass);
      else if (parts && reported > PAGE_SIZE) {
        // A listing served on two pages pushes another off both, the same way on every pass;
        // other page boundaries fall elsewhere.
        this.ctx.log.warn("tipcars short slice split by price", { slice: key });
        harvested = yield* this.parts(slice, parts);
      } else this.short.push(key);
    }
    if (harvested) {
      yield { kind: "SliceDone", slice: key };
      yield* this.marks(harvested);
    }
    return harvested;
  }

  /** Harvests the parts of `slice`; their refs when each is done and together they cover it. */
  private async *parts(
    slice: Slice,
    parts: readonly Slice[],
  ): AsyncGenerator<Observation, Set<string> | null> {
    const from = this.skipped.length;
    const harvested = new Set<string>();
    let done = true;
    for (const part of parts) {
      const refs = yield* this.slice(part);
      if (refs) for (const ref of refs) harvested.add(ref);
      else done = false;
    }
    const skipped = this.skipped.splice(from);
    if (!done) return null;
    return yield* this.covered(slice, parts, harvested, skipped);
  }

  /**
   * Whether the parts of a slice take every listing it reports, counted back to back, and
   * the listings harvested for it by ref are at least as many as it reports at the end. A
   * price band's halves take every whole-Kč price. A year or the new list also has listings
   * no price filter returns, "Dohodou" ones and some priced ones (the site's price filter
   * leaves out 177 used and 185 new or demo cards on 2026-10-28, not one of them returned by
   * a band around its own price); the slice is done when each of those is proven (`candidates`).
   * The count by ref catches a listing that moved into a part done earlier (its rise balances
   * the recount without it ever coming out); one that is short sends a year on to the whole
   * pass, and leaves a price band not done. Returns the refs harvested when done, else null.
   */
  private async *covered(
    slice: Slice,
    parts: readonly Slice[],
    harvested: Set<string>,
    skipped: readonly Slice[],
  ): AsyncGenerator<Observation, Set<string> | null> {
    for (const part of skipped) yield* this.again(part, harvested);
    const key = sliceKey(slice);
    let { left, total } = await this.recount(slice, parts);
    if (left <= 0 && this.live(harvested).size >= total) return harvested;
    if (slice.price) {
      const why = left > 0 ? "listings in neither half" : this.tally(harvested, total);
      this.short.push(`${key} (${why})`);
      return null;
    }
    const candidates = yield* this.candidates(slice, harvested);
    if (candidates === "whole") return harvested;
    // Counted before the band and online checks: a listing proven then was online and
    // outside every band when counted.
    ({ left, total } = await this.recount(slice, parts));
    left = Math.max(0, left);
    const failed: Record<string, number> = {};
    let proven = 0;
    for (const { card, band } of candidates) {
      let reason = typeof band === "string" ? band : await this.absent(band, card.ref);
      if (reason === null) {
        // Still online after the recount, and still as its first read showed it: one gone or
        // changed since cannot stand in.
        const page = await this.fetch(card.url);
        if (page.status === 404 || page.status === 410) {
          yield { kind: "ListingGone", ref: card.ref };
          this.gone.add(card.ref);
          reason = "gone";
        } else if (page.status !== 200) {
          throw new Error(`TipCars returned HTTP ${page.status} for ${card.url}`);
        } else reason = misfit(slice, card, parseDetailPage(page.body));
      }
      if (reason === null) {
        proven++;
        harvested.add(card.ref);
      } else failed[reason] = (failed[reason] ?? 0) + 1;
    }
    const covers = this.live(harvested).size >= total;
    if (proven === left && covers) return harvested;
    const why = Object.entries(failed).map(([reason, n]) => `${n} ${reason}`);
    const note = why.length > 0 ? `; not proven: ${why.join(", ")}` : "";
    const tally = covers ? "" : `; ${this.tally(harvested, total)}`;
    this.short.push(`${key} (${left} listings in no price band, ${proven} proven${note}${tally})`);
    this.ctx.log.warn("tipcars listings in no price band unproven", { slice: key, left, proven });
    return null;
  }

  /** `refs` without the ones that came out as ListingGone. */
  private live(refs: ReadonlySet<string>): Set<string> {
    return new Set([...refs].filter((ref) => !this.gone.has(ref)));
  }

  private tally(harvested: ReadonlySet<string>, total: number): string {
    return `${total} reported at the end, ${this.live(harvested).size} harvested`;
  }

  /**
   * Pages a part done earlier in the census again, adding its listings to `harvested`. A
   * used one comes out again from its card. A new or demo one costs a detail page, so it
   * comes out again only when no run of this census has read it whole (its `listing:<ref>`
   * mark, and the Ledger still knows it): one that moved into the part since it was done, or
   * arrived.
   */
  private async *again(part: Slice, harvested: Set<string>): AsyncGenerator<Observation> {
    for await (const page of this.pages(part, true)) {
      for (const card of page.cards) {
        const read =
          card.category === "N" &&
          (this.detailed.has(card.ref) ||
            (this.ctx.checkpoint.sliceDoneAt(mark(card.ref)) !== null && this.wasKnown(card.ref)));
        if (!read) yield* this.listing(card);
        if (!this.gone.has(card.ref)) harvested.add(card.ref);
      }
    }
  }

  /**
   * After a slice's SliceDone, a SliceDone `listing:<ref>` for each new or demo listing it
   * read whole that is not marked yet, so a later run of the census that pages its part again
   * (`again`) knows the census has it without its detail page. Right after a SliceDone, as the
   * Ledger counts a rejection towards the next SliceDone: a mark never takes a slice's.
   */
  private *marks(harvested: ReadonlySet<string>): Iterable<Observation> {
    for (const ref of harvested) {
      if (!this.detailed.has(ref) || this.marked.has(ref)) continue;
      this.marked.add(ref);
      yield { kind: "SliceDone", slice: mark(ref) };
    }
  }

  /**
   * How many listings `slice` reports that its parts do not (`left`), and the most it
   * reported (`total`). The site counts one query at a time, so the slice is counted before
   * and after its parts, and the parts there and back (first to last, then back to the
   * first), each keeping its lower count: a listing that moves from one part to another once
   * meanwhile counts in one at most (ADR 0003).
   */
  private async recount(
    slice: Slice,
    parts: readonly Slice[],
  ): Promise<{ left: number; total: number }> {
    const count = async (s: Slice) => (await this.page(s, 1)).total;
    const before = await count(slice);
    const counts: number[] = [];
    for (const part of parts) counts.push(await count(part));
    for (let i = parts.length - 2; i >= 0; i--) {
      counts[i] = Math.min(counts[i] as number, await count(parts[i] as Slice));
    }
    const total = Math.max(before, await count(slice));
    return { left: total - counts.reduce((sum, n) => sum + n, 0), total };
  }

  /**
   * The listings of a year (or the new list) that might be ones no price filter returns:
   * met by a pass over the whole slice but not harvested from its parts, each with the band
   * around the price its card showed, or why it cannot be proven: gone, of another year (or
   * neither new nor demo), repriced since. Each comes out as a listing. A pass that meets
   * every listing the slice reports needs no proofs: "whole", its listings then harvested.
   */
  private async *candidates(
    slice: Slice,
    harvested: Set<string>,
  ): AsyncGenerator<Observation, Candidate[] | "whole"> {
    const cards = new Map<string, Card>();
    let reported = 0;
    for await (const page of this.pages(slice, true)) {
      reported = Math.max(reported, page.total);
      for (const card of page.cards) if (!cards.has(card.ref)) cards.set(card.ref, card);
    }
    const fresh = [...cards.values()].filter((card) => !harvested.has(card.ref));
    if (cards.size >= reported) {
      for (const card of fresh) yield* this.listing(card);
      for (const ref of this.live(new Set(cards.keys()))) harvested.add(ref);
      return "whole";
    }
    const out: Candidate[] = [];
    for (const card of fresh) out.push({ card, band: yield* this.candidate(slice, card) });
    return out;
  }

  /** Yields a candidate as a listing; the band to check it against, or why it is no proof. */
  private async *candidate(slice: Slice, card: Card): AsyncGenerator<Observation, Slice | string> {
    if (!card.ref || !card.category) {
      yield* this.listing(card);
      return "without their record";
    }
    const response = await this.fetch(card.url);
    if (response.status === 404 || response.status === 410) {
      if (!this.done.has(card.ref)) yield { kind: "ListingGone", ref: card.ref };
      this.done.add(card.ref);
      this.gone.add(card.ref);
      return "gone";
    }
    yield* this.listing(card, response);
    const unfit = misfit(slice, card, parseDetailPage(response.body));
    if (unfit) return unfit;
    if (card.priceOnRequest) return { ...slice, price: { from: 0, to: 1 } };
    const kc = card.shownKc;
    if (kc === undefined) return "without a shown price";
    // A price in another currency is filtered at its conversion to Kč, which moves with the
    // rate; 1% takes a day's move.
    const margin = card.currency === "CZK" ? 1 : Math.ceil(kc / 100);
    return { ...slice, price: { from: Math.max(0, kc - margin), to: kc + margin } };
  }

  /** Null when one whole pass over `band` does not meet `ref`, else why that is no proof. */
  private async absent(band: Slice, ref: string): Promise<string | null> {
    const refs = new Set<string>();
    let reported = 0;
    for await (const page of this.pages(band, true)) {
      reported = Math.max(reported, page.total);
      for (const card of page.cards) refs.add(card.ref);
    }
    if (refs.has(ref)) return "returned by their price band";
    return refs.size >= reported ? null : "in a price band that came out short";
  }

  /**
   * Every card of a slice. A pass is complete when it alone meets as many distinct listings
   * as the highest total any of its pages reported; a short one is paged again from the top,
   * up to PASSES times. Passes are never pooled: between two passes a listing can go and
   * another arrive, so their union can reach the count without a listing every pass missed.
   * The cards of every pass come out either way, with the refs of the complete pass, if any,
   * and the highest total any page reported.
   */
  private async census(
    slice: Slice,
    first: ListPage,
  ): Promise<{ cards: Card[]; pass: Set<string> | null; reported: number }> {
    const cards = new Map<string, Card>();
    let most = 0;
    for (let pass = 1; pass <= PASSES; pass++) {
      const refs = new Set<string>();
      let reported = 0;
      for await (const page of this.pages(slice, true, pass === 1 ? first : undefined)) {
        reported = Math.max(reported, page.total);
        for (const card of page.cards) {
          refs.add(card.ref);
          if (!cards.has(card.ref)) cards.set(card.ref, card);
        }
      }
      most = Math.max(most, reported);
      if (refs.size >= reported) return { cards: [...cards.values()], pass: refs, reported };
      this.ctx.log.warn("tipcars slice came out short", {
        slice: sliceKey(slice),
        pass,
        distinct: refs.size,
        reported,
      });
    }
    return { cards: [...cards.values()], pass: null, reported: most };
  }

  /**
   * New listings of one list, newest first, up to the first page with none in the scope: a
   * card outside it never becomes known, so it cannot keep the walk going. The known
   * listings on those pages get their price (`prices`).
   */
  private async *incremental(slice: Slice): AsyncGenerator<Observation, Head> {
    const head: Head = { slice, read: 0, total: 0 };
    for await (const page of this.pages(slice, false)) {
      head.read++;
      head.total = Math.max(head.total, page.total);
      yield* this.prices(page.cards);
      const fresh = page.cards.filter((card) => !this.wasKnown(card.ref));
      for (const card of fresh) yield* this.listing(card);
      if (!fresh.some((card) => outOfScope(card) === null)) break;
    }
    return head;
  }

  /**
   * Both lists past their heads to their ends, for prices: every known listing's price each
   * day. The site serves its lists newest first only, 20 a page, so that is some 3,400 pages
   * (97 minutes at 1.7 s a page, on 2026-10-29). Known listings get their price, unknown ones
   * in the scope come out whole (a new or demo one with its detail page): ones the census has
   * not reached, or retired by mistake. Paging is by offset: a listing posted meanwhile pushes
   * the rest down a place, so the walk meets one twice and follows the list's count to its new
   * end; one sold above the walk lifts the rest a place, so one can slip between two pages and
   * go unpriced that day. Stops when `priceSweep` requests are spent, before a page or a
   * detail page, so a list grown past them leaves its oldest listings unpriced (logged).
   */
  private async *sweep(heads: readonly Head[]): AsyncIterable<Observation> {
    if (this.priceSweep <= 0) return;
    const stop = this.requests + this.priceSweep;
    for (const head of heads) {
      let pages = Math.ceil(head.total / PAGE_SIZE);
      for (let n = head.read + 1; n <= Math.min(pages, this.maxPages); n++) {
        if (this.requests >= stop) {
          this.ctx.log.warn("tipcars price sweep ran out of requests", {
            slice: sliceKey(head.slice),
            page: n,
          });
          return;
        }
        const page = await this.page(head.slice, n);
        if (page.cards.length === 0) break;
        pages = Math.max(pages, Math.ceil(page.total / PAGE_SIZE));
        yield* this.prices(page.cards);
        for (const card of page.cards) {
          if (this.wasKnown(card.ref)) continue;
          if (card.category === "N" && this.requests >= stop) {
            this.ctx.log.warn("tipcars price sweep ran out of requests", { ref: card.ref });
            return;
          }
          yield* this.listing(card);
        }
      }
    }
  }

  /**
   * A ListingPriceSeen for each listing among `cards` the Ledger knew before the run, once a
   * run: the card's record price and currency, the ones its ListingSeen carries (a new or demo
   * one's too), so a price lands the day it changes without a detail page. None without a
   * price, in an unknown currency or outside the scope.
   */
  private *prices(cards: readonly Card[]): Iterable<ListingPriceSeen> {
    for (const card of cards) {
      if (!card.ref || !card.category || this.done.has(card.ref) || !this.wasKnown(card.ref)) {
        continue;
      }
      this.done.add(card.ref);
      if (outOfScope(card) || card.price === undefined || !card.currency) continue;
      yield {
        kind: "ListingPriceSeen",
        ref: card.ref,
        price: { amount: card.price, currency: card.currency },
      };
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
   * A slice's pages from the first (`first`, when already read) to its last, an empty first
   * page included (or `maxPages`; a full walk then throws).
   */
  private async *pages(slice: Slice, full: boolean, first?: ListPage) {
    for (let n = 1; ; n++) {
      if (n > this.maxPages) {
        if (full)
          throw new Error(`TipCars ${sliceKey(slice)} has more than ${this.maxPages} pages`);
        return;
      }
      const page = n === 1 && first ? first : await this.page(slice, n);
      if (page.cards.length > 0 || n === 1) yield page;
      if (page.cards.length === 0 || n * PAGE_SIZE >= page.total) return;
    }
  }

  private async page(slice: Slice, n: number): Promise<ListPage> {
    const query = [n > 1 ? `str=${n}-${PAGE_SIZE}` : "", sliceFilter(slice)]
      .filter(Boolean)
      .join("&");
    const url = `${BASE}/${slice.list}${query ? `?${query}` : ""}`;
    const page = parseListPage(await this.get(url), url);
    this.ctx.log.info("tipcars page", { url, cards: page.cards.length, total: page.total });
    return page;
  }

  /** A card as a listing; a new or demo one from its detail page, `response` when fetched. */
  private async *listing(
    card: Card,
    response?: Response,
  ): AsyncIterable<ListingSeen | ListingGone> {
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
    const page = response ?? (await this.fetch(card.url));
    if (page.status === 404 || page.status === 410) {
      yield { kind: "ListingGone", ref: card.ref };
      this.gone.add(card.ref);
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
    const seen = toListingSeen(card, detail);
    // Marked only when the Ledger can take it: a mark stands for the census's sighting.
    if (Number.isFinite(seen.price.amount) && seen.price.currency && seen.vehicle.model) {
      this.detailed.add(card.ref);
    }
    yield seen;
  }

  private async get(url: string): Promise<string> {
    this.ctx.signal.throwIfAborted();
    const page = await this.fetch(url);
    if (page.status !== 200) throw new Error(`TipCars returned HTTP ${page.status} for ${url}`);
    return page.body;
  }

  private fetch(url: string): Promise<Response> {
    this.requests++;
    return this.ctx.http.get({
      url,
      minTier: "T1",
      locale: "cs",
      signal: this.ctx.signal,
    });
  }
}

/** "used:2017", "used:2026-", "new:500000-599999"; a used slice split by price adds ":<from>-<to>". */
function sliceKey(slice: Slice): string {
  const price = slice.price && span(slice.price);
  if (slice.list === "nove") return price ? `new:${price}` : "new";
  const years = slice.year
    ? slice.year.to === slice.year.from
      ? `${slice.year.from}`
      : span(slice.year)
    : "";
  return price ? `used:${years}:${price}` : `used:${years}`;
}

/** The slice's query: bare keys `2017-2017=` (years) and `500000-599999kc=` (price). */
function sliceFilter(slice: Slice): string {
  return [slice.year && `${span(slice.year)}=`, slice.price && `${span(slice.price)}kc=`]
    .filter(Boolean)
    .join("&");
}

function span(range: { from: number; to?: number }): string {
  return `${range.from}-${range.to ?? ""}`;
}

/**
 * A slice's price parts, dearest first, or null for one at a single price or open above
 * OPEN_PRICE_LIMIT. The new list splits into the bands of NEW_PRICE_EDGES, a used year in
 * two at USED_PRICE_SPLIT (listings no price filter returns are in no part: see `covered`),
 * an open band [from, ∞) at 2·from, a closed one in the middle, at whole Kč.
 */
function split(slice: Slice): Slice[] | null {
  const price = slice.price;
  const at = (from: number, to?: number) => ({ ...slice, price: { from, to } });
  if (!price && slice.list === "nove") {
    // Dearest first, as every split: prices mostly drop, and a listing that drops into a band
    // not yet harvested is still met.
    return NEW_PRICE_EDGES.map((from, i) => {
      const next = NEW_PRICE_EDGES[i + 1];
      return at(from, next === undefined ? undefined : next - 1);
    }).reverse();
  }
  if (!price) return [at(USED_PRICE_SPLIT), at(0, USED_PRICE_SPLIT - 1)];
  if (price.to === undefined) {
    if (price.from >= OPEN_PRICE_LIMIT) return null;
    const mid = Math.max(2 * price.from, 1);
    return [at(mid), at(price.from, mid - 1)];
  }
  if (price.from >= price.to) return null;
  const mid = Math.floor((price.from + price.to) / 2);
  return [at(mid + 1, price.to), at(price.from, mid)];
}

/** The SliceDone that marks a new or demo listing read whole in this census (see `marks`). */
function mark(ref: string): string {
  return `listing:${ref}`;
}

/**
 * Why a candidate's detail page does not show it in `slice` as its card did, or null: of the
 * slice's year (a used slice), new or demo (the new list), and at the card's price and
 * currency, or still without a price ("Dohodou").
 */
function misfit(slice: Slice, card: Card, detail: Detail): string | null {
  const year = whole(detail.boxes.vyrobeno) ?? yearMonth(detail.boxes["v provozu od"])?.year;
  const inSlice = slice.year
    ? year !== undefined &&
      year >= slice.year.from &&
      (slice.year.to === undefined || year <= slice.year.to)
    : detail.condition !== undefined;
  if (!inSlice) return "outside the slice";
  if (card.priceOnRequest) return detail.price === undefined ? null : "repriced";
  return detail.price === card.price && detail.currency === card.currency ? null : "repriced";
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
  /** The price the card shows, in whole Kč (converted when the seller's is another currency). */
  shownKc?: number;
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
      shownKc: whole(/([\d\s]+)Kč/.exec(clean(priceBlock))?.[1]),
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
  price?: number;
  currency?: string;
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
    price: whole(offer?.price),
    currency: text(offer?.priceCurrency) || undefined,
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
