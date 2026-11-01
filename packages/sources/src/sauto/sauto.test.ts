import {
  type Cassette,
  createReplayHttp,
  type Http,
  HttpBlockedError,
  type Interaction,
  loadCassette,
} from "@cca/http";
import type { ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  emptyCheckpoint,
  type HarvestContext,
  type HarvestMode,
  silentLogger,
} from "../source.ts";
import { type SautoOptions, sautoSource } from "./sauto.ts";

// Recorded 2026-10-25 against live Sauto: an incremental and a full run of
// sautoSource(OPTIONS), personal fields (phone, user, VIN, description) stripped. The walk then
// stepped a whole page at a time; it now overlaps its pages by a listing, so the incremental
// pages at offsets 2, 6 and 10 are cut from the order the recorded pages at 0, 4, 8 and 12
// served (both cassettes; each order's dates are distinct, newest first).
const fixture = new URL("./fixtures/dacia-spring.cassette.json", import.meta.url);
const now = new Date("2026-10-25T13:27:00Z");
const withoutVat = new URL("./fixtures/without-vat.cassette.json", import.meta.url);
const OPTIONS = { manufacturerModel: "dacia:spring", pageSize: 4, sliceLimit: 8 };
/** A last run before every listing of the fixture: an incremental run yields all it does not know. */
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

async function harvest(
  mode: HarvestMode,
  checkpoint: Partial<Checkpoint> = {},
  edit: (cassette: Cassette) => void = () => {},
  signal = new AbortController().signal,
  options: { source?: SautoOptions; consume?: (o: Observation) => void } = {},
): Promise<{ observations: Observation[]; urls: string[] }> {
  const cassette = structuredClone(await loadCassette(fixture));
  edit(cassette);
  const replay = createReplayHttp(cassette);
  const urls: string[] = [];
  const http: Http = {
    get(request) {
      urls.push(typeof request === "string" ? request : request.url);
      return replay.get(request);
    },
  };
  const ctx: HarvestContext = {
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, lastRunAt: LONG_AGO, ...checkpoint },
    now,
    log: silentLogger,
    signal,
  };
  const observations: Observation[] = [];
  for await (const o of sautoSource({ ...OPTIONS, ...options.source }).harvest(ctx)) {
    observations.push(o);
    options.consume?.(o);
  }
  return { observations, urls };
}

const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const prices = (os: Observation[]) =>
  os.flatMap((o) => (o.kind === "ListingPriceSeen" ? [[o.ref, o.price.amount] as const] : []));
const details = (urls: string[]) => urls.filter((u) => !u.includes("/items/search?"));
const slices = (os: Observation[]) => os.flatMap((o) => (o.kind === "SliceDone" ? [o.slice] : []));
const searches = (urls: string[]) => urls.filter((u) => u.includes("/items/search?"));

type ApiItem = Record<string, unknown>;
/** Search pages carry `results`, details `result`. */
type ApiBody = { results: ApiItem[]; result: ApiItem };

/** Rewrites the JSON body of every recorded response whose URL matches. */
function editBodies(
  cassette: Cassette,
  match: (url: string) => boolean,
  fn: (body: ApiBody) => void,
) {
  for (const i of cassette.interactions.filter((i) => match(i.request.url))) {
    const body = JSON.parse(i.response.body);
    fn(body);
    i.response.body = JSON.stringify(body);
  }
}

function replaceResponse(
  cassette: Cassette,
  match: (url: string) => boolean,
  response: Partial<Interaction["response"]>,
) {
  for (const i of cassette.interactions.filter((i) => match(i.request.url))) {
    Object.assign(i.response, response);
  }
}

/** A synthetic listing as the API serves it, in search results and as its own detail. */
const car = (id: number, fields: ApiItem = {}): ApiItem => ({
  id,
  price: 100000,
  create_date: "2026-10-25T09:00:00",
  sorting_date: "2026-10-25T10:00:00",
  manufacturing_date: "2021-01-01",
  manufacturer_cb: { name: "Dacia", seo_name: "dacia", value: 15 },
  model_cb: { name: "Spring", seo_name: "spring", value: 9057 },
  condition_cb: { name: "Nové", value: 1 },
  ...fields,
});
const cars = (...ids: number[]) => ids.map((id) => car(id));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** `sorting_date` the given seconds before 10:00 on 2026-10-25, as the site writes it. */
const secondsBefore = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 25, 10) - seconds * 1000).toISOString().slice(0, 19);
/** Listings `from`…`to`, each a second older than the one before, newest first. */
const datedCars = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    car(from + i, { sorting_date: secondsBefore(from + i) }),
  );

/**
 * Runs sautoSource({ pageSize: 4 }) against a synthetic API: `search` answers each search
 * query; a detail serves the last search item with its id, merged with `details[id]`.
 * `consume` sees each observation before the harvest resumes, as the Ledger would.
 */
async function harvestSite(
  mode: HarvestMode,
  search: (query: URLSearchParams) => { total: number; results: ApiItem[] },
  options: {
    checkpoint?: Partial<Checkpoint>;
    details?: Record<string, ApiItem>;
    consume?: (o: Observation) => void;
    source?: SautoOptions;
  } = {},
): Promise<{ observations: Observation[]; urls: string[]; error?: unknown }> {
  const served = new Map<string, ApiItem>();
  const urls: string[] = [];
  const http: Http = {
    async get(request) {
      const url = typeof request === "string" ? request : request.url;
      urls.push(url);
      const { pathname, searchParams } = new URL(url);
      const id = pathname.split("/").pop() ?? "";
      let body: unknown;
      if (id === "search") {
        const page = search(searchParams);
        for (const item of page.results) served.set(String(item.id), item);
        body = { pagination: { total: page.total }, results: page.results };
      } else {
        body = { result: { ...served.get(id), ...options.details?.[id] } };
      }
      return { url, status: 200, headers: {}, body: JSON.stringify(body), tier: "T0" };
    },
  };
  const ctx: HarvestContext = {
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, ...options.checkpoint },
    now,
    log: silentLogger,
    signal: new AbortController().signal,
  };
  const observations: Observation[] = [];
  try {
    for await (const o of sautoSource({ pageSize: 4, ...options.source }).harvest(ctx)) {
      observations.push(o);
      options.consume?.(o);
    }
  } catch (error) {
    return { observations, urls, error };
  }
  return { observations, urls };
}

