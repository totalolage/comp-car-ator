import { type Cassette, createReplayHttp, type Http, loadCassette } from "@cca/http";
import type { ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { type Checkpoint, emptyCheckpoint, type HarvestMode } from "../source.ts";
import { bazosSource } from "./bazos.ts";

// Fixtures: 59 real rows of the Kia category and their ad pages, recorded 2026-10-25 (plus
// one Škoda ad, standing in for a misfiled one). The rows keep their real order and dates
// and are re-paged as the site pages them, as a 59-ad category. Ad pages are cut to the
// parts the parser reads; seller names, phone numbers and e-mails are removed. Test edits:
// row 224864791 is retitled as a wanted ad; 224911426's ad page is a removed-ad redirect;
// bump.cassette moves 224316711 to the top during the walk; shift.cassette removes the
// 2nd-7th rows during the walk; changed.cassette serves a maintenance page.
const now = new Date("2026-10-25T17:00:00Z");

const fixture = (name: string) => new URL(`./fixtures/${name}.cassette.json`, import.meta.url);

async function cassette(name: string, edit?: (c: Cassette) => void): Promise<Cassette> {
  const [list, details] = await Promise.all([
    loadCassette(fixture(name)),
    loadCassette(fixture("details")),
  ]);
  const merged: Cassette = {
    version: 1,
    interactions: [...list.interactions, ...details.interactions],
  };
  edit?.(merged);
  return merged;
}

async function harvest(
  recorded: Cassette,
  mode: HarvestMode,
  checkpoint: Partial<Checkpoint> = {},
  signal = new AbortController().signal,
) {
  const replay = createReplayHttp(recorded);
  const requested: string[] = [];
  const http: Http = {
    get(request) {
      requested.push(typeof request === "string" ? request : request.url);
      return replay.get(request);
    },
  };
  const warnings: string[] = [];
  const observations: Observation[] = [];
  let error: unknown;
  try {
    for await (const o of bazosSource({ categories: ["kia"], parts: 2 }).harvest({
      http,
      mode,
      checkpoint: { ...emptyCheckpoint, ...checkpoint },
      now,
      log: { info() {}, warn: (message) => warnings.push(message) },
      signal,
    })) {
      observations.push(o);
    }
  } catch (e) {
    error = e;
  }
  const listed = requested.filter((u) => !u.includes("/inzerat/"));
  const details = requested.filter((u) => u.includes("/inzerat/")).map((u) => refIn(u));
  return { observations, error, warnings, listed: listed.map(pathOf), details };
}

const ROW = '<div class="inzeraty inzeratyflex">';
const refIn = (url: string) => /\/inzerat\/(\d+)\//.exec(url)?.[1] as string;
const pathOf = (url: string) => url.replace("https://auto.bazos.cz", "");
const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const refs = (os: Observation[]) => listings(os).map((o) => o.ref);
const listing = (os: Observation[], ref: string) => listings(os).find((o) => o.ref === ref);

/** Replaces text in every recorded list page. */
const inPages = (
  c: Cassette,
  from: string,
  to: string,
  at?: (url: string, n: number) => boolean,
) => {
  const seen = new Map<string, number>();
  for (const { request, response } of c.interactions) {
    const n = (seen.get(request.url) ?? 0) + 1;
    seen.set(request.url, n);
    if (!at || at(request.url, n)) response.body = response.body.replaceAll(from, to);
  }
};

/** The 29 ads in scope: priced Czech cars from 2000 on whose text states year and odometer. */
const IN_SCOPE = [
  "223455729",
  "223472122",
  "224259231",
  "224316711",
  "224334060",
  "224426489",
  "224452818",
  "224554662",
  "224557936",
  "224563165",
  "224564821",
  "224672197",
  "224787227",
  "224859984",
  "224864444",
  "224866762",
  "224867487",
  "224873612",
  "224878299",
  "224892951",
  "224898124",
  "224899514",
  "224904233",
  "224922323",
  "224923051",
  "225143664",
  "225307819",
  "225393809",
  "225558540",
];

describe("bazos source", () => {
  it("full run yields every car in scope, one slice per id part, and no detail pages for non-cars", async () => {
    const { observations, error, listed, details } = await harvest(await cassette("full"), "full");
    expect(error).toBeUndefined();
    expect(refs(observations).sort()).toEqual(IN_SCOPE);
    // A walk over all pages 16 apart, then one over today's ads.
    expect(listed).toEqual(["/kia/", "/kia/16/", "/kia/32/", "/kia/48/", "/kia/", "/kia/16/"]);
    // Parts, tyres, mirrors, a wanted ad, "Dohodou", a car at 4,999 Kč, "Prodej auta": no
    // detail page.
    for (const ref of [
      "224925222",
      "224902451",
      "224552772",
      "224903702",
      "224864791",
      "224908956",
      "224891855",
      "223463729",
      "224919677",
      "224926199",
    ]) {
      expect(details).not.toContain(ref);
    }
    // A removed ad redirects to a search page.
    expect(observations).toContainEqual({ kind: "ListingGone", ref: "224911426" });
    // Each part's ads come before its SliceDone.
    const done = observations.flatMap((o, i) => (o.kind === "SliceDone" ? [[o.slice, i]] : []));
    expect(done.map(([slice]) => slice)).toEqual(["kia;part=0/2", "kia;part=1/2"]);
    const [, end0] = done[0] as [string, number];
    observations.forEach((o, i) => {
      if (o.kind === "ListingSeen" || o.kind === "ListingGone") {
        expect(Number(o.ref) % 2).toBe(i < end0 ? 0 : 1);
      }
    });
  });

  it("reads the ad text precision first: unknown rather than wrong", async () => {
    const { observations } = await harvest(await cassette("full"), "full");
    // Misfiled: a Škoda in the Kia category keeps its own make.
    expect(listing(observations, "225558540")).toMatchObject({
      url: expect.stringMatching(/^https:\/\/auto\.bazos\.cz\/inzerat\/225558540\/.+\.php$/),
      market: "CZ",
      condition: "used",
      odometerKm: 52_300,
      price: { amount: 358_000, currency: "CZK" },
      location: { city: "Vsetín", postcode: "75651" },
      vehicle: {
        make: "Škoda",
        model: "Kamiq",
        sourceTaxonomy: { make: "kia" },
        firstRegistration: { year: 2019, month: 3 },
        fuel: "petrol",
        powerKw: 85,
        transmission: "manual",
      },
    });
    expect(listing(observations, "225558540")?.photos.length).toBeGreaterThan(0);
    // An EV: 150 kW, not the 64 kWh battery; VAT deductible, so a gross price.
    expect(listing(observations, "224259231")).toMatchObject({
      priceBasis: "gross",
      vehicle: { model: "e-Soul", fuel: "bev", powerKw: 150 },
    });
    // "STK do 10/2028" in the title is the inspection, not the year.
    expect(listing(observations, "224452818")?.vehicle.firstRegistration).toEqual({
      year: 2022,
      month: 11,
    });
    // A petrol car "vhodné na LPG" (suitable for LPG) is no LPG car; "15 tis/km" is 15,000 km.
    expect(listing(observations, "224316711")).toMatchObject({
      odometerKm: 15_000,
      vehicle: { fuel: "petrol", manufactureYear: 2024 },
    });
    // "elekromobil" (sic) is not read as a fuel: unknown.
    expect(listing(observations, "224878299")?.vehicle.fuel).toBeUndefined();
    // "r.2018,102900km" in the description; the trim is the rest of the title as shown.
    expect(listing(observations, "224334060")).toMatchObject({
      odometerKm: 102_900,
      vehicle: { model: "Picanto", trim: "1,3", manufactureYear: 2018 },
    });
    // Financing and trade-in offers are a dealer's.
    expect(listing(observations, "225307819")?.seller).toBe("dealer");
    // The rest say nothing about the seller.
    expect(listing(observations, "224334060")?.seller).toBe("unknown");
  });

  it("leaves out ads whose year or odometer is unknown", async () => {
    const { observations, details } = await harvest(await cassette("full"), "full");
    // Title "2012rok", description "rok výroby 2013": the year is unknown, so the ad is out
    // of scope although it states 193 000 km.
    expect(details).toContain("224544285");
    expect(refs(observations)).not.toContain("224544285");
  });

  it("full run resumes: parts done earlier in the census are skipped", async () => {
    const doneAt = new Date("2026-10-24T03:00:00Z");
    const { observations, details, error } = await harvest(await cassette("full"), "full", {
      sliceDoneAt: (slice) => (slice === "kia;part=0/2" ? doneAt : null),
    });
    expect(error).toBeUndefined();
    expect(details.every((ref) => Number(ref) % 2 === 1)).toBe(true);
    expect(refs(observations).sort()).toEqual(IN_SCOPE.filter((ref) => Number(ref) % 2 === 1));
    expect(observations.at(-1)).toEqual({ kind: "SliceDone", slice: "kia;part=1/2" });
  });

  it("full run with every part done fetches nothing", async () => {
    const { observations, listed } = await harvest(await cassette("full"), "full", {
      sliceDoneAt: () => now,
    });
    expect(observations).toEqual([]);
    expect(listed).toEqual([]);
  });

  it("an ad bumped above the walk while it runs is found by the walk over today's ads", async () => {
    const { observations, error } = await harvest(await cassette("bump"), "full");
    expect(error).toBeUndefined();
    expect(refs(observations).sort()).toEqual(IN_SCOPE);
  });

  it("ads removed above the walk do not make it skip the ads that moved up", async () => {
    const { observations, error, listed, details } = await harvest(await cassette("shift"), "full");
    expect(error).toBeUndefined();
    // /kia/16/ shares no ad with /kia/: the walk steps back and reads /kia/ again.
    expect(listed.slice(0, 4)).toEqual(["/kia/", "/kia/16/", "/kia/", "/kia/16/"]);
    // The 22nd ad moved onto the first page; a walk that did not step back would miss it.
    expect(details).toContain("224911426");
    expect(observations).toContainEqual({ kind: "ListingGone", ref: "224911426" });
    expect(refs(observations).sort()).toEqual(IN_SCOPE);
  });

  it("fewer ads than the site counts: no slice is done and the run fails", async () => {
    // The walk over today's ads (the second read of each page) counts 70 ads, not 59.
    const recorded = await cassette("full", (c) =>
      inPages(
        c,
        "inzerátů z 59",
        "inzerátů z 70",
        (url, n) => n === 2 && !url.includes("/inzerat/"),
      ),
    );
    const { observations, error } = await harvest(recorded, "full");
    expect(String(error)).toMatch(/not harvested whole: kia/);
    expect(observations).toEqual([]);
  });

  it("an unreadable ad is rejected and the harvest goes on", async () => {
    const recorded = await cassette("full", (c) =>
      inPages(
        c,
        '<span translate="no">  75 500 Kč</span>',
        '<span translate="no">neuvedena</span>',
        (url) => !url.includes("/inzerat/"),
      ),
    );
    const full = await harvest(recorded, "full");
    // A ListingSeen the Ledger rejects (no price), so its slice does not count as done.
    const bad = listing(full.observations, "224899514");
    expect(bad?.price.amount).toBeNaN();
    expect(bad?.vehicle.make).toBe("");
    expect(refs(full.observations).length).toBe(IN_SCOPE.length);
    expect(full.observations.filter((o) => o.kind === "SliceDone")).toHaveLength(2);
    expect(full.warnings).toContain("bazos: unreadable ad");
    // A full run fails at the end, so the census resumes with that part only.
    expect(String(full.error)).toMatch(/slices with unreadable ads: kia;part=0\/2/);

    const incremental = await harvest(recorded, "incremental");
    expect(incremental.error).toBeUndefined();
    expect(listing(incremental.observations, "224899514")?.price.amount).toBeNaN();
  });

  it("incremental run fetches new ads only and stops at the first page older than the last run", async () => {
    // Ads met on or after the last run's day (2026-10-11): the first 18 rows.
    const fresh = new Set([
      "225307819",
      "224787227",
      "224672197",
      "225393809",
      "224259231",
      "224426489",
      "224334060",
      "225143664",
      "224452818",
      "224780112",
      "225558540",
      "224926199",
      "224925224",
      "224925222",
      "224923051",
      "224922323",
      "224920358",
      "224919677",
    ]);
    const { observations, error, listed, details } = await harvest(
      await cassette("full"),
      "incremental",
      // 224898124 (2026-10-10) is not in the Ledger either: the last run found it out of scope.
      {
        lastRunAt: new Date("2026-10-11T03:00:00Z"),
        isKnown: (ref) => !fresh.has(ref) && ref !== "224898124",
      },
    );
    expect(error).toBeUndefined();
    // /kia/16/ still holds ads from 2026-10-11; /kia/32/ is all older.
    expect(listed).toEqual(["/kia/", "/kia/16/", "/kia/32/"]);
    expect(details.every((ref) => fresh.has(ref))).toBe(true);
    expect(refs(observations).sort()).toEqual(IN_SCOPE.filter((ref) => fresh.has(ref)));
    expect(observations.some((o) => o.kind === "SliceDone")).toBe(false);
  });

  it("a list page cut short is fetched again", async () => {
    const cut = (c: Cassette, times: number) => {
      let left = times;
      for (const { request, response } of c.interactions) {
        if (request.url.endsWith("/kia/16/") && left-- > 0) {
          response.body = response.body.slice(0, response.body.lastIndexOf(ROW));
        }
      }
    };
    const once = await harvest(await cassette("full", (c) => cut(c, 1)), "full");
    expect(once.error).toBeUndefined();
    expect(once.listed.slice(0, 3)).toEqual(["/kia/", "/kia/16/", "/kia/16/"]);
    expect(refs(once.observations).sort()).toEqual(IN_SCOPE);
    const always = await harvest(await cassette("full", (c) => cut(c, 2)), "full");
    expect(String(always.error)).toMatch(/list page has 19 rows, its header 20/);
  });

  it("an ad page redirecting off the site fails the run instead of retiring the ad", async () => {
    const recorded = await cassette("full", (c) => {
      const ad = c.interactions.find(({ request }) => request.url.includes("/inzerat/224334060/"));
      if (ad) ad.response.url = "https://www.example.com/maintenance";
    });
    const { observations, error } = await harvest(recorded, "full");
    expect(String(error)).toMatch(/224334060 redirected/);
    expect(observations).not.toContainEqual({ kind: "ListingGone", ref: "224334060" });
  });

  it("a changed list page fails the run", async () => {
    const { error } = await harvest(await cassette("changed"), "full");
    expect(String(error)).toMatch(/list page changed/);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { error } = await harvest(await cassette("full"), "full", {}, controller.signal);
    expect(String(error)).toMatch(/stop/);
  });

  it("names its scope by category and rejects unknown ones", () => {
    expect(bazosSource().scope).toBeUndefined();
    expect(bazosSource({ categories: ["skoda", "kia"] }).scope).toBe("categories:kia,skoda");
    expect(() => bazosSource({ categories: ["dodavka"] })).toThrow(RangeError);
  });
});
