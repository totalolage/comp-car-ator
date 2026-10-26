/**
 * AAA AUTO (aaaauto.cz): the Czech used-car dealer's passenger cars made in 2000 or later, plus
 * the demonstrators of Mototechna, the group's new-car dealer, which the same site lists.
 *
 * - Lists are Angular pages rendered on the server, 35 cars a page (`?page=<n>`). Each page
 *   carries the site's own API response as JSON (`<script id="ng-state">`, key `car-list`):
 *   per car its ids, make/model with the site's ids, year of first registration, km, fuel and
 *   hybrid type, kW, cc, Euro class, gearbox, body, seats, doors, colour, cash price, whether
 *   VAT is deductible, six photos, the branch and the country the car stands in; and the
 *   list's total. The site's JSON API takes POST only, so the lists are read as pages.
 * - The detail page adds only more photos and the branch's name, so every listing comes from
 *   its list page alone (one request per 35 listings instead of one per listing). Branch
 *   addresses come from `/api/branches/lite`, read once per run.
 * - Two lists cover the scope: `/ojete-vozy/` from 2000 (used; category "užitkové vozy" left
 *   out with `exclude-categoryId-array=16`) and `/ojete-vozy/predvadeci-vozy-mototechna/`
 *   (demo, same exclusion). Both are read newest added first (`sort=14`), so cars added while
 *   a list is paged only repeat a card. A URL without a query string is served from a stale
 *   cache with an older total, so every URL here has one.
 * - The card's headline "Akční cena" is a financing-only price; the cash price is the one a
 *   buyer pays outright. A VAT-deductible car is shown incl. VAT with its "bez DPH" price
 *   under it; for the others the site states nothing.
 * - About a quarter of the cars still stand abroad (DE, NL, IT…). AAA sells them in CZ in
 *   CZK like the rest: the detail pages sampled state the import fee ("Poplatek za dovoz")
 *   and the registration fee as 0, so the market is CZ and there are no seller extras.
 *   TODO(wave1-stream6): only detail pages carry those fees; sample them now and then.
 * - full: slices `year:<YYYY>` by year of first registration (the current year's slice is
 *   open above) and `demo`. A slice is paged to its end, then its listings come out, then
 *   SliceDone. Slices done earlier in the census are skipped. A slice with fewer distinct cars
 *   than it reports (one removed meanwhile shifts the next across a page boundary) is paged
 *   once more; still short, it stays not done, its listings come out after the other
 *   slices, and the run fails.
 * - incremental: both lists newest first, yielding the listings not known before, each list
 *   stopping at a page whose cars were all known before the run.
 *
 * Research notes: scrape-access.md (AAA row); lists, filters and the API record verified
 * against the live site 2026-10-25. The site has no bot protection; T0 is enough.
 */
