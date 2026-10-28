import {
  type Cassette,
  createReplayHttp,
  type Http,
  HttpBlockedError,
  loadCassette,
} from "@cca/http";
import type { ListingSeen, Observation, SliceDone } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  emptyCheckpoint,
  type HarvestContext,
  type HarvestMode,
  type Source,
  silentLogger,
} from "../source.ts";
import { type AutoScout24Options, autoscout24Source } from "./autoscout24.ts";

// Recorded 2026-10-25 against the live sites by autoscout24Source with the options below
// (a one-off script around recordingHttp, since the recorder CLI takes no adapter options).
// Bodies are trimmed to the __NEXT_DATA__ fields the adapter reads, with two photos per
// listing and no seller contact details. de-full also holds the three country-wide first
// pages (one per Condition), cut down to the two recorded makes: taxonomy and result counts.
// The 4 new and 4 demo cars fit the test cap, so those two pages claim the full page
// allowance (2,000 pages of 2) to be split as well.
const now = new Date("2026-10-25T14:26:00Z");
const deFull = new URL("./fixtures/de-full.cassette.json", import.meta.url);
const atFull = new URL("./fixtures/at-full.cassette.json", import.meta.url);
const deIncremental = new URL("./fixtures/de-incremental.cassette.json", import.meta.url);
/**
 * Recorded 2026-10-27 by a one-off script around recordingHttp (one request a second): first
 * pages of price-filtered queries, trimmed to counts, plus id and price of Aiways' listings.
 */
const priceFilter = new URL("./fixtures/price-filter.cassette.json", import.meta.url);
/** Zeekr (51964) and Aiways (51872) have few listings, so a 4-result cap forces splits. */
const DE: AutoScout24Options = { country: "DE", makes: [51964, 51872], pageSize: 2, resultCap: 4 };
const AT: AutoScout24Options = { country: "AT", makes: [51964] };
/** Xpeng (51940), an incremental run 10 days after the last one. */
const DE_INCREMENTAL: AutoScout24Options = { country: "DE", makes: [51940], pageSize: 2 };
const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
/** The listings on page 2 of the incremental new-car query. */
const NEW_PAGE_2 = [
  "1e754198-6dde-4c80-87bb-a338162a905a",
  "b122d897-9cbd-4d21-b4e9-37424db31ae5",
  "763e1288-34eb-4d4d-846e-5ac504556e29",
];
/** Distinct listings per Condition in de-full. */
const COUNTS = { new: 4, demo: 4, used: 9, usedZeekr: 5 };

interface Run {
  observations: Observation[];
  urls: string[];
  error?: unknown;
}

async function harvest(
  cassette: URL,
  source: Source,
  mode: HarvestMode,
  checkpoint: Partial<Checkpoint> = {},
  edit: (cassette: Cassette) => void = () => {},
  signal = new AbortController().signal,
): Promise<Run> {
  const recorded = structuredClone(await loadCassette(cassette));
  edit(recorded);
  const replay = createReplayHttp(recorded);
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
    checkpoint: { ...emptyCheckpoint, ...checkpoint },
    now,
    log: silentLogger,
    signal,
  };
  const run: Run = { observations: [], urls };
  try {
    for await (const o of source.harvest(ctx)) run.observations.push(o);
  } catch (error) {
    run.error = error;
  }
  return run;
}

const listings = (run: Run) =>
  run.observations.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const slices = (run: Run) =>
  run.observations.filter((o): o is SliceDone => o.kind === "SliceDone").map((o) => o.slice);
const refs = (run: Run) => new Set(listings(run).map((l) => l.ref));
const params = (url: string) => new URL(url).searchParams;

/** Edits `__NEXT_DATA__` pageProps of every recorded page whose URL passes `match`. */
function editPages(
  match: (query: URLSearchParams) => boolean,
  // biome-ignore lint/suspicious/noExplicitAny: recorded site JSON.
  change: (pageProps: any) => void,
) {
  return (cassette: Cassette) => {
    for (const { request, response } of cassette.interactions) {
      if (!match(new URL(request.url).searchParams)) continue;
      const [, head, json, tail] =
        /^([\s\S]*<script id="__NEXT_DATA__"[^>]*>)([\s\S]*?)(<\/script>[\s\S]*)$/.exec(
          response.body,
        ) ?? [];
      const data = JSON.parse(json as string);
      change(data.props.pageProps);
      response.body = `${head}${JSON.stringify(data)}${tail}`;
    }
  };
}

/** Serves the recorded page matching `match` once per count, with that count; the last repeats. */
function countsInTurn(match: (query: URLSearchParams) => boolean, counts: number[]) {
  return (cassette: Cassette) => {
    const index = cassette.interactions.findIndex((i) =>
      match(new URL(i.request.url).searchParams),
    );
    const recorded = cassette.interactions[index];
    if (!recorded) throw new Error("fixture lacks the page");
    const turns = counts.map((count) => {
      const turn = structuredClone(recorded);
      editPages(
        () => true,
        (props) => {
          props.numberOfResults = count;
        },
      )({ version: 1, interactions: [turn] });
      return turn;
    });
    cassette.interactions.splice(index, 1, ...turns);
  };
}

/** The Ledger's checkpoint is live: a listing is known once recorded, i.e. once yielded. */
function liveCheckpoint(inner: Source, knownBefore: Iterable<string> = []) {
  const known = new Set(knownBefore);
  const source: Source = {
    ...inner,
    async *harvest(ctx) {
      for await (const o of inner.harvest(ctx)) {
        yield o;
        if (o.kind === "ListingSeen") known.add(o.ref);
      }
    },
  };
  return { source, isKnown: (ref: string) => known.has(ref) };
}

const slice = (offer: string, make: number, page?: number) => (query: URLSearchParams) =>
  query.get("offer") === offer &&
  query.get("mmmv") === `${make}|||` &&
  (page === undefined || query.get("page") === String(page));