const NEW_LOW = "new/0-134217728";
/** The search for the `nove` band below PRICE_TOP; every other band is empty. */
const newLow = (query: URLSearchParams) =>
  query.get("condition_seo") === "nove" && query.get("price_from") === "0";
const empty = { total: 0, results: [] };
/** A search over `list`, served in pages of 4 from the query's offset. */
const paged = (list: ApiItem[]) => (query: URLSearchParams) => {
  const offset = Number(query.get("offset"));
  return { total: list.length, results: list.slice(offset, offset + 4) };
};
const ALL_SLICES = ["new", "demo", "used"].flatMap((c) => [`${c}/0-134217728`, `${c}/134217728-`]);

const isDetail = (ref: string) => (url: string) => url.endsWith(`/api/v1/items/${ref}`);
const firstSearchPage = (url: string) =>
  url.includes("/items/search?") && !url.includes("price_from") && url.includes("offset=0");

describe("sauto source", () => {
  it("is lazy: no request before the first next()", async () => {
    let requests = 0;
    const http: Http = {
      async get() {
        requests++;
        throw new Error("unexpected");
      },
    };
    sautoSource(OPTIONS).harvest({
      http,
      mode: "full",
      checkpoint: emptyCheckpoint,
      now,
      log: silentLogger,
      signal: new AbortController().signal,
    });
    expect(requests).toBe(0);
  });

  it("incremental run pages newest-first through new, demo and used listings", async () => {
    const { observations, urls } = await harvest("incremental");
    const seen = listings(observations);
    expect(seen.length).toBeGreaterThan(OPTIONS.pageSize);
    expect(searches(urls).length).toBeGreaterThan(1);
    expect(new Set(seen.map((o) => o.condition))).toEqual(new Set(["new", "demo", "used"]));
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    for (const o of seen) {
      expect(o.url).toBe(`https://www.sauto.cz/osobni/detail/dacia/spring/${o.ref}`);
      expect(o.vehicle).toMatchObject({ make: "Dacia", model: "Spring", fuel: "bev" });
      expect(o.price.currency).toBe("CZK");
      expect(o.photos.every((p) => p.startsWith("https://"))).toBe(true);
    }
  });

  it("maps a listing's detail onto ListingSeen", async () => {
    const seen = listings((await harvest("incremental")).observations);
    const byRef = (ref: string) => seen.find((o) => o.ref === ref);
    expect(byRef("210998559")).toEqual({
      kind: "ListingSeen",
      ref: "210998559",
      url: "https://www.sauto.cz/osobni/detail/dacia/spring/210998559",
      market: "CZ",
      condition: "demo",
      vehicle: {
        make: "Dacia",
        model: "Spring",
        trim: "Electric 65 (27 kWh), SoH 96%",
        sourceTaxonomy: { make: "15", model: "9057" },
        firstRegistration: { year: 2025, month: 10 },
        body: "hatchback",
        fuel: "bev",
        powerKw: 48,
        transmission: "automatic",
        seats: 4,
        doors: 5,
        consumptionKwh100km: 14.5,
        color: "Červená",
      },
      odometerKm: 4945,
      price: { amount: 400000, currency: "CZK" },
      // "Možnost odpočtu DPH": the price includes VAT a buyer can reclaim.
      priceBasis: "gross",
      seller: "dealer",
      location: { region: "Hlavní město Praha" },
      photos: [
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/nPYADvcUkmDj2BMFYYHmLC2e/6b57.jpeg",
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/nPYADvcUkmBcG9PJpWHmLC26/e48d.jpeg",
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/kPVqmweP7JB4z4nDicHmLC3d/6e13.jpeg",
      ],
      listedAt: "2026-08-26",
      inspectionValidUntil: { year: 2029, month: 10 },
    });
    expect(byRef("211099650")).toMatchObject({
      condition: "new",
      seller: "dealer",
      priceBasis: "gross",
      odometerKm: 5,
      vehicle: { trim: "Extreme electric 100", powerKw: 75, manufactureYear: 2026 },
    });
    // A private seller (no premise) who does not offer a VAT deduction.
    expect(byRef("210518621")).toMatchObject({
      condition: "used",
      seller: "private",
      priceBasis: "unknown",
      location: { region: "Středočeský kraj", city: "Příbram" },
      vehicle: { firstRegistration: { year: 2025, month: 1 }, drive: "fwd" },
    });
  });

  // Pages of 4 by sorting_date (created): 10-24 (09-29), 10-19 (05-30), 10-14 (05-09),
  // 10-13 (09-14) | 10-13 (10-13) 211264902, 10-05 (10-05), 10-05 (04-22), 09-14 (09-14) | ...
  const LAST_RUN = new Date("2026-10-12T00:00:00Z"); // less the margin, 10-12 00:00 in Prague

  it("incremental run after a last run reads down to it and reads every unknown listing moved up", async () => {
    const { observations, urls } = await harvest("incremental", { lastRunAt: LAST_RUN });
    // The 2nd page (from offset 2: the 1st page's last two and two more) ends older than it.
    expect(searches(urls)).toHaveLength(2);
    // Each page's unknown details come out before the next search, in sorting_date order.
    const read = ["211187061", "210518621", "210389525", "211098051", "211264902"];
    expect(details(urls)).toEqual(read.map((ref) => `https://www.sauto.cz/api/v1/items/${ref}`));
    expect(listings(observations).map((o) => o.ref)).toEqual(read);
  });

  /** The listings on the first recorded search page. */
  const FIRST_PAGE = new Set(["211187061", "210518621", "210389525", "211098051"]);

  it("incremental run prices known listings moved up from their search items, without a detail", async () => {
    const { observations, urls } = await harvest("incremental", {
      lastRunAt: LAST_RUN,
      isKnown: (ref) => FIRST_PAGE.has(ref),
    });
    expect(details(urls)).toEqual(["https://www.sauto.cz/api/v1/items/211264902"]);
    expect(prices(observations)).toEqual([
      ["211187061", 220000],
      ["210518621", 359000],
      ["210389525", 249000],
      ["211098051", 259000],
    ]);
    expect(listings(observations).map((o) => o.ref)).toEqual(["211264902"]);
  });

  it("incremental run's search price is the price the listing's ListingSeen carries", async () => {
    // Like for like, or the Ledger would record changes that did not happen.
    const full = await harvest("full");
    const seen = new Map(listings(full.observations).map((o) => [o.ref, o.price.amount]));
    const { observations } = await harvest("incremental", { isKnown: () => true });
    expect(prices(observations).length).toBe(seen.size);
    expect(new Map(prices(observations))).toEqual(seen);
    expect(prices(observations).every(([, amount]) => amount > 0)).toBe(true);
    expect(listings(full.observations).some((o) => o.priceBasis !== "unknown")).toBe(true);
  });

  it("a known listing's price change shows up in the next incremental run", async () => {
    const { observations, urls } = await harvest(
      "incremental",
      { lastRunAt: LAST_RUN, isKnown: () => true },
      (cassette) =>
        editBodies(cassette, firstSearchPage, (body) => {
          // The edit moves it to the top of the order.
          const at = body.results.findIndex((i) => i.id === 210518621);
          const [item] = body.results.splice(at, 1);
          if (item) {
            Object.assign(item, { price: 339000, sorting_date: "2026-10-25T12:00:00" });
            body.results.unshift(item);
          }
        }),
    );
    expect(details(urls)).toEqual([]);
    expect(prices(observations)).toContainEqual(["210518621", 339000]);
  });

  it("first incremental run reads back a day", async () => {
    // Nothing moved within the day before the recording (the newest is 10-24 11:22).
    const { observations, urls } = await harvest("incremental", { lastRunAt: null });
    expect(searches(urls)).toHaveLength(1);
    expect(observations).toEqual([]);
  });

  it("incremental run keeps walking past a page of recent listings without a price", async () => {
    const { observations, urls } = await harvest(
      "incremental",
      { lastRunAt: LAST_RUN },
      // The first page's listings lose their price, on every page that repeats them.
      (cassette) =>
        editBodies(
          cassette,
          (url) => url.includes("/items/search?"),
          (body) => {
            for (const item of body.results)
              if (FIRST_PAGE.has(String(item.id)))
                Object.assign(item, { price: null, price_by_agreement: true });
          },
        ),
    );
    expect(searches(urls)).toHaveLength(2);
    expect(listings(observations).map((o) => o.ref)).toEqual(["211264902"]);
  });

  it("incremental run never drops a late-published listing: past its budget it fails, and the next run reads the rest", async () => {
    // Page 1 holds four listings created before the last run (drafted earlier, published or
    // topped up since), none in the Ledger; 211264902 was created since.
    const recorded = new Set<string>();
    const day = async () => {
      const out: Observation[] = [];
      const error = await harvest(
        "incremental",
        { lastRunAt: LAST_RUN, isKnown: (ref) => recorded.has(ref) },
        () => {},
        undefined,
        {
          source: { budget: 5 },
          consume: (o) => {
            out.push(o);
            if (o.kind === "ListingSeen") recorded.add(o.ref);
          },
        },
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { error, out };
    };
    const first = await day();
    // One search and four details use the cap; the Ledger keeps those late-published
    // listings and lastRunAt stays where it was, so the next page is still eligible.
    expect(listings(first.out).map((o) => o.ref)).toEqual([
      "211187061",
      "210518621",
      "210389525",
      "211098051",
    ]);
    expect(String(first.error)).toMatch(/request budget 5 exhausted/);
    const second = await day();
    expect(second.error).toBeUndefined();
    expect(listings(second.out).map((o) => o.ref)).toEqual(["211264902"]);
    expect(prices(second.out).map(([ref]) => ref)).toEqual([
      "211187061",
      "210518621",
      "210389525",
      "211098051",
    ]);
  });

  it("incremental budget includes search requests, including a walk of only known listings", async () => {
    const { observations, urls, error } = await harvestSite("incremental", paged(datedCars(1, 9)), {
      checkpoint: { isKnown: () => true },
      source: { budget: 2 },
    });
    expect(urls).toHaveLength(2);
    expect(details(urls)).toEqual([]);
    // The 2nd page, at offset 2, repeats 3 and 4.
    expect(prices(observations).map(([ref]) => ref)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(String(error)).toMatch(/request budget 2 exhausted/);
  });

  it("incremental run streams unknown details within the request cap and keeps a fetched page's known prices before exhaustion", async () => {
    const list = datedCars(1, 6);
    // Old drafts published recently remain eligible, regardless of create_date.
    for (const item of list) item.create_date = "2020-01-01T00:00:00";
    const recorded = new Set(["3", "4", "6"]);
    const day = () =>
      harvestSite("incremental", paged(list), {
        checkpoint: {
          lastRunAt: new Date("2026-10-24T00:00:00Z"),
          isKnown: (ref) => recorded.has(ref),
        },
        source: { budget: 4 },
        consume: (o) => {
          if (o.kind === "ListingSeen") recorded.add(o.ref);
        },
      });
    const first = await day();
    expect(first.urls).toHaveLength(4);
    expect(listings(first.observations).map((o) => o.ref)).toEqual(["1", "2"]);
    expect(prices(first.observations).map(([ref]) => ref)).toEqual(["3", "4", "6"]);
    expect(first.urls[1]).toMatch(/\/items\/1$/);
    expect(String(first.error)).toMatch(/request budget 4 exhausted/);
    const second = await day();
    expect(second.error).toBeUndefined();
    expect(listings(second.observations).map((o) => o.ref)).toEqual(["5"]);
    expect(second.urls).toHaveLength(3);
    const exact = await harvestSite("incremental", paged(datedCars(10, 12)), {
      source: { budget: 4 },
    });
    expect(exact.error).toBeUndefined();
    expect(exact.urls).toHaveLength(4);
    expect(listings(exact.observations)).toHaveLength(3);
  });

  it("incremental run pages overlap, so a removal between pages skips no listing, and pages back when it loses its place", async () => {
    /** Walks `length` listings in pages of 100; `move` reorders them after listing `at`. */
    const walk = async (length: number, at: string, move: (list: ApiItem[]) => ApiItem[]) => {
      let list = datedCars(1, length);
      const search = (q: URLSearchParams) => {
        const offset = Number(q.get("offset"));
        return { total: list.length, results: list.slice(offset, offset + 100) };
      };
      return harvestSite("incremental", search, {
        checkpoint: { lastRunAt: new Date("2026-10-24T00:00:00Z") },
        source: { pageSize: 100 },
        // Slow detail reads give the order time to move before the next search.
        consume: (o) => {
          if (o.kind === "ListingSeen" && o.ref === at) list = move(list);
        },
      });
    };
    const offsets = (urls: string[]) =>
      urls
        .filter((u) => u.includes("/items/search?"))
        .map((u) => new URL(u).searchParams.get("offset"));
    const refs = (o: Observation[]) => listings(o).map((l) => l.ref);

    const shifted = await walk(300, "100", (list) => list.slice(1));
    expect(shifted.error).toBeUndefined();
    expect(refs(shifted.observations)).toHaveLength(300);

    // Ten listings above the page go: the next page starts past it, so the walk pages back
    // to the page before, now repeating the end of the one it read, and goes on.
    const lost = await walk(300, "100", (list) => list.slice(10));
    expect(lost.error).toBeUndefined();
    expect(new Set(refs(lost.observations)).size).toBe(300);
    expect(offsets(lost.urls)).toEqual(["0", "94", "0", "94", "188", "282"]);

    // The page's last listing moves to the top (an edit or top-up): the next page still
    // repeats the listings before it, so the walk goes on.
    const topped = await walk(300, "100", (list) => [
      { ...list[99], sorting_date: "2026-10-25T12:00:00" },
      ...list.slice(0, 99),
      ...list.slice(100),
    ]);
    expect(topped.error).toBeUndefined();
    expect(refs(topped.observations)).toHaveLength(300);
    expect(offsets(topped.urls)).toEqual(["0", "94", "188", "282"]);

    // An order that shifted up more pages than the walk pages back fails rather than skip.
    const far = await walk(1000, "664", (list) => list.slice(400));
    expect(String(far.error)).toMatch(/lost its place in the order at offset 373/);
    expect(refs(far.observations)).toHaveLength(664);
    expect(offsets(far.urls).slice(-4)).toEqual(["658", "563", "468", "373"]);
  });

  it("incremental run takes listings sharing a date in any order: it steps above their tie, and fails when one fills a page", async () => {
    const refs = (o: Observation[]) => listings(o).map((l) => l.ref);
    const tie = "2026-10-25T09:00:00";
    const old = "2020-01-01T00:00:00";
    // Listings 1–15 dated a second apart, 16–25 one tie, 26–40 older. Once the walk has read
    // the first page (1–20), unseen 21 swaps above 16 inside the tie: the page at the old
    // stride (19) still repeats 19 and 20, yet 21 is above it.
    const list = [
      ...datedCars(1, 15),
      ...Array.from({ length: 10 }, (_, i) => car(16 + i, { sorting_date: tie })),
      ...Array.from({ length: 15 }, (_, i) => car(26 + i, { sorting_date: old })),
    ];
    const offsets: number[] = [];
    const swapped = await harvestSite(
      "incremental",
      (q) => {
        const offset = Number(q.get("offset"));
        offsets.push(offset);
        return { total: list.length, results: list.slice(offset, offset + 20) };
      },
      {
        checkpoint: { lastRunAt: new Date("2026-10-24T00:00:00Z") },
        source: { pageSize: 20 },
        consume: (o) => {
          if (o.kind === "ListingSeen" && o.ref === "20") {
            const at = list.findIndex((item) => item.id === 21);
            const [moved] = list.splice(at, 1);
            list.splice(15, 0, moved as ApiItem);
          }
        },
      },
    );
    expect(swapped.error).toBeUndefined();
    // The next page starts one above the tie (at 15, less the overlap of one), reads it
    // whole, and its last listing is older than the last run: nothing newer is left.
    expect(offsets).toEqual([0, 14]);
    expect(new Set(refs(swapped.observations))).toEqual(
      new Set(Array.from({ length: 25 }, (_, i) => String(i + 1))),
    );

    // The review's case: 1–20 share one date and fill the first page; 21 moves above the page
    // at 19 while 20 goes. No page can start above that tie, and this API ignores the price
    // halves that would split it, so the run fails having read only 1–20.
    const split: string[] = [];
    const filled = await harvestSite(
      "incremental",
      (q) => {
        const offset = Number(q.get("offset"));
        if (q.has("price_from")) split.push(`${q.get("price_from")}-${q.get("price_to") ?? ""}`);
        if (offset === 0) return { total: 60, results: cars(...range(1, 20)) };
        if (offset === 19) return { total: 60, results: cars(19, ...range(22, 40)) };
        return {
          total: 60,
          results: [car(40, { sorting_date: old }), car(41, { sorting_date: old })],
        };
      },
      {
        checkpoint: { lastRunAt: new Date("2026-10-24T00:00:00Z") },
        source: { pageSize: 20 },
      },
    );
    expect(String(filled.error)).toMatch(
      /band 0-2 cannot be split, and 20 listings dated 2026-10-25T10:00:00 fill its page/,
    );
    expect(refs(filled.observations)).toEqual(range(1, 20).map(String));
    // The halves share their middle price: the lower one ends at it.
    expect(split[0]).toBe("0-134217728");

    // Where the price halves do split it, each half is walked from its top and nothing is lost,
    // a listing stored at a fraction of a crown included: halves share their middle price, so
    // 41 at 131,071.5 falls in the half up to 131,072 (2^17) rather than between two.
    const cheap = cars(...range(1, 20));
    const dear = range(21, 40).map((id) => car(id, { price: 200_000 }));
    const halved = await harvestSite(
      "incremental",
      (q) => {
        const offset = Number(q.get("offset"));
        const from = Number(q.get("price_from") ?? "0");
        const to = Number(q.get("price_to") ?? Number.POSITIVE_INFINITY);
        const all = [...cheap, car(41, { price: 131_071.5 }), ...dear];
        const inBand = q.has("price_from")
          ? all.filter((item) => (item.price as number) >= from && (item.price as number) <= to)
          : all;
        return { total: inBand.length, results: inBand.slice(offset, offset + 20) };
      },
      {
        checkpoint: { lastRunAt: new Date("2026-10-24T00:00:00Z") },
        source: { pageSize: 20 },
      },
    );
    expect(halved.error).toBeUndefined();
    expect(new Set(refs(halved.observations))).toEqual(new Set(range(1, 41).map(String)));
  });

  it("rejects a page size that is not a whole number from 1 to 10,000", () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
      expect(() => sautoSource({ pageSize })).toThrow(/pageSize must be a whole number from 1/);
    }
    for (const pageSize of [1, 2, 10_000]) expect(() => sautoSource({ pageSize })).not.toThrow();
  });

  // The review's small-page case: 30 listings share one date; once the first page is read,
  // unseen 11 moves to the top of the order. Every page size checks each step (pages of 1 and
  // 2 cannot step on, and walk price halves), so the walk reads all 30 or fails.
  it.each([1, 2, 3, 4, 10, 20])(
    "pages of %i: listings sharing a date that reorder between pages are all read, or the run fails",
    async (pageSize) => {
      const walk = (price: (id: number) => number) => {
        const list = range(1, 30).map((id) => car(id, { price: price(id) }));
        let searched = 0;
        return harvestSite(
          "incremental",
          (q) => {
            if (searched++ === 1) {
              const [moved] = list.splice(10, 1);
              list.unshift(moved as ApiItem);
            }
            const offset = Number(q.get("offset"));
            const from = Number(q.get("price_from") ?? "0");
            const to = Number(q.get("price_to") ?? Number.POSITIVE_INFINITY);
            const inBand = list.filter(
              (item) => (item.price as number) >= from && (item.price as number) <= to,
            );
            return { total: inBand.length, results: inBand.slice(offset, offset + pageSize) };
          },
          { checkpoint: { lastRunAt: new Date("2026-10-24T00:00:00Z") }, source: { pageSize } },
        );
      };
      const refs = (o: Observation[]) => new Set(listings(o).map((l) => l.ref));

      // One price: no half splits the tie.
      const tied = await walk(() => 100_000);
      expect(String(tied.error)).toMatch(/cannot be split/);

      // A price each: the halves split it, and each is walked from its top.
      const split = await walk((id) => 100_000 + id * 1_000);
      expect(split.error).toBeUndefined();
      expect(refs(split.observations)).toEqual(new Set(range(1, 30).map(String)));
    },
  );

  it("incremental run places pages by well-formed dates only, and pages back to a page dated above its place", async () => {
    const refs = (o: Observation[]) => listings(o).map((l) => l.ref);
    const lastRunAt = new Date("2026-10-24T00:00:00Z");
    /** Pages of 20 over `list`; `change(n, list)` runs before the n-th search is served. */
    const walk = (initial: ApiItem[], change: (n: number, list: ApiItem[]) => ApiItem[]) => {
      let list = initial;
      const offsets: number[] = [];
      return harvestSite(
        "incremental",
        (q) => {
          const offset = Number(q.get("offset"));
          offsets.push(offset);
          list = change(offsets.length, list);
          return { total: list.length, results: list.slice(offset, offset + 20) };
        },
        { checkpoint: { lastRunAt }, source: { pageSize: 20 } },
      ).then((result) => ({ ...result, offsets }));
    };

    // 22 has a malformed date. After the first page, 2–4 go: the page at 18 starts at 22,
    // past unseen 21. Its date ("z") would sort after any; it is not taken as a place, the
    // walk pages back, and 22 is still read as moved.
    const malformed = await walk(
      datedCars(1, 60).map((item) => (item.id === 22 ? { ...item, sorting_date: "z" } : item)),
      (n, list) => (n === 2 ? list.filter((item) => ![2, 3, 4].includes(item.id as number)) : list),
    );
    expect(malformed.error).toBeUndefined();
    // From the page at 0, the next starts above 21, the last dated listing above the tie of
    // one (23), as 22's date tells nothing.
    expect(malformed.offsets.slice(0, 4)).toEqual([0, 18, 0, 17]);
    // 2–4 were read before they went; 21 on the page paged back to.
    expect(new Set(refs(malformed.observations))).toEqual(new Set(range(1, 60).map(String)));

    // After the third page, 2–11 go and the page at 54 starts past it; by the next search 30
    // listings arrive on top, so the page it pages back to (35) ends above its place. That
    // page follows on but gets no further; the walk steps on from it and meets every listing.
    const fresh = Array.from({ length: 30 }, (_, i) =>
      car(1000 + i, { sorting_date: `2026-10-25T11:00:${String(59 - i).padStart(2, "0")}` }),
    );
    const backed = await walk(datedCars(1, 100), (n, list) => {
      if (n === 4) return list.filter((item) => !range(2, 11).includes(item.id as number));
      if (n === 5) return [...fresh, ...list];
      return list;
    });
    expect(backed.error).toBeUndefined();
    expect(backed.offsets.slice(0, 6)).toEqual([0, 18, 36, 54, 35, 53]);
    const met = new Set(refs(backed.observations));
    expect([1, ...range(12, 100)].filter((id) => !met.has(String(id)))).toEqual([]);

    // A page whose dates are not newest first is not an order the walk can place itself in.
    const unsorted = await walk(datedCars(1, 20).reverse(), (_, list) => list);
    expect(String(unsorted.error)).toMatch(/at offset 0 is not newest first/);
  });

  it("incremental run prices known listings and reads no detail for them, however recently changed", async () => {
    const known = { isKnown: () => true };
    const longAgo = await harvest("incremental", known);
    expect(listings(longAgo.observations)).toEqual([]);
    expect(prices(longAgo.observations)).toHaveLength(13);
    expect(details(longAgo.urls)).toEqual([]);
    expect(searches(longAgo.urls)).toHaveLength(6);
    const justNow = await harvest("incremental", { ...known, lastRunAt: now });
    expect(justNow.observations).toEqual([]);
    expect(searches(justNow.urls)).toHaveLength(1);
  });

  it("full run halves bands over the slice limit and reports each finished slice", async () => {
    const { observations, urls } = await harvest("full");
    const done = slices(observations);
    expect(new Set(done).size).toBe(done.length);
    // A leaf band paged in overlapping steps (pageSize 4, step 3); overlaps yield once.
    expect(searches(urls).some((u) => u.includes("price_from") && u.includes("offset=3"))).toBe(
      true,
    );
    const refs = listings(observations).map((o) => o.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(done).toContain("new/134217728-");
    expect(done).toContain("demo/134217728-");
    expect(done.some((s) => s.startsWith("used/") && s !== "used/0-134217728")).toBe(true);
    expect(done).not.toContain("used/0-134217728");
    // The census sees what the incremental run saw.
    const incremental = listings((await harvest("incremental")).observations);
    expect(new Set(listings(observations).map((o) => o.ref))).toEqual(
      new Set(incremental.map((o) => o.ref)),
    );
    // Every listing belongs to the slice whose SliceDone follows it.
    let open: ListingSeen[] = [];
    for (const o of observations) {
      if (o.kind === "ListingSeen") open.push(o);
      if (o.kind === "SliceDone") {
        const [condition, band] = o.slice.split("/") as [string, string];
        const [from, to] = band.split("-").map((n) => (n === "" ? Infinity : Number(n)));
        for (const l of open) {
          expect(l.condition).toBe(condition);
          expect(l.price.amount).toBeGreaterThanOrEqual(from as number);
          expect(l.price.amount).toBeLessThan(to as number);
        }
        open = [];
      }
    }
    expect(open).toEqual([]);
  });

  it("full run halves a band over 2,000 results by default, so a slice's details fit in a run", async () => {
    // At 1 request a second a 9,500-result slice took near 3 hours: a run cut off in one
    // lost it all.
    const whole = (q: URLSearchParams) => newLow(q) && q.get("price_to") === "134217727";
    const { observations, error } = await harvestSite("full", (q) =>
      whole(q) ? { total: 2_001, results: [] } : empty,
    );
    expect(error).toBeUndefined();
    expect(slices(observations)).toEqual([
      "new/0-67108864",
      "new/67108864-134217728",
      ...ALL_SLICES.filter((s) => s !== NEW_LOW),
    ]);
  });

  it("full run resumes a census: slices done earlier are skipped", async () => {
    const all = await harvest("full");
    const done = slices(all.observations);
    const skipped = new Set(done.filter((s) => s.startsWith("used/")));
    const resumed = await harvest("full", {
      sliceDoneAt: (slice) => (skipped.has(slice) ? new Date("2026-10-24T03:00:00Z") : null),
    });
    expect(slices(resumed.observations)).toEqual(done.filter((s) => !skipped.has(s)));
    expect(listings(resumed.observations).every((o) => o.condition !== "used")).toBe(true);
    expect(resumed.urls.length).toBeLessThan(all.urls.length);
  });

  it("a malformed item comes out as an observation the Ledger rejects; the run goes on", async () => {
    const all = listings((await harvest("incremental")).observations);
    const victim = all[1] as ListingSeen;
    const { observations } = await harvest("incremental", {}, (cassette) => {
      const strip = (item: ApiItem) => {
        delete item.manufacturer_cb;
        delete item.model_cb;
      };
      editBodies(
        cassette,
        (url) => url.includes("/items/search?"),
        (body) => {
          for (const item of body.results) if (String(item.id) === victim.ref) strip(item);
        },
      );
      editBodies(cassette, isDetail(victim.ref), (body) => strip(body.result));
      editBodies(cassette, firstSearchPage, (body) => {
        delete body.results[0]?.id;
      });
    });
    const out = listings(observations);
    // Ledger validation rejects an empty ref and an empty make/model (packages/ledger/src/validate.ts).
    expect(out.filter((o) => o.ref === "")).toHaveLength(1);
    expect(out.find((o) => o.ref === victim.ref)?.vehicle.make).toBe("");
    expect(out.filter((o) => o.ref !== "" && o.vehicle.make !== "")).toHaveLength(all.length - 2);
  });

  it("a malformed search entry neither ends its slice's paging nor its census", async () => {
    const full = await harvest("full");
    const paged = searches(full.urls).find(
      (u) => u.includes("price_from") && u.includes("offset=3"),
    );
    const pageOne = paged?.replace("offset=3", "offset=0");
    expect(pageOne).toBeDefined();
    let dropped = "";
    const { observations, urls } = await harvest("full", {}, (cassette) =>
      editBodies(
        cassette,
        (url) => url === pageOne,
        (body) => {
          dropped = String(body.results[0]?.id);
          (body.results as unknown[])[0] = null;
        },
      ),
    );
    expect(urls).toContain(paged);
    const out = listings(observations);
    expect(out.filter((o) => o.ref === "")).toHaveLength(1);
    expect(out.some((o) => o.ref === dropped)).toBe(false);
    expect(out.length).toBe(listings(full.observations).length);
    expect(slices(observations)).toEqual(slices(full.observations));
  });

  it("skips listings without a price and reports a removed listing gone", async () => {
    const all = listings((await harvest("incremental")).observations);
    const [unpriced, removed] = all as [ListingSeen, ListingSeen];
    const { observations } = await harvest("incremental", {}, (cassette) => {
      editBodies(
        cassette,
        (url) => url.includes("/items/search?"),
        (body) => {
          for (const item of body.results) {
            if (String(item.id) === unpriced.ref)
              Object.assign(item, { price: null, price_by_agreement: true });
          }
        },
      );
      replaceResponse(cassette, isDetail(removed.ref), {
        status: 404,
        body: JSON.stringify({ status_code: 404, status_message: "Not found" }),
      });
    });
    expect(observations.some((o) => o.kind === "ListingSeen" && o.ref === unpriced.ref)).toBe(
      false,
    );
    expect(observations).toContainEqual({ kind: "ListingGone", ref: removed.ref });
    expect(listings(observations)).toHaveLength(all.length - 2);
  });

  it("a price set without VAT comes out as the gross headline the site shows, in search and detail alike", async () => {
    // Recorded 2026-10-29 from live Sauto: every Toyota Sienna, bodies trimmed to the fields the
    // adapter reads plus `price_original`. 209539998's page shows 1 681 900 Kč, "Bez DPH:
    // 1 390 000 Kč": its seller entered the net, and `price` is that plus 21%.
    const run = async (checkpoint: Partial<Checkpoint>) => {
      const ctx: HarvestContext = {
        http: createReplayHttp(await loadCassette(withoutVat)),
        mode: "incremental",
        checkpoint: { ...emptyCheckpoint, lastRunAt: LONG_AGO, ...checkpoint },
        now: new Date("2026-10-29T02:33:00Z"),
        log: silentLogger,
        signal: new AbortController().signal,
      };
      const observations: Observation[] = [];
      const source = sautoSource({ manufacturerModel: "toyota:sienna", pageSize: 4 });
      for await (const o of source.harvest(ctx)) observations.push(o);
      return observations;
    };
    const seen = listings(await run({}));
    const byRef = new Map(seen.map((o) => [o.ref, o]));
    expect(byRef.get("209539998")).toMatchObject({
      price: { amount: 1_681_900, currency: "CZK" },
      priceBasis: "gross",
      seller: "dealer",
    });
    expect(byRef.get("209783754")).toMatchObject({
      price: { amount: 1_750_000, currency: "CZK" },
      priceBasis: "gross",
    });
    expect(seen.some((o) => o.priceBasis === "net")).toBe(false);
    // The search price a known listing gets daily is the same gross amount.
    const known = await run({ isKnown: () => true });
    expect(new Map(prices(known))).toEqual(new Map(seen.map((o) => [o.ref, o.price.amount])));
  });

  it("fails the run when the API answers with a page that is not JSON", async () => {
    await expect(
      harvest("incremental", {}, (cassette) =>
        replaceResponse(cassette, firstSearchPage, {
          headers: { "content-type": "text/html" },
          body: "<!doctype html><title>Seznam - souhlas</title>",
        }),
      ),
    ).rejects.toThrow(/non-JSON/);
  });

  it("fails the run when the API is blocked", async () => {
    await expect(
      harvest("full", {}, (cassette) =>
        replaceResponse(cassette, () => true, {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
      ),
    ).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("incremental run walks price halves when the order since the last run outgrows the 10,000-result window", async () => {
    // Two days of top-ups: more than the window above the last run. Each price half fits.
    const low = [car(1, { price: 90000 }), car(2, { price: 80000 })];
    const high = [car(3, { price: 200_000_000 })];
    const search = (q: URLSearchParams) => {
      const offset = Number(q.get("offset"));
      if (q.get("price_from") === "0")
        return { total: 2, results: low.slice(offset, offset + 100) };
      if (q.get("price_from")) return { total: 1, results: high.slice(offset, offset + 100) };
      // Each place its own date, so pages step past their last listing's tie of one.
      return {
        total: 10_001,
        results: Array.from({ length: 100 }, (_, i) => ({
          ...low[0],
          sorting_date: secondsBefore(offset + i),
        })),
      };
    };
    for (const lastRunAt of [new Date("2026-10-24T00:00:00Z"), null]) {
      const { observations, urls, error } = await harvestSite("incremental", search, {
        checkpoint: { lastRunAt },
        source: { pageSize: 100 },
      });
      expect(error).toBeUndefined();
      // 106 overlapping pages up to the window, then one page per half.
      expect(searches(urls)).toHaveLength(108);
      expect(listings(observations).map((o) => o.ref)).toEqual(["1", "2", "3"]);
    }
  });

  it("full run leaves a band whose pages hold fewer results than its total not done, and fails", async () => {
    const { observations, urls, error } = await harvestSite("full", (q) =>
      newLow(q) ? { total: 6, results: cars(1001, 1002) } : empty,
    );
    expect(String(error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(observations).map((o) => o.ref)).toEqual(["1001", "1002"]);
    expect(slices(observations)).toEqual(ALL_SLICES.filter((s) => s !== NEW_LOW));
    // Paged once more before giving up.
    expect(searches(urls).filter((u) => newLow(new URL(u).searchParams))).toHaveLength(2);
  });

  it("full run does not count a page served twice towards its band's total", async () => {
    // Offsets 0 and 3 (pageSize 4, step 3) both answer 1–4, of a total of 6.
    const { observations, error } = await harvestSite("full", (q) =>
      newLow(q) ? { total: 6, results: cars(1, 2, 3, 4) } : empty,
    );
    expect(String(error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(observations).map((o) => o.ref)).toEqual(["1", "2", "3", "4"]);
    expect(slices(observations)).not.toContain(NEW_LOW);
  });

  it("full run finishes a short band when paging it again reaches its total", async () => {
    let passes = 0;
    const { observations, error } = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      passes++;
      // The first pass misses 3 and serves 1 without a price; the second has it priced.
      const unpriced = car(1, { price: null, price_by_agreement: true });
      return { total: 3, results: passes === 1 ? [unpriced, car(2)] : cars(1, 2, 3) };
    });
    expect(error).toBeUndefined();
    expect(listings(observations).map((o) => o.ref)).toEqual(["1", "2", "3"]);
    expect(slices(observations)).toEqual(ALL_SLICES);
  });

  it("full run judges each pass alone, against the highest total its pages reported", async () => {
    // Two short passes that together hold all 3 results.
    let passes = 0;
    const apart = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      passes++;
      return { total: 3, results: passes === 1 ? cars(1, 2) : cars(2, 3) };
    });
    expect(String(apart.error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(apart.observations).map((o) => o.ref)).toEqual(["1", "2", "3"]);
    expect(slices(apart.observations)).not.toContain(NEW_LOW);
    // The first page reports 6, the next only 5; 5 distinct do not reach 6.
    const shrunk = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      return q.get("offset") === "0"
        ? { total: 6, results: cars(1, 2, 3, 4) }
        : { total: 5, results: cars(4, 5) };
    });
    expect(String(shrunk.error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(slices(shrunk.observations)).not.toContain(NEW_LOW);
  });

  it("incremental run yields each new listing once, though the order repeats it", async () => {
    // After the first page two listings arrive on top, so the second page (at 2) repeats the
    // first whole; the pages after it hold unseen listings.
    let list = datedCars(1, 8);
    let searched = 0;
    const recorded = new Set<string>();
    const { observations, error, urls } = await harvestSite(
      "incremental",
      (q) => {
        if (searched++ === 1) {
          const fresh = [101, 102].map((id) => car(id, { sorting_date: secondsBefore(-id) }));
          list = [...fresh, ...list];
        }
        return paged(list)(q);
      },
      {
        checkpoint: { lastRunAt: LONG_AGO, isKnown: (ref) => recorded.has(ref) },
        consume: (o) => {
          if (o.kind === "ListingSeen") recorded.add(o.ref);
        },
      },
    );
    expect(error).toBeUndefined();
    expect(searches(urls).map((u) => new URL(u).searchParams.get("offset"))).toEqual([
      "0",
      "2",
      "4",
      "6",
    ]);
    expect(listings(observations).map((o) => o.ref)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
  });

  it("keeps listings made before 2000 out, and counts them towards a band's total", async () => {
    // A first page of nothing in scope, which must not end a first run's walk.
    const list = [
      car(1, { manufacturing_date: "1999-12-01" }),
      // Without a year of manufacture, the first registration's year counts.
      car(3, { manufacturing_date: null, in_operation_date: "1999-06-01" }),
      car(6, { manufacturing_date: "1990-01-01" }),
      car(7, { price: null, price_by_agreement: true }),
      car(2, { manufacturing_date: "2000-01-01" }),
      car(4, { manufacturing_date: null, in_operation_date: "2000-03-01" }),
      // Only the detail dates this one.
      car(5, { manufacturing_date: null }),
    ].map((item, i) => ({ ...item, sorting_date: secondsBefore(i + 1) }));
    const details = { 5: { manufacturing_date: "1998-01-01" } };
    const incremental = await harvestSite("incremental", paged(list), { details });
    expect(incremental.error).toBeUndefined();
    expect(listings(incremental.observations).map((o) => o.ref)).toEqual(["2", "4"]);
    expect(searches(incremental.urls).every((u) => u.includes("vehicle_age_from=2000"))).toBe(true);
    expect(incremental.urls.some((u) => /\/items\/[1367]$/.test(u))).toBe(false);
    const full = await harvestSite("full", (q) => (newLow(q) ? paged(list)(q) : empty), {
      details,
    });
    expect(full.error).toBeUndefined();
    expect(listings(full.observations).map((o) => o.ref)).toEqual(["2", "4"]);
    expect(slices(full.observations)).toEqual(ALL_SLICES);
    expect(searches(full.urls).every((u) => u.includes("vehicle_age_from=2000"))).toBe(true);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(harvest("full", {}, () => {}, controller.signal)).rejects.toThrow("stop");
  });
});