import {
  type Body,
  type Fuel,
  type ListingGone,
  type ListingSeen,
  type Observation,
  pragueDate,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

export interface AaaautoOptions {
  /**
   * Most list pages one walk reads: per list in incremental runs, per slice in full runs,
   * where a slice with more pages fails the run. Default unlimited. For bounded recordings
   * and smoke runs.
   */
  maxPages?: number;
  /**
   * Full runs harvest only these slices (keys as in SliceDone, e.g. "year:2004"). Narrows
   * `scope` to them, so a partial census never retires other listings. For bounded
   * recordings and smoke runs.
   */
  slices?: readonly string[];
}

const BASE = "https://www.aaaauto.cz";
const FIRST_YEAR = 2000;
/** "Užitkové vozy" (vans, trucks, buses), outside the passenger-car scope. */
const NOT_UTILITY = "exclude-categoryId-array=16";
const NEWEST_ADDED = "sort=14";

interface List {
  /** Slice key in full runs. */
  key: string;
  path: string;
  filter: string;
  demo: boolean;
}

export function aaaautoSource(options: AaaautoOptions = {}): Source {
  const only = options.slices && [...new Set(options.slices)].sort();
  return {
    id: "aaaauto",
    scope: only ? `slices:${only.join(",")}` : "all",
    harvest: (ctx) => new Harvest(ctx, options.maxPages ?? Number.POSITIVE_INFINITY, only).run(),
  };
}

class Harvest {
  /** Refs that came out this run, so a car on two pages comes out once. */
  private readonly done = new Set<string>();
  /** `isKnown` as of a ref's first sighting: the Ledger may record this run's listings as we go. */
  private readonly knownBefore = new Map<string, boolean>();
  private branches: Map<string, Branch> | undefined;
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
      if (this.only) throw new Error("AAA Auto slices narrow full runs only");
      yield* this.incremental(usedList(`${FIRST_YEAR}`, "", "used"));
      yield* this.incremental(DEMO);
      return;
    }
    // A short slice's listings come out after every slice that is done: the Ledger counts the
    // Observations before a SliceDone towards that slice, and a rejected one among a short
    // slice's would keep the next slice not done.
    const short: { list: List; cars: Raw[] }[] = [];
    for (const list of this.slices()) {
      if (this.ctx.checkpoint.sliceDoneAt(list.key)) continue;
      const { cars, complete } = await this.census(list);
      if (!complete) {
        short.push({ list, cars });
        continue;
      }
      for (const car of cars) yield* this.listing(car, list);
      yield { kind: "SliceDone", slice: list.key };
    }
    for (const { list, cars } of short) {
      for (const car of cars) yield* this.listing(car, list);
    }
    if (short.length > 0) {
      const keys = short.map((s) => s.list.key).join(", ");
      throw new Error(`AAA Auto slices yielded fewer listings than reported: ${keys}`);
    }
  }

  private slices(): List[] {
    const thisYear = Number(pragueDate(this.ctx.now).slice(0, 4));
    const all: List[] = [];
    for (let year = FIRST_YEAR; year < thisYear; year++) {
      all.push(usedList(`${year}`, `yearTo=${year}`, `year:${year}`));
    }
    // Open above, as the incremental list is: a year ahead of the calendar is still in scope.
    all.push(usedList(`${thisYear}`, "", `year:${thisYear}-`));
    all.push(DEMO);
    if (!this.only) return all;
    const unknown = this.only.filter((key) => !all.some((s) => s.key === key));
    if (unknown.length > 0) throw new Error(`Unknown AAA Auto slices: ${unknown.join(", ")}`);
    return all.filter((s) => this.only?.includes(s.key));
  }

  /**
   * Every car of a slice, paged twice when the first pass has fewer distinct cars than the
   * slice reports. A pass is complete when it alone reaches the highest total any of its
   * pages reported; the cars of both passes come out either way.
   */
  private async census(list: List): Promise<{ cars: Raw[]; complete: boolean }> {
    const cars = new Map<string, Raw>();
    let unidentified: Raw[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      const refs = new Set<string>();
      unidentified = [];
      let reported = 0;
      for await (const page of this.pages(list, true)) {
        reported = Math.max(reported, page.total);
        for (const car of page.cars) {
          const ref = refOf(car);
          if (!ref) unidentified.push(car);
          else {
            refs.add(ref);
            if (!cars.has(ref)) cars.set(ref, car);
          }
        }
      }
      if (refs.size >= reported)
        return { cars: [...cars.values(), ...unidentified], complete: true };
      this.ctx.log.warn("aaaauto slice came out short", {
        slice: list.key,
        pass,
        distinct: refs.size,
        reported,
      });
    }
    return { cars: [...cars.values(), ...unidentified], complete: false };
  }

  /**
   * New listings of one list, newest first, up to the first page whose cars were all known
   * before this run. Each ref's known status is taken when the run first meets it, so a car
   * that came out on an earlier page (it moved down as others were added) still counts as
   * unknown and the walk goes on to the cars it was pushed down with; it comes out once.
   */
  private async *incremental(list: List): AsyncIterable<Observation> {
    for await (const page of this.pages(list, false)) {
      const allKnown = page.cars.map((car) => this.knewBefore(refOf(car))).every(Boolean);
      for (const car of page.cars) {
        if (!this.knewBefore(refOf(car))) yield* this.listing(car, list);
      }
      if (allKnown) return;
    }
  }

  /** `isKnown` as of the run's first sighting of a ref; a car without one is never known. */
  private knewBefore(ref: string): boolean {
    if (!ref) return false;
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
  private async *pages(list: List, full: boolean) {
    for (let n = 1; ; n++) {
      if (n > this.maxPages) {
        if (full) throw new Error(`AAA Auto ${list.key} has more than ${this.maxPages} pages`);
        return;
      }
      const query = [list.filter, NOT_UTILITY, NEWEST_ADDED, `page=${n}`].filter(Boolean);
      const url = `${BASE}${list.path}?${query.join("&")}`;
      const page = parseListPage(await this.get(url), url);
      if (page.cars.length > 0 && !page.cars.some(refOf)) {
        throw new Error(`AAA Auto page changed: no car on it has an id at ${url}`);
      }
      this.ctx.log.info("aaaauto page", { url, cars: page.cars.length, total: page.total });
      if (page.cars.length > 0 || n === 1) yield page;
      if (page.cars.length === 0 || n >= page.pages) return;
    }
  }

  private async *listing(car: Raw, list: List): AsyncIterable<ListingSeen | ListingGone> {
    // The lists filter from 2000 already; a car the site places earlier stays out of scope.
    if (Number.isInteger(car.productionYear) && (car.productionYear as number) < FIRST_YEAR) return;
    const ref = refOf(car);
    if (ref && this.done.has(ref)) return;
    if (ref) this.done.add(ref);
    if (ref && car.isSold === true) {
      yield { kind: "ListingGone", ref };
      return;
    }
    const seen = toListingSeen(car, list.demo, await this.branchMap());
    if (!seen) {
      this.ctx.log.warn("aaaauto car the adapter cannot map", { ref, list: list.key });
      yield rejected(car, list.demo);
      return;
    }
    yield seen;
  }

  /**
   * Branch addresses, read once a run. Only `location` depends on them, so when the list
   * cannot be read the run goes on without locations.
   */
  private async branchMap(): Promise<Map<string, Branch>> {
    if (!this.branches) {
      const url = `${BASE}/api/branches/lite`;
      try {
        this.branches = parseBranches(await this.get(url), url);
      } catch (error) {
        this.ctx.signal.throwIfAborted();
        this.ctx.log.warn("aaaauto branches unavailable; listings come out without location", {
          error: String(error),
        });
        this.branches = new Map();
      }
    }
    return this.branches;
  }

  private async get(url: string): Promise<string> {
    this.ctx.signal.throwIfAborted();
    const page = await this.ctx.http.get({ url, locale: "cs", signal: this.ctx.signal });
    if (page.status !== 200) throw new Error(`AAA Auto returned HTTP ${page.status} for ${url}`);
    return page.body;
  }
}

