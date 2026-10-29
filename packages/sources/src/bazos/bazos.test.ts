import {
  type Cassette,
  createReplayHttp,
  type Http,
  type Interaction,
  loadCassette,
} from "@cca/http";
import type { ListingPriceSeen, ListingSeen, Observation } from "@cca/vocabulary";
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
/** A last run before every ad of the fixtures: an incremental run reads every page. */
const LONG_AGO = new Date("2026-09-01T03:00:00Z");

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
  categories = ["kia"],
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
    for await (const o of bazosSource({ categories, parts: 2 }).harvest({
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

/** Rewrites one ad's title in every list page, or its title and text on its ad page. */
const rewrite = (c: Cassette, ref: string, on: "list" | "ad", title: string, text = "") => {
  for (const { request, response } of c.interactions) {
    const ad = request.url.includes(`/inzerat/${ref}/`);
    if (on === "list" && !ad) {
      const link = new RegExp(`(<a href="/inzerat/${ref}/[^"]*">)[^<]*(</a></h2>)`);
      response.body = response.body.replace(link, `$1${title}$2`);
    }
    if (on === "ad" && ad) {
      response.body = response.body
        .replace(/(<h1 class=nadpisdetail>)[^<]*/i, `$1${title}`)
        .replace(/(<div class=popisdetail>)[\s\S]*?(<\/div>)/, `$1${text}$2`);
    }
  }
};

/**
 * The recorded Kia category as a list the test moves ads around in: ids in the site's order,
 * each with its row as the list page shows it. An id ending in "*" is the ad bumped today.
 */
async function category() {
  const { interactions } = await loadCassette(fixture("full"));
  const rows = new Map<string, string>();
  for (const { response } of interactions) {
    for (const block of response.body.split(ROW).slice(1)) {
      const ref = refIn(block);
      if (!rows.has(ref)) rows.set(ref, block.replace("</div></body></html>", ""));
    }
  }
  const page = (list: string[], offset: number, hidden: ReadonlySet<string>): Interaction => {
    const url = `https://auto.bazos.cz/kia/${offset === 0 ? "" : `${offset}/`}`;
    const slots = list.slice(offset, offset + 20);
    const shown = slots
      .filter((id) => !hidden.has(id))
      .map((id) => {
        const row = rows.get(id.replace("*", "")) as string;
        return (
          ROW + (id.endsWith("*") ? row.replace(/\[\d+\.\d+\. \d{4}\]/, "[25.10. 2026]") : row)
        );
      });
    const header = `Zobrazeno ${offset + 1}-${offset + slots.length} inzerátů z ${list.length}`;
    const body = `<html><body><div class="maincontent">\n<div class="listainzerat inzeratyflex"><div class="inzeratynadpis">${header}</div></div>\n${shown.join("")}</div></body></html>`;
    const headers = { "content-type": "text/html; charset=UTF-8" };
    return {
      request: { url },
      response: { url, status: offset ? 404 : 200, headers, body, tier: "T0" },
    };
  };
  return {
    ids: [...rows.keys()],
    /** A new ad, as a copy of another's row under a new id. */
    post(ref: string, like: string) {
      rows.set(ref, (rows.get(like) as string).replaceAll(like, ref));
    },
    /**
     * The list pages served in request order, `[offset, list]` each, plus the ad pages. Ids
     * in `hidden` hold their place and count, but no page shows them.
     */
    async cassette(
      served: [number, string[]][],
      hidden: ReadonlySet<string> = new Set(),
    ): Promise<Cassette> {
      const details = await loadCassette(fixture("details"));
      return {
        version: 1,
        interactions: [
          ...served.map(([offset, list]) => page(list, offset, hidden)),
          ...details.interactions,
        ],
      };
    },
  };
}

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

  // Probe from review: the walk misses an ad bumped above it and then above the walk over
  // today's ads, while an ad it met is removed, so the ads met still match the final count.
  describe("an ad met and later removed does not stand in for one the walk missed", () => {
    const missed = "224864444";
    const bumpedTwice = async (removed: (ids: string[]) => string, posted?: string) => {
      const kia = await category();
      const ids = kia.ids;
      const gone = removed(ids);
      if (posted) kia.post(posted, "224920358"); // a 1,200 Kč part: no ad page
      const without = (list: string[], ...drop: string[]) =>
        list.filter((id) => !drop.includes(id));
      // 20 ads bumped before the walk over today's ads put the missed one off its first page.
      const bumped = ids.slice(19, 39);
      const rest = without(ids, missed, gone, ...bumped);
      const top = posted ? [`${posted}*`] : [];
      const duringWalk = [`${missed}*`, ...without(ids, missed)];
      const beforeTopUp = [...top, ...bumped.map((id) => `${id}*`), `${missed}*`, ...rest];
      const after = [`${missed}*`, ...top, ...bumped.map((id) => `${id}*`), ...rest];
      return harvest(
        await kia.cassette([
          [0, ids],
          [16, duringWalk],
          [32, duringWalk],
          [48, duringWalk],
          [0, beforeTopUp],
          [16, after],
          [32, after],
          // The walk is redone on a list that holds still.
          [0, after],
          [16, after],
          [32, after],
          [48, after],
        ]),
        "full",
      );
    };

    it("an older ad removed: the ads met fall short of the highest count", async () => {
      const { observations, error, warnings, listed } = await bumpedTwice(
        (ids) => ids[18] as string,
      );
      expect(error).toBeUndefined();
      expect(warnings).toContain("bazos: walk met fewer ads than the site counts");
      expect(listed).toHaveLength(14);
      expect(refs(observations).sort()).toEqual(IN_SCOPE);
      expect(observations.filter((o) => o.kind === "SliceDone")).toHaveLength(2);
    });

    it("an ad dated today removed while one is posted: the walk over today's ads proves it gone", async () => {
      const { observations, error, warnings } = await bumpedTwice(
        (ids) => ids[5] as string,
        "225600001",
      );
      expect(error).toBeUndefined();
      expect(warnings).toContain("bazos: walk met fewer ads than the site counts");
      expect(refs(observations).sort()).toEqual(IN_SCOPE.filter((ref) => ref !== "224426489"));
      expect(observations.filter((o) => o.kind === "SliceDone")).toHaveLength(2);
    });
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
    expect(String(error)).toMatch(/not harvested whole: kia \(met 59 ads of 70 counted\)$/);
    expect(observations).toEqual([]);
  });

  it("an ad the site counts but no page shows keeps the category out of the census, by name", async () => {
    // As on Ford and Mercedes live: the 26th place is counted (the category holds 60) and
    // /kia/16/ shows 19 of the 20 rows its header counts, on every read.
    const kia = await category();
    const list = [...kia.ids.slice(0, 25), "225999999", ...kia.ids.slice(25)];
    const { observations, error, warnings } = await harvest(
      await kia.cassette(
        [
          [0, list],
          [16, list],
          [32, list],
          [48, list],
        ],
        new Set(["225999999"]),
      ),
      "full",
    );
    expect(warnings).toContain(
      "Bazoš list page has 19 rows, its header 20: https://auto.bazos.cz/kia/16/",
    );
    // The ad lacked lies mid-page, on no page next to it, and no walk meets it.
    expect(warnings).toContain("bazos: walk met a list page whose rows do not match its header");
    expect(warnings).toContain("bazos: walk met fewer ads than the site counts");
    expect(String(error)).toBe(
      "Error: bazos: categories not harvested whole: kia (pages whose rows do not match their header: /kia/16/ 19 of 20; met 59 ads of 60 counted)",
    );
    expect(observations).toEqual([]);
  });

  it("leaves out new cars", async () => {
    const recorded = await cassette("full", (c) => {
      // Said in the list row: no ad page. Said on the ad page only: read, then left out.
      rewrite(c, "224557936", "list", "Kia Ceed nový vůz 2026, 10 km");
      rewrite(
        c,
        "224452818",
        "ad",
        "Kia Ceed 1.5 T-GDi nový vůz",
        "Rok výroby 2026, najeto 10 km.",
      );
      // Said in the description only.
      rewrite(
        c,
        "224563165",
        "ad",
        "Kia Ceed 1.5 T-GDi 2026",
        "Nový vůz. Rok výroby 2026, najeto 10 km.",
      );
      // Registered this year with next to no km but never called new: used cars.
      rewrite(
        c,
        "224564821",
        "ad",
        "Kia Ceed 1.5 T-GDi",
        "Ojetý vůz. První registrace 2026, najeto 50 km.",
      );
      rewrite(
        c,
        "224554662",
        "ad",
        "Kia Ceed 1.5 T-GDi exdealer",
        "Exdealer, první registrace 2026, najeto 50 km.",
      );
      // New parts, a car bought new, or a new car bought instead: used cars still.
      rewrite(
        c,
        "224672197",
        "ad",
        "Kia Ceed 1.5 T-GDi",
        "Rok výroby 2019, najeto 85 000 km. Nové pneumatiky, nová STK, nová spojka.",
      );
      rewrite(
        c,
        "224787227",
        "ad",
        "Kia Ceed 1.5 T-GDi",
        "Koupen jako nový vůz v ČR, rok výroby 2018, najeto 120 000 km. Důvod prodeje: nové auto.",
      );
      rewrite(c, "224859984", "ad", "Kia Ceed 1.5 T-GDi", "Rok výroby 2026, najeto 5 000 km.");
    });
    const { observations, details } = await harvest(recorded, "full");
    const left = ["224557936", "224452818", "224563165"];
    expect(details).not.toContain("224557936");
    expect(details).toContain("224452818");
    expect(refs(observations).sort()).toEqual(IN_SCOPE.filter((ref) => !left.includes(ref)));
    const kept = ["224564821", "224554662", "224672197", "224787227", "224859984"].map((ref) =>
      listing(observations, ref),
    );
    expect(kept.map((o) => o?.condition)).toEqual(["used", "used", "used", "used", "used"]);
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

    const incremental = await harvest(recorded, "incremental", { lastRunAt: LONG_AGO });
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
      // 224898124 (2026-10-10) is not in the Ledger either: the last run could not read it.
      {
        lastRunAt: new Date("2026-10-11T03:00:00Z"),
        isKnown: (ref) => !fresh.has(ref) && ref !== "224898124",
      },
    );
    expect(error).toBeUndefined();
    // /kia/16/ still holds ads from 2026-10-11; /kia/32/ is all older.
    expect(listed).toEqual(["/kia/", "/kia/16/", "/kia/32/"]);
    // An unknown ad on a page read is tried again, whatever its date.
    expect(details.filter((ref) => !fresh.has(ref))).toEqual(["224898124"]);
    expect(refs(observations).sort()).toEqual(
      IN_SCOPE.filter((ref) => fresh.has(ref) || ref === "224898124"),
    );
    expect(observations.some((o) => o.kind === "SliceDone")).toBe(false);
  });

  it("incremental run retries unknown ads older than the last run on the pages it reads", async () => {
    // The last run (this morning) could not read two ads from 2026-10-11, so the Ledger does
    // not know them; they sit on the first page, below today's ads.
    const retry = new Set(["224923051", "224922323"]);
    const { observations, error, listed, details } = await harvest(
      await cassette("full"),
      "incremental",
      { lastRunAt: new Date("2026-10-25T03:00:00Z"), isKnown: (ref) => !retry.has(ref) },
    );
    expect(error).toBeUndefined();
    // /kia/16/ is dated wholly before today: the walk ends there.
    expect(listed).toEqual(["/kia/", "/kia/16/"]);
    expect(details.sort()).toEqual([...retry].sort());
    expect(refs(observations).sort()).toEqual([...retry].sort());
  });

  describe("incremental run, known ads", () => {
    /** Sets the price cell of one ad's row in every list page, or in the one at `path`. */
    const reprice = (c: Cassette, ref: string, shown: string, path?: string) => {
      const cell = new RegExp(
        `(/inzerat/${ref}/[\\s\\S]*?<div class="inzeratycena">)[\\s\\S]*?(</div>)`,
      );
      for (const { request, response } of c.interactions) {
        if (request.url.includes("/inzerat/")) continue;
        if (path && pathOf(request.url) !== path) continue;
        response.body = response.body.replace(
          cell,
          `$1<b><span translate="no">  ${shown}</span></b>$2`,
        );
      }
    };
    const pricesSeen = (os: Observation[]) =>
      os.filter((o): o is ListingPriceSeen => o.kind === "ListingPriceSeen");
    // The last run was this morning: the walk reads /kia/ and /kia/16/, and the Ledger
    // knows every ad on them.
    const known = { lastRunAt: new Date("2026-10-25T03:00:00Z"), isKnown: () => true };

    it("gives each known ad on the pages it reads the price its row shows, without its ad page", async () => {
      // The seller cut 224787227's price since the last run (349 900 Kč then).
      const recorded = await cassette("full", (c) => reprice(c, "224787227", "339 900 Kč"));
      const { observations, error, listed, details } = await harvest(
        recorded,
        "incremental",
        known,
      );
      expect(error).toBeUndefined();
      expect(listed).toEqual(["/kia/", "/kia/16/"]);
      expect(details).toEqual([]);
      const prices = pricesSeen(observations);
      expect(observations).toEqual(prices);
      expect(prices.find((o) => o.ref === "224787227")?.price).toEqual({
        amount: 339_900,
        currency: "CZK",
      });
      // An unchanged price is stated too: price history is daily.
      expect(prices.find((o) => o.ref === "225307819")?.price).toEqual({
        amount: 219_000,
        currency: "CZK",
      });
      // Each ad once, though the pages overlap; rows priced under 10 000 Kč are out of scope.
      const priced = prices.map((o) => o.ref);
      expect(new Set(priced).size).toBe(priced.length);
      expect(prices.every((o) => o.price.amount >= 10_000)).toBe(true);
    });

    it("states the price the ad's ListingSeen carries", async () => {
      // The recorded rows and ad pages, every page read: each in-scope ad's list price is the
      // one a full run takes from its ad page.
      const full = await harvest(await cassette("full"), "full");
      const incremental = await harvest(await cassette("full"), "incremental", {
        lastRunAt: LONG_AGO,
        isKnown: () => true,
      });
      expect(incremental.error).toBeUndefined();
      const seen = listings(full.observations).filter((o) => Number.isFinite(o.price.amount));
      expect(seen.length).toBeGreaterThan(20);
      const prices = new Map(pricesSeen(incremental.observations).map((o) => [o.ref, o.price]));
      for (const listing of seen) expect(prices.get(listing.ref)).toEqual(listing.price);
    });

    it("gives a known ad whose row states no price, or one out of scope, nothing", async () => {
      const recorded = await cassette("full", (c) => {
        reprice(c, "224787227", "Dohodou");
        reprice(c, "225307819", "V textu");
        // Under 10 000 Kč its ListingSeen would not come either.
        reprice(c, "224672197", "9 000 Kč");
      });
      const { observations, error, details } = await harvest(recorded, "incremental", known);
      expect(error).toBeUndefined();
      expect(details).toEqual([]);
      expect(pricesSeen(observations).length).toBeGreaterThan(0);
      const refsMet = observations.map((o) => ("ref" in o ? o.ref : undefined));
      expect(refsMet).not.toContain("224787227");
      expect(refsMet).not.toContain("225307819");
      expect(refsMet).not.toContain("224672197");
    });

    it("takes a known ad's price from the next page when its row on one is unreadable", async () => {
      // 224919677 is on both /kia/ and /kia/16/ (the pages overlap); retitled as a car.
      const recorded = await cassette("full", (c) => {
        rewrite(c, "224919677", "list", "Kia Carnival 2.9 CRDi 2008");
        reprice(c, "224919677", "cca 120 000 Kč", "/kia/");
        reprice(c, "224919677", "120 000 Kč", "/kia/16/");
      });
      const { observations, error, details } = await harvest(recorded, "incremental", known);
      expect(error).toBeUndefined();
      expect(details).toEqual([]);
      expect(pricesSeen(observations).filter((o) => o.ref === "224919677")).toEqual([
        { kind: "ListingPriceSeen", ref: "224919677", price: { amount: 120_000, currency: "CZK" } },
      ]);
    });
  });

  it("incremental run without a complete run yet stops at the first page older than yesterday", async () => {
    // The Ledger knows nothing. Reading every page would take hours on the live site, so
    // the run would never complete; it reads a day of ads, and a full run the rest.
    const { observations, error, listed, details } = await harvest(
      await cassette("full"),
      "incremental",
    );
    expect(error).toBeUndefined();
    // /kia/ holds today's ads; /kia/16/ is dated wholly before yesterday (2026-10-24).
    expect(listed).toEqual(["/kia/", "/kia/16/"]);
    expect(details.length).toBeGreaterThan(0);
    expect(refs(observations).every((ref) => IN_SCOPE.includes(ref))).toBe(true);
  });

  describe("a list page cut short", () => {
    const lastRow = (body: string) => body.slice(0, body.lastIndexOf(ROW));
    const everyRow = (body: string) => body.slice(0, body.indexOf(ROW));
    /**
     * Serves `path` as its last recording on each of 8 reads (the 8th repeats), cut by `drop`
     * on the reads `short` picks (1-based).
     */
    const cutAt = (
      c: Cassette,
      path: string,
      short: (read: number) => boolean,
      drop: (body: string) => string = lastRow,
    ) => {
      const at = ({ request }: Interaction) => request.url.endsWith(path);
      const recorded = c.interactions.filter(at).at(-1) as Interaction;
      const reads = Array.from({ length: 8 }, (_, i) => ({
        request: recorded.request,
        response: {
          ...recorded.response,
          body: short(i + 1) ? drop(recorded.response.body) : recorded.response.body,
        },
      }));
      c.interactions.splice(0, c.interactions.length, ...c.interactions.filter((i) => !at(i)));
      c.interactions.push(...reads);
    };
    /** The Kia list pages again as a Mazda category, harvested after Kia and never cut. */
    const withMazda = (c: Cassette) => {
      const mazda = (url: string) => url.replace("/kia/", "/mazda/");
      for (const { request, response } of c.interactions.filter(({ request }) =>
        request.url.includes("/kia/"),
      )) {
        c.interactions.push({
          request: { ...request, url: mazda(request.url) },
          response: { ...response, url: mazda(response.url) },
        });
      }
    };
    const stayingShort = (path = "/kia/16/", drop = lastRow) =>
      cassette("full", (c) => {
        withMazda(c);
        cutAt(c, path, () => true, drop);
      });
    const short = "Bazoš list page has 19 rows, its header 20: https://auto.bazos.cz/kia/16/";
    const unmatched = "bazos: walk met a list page whose rows do not match its header";

    it("is fetched again", async () => {
      const recorded = await cassette("full", (c) => cutAt(c, "/kia/16/", (read) => read === 1));
      const once = await harvest(recorded, "full");
      expect(once.error).toBeUndefined();
      expect(once.listed.slice(0, 3)).toEqual(["/kia/", "/kia/16/", "/kia/16/"]);
      expect(refs(once.observations).sort()).toEqual(IN_SCOPE);
    });

    // Reads of /kia/16/ in a full run: the 1st in the walk, the 2nd in the walk over today's
    // ads, each a read later when a read before it was short.
    it.each([
      ["the walk", [1, 2]],
      ["the walk over today's ads", [2, 3]],
    ])(
      "short twice in %s, the census walk is redone and taken when the redo reads it whole",
      async (_, reads) => {
        // The row the page leaves out shows on the next page, which overlaps it; that does not
        // tell it apart from an ad that moved there between the two reads.
        const recorded = await cassette("full", (c) =>
          cutAt(c, "/kia/16/", (read) => reads.includes(read)),
        );
        const { observations, error, warnings, listed } = await harvest(recorded, "full");
        expect(error).toBeUndefined();
        expect(warnings).toContain(short);
        expect(warnings).toContain(unmatched);
        expect(listed.filter((path) => path === "/kia/")).toHaveLength(4);
        expect(refs(observations).sort()).toEqual(IN_SCOPE);
        expect(observations.filter((o) => o.kind === "SliceDone")).toHaveLength(2);
      },
    );

    // Counterexample from review: the row /kia/16/ leaves out shows on /kia/32/, while a
    // different ad escapes every walk (the walk over today's ads counts 60, one more than any
    // page shows). Lowering the count by the rows short pages lack would take the census.
    it("a short page whose ad is met elsewhere lends no credit to an ad no walk met", async () => {
      const recorded = await cassette("full", (c) => {
        cutAt(c, "/kia/16/", () => true);
        inPages(c, "inzerátů z 59", "inzerátů z 60", (url, n) => url.endsWith("/kia/") && n >= 2);
      });
      const { observations, error, warnings, listed } = await harvest(recorded, "full");
      expect(warnings).toContain(unmatched);
      expect(listed.filter((path) => path === "/kia/")).toHaveLength(4);
      // Both walks are refused, and the count is not lowered by the row /kia/16/ lacks.
      expect(String(error)).toBe(
        "Error: bazos: categories not harvested whole: kia (pages whose rows do not match their header: /kia/16/ 19 of 20; met 59 ads of 60 counted)",
      );
      expect(observations).toEqual([]);
    });

    it("staying short, incremental reads the rows shown and goes on to later pages and categories", async () => {
      const { observations, error, warnings, listed } = await harvest(
        await stayingShort(),
        "incremental",
        { lastRunAt: LONG_AGO },
        undefined,
        ["kia", "mazda"],
      );
      expect(error).toBeUndefined();
      expect(warnings).toContain(short);
      expect(listed).toEqual([
        "/kia/",
        "/kia/16/",
        "/kia/16/",
        "/kia/32/",
        "/kia/48/",
        "/mazda/",
        "/mazda/16/",
        "/mazda/32/",
        "/mazda/48/",
      ]);
      // Each category's cars, the Kia ones read from the short page included.
      expect(refs(observations).sort()).toEqual(IN_SCOPE.flatMap((ref) => [ref, ref]));
      expect(warnings).toContain(
        "bazos: categories not harvested whole: kia (page whose rows do not match its header: /kia/16/ 19 of 20)",
      );
    });

    it("showing no rows, incremental gives up on that category and goes on to the next", async () => {
      const { observations, error, warnings, listed } = await harvest(
        await stayingShort("/kia/", everyRow),
        "incremental",
        { lastRunAt: LONG_AGO },
        undefined,
        ["kia", "mazda"],
      );
      expect(error).toBeUndefined();
      expect(warnings).toContain("bazos: lost its place in kia at offset 0");
      expect(listed.slice(0, 3)).toEqual(["/kia/", "/kia/", "/mazda/"]);
      expect(refs(observations).sort()).toEqual(IN_SCOPE);
      expect(warnings).toContain(
        "bazos: categories not harvested whole: kia (lost its place at offset 0)",
      );
    });

    it("lacking an ad no page next to it shows in a full run, that category reports no slice done while the others do", async () => {
      // A row from the middle of /kia/16/, which no other page covers.
      const midRow = (body: string) => {
        const blocks = body.split(ROW);
        blocks.splice(10, 1);
        return blocks.join(ROW);
      };
      const { observations, error, warnings, listed, details } = await harvest(
        await stayingShort("/kia/16/", midRow),
        "full",
        {},
        undefined,
        ["kia", "mazda"],
      );
      expect(warnings).toContain(short);
      expect(warnings).toContain(unmatched);
      // The Kia walk is redone once, then the Mazda census runs as usual.
      expect(listed.filter((path) => path === "/kia/")).toHaveLength(4);
      expect(listed.filter((path) => path.startsWith("/mazda/"))).toEqual([
        "/mazda/",
        "/mazda/16/",
        "/mazda/32/",
        "/mazda/48/",
        "/mazda/",
        "/mazda/16/",
      ]);
      // Kia yields nothing: its ad pages are not read (the two categories list the same
      // ads, so each ad page is read once, for Mazda), nothing is retired, no slice is done.
      expect(new Set(details).size).toBe(details.length);
      expect(refs(observations).sort()).toEqual(IN_SCOPE);
      expect(observations.filter((o) => o.kind === "ListingGone")).toEqual([
        { kind: "ListingGone", ref: "224911426" },
      ]);
      expect(observations.flatMap((o) => (o.kind === "SliceDone" ? [o.slice] : []))).toEqual([
        "mazda;part=0/2",
        "mazda;part=1/2",
      ]);
      // The run fails at the end, so the census resumes with Kia only.
      expect(String(error)).toMatch(
        /categories not harvested whole: kia \(pages whose rows do not match their header: \/kia\/16\/ 19 of 20; met 58 ads of 59 counted\)$/,
      );
    });
  });

  describe("a census walk proves the known ads it meets live", () => {
    // 224452818 is on /kia/, 224899514 and 224873612 on /kia/16/; both even ids are in part 0.
    const known = new Set(["224452818", "224899514", "224873612"]);
    const isKnown = (ref: string) => known.has(ref);
    const prices = (os: Observation[]) =>
      os.filter((o): o is ListingPriceSeen => o.kind === "ListingPriceSeen");
    const failingAt32 = (c: Cassette) => {
      c.interactions = c.interactions.filter(({ request }) => pathOf(request.url) !== "/kia/32/");
    };
    const unreadable = (c: Cassette) =>
      inPages(
        c,
        '<span translate="no">  75 500 Kč</span>',
        '<span translate="no">neuvedena</span>',
        (url) => !url.includes("/inzerat/"),
      );

    it("as it meets them, so a request failing later keeps their sightings", async () => {
      const recorded = await cassette("full", failingAt32);
      const { observations, error, details } = await harvest(recorded, "full", { isKnown });
      expect(String(error)).toMatch(
        /No recorded interaction for https:\/\/auto.bazos.cz\/kia\/32\//,
      );
      expect(details).toEqual([]);
      // An ad moved here from another category is not missed in the part it left.
      expect(observations.every((o) => o.kind === "ListingPriceSeen")).toBe(true);
      expect(prices(observations).map((o) => o.ref)).toEqual([...known]);
      expect(prices(observations)).toContainEqual({
        kind: "ListingPriceSeen",
        ref: "224899514",
        price: { amount: 75_500, currency: "CZK" },
      });
    });

    it("in a walk not taken too", async () => {
      const recorded = await cassette("full", (c) =>
        inPages(
          c,
          "inzerátů z 59",
          "inzerátů z 70",
          (url, n) => n === 2 && !url.includes("/inzerat/"),
        ),
      );
      const { observations, error } = await harvest(recorded, "full", { isKnown });
      expect(String(error)).toMatch(/not harvested whole: kia/);
      expect(prices(observations).map((o) => o.ref)).toEqual([...known]);
      expect(observations).toHaveLength(known.size);
    });

    it("in parts done earlier in the census, without their ad pages", async () => {
      const doneAt = new Date("2026-10-24T03:00:00Z");
      const { observations, error, details } = await harvest(await cassette("full"), "full", {
        isKnown,
        sliceDoneAt: (slice) => (slice === "kia;part=0/2" ? doneAt : null),
      });
      expect(error).toBeUndefined();
      expect(details.every((ref) => Number(ref) % 2 === 1)).toBe(true);
      expect(prices(observations).map((o) => o.ref)).toEqual([...known]);
      expect(observations.at(-1)).toEqual({ kind: "SliceDone", slice: "kia;part=1/2" });
    });

    it("an ad another category lists out of scope, when this one lists it", async () => {
      // 224899514 moved to Škoda, its price raised: Kia's list, read first, still shows it
      // at 9 000 Kč, out of scope there.
      const recorded = await cassette("full", (c) => {
        const skoda = c.interactions
          .filter(({ request }) => !request.url.includes("/inzerat/"))
          .map(({ request, response }) => {
            const url = request.url.replace("/kia/", "/skoda/");
            return { request: { ...request, url }, response: { ...response, url } };
          })
          .filter(({ request }) => pathOf(request.url) !== "/skoda/32/");
        inPages(
          c,
          '<span translate="no">  75 500 Kč</span>',
          '<span translate="no">  9 000 Kč</span>',
          (url) => url.includes("/kia/"),
        );
        c.interactions.push(...skoda);
      });
      const { observations, error } = await harvest(
        recorded,
        "full",
        { isKnown: (ref) => ref === "224899514" },
        undefined,
        ["kia", "skoda"],
      );
      expect(String(error)).toMatch(/No recorded interaction for .*\/skoda\/32\//);
      expect(observations.filter((o) => o.kind === "SliceDone")).toHaveLength(2);
      expect(prices(observations)).toEqual([
        { kind: "ListingPriceSeen", ref: "224899514", price: { amount: 75_500, currency: "CZK" } },
      ]);
    });

    it("an unreadable row by its rejected sighting, before a later request fails", async () => {
      const recorded = await cassette("full", (c) => {
        unreadable(c);
        failingAt32(c);
      });
      const { observations, error } = await harvest(recorded, "full", { isKnown });
      expect(String(error)).toMatch(
        /No recorded interaction for https:\/\/auto.bazos.cz\/kia\/32\//,
      );
      expect(prices(observations).map((o) => o.ref)).toEqual(["224452818", "224873612"]);
      const bad = listing(observations, "224899514");
      // Its part is named, so the Ledger keeps that part, not the next SliceDone, not done.
      expect(bad).toMatchObject({ slice: "kia;part=0/2" });
      expect(bad?.price.amount).toBeNaN();
    });

    it("an unreadable row in a part done earlier keeps the census from completing", async () => {
      const doneAt = new Date("2026-10-24T03:00:00Z");
      const { observations, error } = await harvest(await cassette("full", unreadable), "full", {
        isKnown,
        sliceDoneAt: (slice) => (slice === "kia;part=0/2" ? doneAt : null),
      });
      expect(listing(observations, "224899514")).toMatchObject({ slice: "kia;part=0/2" });
      expect(observations.at(-1)).toEqual({ kind: "SliceDone", slice: "kia;part=1/2" });
      expect(String(error)).toMatch(/slices with unreadable ads: kia;part=0\/2$/);
    });
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
