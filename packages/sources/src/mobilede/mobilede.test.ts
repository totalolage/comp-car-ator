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
} from "../source.ts";
import { mobiledeSource } from "./mobilede.ts";

// The pages are real mobile.de search results captured 2026-10-26 (77 listings standing in
// Germany: new, used, demo, dealer and private), cut to the flight rows the adapter reads (the
// results, the make taxonomy, one card per listing; no seller contact details). Akamai started
// challenging the home IP before a live recording of the adapter finished, so the cassettes
// were recorded by mobiledeSource itself, through recordingHttp, against a model of the site
// serving those listings with the site's query rules (con, ms, inclusive `p` bounds to the cent,
// doc, 20 per page newest first, a promoted listing on page 1). ADR 0014 has the details.
const now = new Date("2026-10-26T10:00:00Z");
/** Audi (1900) with a 3-result cap: its used cars split into price bands. */
const full = new URL("./fixtures/full.cassette.json", import.meta.url);
const AUDI = 1900;
/** Every make, a first incremental run: 5 new cars and 25 used ones on two pages. */
const incremental = new URL("./fixtures/incremental.cassette.json", import.meta.url);
/** Every make, a 1-result cap: two used cars at 38,999 € split by make. */
const makeSplit = new URL("./fixtures/make-split.cassette.json", import.meta.url);
const SPLIT_PRICE = "38999:38999.99";

interface Run {
  observations: Observation[];
  urls: string[];
  warnings: string[];
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
  const run: Run = { observations: [], urls: [], warnings: [] };
  const http: Http = {
    get(request) {
      run.urls.push(typeof request === "string" ? request : request.url);
      return replay.get(request);
    },
  };
  const ctx: HarvestContext = {
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, ...checkpoint },
    now,
    log: { info() {}, warn: (message) => run.warnings.push(message) },
    signal,
  };
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

/** Edits `searchResults` in the flight data of every page whose URL passes `match`. */
function editResults(
  match: (query: URLSearchParams) => boolean,
  // biome-ignore lint/suspicious/noExplicitAny: recorded site JSON.
  change: (results: any) => void,
) {
  return (cassette: Cassette) => {
    for (const { request, response } of cassette.interactions) {
      if (!match(new URL(request.url).searchParams)) continue;
      const [, head, chunk, tail] =
        /^([\s\S]*?self\.__next_f\.push\()(\[[\s\S]*?\])(\)<\/script>[\s\S]*)$/.exec(
          response.body,
        ) ?? [];
      const [tag, flight] = JSON.parse(chunk as string) as [number, string];
      const rows = flight.split("\n").map((row) => {
        const [, id, json] = /^([\da-f]+):(.*)$/.exec(row) ?? [];
        if (!json?.includes('"searchResults"')) return row;
        const data = JSON.parse(json);
        change(data[3].searchResults);
        return `${id}:${JSON.stringify(data)}`;
      });
      response.body = `${head}${JSON.stringify([tag, rows.join("\n")])}${tail}`;
    }
  };
}

/** Replaces the body of every page whose URL passes `match`. */
function replaceBody(match: (query: URLSearchParams) => boolean, status: number, body: string) {
  return (cassette: Cassette) => {
    for (const { request, response } of cassette.interactions) {
      if (!match(new URL(request.url).searchParams)) continue;
      response.status = status;
      response.body = body;
    }
  };
}

/** Rewrites every recorded request URL's `doc` filter (undefined removes it). */
function recordedDoc(doc: string | undefined) {
  return (cassette: Cassette) => {
    for (const { request } of cassette.interactions) {
      const url = new URL(request.url);
      if (doc === undefined) url.searchParams.delete("doc");
      else url.searchParams.set("doc", doc);
      request.url = url.href;
    }
  };
}

const usedBand = (from: number) => (query: URLSearchParams) =>
  query.get("con") === "USED" && query.get("p")?.startsWith(`${from}:`) === true;