function usedList(fromYear: string, filter: string, key: string): List {
  return { key, path: `/ojete-vozy/${fromYear}`, filter, demo: false };
}

const DEMO: List = {
  key: "demo",
  path: "/ojete-vozy/predvadeci-vozy-mototechna/",
  filter: "",
  demo: true,
};

// ---------------------------------------------------------------------------------------
// Pages

type Raw = Record<string, unknown>;

interface ListPage {
  total: number;
  pages: number;
  cars: Raw[];
}

const STATE_OPEN = '<script id="ng-state" type="application/json">';

function parseListPage(html: string, url: string): ListPage {
  const start = html.indexOf(STATE_OPEN);
  const end = start < 0 ? -1 : html.indexOf("</script>", start);
  let state: Raw | undefined;
  try {
    state = end < 0 ? undefined : JSON.parse(html.slice(start + STATE_OPEN.length, end));
  } catch {
    state = undefined;
  }
  const message = (state?.["car-list"] as Raw | undefined)?.message as Raw | undefined;
  const pagination = message?.pagination as Raw | undefined;
  const items = message?.items;
  const total = pagination?.totalItems;
  const pages = pagination?.totalPages;
  if (!Array.isArray(items) || !Number.isInteger(total) || !Number.isInteger(pages)) {
    throw new Error(`AAA Auto page changed: no car list in the page state at ${url}`);
  }
  return {
    total: total as number,
    pages: pages as number,
    cars: items.map((car) => (car && typeof car === "object" ? (car as Raw) : {})),
  };
}

