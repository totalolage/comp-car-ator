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

interface Fixture {
  cassette: URL;
  /** The `now` the cassette was recorded with. */
  now: Date;
}
const fixture = (name: string, now: string): Fixture => ({
  cassette: new URL(`./fixtures/${name}.cassette.json`, import.meta.url),
  now: new Date(now),
});

// Live cassettes, recorded 2026-10-26 by mobiledeSource itself through the live Http (T2, Chrome
// attached over CDP) in three sessions of 16, 3 and 3 documents, bodies cut to the flight rows the
// adapter reads (the results, the make taxonomy, one card per listing; no seller contact details).
/** Aiways with a 4-result cap: its 8 used cars split into price bands, 16 pages. */
const full = fixture("full", "2026-10-26T16:30:28.473Z");
const AIWAYS = 31930;
/** Lexus, a first incremental run: no new cars, 22 used ones on two pages. */
const incremental = fixture("incremental", "2026-10-26T18:03:06.139Z");
const LEXUS = 15200;
/**
 * Lexus 20 minutes after `incremental`, recorded with its listings known except the three
 * newest: a later run that pages past listings it has not seen to a page of known ones.
 */
const incrementalKnown = fixture("incremental-known", "2026-10-26T18:24:27.066Z");

// Supplemental (model-make-split): a make split's recount needs a one- or two-euro band over the
// cap, some 35 bisection pages deep, and then every make of the taxonomy (~186) counted three
// times, far more than Akamai lets through in a session. So this cassette was recorded by
// mobiledeSource, through recordingHttp, against a model of the site serving 77 real listings
// captured 2026-10-26 with the site's query rules (con, ms, inclusive whole-euro `p`, doc, 20
// per page newest first). ADR 0015 has the details.
/** Every make, a 1-result cap: two used cars at 38,999 €, so the bands around it split by make. */
const modelMakeSplit = fixture("model-make-split", "2026-10-26T10:00:00Z");
const SPLIT_PRICE = "38998:38999";

interface Run {
  observations: Observation[];
  urls: string[];
  warnings: string[];
  /** The `mobile-de slice` log entries: each slice's key, results and outcome. */
  slices: unknown[];
  error?: unknown;
}