describe("mobile-de source", () => {
  it("is one Source, scoped by the makes it covers", () => {
    expect(mobiledeSource()).toMatchObject({ id: "mobile-de", scope: undefined });
    expect(mobiledeSource({ makes: [3500, 1900, 3500] }).scope).toBe("makes:1900,3500");
    expect(() => mobiledeSource({ resultCap: 2001 })).toThrow(RangeError);
    expect(() => mobiledeSource({ makes: [Number.NaN] })).toThrow(RangeError);
  });

  it("asks for cars standing in Germany, 2000+, undamaged, newest first, at T2", async () => {
    const requests: unknown[] = [];
    const replay = createReplayHttp(await loadCassette(full));
    const source = mobiledeSource({ makes: [AUDI], resultCap: 3 });
    const ctx: HarvestContext = {
      http: {
        get(request) {
          requests.push(request);
          return replay.get(request);
        },
      },
      mode: "full",
      checkpoint: emptyCheckpoint,
      now,
      log: { info() {}, warn() {} },
      signal: new AbortController().signal,
    };
    for await (const _ of source.harvest(ctx)) {
      // Only the requests matter here.
    }
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests as { url: string }[]) {
      expect(request).toMatchObject({ locale: "de", minTier: "T2" });
      const query = params(request.url);
      expect(query.get("cn")).toBe("DE");
      expect(query.get("fr")).toBe("2000:");
      expect(query.get("dam")).toBe("false");
      expect([query.get("sb"), query.get("od")]).toEqual(["doc", "down"]);
      expect(query.get("ms")).toBe(String(AUDI));
      expect(["NEW", "USED"]).toContain(query.get("con"));
    }
  });

  it("maps listings: condition, VAT, seller, vehicle facts and the card's photos", async () => {
    const run = await harvest(full, mobiledeSource({ makes: [AUDI], resultCap: 3 }), "full");
    expect(run.error).toBeUndefined();
    const byRef = new Map(listings(run).map((l) => [l.ref, l]));
    expect(byRef.get("52794216877376")).toEqual({
      kind: "ListingSeen",
      ref: "52794216877376",
      url: "https://suchen.mobile.de/fahrzeuge/details.html?id=52794216877376",
      market: "DE",
      condition: "used",
      vehicle: {
        make: "Audi",
        model: "Q5",
        trim: "Sportback quattro S Line Ext.+Int.°Tech Plus°",
        sourceTaxonomy: { make: "1900" },
        firstRegistration: { year: 2025, month: 10 },
        fuel: "diesel",
        powerKw: 150,
        transmission: "automatic",
        engineCc: 1968,
        seats: 5,
        euroClass: 6,
        consumptionL100km: 6.4,
        co2GKm: 167,
        color: "Schwarz",
      },
      odometerKm: 40,
      price: { amount: 59980, currency: "EUR" },
      priceBasis: "gross",
      seller: "dealer",
      location: { city: "Nordhausen", postcode: "99734" },
      photos: [
        "https://img.classistatic.de/api/v1/mo-prod/images/a0/a0f18c13-56b9-423f-b15d-d939bccf6016?rule=mo-1024",
      ],
      inspectionValidUntil: { year: 2028, month: 10 },
    });
    // A private seller (FSBO) shows no VAT, so the basis is unknown.
    expect(byRef.get("52795104061312")).toMatchObject({
      condition: "used",
      price: { amount: 3950, currency: "EUR" },
      priceBasis: "unknown",
      seller: "private",
      odometerKm: 246500,
      vehicle: { make: "Audi", model: "A4", transmission: "manual", euroClass: 5 },
    });
    // NEW slice listings are new whatever else they say; a Vorführfahrzeug is a demo car.
    expect(byRef.get("454384877")).toMatchObject({ condition: "new", odometerKm: 0 });
    expect(byRef.get("43642103324960")).toMatchObject({ condition: "demo" });
  });

  it("full: splits a make into price bands that partition it, each reported done", async () => {
    const run = await harvest(full, mobiledeSource({ makes: [AUDI], resultCap: 3 }), "full");
    expect(run.error).toBeUndefined();
    expect(refs(run).size).toBe(8);
    const done = slices(run);
    expect(done).toContain("new;make=1900");
    const bands = done
      .filter((s) => s.startsWith("used;"))
      .map((s) =>
        /price=(\d+)-(\d*)$/
          .exec(s)
          ?.slice(1)
          .map((n) => (n ? Number(n) : null)),
      );
    // Contiguous whole-euro bands from 0 up to the open top band.
    expect(bands[0]?.[0]).toBe(0);
    expect(bands.at(-1)).toEqual([1_000_000, null]);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]?.[0]).toBe((bands[i - 1]?.[1] as number) + 1);
    }
    // Each band reaches its upper bound's last cent.
    for (const url of run.urls) {
      const p = params(url).get("p");
      if (p) expect(p).toMatch(/^\d+:(\d+\.99)?$/);
    }
  });

  it("full: skips slices done earlier in the census", async () => {
    const done = new Set(["new;make=1900", "used;make=1900;price=0-7812"]);
    const run = await harvest(full, mobiledeSource({ makes: [AUDI], resultCap: 3 }), "full", {
      sliceDoneAt: (slice) => (done.has(slice) ? now : null),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.some((u) => params(u).get("con") === "NEW")).toBe(false);
    expect(run.urls.some((u) => params(u).get("p") === "0:7812.99")).toBe(false);
    expect(slices(run)).not.toContain("new;make=1900");
    expect(slices(run)).toContain("used;make=1900;price=7813-15624");
  });

  it("full: pages a short slice again, then fails the run after the others", async () => {
    // The band claims one result more than it serves.
    const run = await harvest(
      full,
      mobiledeSource({ makes: [AUDI], resultCap: 3 }),
      "full",
      {},
      editResults(usedBand(7813), (results) => {
        results.numResultsTotal += 1;
      }),
    );
    expect(String(run.error)).toMatch(/not harvested whole: used;make=1900;price=7813-15624/);
    expect(run.urls.filter((u) => params(u).get("p") === "7813:15624.99")).toHaveLength(2);
    expect(slices(run)).not.toContain("used;make=1900;price=7813-15624");
    expect(slices(run)).toContain("used;make=1900;price=15625-31249");
    expect(run.warnings.some((w) => /short/.test(w))).toBe(true);
  });

  it("full: splits a single price over the cap by make and recounts the parts", async () => {
    const run = await harvest(makeSplit, mobiledeSource({ resultCap: 1 }), "full");
    expect(run.error).toBeUndefined();
    expect(refs(run)).toEqual(new Set(["454384877", "44481897375264", "43061006993376"]));
    expect(slices(run)).toEqual(
      expect.arrayContaining([
        "new",
        "used;make=1400;price=38999-38999",
        "used;make=17200;price=38999-38999",
        "used;make=20100;price=38999-38999",
      ]),
    );
    // The split slice itself is never done: a resumed census probes it again.
    expect(slices(run)).not.toContain("used;price=38999-38999");
    // Probe, then before and after the parts' recount.
    const whole = run.urls.filter(
      (u) => params(u).get("p") === SPLIT_PRICE && !params(u).has("ms"),
    );
    expect(whole).toHaveLength(3);
  });

  it("full: fails when the make parts of a price miss results", async () => {
    // A listing at that price under a make outside the taxonomy: the slice counts 3, its parts 2.
    const run = await harvest(
      makeSplit,
      mobiledeSource({ resultCap: 1 }),
      "full",
      {},
      editResults(
        (q) => q.get("p") === SPLIT_PRICE && !q.has("ms"),
        (results) => {
          results.numResultsTotal = 3;
        },
      ),
    );
    expect(String(run.error)).toMatch(/not harvested whole: used;price=38999-38999/);
    expect(slices(run)).toContain("used;make=17200;price=38999-38999");
    expect(run.warnings.filter((w) => /miss results/.test(w))).toHaveLength(3);
  });

  it("incremental: a first run looks back one day, newest first, and skips promotions", async () => {
    const run = await harvest(
      incremental,
      mobiledeSource(),
      "incremental",
      {},
      editResults(
        (q) => q.get("con") === "USED" && !q.has("pageNumber"),
        (results) => {
          results.listings.unshift({ ...results.listings[0], id: 1, type: "topInCategory" });
        },
      ),
    );
    expect(run.error).toBeUndefined();
    expect(run.urls.every((u) => params(u).get("doc") === "1")).toBe(true);
    expect(listings(run)).toHaveLength(30);
    expect(refs(run).has("1")).toBe(false);
    expect(slices(run)).toEqual([]);
    expect(listings(run).find((l) => l.ref === "52794083031360")).toMatchObject({
      condition: "demo",
      listedAt: "2026-10-26",
    });
  });

  it("incremental: stops a slice at a page of listings known before the run", async () => {
    const first = await harvest(incremental, mobiledeSource(), "incremental");
    const usedPage1 = listings(first)
      .filter((l) => l.condition !== "new")
      .slice(0, 20)
      .map((l) => l.ref);
    const known = new Set(usedPage1);
    const run = await harvest(incremental, mobiledeSource(), "incremental", {
      isKnown: (ref) => known.has(ref),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.some((u) => params(u).get("pageNumber") === "2")).toBe(false);
    expect(listings(run)).toHaveLength(25);
  });

  it("incremental: widens the window to the gap since the last run, or drops it", async () => {
    const fiveDays = new Date(now.getTime() - 5 * 86_400_000);
    const week = await harvest(
      incremental,
      mobiledeSource(),
      "incremental",
      { lastRunAt: fiveDays },
      recordedDoc("7"),
    );
    expect(week.error).toBeUndefined();
    expect(week.urls.every((u) => params(u).get("doc") === "7")).toBe(true);

    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
    const stale = await harvest(
      incremental,
      mobiledeSource(),
      "incremental",
      { lastRunAt: monthAgo },
      recordedDoc(undefined),
    );
    expect(stale.error).toBeUndefined();
    expect(stale.urls.some((u) => params(u).has("doc"))).toBe(false);
    expect(stale.warnings.some((w) => /over 14 days/.test(w))).toBe(true);
  });

  it("fails on Akamai's denial page without inventing listings", async () => {
    const denial =
      "<html><head><title>Zugriff verweigert / Access denied</title></head><body><p>Error Reference: 0.cb3e1202.1793003239.1c6f1a80</p></body></html>";
    const run = await harvest(
      incremental,
      mobiledeSource(),
      "incremental",
      {},
      replaceBody(() => true, 200, denial),
    );
    expect(run.error).toBeInstanceOf(HttpBlockedError);
    expect(run.observations).toEqual([]);
  });

  it("fails on a page without search results (the site changed)", async () => {
    const run = await harvest(
      incremental,
      mobiledeSource(),
      "incremental",
      {},
      replaceBody((q) => q.get("con") === "NEW", 200, "<html><body>Wartung</body></html>"),
    );
    expect(String(run.error)).toMatch(/page changed: no searchResults/);
    expect(run.observations).toEqual([]);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    const run = await harvest(
      full,
      mobiledeSource({ makes: [AUDI], resultCap: 3 }),
      "full",
      {},
      () => {},
      controller.signal,
    );
    expect(String(run.error)).toMatch(/deadline/);
    expect(run.urls).toEqual([]);
  });
});