interface Branch {
  city?: string;
  postcode?: string;
}

/** Branches by the CRM id cars name them by (`adminToolbox.branchId`). */
function parseBranches(body: string, url: string): Map<string, Branch> {
  let list: unknown;
  try {
    list = JSON.parse(body);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) throw new Error(`AAA Auto page changed: no branch list at ${url}`);
  const out = new Map<string, Branch>();
  for (const b of list as Raw[]) {
    const id = text(b?.crmId);
    if (!id) continue;
    out.set(
      id,
      dropUndefined({
        city: text(b.city) || undefined,
        postcode: text(b.zip).replace(/\s/g, "") || undefined,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Mapping

function refOf(car: Raw): string {
  return Number.isInteger(car.id) && (car.id as number) > 0 ? String(car.id) : "";
}

/** A car the adapter cannot map comes out without a ref, as a ListingSeen the Ledger rejects. */
function rejected(car: Raw, demo: boolean): ListingSeen {
  const make = car.make as Raw | undefined;
  const model = car.model as Raw | undefined;
  return {
    kind: "ListingSeen",
    ref: "",
    url: "",
    market: "CZ",
    condition: demo ? "demo" : "used",
    vehicle: { make: text(make?.title), model: text(model?.title) },
    price: { amount: Number.NaN, currency: "CZK" },
    priceBasis: "unknown",
    seller: "dealer",
    photos: [],
  };
}

/** The car as a ListingSeen, or undefined when its id, make, model or cash price is missing. */
function toListingSeen(
  car: Raw,
  demo: boolean,
  branches: Map<string, Branch>,
): ListingSeen | undefined {
  const ref = refOf(car);
  const make = car.make as Raw | undefined;
  const model = car.model as Raw | undefined;
  const engine = (car.engine ?? {}) as Raw;
  const body = (car.body ?? {}) as Raw;
  const price = (car.price ?? {}) as Raw;
  const cash = whole(price.cash);
  const url = listingUrl(car, demo);
  if (!ref || !url || !text(make?.title) || !text(model?.title) || cash === undefined) {
    return undefined;
  }
  const fuel = fuelOf(car);
  const vehicle: VehicleDescriptor = dropUndefined({
    make: text(make?.title),
    model: text(model?.title),
    trim: [text(engine.title), text(model?.lineTitle)].filter(Boolean).join(" ") || undefined,
    sourceTaxonomy: dropUndefined({
      make: text(make?.id) || undefined,
      model: text(model?.id) || undefined,
    }),
    // The site's "Rok uvedení do provozu": the year only.
    firstRegistration: Number.isInteger(car.productionYear)
      ? { year: car.productionYear as number }
      : undefined,
    // "S" is also "Sedan/Liftback", which does not tell a sedan from a hatchback.
    body: /liftback/i.test(text(body.title)) ? undefined : BODIES[text(body.id)],
    fuel,
    powerKw: whole(engine.performanceKW),
    transmission: GEARBOXES[text((car.gearbox as Raw | undefined)?.id)],
    drive: engine.is4x4 === true ? ("awd" as const) : undefined,
    engineCc: whole(engine.engineSize),
    seats: whole(body.seats),
    doors: whole(body.doors),
    // The site gives electric cars an Euro class and a fuel consumption too; neither applies.
    euroClass: fuel === "bev" ? undefined : euroClass(text(engine.emissionStandard)),
    consumptionL100km:
      fuel === "bev" ? undefined : positive((car.fuel as Raw | undefined)?.consumptionAverage),
    color: text((body.externalColor as Raw | undefined)?.title) || undefined,
  });
  // The branch is where a car in CZ stands; a car still abroad is only sold through it.
  const branch =
    car.countryRegion === "CZ"
      ? branches.get(text((car.adminToolbox as Raw | undefined)?.branchId))
      : undefined;
  const photos = (car.photos as Raw | undefined)?.default;
  return dropUndefined({
    kind: "ListingSeen",
    ref,
    url,
    // Every car is sold in CZ in CZK, also the ones AAA still brings in from abroad.
    market: "CZ",
    condition: demo ? "demo" : "used",
    vehicle,
    odometerKm:
      car.mileageUnit === "km" && Number.isInteger(car.mileage) && (car.mileage as number) >= 0
        ? (car.mileage as number)
        : undefined,
    price: { amount: cash, currency: "CZK" },
    // Deductible: the cash price is incl. VAT and the "bez DPH" price is shown under it.
    priceBasis: price.isVATDeduct === true ? "gross" : "unknown",
    seller: "dealer",
    location: branch && Object.keys(branch).length > 0 ? branch : undefined,
    photos: Array.isArray(photos)
      ? photos.filter((p): p is string => /^https:\/\//.test(text(p)))
      : [],
  }) as ListingSeen;
}

/**
 * The page a card links to: AAA's detail page by make and model slug and id; a Mototechna
 * demonstrator's page on mototechna.cz by its AAA id (`aaaid`).
 */
function listingUrl(car: Raw, demo: boolean): string | undefined {
  if (demo) return whole(car.aaaid) ? `https://mototechna.cz/car/${car.aaaid}` : undefined;
  const make = text((car.make as Raw | undefined)?.slug);
  const model = text((car.model as Raw | undefined)?.slug);
  const ref = refOf(car);
  return make && model && ref ? `${BASE}/detail/${make}/${model}/${ref}` : undefined;
}

const BODIES: Record<string, Body> = {
  S: "sedan",
  C: "wagon",
  H: "hatchback",
  SUV: "suv",
  OFF: "suv",
  MPV: "mpv",
  "C-MPV": "mpv",
  B: "van",
  VAN: "van",
  P: "pickup",
  CPE: "coupe",
  CAB: "convertible",
};

const GEARBOXES: Record<string, "manual" | "automatic"> = { M: "manual", A: "automatic" };

/** Electrified drivetrains by the site's EV type; a mild hybrid keeps its engine's fuel. */
const EV_FUELS: Record<string, Fuel> = {
  BEV: "bev",
  REEV: "reev",
  FCEV: "hydrogen",
  PHEV: "phev",
  FHEV: "hev",
};
const BASE_FUELS: Record<string, Fuel> = { "1": "petrol", "2": "diesel", "7": "bev" };
/** `alternativeFuel` ids: petrol + LPG, petrol + CNG, "hybridní" (type in `engine`). */
const LPG = "3";
const CNG = "4";
const HYBRID = "5";

function fuelOf(car: Raw): Fuel | undefined {
  const engine = (car.engine ?? {}) as Raw;
  const ev = EV_FUELS[text(engine.engineEvType)];
  if (ev) return ev;
  const alternative = text((car.alternativeFuel as Raw | undefined)?.id);
  if (alternative === LPG) return "lpg";
  if (alternative === CNG) return "cng";
  // "Hybridní" without its type does not tell a full hybrid from a plug-in or mild one.
  if (alternative === HYBRID && engine.engineEvType !== "MHEV") return undefined;
  return BASE_FUELS[text((car.fuel as Raw | undefined)?.id)];
}

/** "EURO6D" → 6. */
function euroClass(value: string): number | undefined {
  const m = /^EURO\s*(\d)/i.exec(value);
  const n = Number(m?.[1]);
  return m && n >= 0 && n <= 7 ? n : undefined;
}

// ---------------------------------------------------------------------------------------
// Value helpers

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** A whole number > 0 from a number or a digit string ("315000"). */
function whole(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : /^\d+$/.test(text(value))
        ? Number(text(value))
        : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