async function harvest(
  { cassette, now }: Fixture,
  source: Source,
  mode: HarvestMode,
  checkpoint: Partial<Checkpoint> = {},
  edit: (cassette: Cassette) => void = () => {},
  signal = new AbortController().signal,
): Promise<Run> {
  const recorded = structuredClone(await loadCassette(cassette));
  edit(recorded);
  const replay = createReplayHttp(recorded);
  const run: Run = { observations: [], urls: [], warnings: [], slices: [] };
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
    log: {
      info: (message, data) => {
        if (message === "mobile-de slice") run.slices.push(data);
      },
      warn: (message) => run.warnings.push(message),
    },
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
    const replay = createReplayHttp(await loadCassette(full.cassette));
    const source = mobiledeSource({ makes: [AIWAYS], resultCap: 4 });
    const ctx: HarvestContext = {
      http: {
        get(request) {
          requests.push(request);
          return replay.get(request);
        },
      },
      mode: "full",
      checkpoint: emptyCheckpoint,
      now: full.now,
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
      expect(query.get("ms")).toBe(String(AIWAYS));
      expect(["NEW", "USED"]).toContain(query.get("con"));
    }
  });

  it("maps listings: condition, VAT, seller, vehicle facts and the card's photos", async () => {
    // No new Lexus came online that day; one of the used ones stands in on the NEW page.
    const run = await harvest(
      incremental,
      mobiledeSource({ makes: [LEXUS] }),
      "incremental",
      {},
      (cassette) => {
        let listing: unknown;
        editResults(
          (q) => q.get("con") === "USED" && !q.has("pageNumber"),
          (results) => {
            listing = results.listings.find((l: { id: number }) => l.id === 52824537148736);
          },
        )(cassette);
        editResults(
          (q) => q.get("con") === "NEW",
          (results) => {
            results.numResultsTotal = 1;
            results.listings = [listing];
          },
        )(cassette);
      },
    );
    expect(run.error).toBeUndefined();
    const byRef = new Map(listings(run).map((l) => [l.ref, l]));
    // A dealer showing the net price beside the gross one ("MwSt. ausweisbar"): gross.
    expect(byRef.get("52835669852448")).toEqual({
      kind: "ListingSeen",
      ref: "52835669852448",
      url: "https://suchen.mobile.de/fahrzeuge/details.html?id=52835669852448",
      market: "DE",
      condition: "used",
      vehicle: {
        make: "Lexus",
        model: "NX 450h",
        trim: "+ E-FOUR BUSINESS  *CONNECT Paket*",
        sourceTaxonomy: { make: "15200" },
        firstRegistration: { year: 2022, month: 10 },
        powerKw: 225,
        transmission: "automatic",
        engineCc: 2487,
        seats: 4,
        euroClass: 6,
        color: "Weiß",
      },
      odometerKm: 25227,
      price: { amount: 44480, currency: "EUR" },
      priceBasis: "gross",
      seller: "dealer",
      location: { city: "Berlin", postcode: "13403" },
      photos: [
        "https://img.classistatic.de/api/v1/mo-prod/images/cd/cdd77727-7d12-49f2-9664-b277dc7cfe1e?rule=mo-1024",
      ],
      listedAt: "2026-10-26",
    });
    // A private seller (FSBO) shows no VAT, so the basis is unknown.
    expect(byRef.get("52818657050944")).toMatchObject({
      condition: "used",
      price: { amount: 29450, currency: "EUR" },
      priceBasis: "unknown",
      seller: "private",
      odometerKm: 90390,
      inspectionValidUntil: { year: 2028, month: 8 },
    });
    expect(byRef.get("52818657050944")?.photos).toHaveLength(4);
    // A Tageszulassung or Vorführfahrzeug is a demo car; a NEW slice listing is new.
    expect(byRef.get("50686514678144")).toMatchObject({ condition: "demo", odometerKm: 6500 });
    expect(
      listings(run)
        .filter((l) => l.condition === "new")
        .map((l) => l.ref),
    ).toEqual(["52824537148736"]);
  });

  it("reads a hybrid's kind from its title: a mild one is its combustion fuel", async () => {
    // A "Hybrid (Benzin/Elektro)" Lexus, its card retitled.
    const fuelOf = async (title: string) => {
      const run = await harvest(
        incremental,
        mobiledeSource({ makes: [LEXUS] }),
        "incremental",
        {},
        (cassette) => {
          for (const { response } of cassette.interactions) {
            response.body = response.body.replaceAll(
              "Lexus NX 450h+ E-FOUR BUSINESS  *CONNECT Paket*",
              title,
            );
          }
        },
      );
      const listing = listings(run).find((l) => l.ref === "52835669852448");
      expect(listing).toBeDefined();
      return listing?.vehicle.fuel;
    };
    expect(await fuelOf("Lexus NX 450h+ E-FOUR BUSINESS")).toBeUndefined();
    expect(await fuelOf("Lexus NX 450h+ Plug-in-Hybrid")).toBe("phev");
    expect(await fuelOf("Lexus NX 350h 48V Mild-Hybrid")).toBe("petrol");
    // "e-Hybrid" is a plug-in badge only on Volkswagen group cars.
    expect(await fuelOf("Lexus NX 350h e-Hybrid")).toBeUndefined();
  });

  it("full: splits a make into price bands that partition it, each reported done", async () => {
    const run = await harvest(full, mobiledeSource({ makes: [AIWAYS], resultCap: 4 }), "full");
    expect(run.error).toBeUndefined();
    // Every listing of the make once, though no band is allowed more than four.
    expect(refs(run).size).toBe(8);
    expect(listings(run)).toHaveLength(8);
    const done = slices(run);
    expect(done).toContain("new;make=31930");
    const bands = done
      .filter((s) => s.startsWith("used;"))
      .map((s) =>
        /price=(\d+)-(\d*)$/
          .exec(s)
          ?.slice(1)
          .map((n) => (n ? Number(n) : null)),
      );
    // Whole-euro bands from 0 up to the open top band, neighbours sharing their bound so a price
    // with cents cannot fall between them.
    expect(bands[0]).toEqual([0, 15_624]);
    expect(bands.at(-1)).toEqual([999_999, null]);
    for (let i = 1; i < bands.length; i++) expect(bands[i]?.[0]).toBe(bands[i - 1]?.[1]);
    // The make (8) and the bands over the cap were split, never paged.
    expect(done).not.toContain("used;make=31930");
    expect(done).not.toContain("used;make=31930;price=0-31249");
    // Never a decimal: the site reads "." as a thousands separator (122.99 = 12,299 €).
    for (const url of run.urls) {
      const p = params(url).get("p");
      if (p) expect(p).toMatch(/^\d+:\d*$/);
    }
    for (const listing of listings(run)) {
      expect(listing).toMatchObject({ market: "DE", vehicle: { make: "Aiways" } });
      for (const photo of listing.photos) {
        expect(photo).toMatch(/^https:\/\/img\.classistatic\.de\/.+\?rule=mo-1024$/);
      }
    }
    // One of the eight shows no photo on its card.
    expect(listings(run).filter((l) => l.photos.length > 0)).toHaveLength(7);
  });

  it("full: skips slices done earlier in the census", async () => {
    const done = new Set(["new;make=31930", "used;make=31930;price=0-15624"]);
    const run = await harvest(full, mobiledeSource({ makes: [AIWAYS], resultCap: 4 }), "full", {
      sliceDoneAt: (slice) => (done.has(slice) ? full.now : null),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.some((u) => params(u).get("con") === "NEW")).toBe(false);
    expect(run.urls.some((u) => params(u).get("p") === "0:15624")).toBe(false);
    expect(slices(run)).not.toContain("new;make=31930");
    expect(slices(run)).toContain("used;make=31930;price=15624-31249");
    expect(refs(run).size).toBe(5);
  });

  it("full: pages a short slice again, then fails the run after the others", async () => {
    // The band claims one result more than it serves.
    const run = await harvest(
      full,
      mobiledeSource({ makes: [AIWAYS], resultCap: 4 }),
      "full",
      {},
      editResults(usedBand(0), (results) => {
        results.numResultsTotal += 1;
      }),
    );
    expect(String(run.error)).toMatch(/not harvested whole: used;make=31930;price=0-15624/);
    expect(run.urls.filter((u) => params(u).get("p") === "0:15624")).toHaveLength(2);
    expect(slices(run)).not.toContain("used;make=31930;price=0-15624");
    expect(slices(run)).toContain("used;make=31930;price=15624-31249");
    expect(run.warnings.some((w) => /short/.test(w))).toBe(true);
  });

  it("full: splits a one- or two-euro band over the cap by make and recounts the parts", async () => {
    const run = await harvest(modelMakeSplit, mobiledeSource({ resultCap: 1 }), "full");
    expect(run.error).toBeUndefined();
    expect(refs(run)).toEqual(new Set(["454384877", "44481897375264", "43061006993376"]));
    expect(slices(run)).toEqual(
      expect.arrayContaining([
        "new",
        "used;make=1400;price=38998-38999",
        "used;make=17200;price=38998-38999",
        "used;make=20100;price=38999-39000",
      ]),
    );
    // The split slice itself is never done: a resumed census probes it again.
    expect(slices(run)).not.toContain("used;price=38998-38999");
    // Halving a two-euro band would leave out a price with cents between its two euros.
    expect(run.urls.some((u) => /^(\d+):\1$/.test(params(u).get("p") ?? ""))).toBe(false);
    // Probe, then before and after the parts' recount.
    const whole = run.urls.filter(
      (u) => params(u).get("p") === SPLIT_PRICE && !params(u).has("ms"),
    );
    expect(whole).toHaveLength(3);
  });

  it("full: fails when the make parts of a band miss results", async () => {
    // A listing at that price under a make outside the taxonomy: the slice counts 3, its parts 2.
    const run = await harvest(
      modelMakeSplit,
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
    expect(String(run.error)).toMatch(/not harvested whole: used;price=38998-38999/);
    expect(slices(run)).toContain("used;make=17200;price=38998-38999");
    expect(run.warnings.filter((w) => /miss results/.test(w))).toHaveLength(3);
  });

  it("incremental: a first run looks back one day, newest first, and skips promotions", async () => {
    const run = await harvest(incremental, mobiledeSource({ makes: [LEXUS] }), "incremental");
    expect(run.error).toBeUndefined();
    expect(run.urls.every((u) => params(u).get("doc") === "1")).toBe(true);
    expect(run.urls.filter((u) => params(u).get("pageNumber") === "2")).toHaveLength(1);
    // Page 1 leads with three promoted listings; only the 22 the search reports come out, once.
    expect(listings(run)).toHaveLength(22);
    expect(refs(run).size).toBe(22);
    expect(slices(run)).toEqual([]);
    expect(listings(run)[0]?.ref).toBe("52860279776576");
    expect(listings(run).find((l) => l.ref === "52835669852448")).toMatchObject({
      listedAt: "2026-10-26",
    });
  });

  it("incremental: stops a slice at a page of listings known before the run", async () => {
    const first = await harvest(incremental, mobiledeSource({ makes: [LEXUS] }), "incremental");
    const known = new Set(
      listings(first)
        .slice(0, 20)
        .map((l) => l.ref),
    );
    const run = await harvest(incremental, mobiledeSource({ makes: [LEXUS] }), "incremental", {
      isKnown: (ref) => known.has(ref),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.some((u) => params(u).get("pageNumber") === "2")).toBe(false);
    expect(listings(run)).toHaveLength(20);
  });

  it("incremental: a later run pages past unseen listings to a page of known ones", async () => {
    const first = await harvest(incremental, mobiledeSource({ makes: [LEXUS] }), "incremental");
    const unseen = listings(first)
      .slice(0, 3)
      .map((l) => l.ref);
    const known = new Set(listings(first).map((l) => l.ref));
    for (const ref of unseen) known.delete(ref);
    const run = await harvest(incrementalKnown, mobiledeSource({ makes: [LEXUS] }), "incremental", {
      lastRunAt: incremental.now,
      isKnown: (ref) => known.has(ref),
    });
    expect(run.error).toBeUndefined();
    expect(run.urls.every((u) => params(u).get("doc") === "1")).toBe(true);
    expect(run.urls.filter((u) => params(u).get("pageNumber") === "2")).toHaveLength(1);
    for (const ref of unseen) expect(refs(run).has(ref)).toBe(true);
    expect(run.slices).toContainEqual(
      expect.objectContaining({ slice: "used;make=15200", outcome: "stopped" }),
    );
  });

  it("incremental: widens the window to the gap since the last run, or drops it", async () => {
    const fiveDays = new Date(incremental.now.getTime() - 5 * 86_400_000);
    const week = await harvest(
      incremental,
      mobiledeSource({ makes: [LEXUS] }),
      "incremental",
      { lastRunAt: fiveDays },
      recordedDoc("7"),
    );
    expect(week.error).toBeUndefined();
    expect(week.urls.every((u) => params(u).get("doc") === "7")).toBe(true);

    const monthAgo = new Date(incremental.now.getTime() - 30 * 86_400_000);
    const stale = await harvest(
      incremental,
      mobiledeSource({ makes: [LEXUS] }),
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
      mobiledeSource({ makes: [LEXUS] }),
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
      mobiledeSource({ makes: [LEXUS] }),
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
      mobiledeSource({ makes: [AIWAYS], resultCap: 4 }),
      "full",
      {},
      () => {},
      controller.signal,
    );
    expect(String(run.error)).toMatch(/deadline/);
    expect(run.urls).toEqual([]);
  });
});