/** The country-wide used-car query, split by price when no makes are given. */
const usedEverywhere = (query: URLSearchParams) =>
  !query.has("mmmv") && !query.has("pricefrom") && query.get("offer") === "U,J,O";

// biome-ignore lint/suspicious/noExplicitAny: recorded site JSON.
type RawListing = any;
const priceOf = (listing: RawListing): number => listing.price.priceRaw;
/** A used car without a price: the Condition counts it, no price band takes it. */
const UNPRICED = "00000000-0000-4000-8000-000000000003";
const noPrice = (offer: string, listings: RawListing[]) => {
  if (offer !== "U,J,O") return listings;
  const listing = structuredClone(listings[0]);
  listing.id = UNPRICED;
  listing.price = { priceFormatted: "Preis auf Anfrage", isConditionalPrice: false };
  return [listing, ...listings];
};
const unpriced =
  /not harvested whole: used \(1 listing outside every whole-euro price band, possibly unpriced or fractional, or counts that moved\)$/;
/** The site's price filter (price-filter.cassette.json): whole-euro bounds, both inclusive. */
const takes = (price: unknown, from: number, to: number | undefined) =>
  typeof price === "number" && price >= from && (to === undefined || price <= to);
/** `__NEXT_DATA__` pageProps of a recorded page. */
const pagePropsOf = (body: string) =>
  JSON.parse(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(body)?.[1] ?? "").props
    .pageProps;
const makeOf = (listing: RawListing) =>
  Number(/make_id:(\d+)/.exec(listing.tracking.modelTaxonomy)?.[1]);
/** First-registration year, "07-2011" → 2011; new cars have none. */
const yearOf = (listing: RawListing) =>
  Number(/^\d{2}-(\d{4})$/.exec(listing.tracking.firstRegistration)?.[1]);

/**
 * Adds the country-wide price-band queries a run without makes asks for (de-full records
 * only each Condition's first page country-wide), served from the listings of the recorded
 * make queries: a band holds those its bounds take, newest first as recorded, and a band
 * over the cap has its halves, or at one price its first-registration years. `pool` edits a
 * Condition's listings first.
 */
function bandsFromMakes(
  pool: (offer: string, listings: RawListing[]) => RawListing[] = (_, listings) => listings,
) {
  const { pageSize = 2, resultCap = 4 } = DE;
  return (cassette: Cassette) => {
    for (const offer of ["N", "D,S", "U,J,O"]) {
      const top = cassette.interactions.find(({ request }) => {
        const query = new URL(request.url).searchParams;
        return !query.has("mmmv") && query.get("offer") === offer;
      });
      if (!top) throw new Error("fixture lacks the page");
      const byRef = new Map<string, RawListing>();
      for (const { request, response } of cassette.interactions) {
        const query = new URL(request.url).searchParams;
        if (query.get("offer") !== offer || !query.has("mmmv")) continue;
        for (const listing of pagePropsOf(response.body).listings) {
          byRef.set(listing.id, listing);
        }
      }
      const listings = pool(offer, [...byRef.values()]);
      const add = (from: number, to: number | undefined, year?: number) => {
        const held = listings.filter(
          (l) =>
            takes(priceOf(l), from, to) &&
            (year === undefined ||
              yearOf(l) === year ||
              (year === now.getUTCFullYear() && yearOf(l) > year)),
        );
        const pages = Math.max(1, Math.ceil(held.length / pageSize));
        for (let n = 1; n <= pages; n++) {
          const url = new URL(top.request.url);
          url.searchParams.set("pricefrom", String(from));
          if (to !== undefined) url.searchParams.set("priceto", String(to));
          if (year !== undefined) url.searchParams.set("fregfrom", String(year));
          if (year !== undefined && year < now.getUTCFullYear()) {
            url.searchParams.set("fregto", String(year));
          }
          url.searchParams.set("page", String(n));
          const turn = structuredClone(top);
          turn.request.url = url.href;
          turn.response.url = url.href;
          editPages(
            () => true,
            (props) => {
              props.numberOfResults = held.length;
              props.numberOfPages = pages;
              props.listings = held.slice((n - 1) * pageSize, n * pageSize);
            },
          )({ version: 1, interactions: [turn] });
          cassette.interactions.push(turn);
        }
        if (held.length <= resultCap) return;
        if (to !== undefined && from < to) {
          const mid = Math.floor((from + to) / 2);
          add(from, mid);
          add(mid + 1, to);
        } else if (year === undefined) {
          for (let y = 2000; y <= now.getUTCFullYear(); y++) add(from, to, y);
        }
      };
      add(0, 999_999);
      add(1_000_000, undefined);
    }
  };
}

describe("autoscout24 source", () => {
  it("is one Source per country, scoped by the makes it covers", () => {
    expect(autoscout24Source({ country: "DE" }).id).toBe("autoscout24-de");
    expect(autoscout24Source({ country: "DE" }).scope).toBeUndefined();
    expect(autoscout24Source({ country: "AT", makes: [74, 29, 74] })).toMatchObject({
      id: "autoscout24-at",
      scope: "makes:29,74",
    });
    expect(() => autoscout24Source({ country: "DE", pageSize: 100 })).toThrow(RangeError);
    expect(() => autoscout24Source({ country: "DE", resultCap: 5_000 })).toThrow(RangeError);
  });

  it("maps DE listings onto ListingSeen", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full");
    expect(run.error).toBeUndefined();
    for (const listing of listings(run)) {
      expect(listing.market).toBe("DE");
      expect(listing.price.currency).toBe("EUR");
      expect(listing.price.amount).toBeGreaterThan(0);
      expect(listing.url).toMatch(/^https:\/\/www\.autoscout24\.de\/angebote\/.+/);
      expect(listing.url.endsWith(listing.ref)).toBe(true);
      expect(["Zeekr", "Aiways"]).toContain(listing.vehicle.make);
      expect(listing.vehicle.powerKw).toBeGreaterThan(0);
    }
    const seen = new Map(listings(run).map((l) => [l.ref, l]));
    expect(seen.get("1eaa0d24-13f7-4e34-a208-4a34949ebd50")).toEqual({
      kind: "ListingSeen",
      ref: "1eaa0d24-13f7-4e34-a208-4a34949ebd50",
      url: "https://www.autoscout24.de/angebote/zeekr-7gt-310-kw-rwd-business-edition-businessedition-led-elektro-weiss-cat_ma51964gr203164ge11149mt12773tr481101-1eaa0d24-13f7-4e34-a208-4a34949ebd50",
      market: "DE",
      condition: "demo",
      vehicle: {
        make: "Zeekr",
        model: "7GT",
        trim: "310 kW RWD Business Edition BusinessEdition*LED...",
        sourceTaxonomy: { make: "51964", model: "79454" },
        firstRegistration: { year: 2026, month: 9 },
        fuel: "bev",
        powerKw: 310,
        transmission: "automatic",
        consumptionKwh100km: 16.6,
        co2GKm: 0,
      },
      odometerKm: 50,
      price: { amount: 47550, currency: "EUR" },
      priceBasis: "gross",
      seller: "dealer",
      location: { city: "Osnabrück", postcode: "49084" },
      photos: [
        "https://prod.pictures.autoscout24.net/listing-images/1eaa0d24-13f7-4e34-a208-4a34949ebd50_24a63ecc-1785-49fa-9a92-7ce89d46f549.jpg/250x188.webp",
        "https://prod.pictures.autoscout24.net/listing-images/1eaa0d24-13f7-4e34-a208-4a34949ebd50_08018195-52be-4ce2-bd54-54ed3c754870.jpg/250x188.webp",
      ],
    });
    // A private seller without a VAT label.
    expect(seen.get("14e8ba18-ea91-4395-bcb9-c50e2047a994")).toMatchObject({
      condition: "used",
      seller: "private",
      priceBasis: "unknown",
      odometerKm: 23000,
      vehicle: { make: "Aiways", model: "U5", trim: "U5 Premium", powerKw: 150 },
    });
    // New cars have no first registration; a hybrid without a plug-in marker has no fuel;
    // "1.030 kW (1.400 PS)" keeps its thousands.
    const newHybrid = seen.get("ebb7bf2f-4b57-4761-bcd9-a36ad0488cce");
    expect(newHybrid?.vehicle).toMatchObject({ model: "9X", powerKw: 1030, engineCc: 2000 });
    expect(newHybrid?.vehicle.firstRegistration).toBeUndefined();
    expect(newHybrid?.vehicle.fuel).toBeUndefined();
  });

  it("reads Jeep's e-Hybrid as a mild hybrid, the Volkswagen group's as a plug-in", async () => {
    const fuelOf = async (make: string, version: string) => {
      const run = await harvest(
        deFull,
        autoscout24Source(DE),
        "full",
        {},
        editPages(
          () => true,
          (page) => {
            for (const l of page.listings ?? []) {
              if (l.id !== "ebb7bf2f-4b57-4761-bcd9-a36ad0488cce") continue;
              l.vehicle.make = make;
              l.vehicle.modelVersionInput = version;
            }
          },
        ),
      );
      return listings(run).find((l) => l.ref === "ebb7bf2f-4b57-4761-bcd9-a36ad0488cce")?.vehicle
        .fuel;
    };
    expect(await fuelOf("Jeep", "Avenger 1.2 48V e-Hybrid Altitude")).toBeUndefined();
    expect(await fuelOf("Jeep", "Compass 1.3 4xe Plug-in Hybrid")).toBe("phev");
    expect(await fuelOf("Volkswagen", "Golf 1.5 eTSI eHybrid DSG")).toBe("phev");
  });

  it("maps AT listings onto ListingSeen", async () => {
    const run = await harvest(atFull, autoscout24Source(AT), "full");
    expect(run.error).toBeUndefined();
    expect(run.urls.every((url) => url.startsWith("https://www.autoscout24.at/lst?"))).toBe(true);
    expect(run.urls.every((url) => params(url).get("cy") === "A")).toBe(true);
    for (const listing of listings(run)) {
      expect(listing.market).toBe("AT");
      expect(listing.url).toMatch(/^https:\/\/www\.autoscout24\.at\/angebote\/.+/);
    }
    expect(listings(run).find((l) => l.ref === "a277dfcf-9ff8-4761-ae16-a5d974c3373b")).toEqual({
      kind: "ListingSeen",
      ref: "a277dfcf-9ff8-4761-ae16-a5d974c3373b",
      url: "https://www.autoscout24.at/angebote/zeekr-7x-long-range-20-zoll-ahk-advance-310-kw-421-ps-elektro-schwarz-cat_ma51964mo77829-a277dfcf-9ff8-4761-ae16-a5d974c3373b",
      market: "AT",
      condition: "demo",
      vehicle: {
        make: "Zeekr",
        model: "7X",
        trim: "Long Range 20 Zoll AHK Advance 310 kW (421 PS),...",
        sourceTaxonomy: { make: "51964", model: "77829" },
        firstRegistration: { year: 2026, month: 7 },
        fuel: "bev",
        powerKw: 310,
        transmission: "automatic",
      },
      odometerKm: 0,
      price: { amount: 60211, currency: "EUR" },
      priceBasis: "gross",
      seller: "dealer",
      location: { city: "Altach", postcode: "6844" },
      photos: [
        "https://prod.pictures.autoscout24.net/listing-images/a277dfcf-9ff8-4761-ae16-a5d974c3373b_b9fb9374-00f0-4e6d-b283-db8c7133d3e9.jpg/250x188.webp",
        "https://prod.pictures.autoscout24.net/listing-images/a277dfcf-9ff8-4761-ae16-a5d974c3373b_ab7e00cf-2862-43f7-beee-99a9a638c887.jpg/250x188.webp",
      ],
    });
  });

  it("takes Condition from the offer filter: new, demo (with Tageszulassung), used", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full");
    expect(new Set(run.urls.map((url) => params(url).get("offer")))).toEqual(
      new Set(["N", "D,S", "U,J,O"]),
    );
    const count = (condition: string) =>
      new Set(
        listings(run)
          .filter((l) => l.condition === condition)
          .map((l) => l.ref),
      ).size;
    expect({ new: count("new"), demo: count("demo"), used: count("used") }).toEqual({
      new: COUNTS.new,
      demo: COUNTS.demo,
      used: COUNTS.used,
    });
  });

  it("reads the price basis from the VAT label: gross, net, or unknown without one", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full");
    const bases = new Set(listings(run).map((l) => `${l.seller}:${l.priceBasis}`));
    expect(bases).toContain("dealer:gross");
    expect(bases).toContain("private:unknown");
    expect([...bases].every((basis) => /:(gross|unknown)$/.test(basis))).toBe(true);
    // Only "inkl. MwSt." was seen live; a net label maps to net.
    const net = await harvest(
      deFull,
      autoscout24Source(DE),
      "full",
      {},
      editPages(
        () => true,
        (props) => {
          for (const l of props.listings) if (l.price.vatLabel) l.price.vatLabel = "zzgl. MwSt.";
        },
      ),
    );
    const netBases = new Set(listings(net).map((l) => l.priceBasis));
    expect(netBases).toEqual(new Set(["net", "unknown"]));
  });

  it("splits a slice over the cap into price bands under it, dearest first, each one done", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full");
    const done = slices(run);
    // Zeekr's 5 used cars exceed the 4-result cap, so that make slice is split, never done.
    expect(done).not.toContain("used;make=51964");
    expect(done).toEqual([
      "new;make=51872",
      "new;make=51964",
      "demo;make=51872",
      "demo;make=51964",
      "used;make=51872",
      "used;make=51964;price=1000000-",
      "used;make=51964;price=500000-999999",
      "used;make=51964;price=250000-499999",
      "used;make=51964;price=125000-249999",
      "used;make=51964;price=0-124999",
    ]);
    // No query is paged past the cap: 2 per page, so page 2 is the last one asked for.
    expect(Math.max(...run.urls.map((url) => Number(params(url).get("page"))))).toBe(2);
    const used = listings(run).filter((l) => l.condition === "used" && l.vehicle.make === "Zeekr");
    expect(new Set(used.map((l) => l.ref)).size).toBe(COUNTS.usedZeekr);
  });

  it("splits a query served its full page allowance even under the result cap", async () => {
    // Sponsored slots fill pages too, so 80 pages of 50 reach fewer than 4,000 results.
    const run = await harvest(
      deFull,
      autoscout24Source(DE),
      "full",
      {},
      editPages(slice("N", 51964, 1), (props) => {
        props.numberOfPages = 2_000; // 4,000 results' worth at 2 per page
      }),
    );
    // The cassette has no price bands for this slice, so the split ends in a replay miss.
    expect(run.error).toMatchObject({ name: "ReplayMissError" });
    const last = params(run.urls.at(-1) as string);
    expect([last.get("offer"), last.get("pricefrom"), last.get("priceto")]).toEqual([
      "N",
      "1000000",
      null,
    ]);
  });

  it("without makes, splits each Condition by price band, dearest first", async () => {
    const all = await harvest(
      deFull,
      autoscout24Source({ ...DE, makes: undefined }),
      "full",
      {},
      bandsFromMakes(),
    );
    const scoped = await harvest(deFull, autoscout24Source(DE), "full");
    expect(all.error).toBeUndefined();
    expect(refs(all)).toEqual(refs(scoped));
    // The 4 new and 4 demo cars fit one band; the 9 used cars are halved down to bands of 4.
    expect(slices(all)).toEqual([
      "new;price=1000000-",
      "new;price=0-999999",
      "demo;price=1000000-",
      "demo;price=0-999999",
      "used;price=1000000-",
      "used;price=500000-999999",
      "used;price=250000-499999",
      "used;price=125000-249999",
      "used;price=62500-124999",
      "used;price=31250-62499",
      "used;price=0-31249",
    ]);
    // No make query: price bands reach every listing the Condition counts.
    expect(all.urls.some((url) => params(url).has("mmmv"))).toBe(false);
  });

  it("replays price bands as the live site filters them: whole euros, both bounds inclusive", async () => {
    const pages = (await loadCassette(priceFilter)).interactions.map(({ request, response }) => ({
      host: new URL(request.url).host,
      query: params(request.url),
      props: pagePropsOf(response.body),
    }));
    // Aiways' 4 used cars in DE, then bands with a bound at a listing's price or next to it.
    const aiways = pages.filter((page) => page.query.get("mmmv") === "51872|||");
    const all = aiways.find((page) => !page.query.has("pricefrom"));
    const prices: number[] = all?.props.listings.map(priceOf).sort();
    expect(prices).toEqual([12000, 12500, 14000, 19990]);
    const bands = aiways.filter((page) => page.query.has("pricefrom"));
    expect(bands).toHaveLength(6);
    for (const { query, props } of bands) {
      const from = Number(query.get("pricefrom"));
      const to = Number(query.get("priceto"));
      // A fractional bound matches nothing, not even the 19,990 car inside it.
      const expected = Number.isInteger(from) && Number.isInteger(to);
      const held = expected ? prices.filter((price) => takes(price, from, to)).length : 0;
      expect([query.toString(), props.numberOfResults]).toEqual([query.toString(), held]);
    }
    // Each Condition counted as many listings as its two top bands: no unpriced one counted.
    const roots = pages.filter((page) => !page.query.has("mmmv") && !page.query.has("pricefrom"));
    expect(roots).toHaveLength(4);
    for (const root of roots) {
      const band = (from: string, to: string | null) =>
        pages.find(
          (page) =>
            page.host === root.host &&
            page.query.get("offer") === root.query.get("offer") &&
            page.query.get("pricefrom") === from &&
            page.query.get("priceto") === to,
        )?.props.numberOfResults;
      expect(band("0", "999999") + band("1000000", null)).toBe(root.props.numberOfResults);
      // And none is free.
      if (root.host.endsWith(".de")) expect(band("0", "0")).toBe(0);
    }
  });

  it("without makes, a listing at a band's bound is harvested once, from the band that takes it", async () => {
    let low = "";
    let high = "";
    const atBounds = (offer: string, listings: RawListing[]) => {
      if (offer !== "U,J,O") return listings;
      const aiways = listings.find((l) => makeOf(l) === 51872);
      const zeekr = listings.find((l) => priceOf(l) > 31_250 && priceOf(l) <= 62_499);
      aiways.price.priceRaw = 31_249;
      zeekr.price.priceRaw = 31_250;
      low = aiways.id;
      high = zeekr.id;
      return listings;
    };
    const source = autoscout24Source({ ...DE, makes: undefined });
    const run = await harvest(deFull, source, "full", {}, bandsFromMakes(atBounds));
    // Its counts add up, so the census completes.
    expect(run.error).toBeUndefined();
    const at = (ref: string) =>
      run.observations.flatMap((o, i) => (o.kind === "ListingSeen" && o.ref === ref ? [i] : []));
    const done = (key: string) =>
      run.observations.findIndex((o) => o.kind === "SliceDone" && o.slice === key);
    expect([at(low).length, at(high).length]).toEqual([1, 1]);
    const [lowAt = -1, highAt = -1] = [at(low)[0], at(high)[0]];
    expect(highAt).toBeGreaterThan(done("used;price=62500-124999"));
    expect(highAt).toBeLessThan(done("used;price=31250-62499"));
    expect(lowAt).toBeGreaterThan(done("used;price=31250-62499"));
    expect(lowAt).toBeLessThan(done("used;price=0-31249"));
  });

  it("without makes, a listing priced between two bands' whole euros fails the census", async () => {
    // None was seen live, and the filter takes no fractional bound. Should one turn up, the
    // bands either side miss it, and the recount of the band they split finds it short.
    let fractionalRef = "";
    const fractional = (offer: string, listings: RawListing[]) => {
      if (offer !== "U,J,O") return listings;
      const aiways = listings.find((l) => makeOf(l) === 51872);
      aiways.price.priceRaw = 31_249.5;
      fractionalRef = aiways.id;
      return listings;
    };
    const source = autoscout24Source({ ...DE, makes: undefined });
    const run = await harvest(deFull, source, "full", {}, bandsFromMakes(fractional));
    const short =
      /not harvested whole: used;price=0-62499 \(1 listing outside every whole-euro price band, possibly fractional, or counts that moved\)$/;
    expect(String(run.error)).toMatch(short);
    expect(refs(run)).not.toContain(fractionalRef);
    expect(slices(run)).toEqual(
      expect.arrayContaining(["used;price=31250-62499", "used;price=0-31249"]),
    );
    // Resuming skips the finished bands, recounts the split ones and fails again.
    const done = slices(run);
    const resumed = await harvest(
      deFull,
      source,
      "full",
      { sliceDoneAt: (key) => (done.includes(key) ? now : null) },
      bandsFromMakes(fractional),
    );
    expect(String(resumed.error)).toMatch(short);
    expect(slices(resumed)).toEqual([]);
  });

  it("without makes, harvests a listing that no make filter returns", async () => {
    // The make filters miss a few listings the Condition counts; the price bands do not.
    let stray = "";
    const run = await harvest(
      deFull,
      autoscout24Source({ ...DE, makes: undefined }),
      "full",
      {},
      (cassette) => {
        bandsFromMakes((offer, listings) => {
          if (offer !== "U,J,O") return listings;
          const listing = structuredClone(listings[0]);
          listing.id = stray = "00000000-0000-4000-8000-000000000001";
          listing.tracking.modelTaxonomy = "[make_id:99999, model_group_id:1]";
          listing.price.priceRaw = 60_000; // joins the 3 used cars of 31,250-62,499
          return [listing, ...listings];
        })(cassette);
        countsInTurn(usedEverywhere, [COUNTS.used + 1])(cassette);
      },
    );
    expect(run.error).toBeUndefined();
    expect(refs(run).has(stray)).toBe(true);
    expect(slices(run)).toContain("used;price=0-31249");
  });

  it("splits a band still over the cap at one price by first-registration year", async () => {
    // Aiways' 4 used cars and one Zeekr at one price: 5 over the cap of 4, so by year.
    const samePrice = (offer: string, listings: RawListing[]) => {
      if (offer !== "U,J,O") return listings;
      const zeekr = listings.find((l) => makeOf(l) === 51964);
      for (const l of listings) if (makeOf(l) === 51872 || l === zeekr) l.price.priceRaw = 12000;
      // Registered after the current year (a typo on the site): the open current year has it.
      zeekr.tracking.firstRegistration = "01-2027";
      return listings;
    };
    const source = autoscout24Source({ ...DE, makes: undefined });
    const run = await harvest(deFull, source, "full", {}, bandsFromMakes(samePrice));
    expect(run.error).toBeUndefined();
    const years = slices(run).filter((key) => key.startsWith("used;price=12000-12000;"));
    expect(years).toHaveLength(27);
    expect(years.slice(0, 2)).toEqual([
      "used;price=12000-12000;year=2026",
      "used;price=12000-12000;year=2025",
    ]);
    expect(slices(run)).not.toContain("used;price=12000-12000");
    expect(refs(run).size).toBe(COUNTS.new + COUNTS.demo + COUNTS.used);
    // The current year is open above; earlier years are one year each.
    const asked = run.urls.map(params).filter((query) => query.get("pricefrom") === "12000");
    const bounds = (year: string) =>
      asked.find((query) => query.get("fregfrom") === year)?.get("fregto") ?? null;
    expect([bounds("2026"), bounds("2025")]).toEqual([null, "2025"]);
    // A listing that no year band returns at that price is one the census cannot see: it fails.
    const stray = (offer: string, listings: RawListing[]) => {
      const same = samePrice(offer, listings);
      if (offer !== "U,J,O") return same;
      const listing = structuredClone(same.find((l) => priceOf(l) === 12000));
      listing.id = "00000000-0000-4000-8000-000000000002";
      listing.tracking.firstRegistration = "new";
      return [listing, ...same];
    };
    const failed = await harvest(deFull, source, "full", {}, (cassette) => {
      bandsFromMakes(stray)(cassette);
      countsInTurn(usedEverywhere, [COUNTS.used + 1])(cassette);
    });
    expect(String(failed.error)).toMatch(
      /not harvested whole: used;price=12000-12000 \(1 listing outside every registration year, or counts that moved\)$/,
    );
    expect(slices(failed)).toContain("used;price=12000-12000;year=2026");
  });

  it("without makes, a failed census resumes, skipping the price bands it finished", async () => {
    const source = autoscout24Source({ ...DE, makes: undefined });
    const complete = await harvest(deFull, source, "full", {}, bandsFromMakes());
    const lowest = (query: URLSearchParams) =>
      query.get("offer") === "U,J,O" && query.get("priceto") === "31249";
    const failing = await harvest(deFull, source, "full", {}, (cassette) => {
      bandsFromMakes()(cassette);
      for (const { request, response } of cassette.interactions) {
        if (lowest(new URL(request.url).searchParams)) {
          response.body = "<html><body>Wartungsarbeiten</body></html>";
        }
      }
    });
    expect(String(failing.error)).toMatch(/page changed/);
    const finished = slices(failing);
    expect(finished).toContain("used;price=31250-62499");
    expect(finished).not.toContain("used;price=0-31249");
    const resumed = await harvest(
      deFull,
      source,
      "full",
      { sliceDoneAt: (key) => (finished.includes(key) ? new Date("2026-10-24T00:00:00Z") : null) },
      bandsFromMakes(),
    );
    expect(resumed.error).toBeUndefined();
    expect(slices(resumed)).toEqual(["used;price=0-31249"]);
    // Finished bands are only counted again (for the split slices above them), not paged.
    expect(listings(resumed).every((l) => l.price.amount <= 31_249)).toBe(true);
    expect([...finished, ...slices(resumed)]).toEqual(slices(complete));
    expect(new Set([...refs(failing), ...refs(resumed)])).toEqual(refs(complete));
  });

  it("a full run fails when a split slice's parts miss even one of its results", async () => {
    // A listing without a price: the Condition counts it, no price band takes it. (In the
    // recorded counts no such listing showed up; see the price-filter test.)
    const counted = countsInTurn(usedEverywhere, [COUNTS.used + 1]);
    const gap = (cassette: Cassette) => {
      bandsFromMakes(noPrice)(cassette);
      counted(cassette);
    };
    const source = autoscout24Source({ ...DE, makes: undefined });
    const run = await harvest(deFull, source, "full", {}, gap);
    expect(String(run.error)).toMatch(unpriced);
    expect(refs(run)).not.toContain(UNPRICED);
    // Probed, then counted before and after its parts three times before giving up.
    expect(run.urls.filter((url) => usedEverywhere(params(url)))).toHaveLength(7);
    // The parts themselves are fine, so they stay done; resuming re-counts them and fails again.
    expect(slices(run)).toContain("used;price=0-31249");
    const done = slices(run);
    const resumed = await harvest(
      deFull,
      source,
      "full",
      { sliceDoneAt: (key) => (done.includes(key) ? now : null) },
      gap,
    );
    expect(String(resumed.error)).toMatch(unpriced);
    expect(slices(resumed)).toEqual([]);
  });

  it("a car moving between price bands while they are counted cannot stand in for an unpriced one", async () => {
    // The reviewer's churn on disjoint bands: a car the top band [1,000,000, ∞) holds drops
    // to 999,999, into [0, 999,999], while the Condition's bands are counted, and in the next
    // recounts flickers back and forth. Were the bands counted once each, dearer first, it
    // would count in both and stand in for the unpriced listing; counted there and back, it
    // counts in one at most, so every recount comes out short.
    let held = { top: 0, rest: 0 };
    const atTop = (offer: string, listings: RawListing[]) => {
      const pool = noPrice(offer, listings);
      if (offer !== "U,J,O") return pool;
      (pool[1] as RawListing).price.priceRaw = 1_000_000;
      held = {
        top: pool.filter((l) => takes(priceOf(l), 1_000_000, undefined)).length,
        rest: pool.filter((l) => takes(priceOf(l), 0, 999_999)).length,
      };
      return pool;
    };
    const band = (from: string, to: string | null) => (query: URLSearchParams) =>
      !query.has("mmmv") &&
      query.get("offer") === "U,J,O" &&
      query.get("pricefrom") === from &&
      query.get("priceto") === to &&
      query.get("page") === "1";
    const churn =
      (top: (n: number) => number[], rest: (n: number) => number[]) => (cassette: Cassette) => {
        bandsFromMakes(atTop)(cassette);
        countsInTurn(usedEverywhere, [COUNTS.used + 1])(cassette);
        countsInTurn(band("1000000", null), top(held.top))(cassette);
        countsInTurn(band("0", "999999"), rest(held.rest))(cassette);
      };
    const source = autoscout24Source({ ...DE, makes: undefined });
    // Counts of the top band: its probe, then per recount there (before the rest) and back.
    // The rest is probed and recounts itself (three counts) before the Condition's recounts.
    const dropsOnce = churn(
      (n) => [n, n, n - 1],
      (n) => [n, n, n, n + 1],
    );
    const flickers = churn(
      // Drops after the top band's first count, rises back before its second, drops again.
      (n) => [n, n, n - 1, n - 1, n, n, n - 1],
      (n) => [n, n, n, n + 1],
    );
    for (const edit of [dropsOnce, flickers]) {
      const run = await harvest(deFull, source, "full", {}, edit);
      expect(String(run.error)).toMatch(unpriced);
      expect(refs(run)).not.toContain(UNPRICED);
      expect(slices(run)).not.toContain("used");
    }
  });

  it("a split slice is recounted after its parts until its count holds still", async () => {
    // A listing that goes between the counts before and after the parts could stand in for
    // one they miss, so a recount it moves fails; the next one, after it went, holds.
    const more = COUNTS.used + 1;
    const bands = bandsFromMakes();
    const counted = (counts: number[]) => (cassette: Cassette) => {
      bands(cassette);
      countsInTurn(usedEverywhere, counts)(cassette);
    };
    const settles = counted([more, more, COUNTS.used]);
    const source = autoscout24Source({ ...DE, makes: undefined });
    const run = await harvest(deFull, source, "full", {}, settles);
    expect(run.error).toBeUndefined();
    expect(run.urls.filter((url) => usedEverywhere(params(url)))).toHaveLength(5);
    // When it keeps moving, every recount fails and so does the run.
    const used = COUNTS.used;
    const moving = counted([more, more, used, more, used, more, used]);
    const failed = await harvest(deFull, source, "full", {}, moving);
    expect(String(failed.error)).toMatch(/not harvested whole: used \(1 listing outside/);
  });

  it("a slice over the cap that cannot be split further fails the full run", async () => {
    // The open top band over the cap is split by year; one year still over it is left.
    const run = await harvest(deFull, autoscout24Source(DE), "full", {}, (cassette) => {
      const top = (query: URLSearchParams) => query.get("pricefrom") === "1000000";
      editPages(top, (props) => {
        props.numberOfResults = 10;
      })(cassette);
      const recorded = cassette.interactions.find((i) => top(new URL(i.request.url).searchParams));
      if (!recorded) throw new Error("fixture lacks the page");
      for (let year = 2000; year <= now.getUTCFullYear(); year++) {
        const turn = structuredClone(recorded);
        const url = new URL(turn.request.url);
        url.searchParams.set("fregfrom", String(year));
        if (year < now.getUTCFullYear()) url.searchParams.set("fregto", String(year));
        turn.request.url = url.href;
        editPages(
          () => true,
          (props) => {
            props.numberOfResults = year === 2024 ? 10 : 0;
          },
        )({ version: 1, interactions: [turn] });
        cassette.interactions.push(turn);
      }
    });
    expect(String(run.error)).toMatch(
      /not harvested whole: used;make=51964;price=1000000-;year=2024$/,
    );
    expect(slices(run)).not.toContain("used;make=51964;price=1000000-;year=2024");
    expect(slices(run)).toContain("used;make=51964;price=1000000-;year=2025");
    expect(slices(run)).toContain("used;make=51964;price=500000-999999");
  });

  it("a failed census resumes, skipping the slices it finished", async () => {
    const complete = await harvest(deFull, autoscout24Source(DE), "full");
    const failing = await harvest(deFull, autoscout24Source(DE), "full", {}, (cassette) => {
      for (const { request, response } of cassette.interactions) {
        if (slice("U,J,O", 51872)(new URL(request.url).searchParams)) {
          response.body = "<html><body>Wartungsarbeiten</body></html>";
        }
      }
    });
    expect(String(failing.error)).toMatch(/page changed/);
    const finished = slices(failing);
    expect(finished).toEqual([
      "new;make=51872",
      "new;make=51964",
      "demo;make=51872",
      "demo;make=51964",
    ]);
    const resumed = await harvest(deFull, autoscout24Source(DE), "full", {
      sliceDoneAt: (key) => (finished.includes(key) ? new Date("2026-10-24T00:00:00Z") : null),
    });
    expect(resumed.error).toBeUndefined();
    expect(resumed.urls.every((url) => params(url).get("offer") === "U,J,O")).toBe(true);
    expect([...finished, ...slices(resumed)]).toEqual(slices(complete));
    expect(new Set([...refs(failing), ...refs(resumed)])).toEqual(refs(complete));
  });

  it("a slice that comes out short is paged again, then left not done and the run fails", async () => {
    const run = await harvest(
      deFull,
      autoscout24Source(DE),
      "full",
      {},
      editPages(slice("N", 51964, 2), (props) => {
        props.listings = [];
      }),
    );
    expect(String(run.error)).toMatch(/not harvested whole: new;make=51964$/);
    expect(slices(run)).not.toContain("new;make=51964");
    expect(slices(run)).toContain("used;make=51872");
    const pages = run.urls.filter((url) => slice("N", 51964)(params(url)));
    expect(pages.map((url) => params(url).get("page"))).toEqual(["1", "2", "1", "2"]);
  });

  it("a slice that comes out short once is harvested again and then done", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full", {}, (cassette) => {
      const index = cassette.interactions.findIndex((i) =>
        slice("N", 51964, 2)(new URL(i.request.url).searchParams),
      );
      const empty = structuredClone(cassette.interactions[index]);
      if (!empty) throw new Error("fixture lacks the page");
      editPages(
        () => true,
        (props) => {
          props.listings = [];
        },
      )({ version: 1, interactions: [empty] });
      cassette.interactions.splice(index, 0, empty);
    });
    expect(run.error).toBeUndefined();
    expect(slices(run)).toContain("new;make=51964");
    const pages = run.urls.filter((url) => slice("N", 51964)(params(url)));
    expect(pages.map((url) => params(url).get("page"))).toEqual(["1", "2", "1", "2"]);
  });

  it("incremental: listings online since the last run, newest first, no SliceDone", async () => {
    const run = await harvest(deIncremental, autoscout24Source(DE_INCREMENTAL), "incremental", {
      lastRunAt: tenDaysAgo,
    });
    expect(run.error).toBeUndefined();
    expect(slices(run)).toEqual([]);
    // Sponsored listings take page slots, so the 31 new cars span more than 16 pages of 2.
    const newCars = listings(run).filter((l) => l.condition === "new");
    expect(new Set(newCars.map((l) => l.ref)).size).toBe(31);
    const newPages = run.urls.filter((url) => params(url).get("offer") === "N");
    expect(newPages.length).toBeGreaterThan(16);
    for (const url of run.urls) {
      expect(params(url).get("adage")).toBe("14");
      expect(params(url).get("sort")).toBe("age");
      expect(params(url).get("desc")).toBe("1");
    }
  });

  it("incremental: a query stops at a page of known listings", async () => {
    const first = await harvest(deIncremental, autoscout24Source(DE_INCREMENTAL), "incremental", {
      lastRunAt: tenDaysAgo,
    });
    const known = new Set(NEW_PAGE_2);
    const stopped = await harvest(deIncremental, autoscout24Source(DE_INCREMENTAL), "incremental", {
      lastRunAt: tenDaysAgo,
      isKnown: (ref) => known.has(ref),
    });
    const newPages = (run: Run) =>
      run.urls
        .filter((url) => params(url).get("offer") === "N")
        .map((url) => params(url).get("page"));
    expect(newPages(first).length).toBeGreaterThan(2);
    expect(newPages(stopped)).toEqual(["1", "2"]);
    const others = (run: Run) => run.urls.filter((url) => params(url).get("offer") !== "N");
    expect(others(stopped)).toEqual(others(first));
  });

  it("incremental: listings recorded during the run do not count as known before it", async () => {
    const inner = autoscout24Source(DE_INCREMENTAL);
    const { source, isKnown } = liveCheckpoint(inner);
    const plain = await harvest(deIncremental, inner, "incremental", { lastRunAt: tenDaysAgo });
    const live = await harvest(deIncremental, source, "incremental", {
      lastRunAt: tenDaysAgo,
      isKnown,
    });
    expect(live.urls).toEqual(plain.urls);
  });

  it("incremental: a page of known listings stops the query though it repeats one from an earlier page", async () => {
    // A listing known before the run, on page 1 and again in page 2's first (sponsored) slot.
    const repeated = "155cb87c-80dd-42e5-af7a-fd1e2bda3ecc";
    // biome-ignore lint/suspicious/noExplicitAny: recorded site JSON.
    let listing: any;
    const sponsored = (cassette: Cassette) => {
      editPages(slice("N", 51940, 1), (props) => {
        // biome-ignore lint/suspicious/noExplicitAny: recorded site JSON.
        listing = props.listings.find((l: any) => l.id === repeated);
      })(cassette);
      if (!listing) throw new Error("fixture lacks the listing");
      editPages(slice("N", 51940, 2), (props) => {
        props.listings[0] = listing;
      })(cassette);
    };
    const { source, isKnown } = liveCheckpoint(autoscout24Source(DE_INCREMENTAL), [
      repeated,
      ...NEW_PAGE_2.slice(1),
    ]);
    const run = await harvest(
      deIncremental,
      source,
      "incremental",
      { lastRunAt: tenDaysAgo, isKnown },
      sponsored,
    );
    expect(run.error).toBeUndefined();
    const newPages = run.urls
      .filter((url) => params(url).get("offer") === "N")
      .map((url) => params(url).get("page"));
    expect(newPages).toEqual(["1", "2"]);
  });

  it("incremental after more than 14 days searches without a time window", async () => {
    const full = await harvest(deFull, autoscout24Source(DE), "full");
    const run = await harvest(deFull, autoscout24Source(DE), "incremental", {
      lastRunAt: new Date(now.getTime() - 30 * 86_400_000),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.some((url) => params(url).has("adage"))).toBe(false);
    expect(slices(run)).toEqual([]);
    expect(refs(run)).toEqual(refs(full));
  });

  it("the first incremental run looks one day back", async () => {
    const run = await harvest(deIncremental, autoscout24Source(DE_INCREMENTAL), "incremental");
    // The cassette holds the 14-day queries only, so the 1-day one misses.
    expect(run.error).toMatchObject({ name: "ReplayMissError" });
    expect(params(run.urls[0] as string).get("adage")).toBe("1");
  });

  it("a malformed listing comes out as one the Ledger rejects; the run goes on", async () => {
    const run = await harvest(
      deFull,
      autoscout24Source(DE),
      "full",
      {},
      editPages(slice("N", 51964, 1), (props) => {
        delete props.listings[0].id;
        props.listings[0].price.priceRaw = null;
      }),
    );
    expect(run.error).toBeUndefined();
    const broken = listings(run).filter((l) => l.ref === "");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.price.amount).toBeNaN();
    // Its slice still reports done; the Ledger rejects that SliceDone because of the listing.
    expect(slices(run)).toContain("new;make=51964");
    expect(listings(run)).toHaveLength(
      listings(await harvest(deFull, autoscout24Source(DE), "full")).length,
    );
  });

  it("a bot challenge fails the run with HttpBlockedError", async () => {
    const run = await harvest(deFull, autoscout24Source(DE), "full", {}, (cassette) => {
      const response = cassette.interactions[0]?.response;
      if (response) response.headers["cf-mitigated"] = "challenge";
    });
    expect(run.error).toBeInstanceOf(HttpBlockedError);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const run = await harvest(
      deFull,
      autoscout24Source(DE),
      "full",
      {},
      () => {},
      controller.signal,
    );
    expect(String(run.error)).toMatch(/stop/);
    expect(run.urls).toEqual([]);
  });
});
