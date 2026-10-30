import { readFile } from "node:fs/promises";
import { type Cassette, createReplayHttp, HttpBlockedError, loadCassette } from "@cca/http";
import type { ListingGone, ListingPriceSeen, ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, type Logger, silentLogger } from "../source.ts";
import { type TipcarsOptions, tipcarsSource } from "./tipcars.ts";

// Recorded 2026-10-25 from devbox (T1) with the real adapter; bodies trimmed to what the
// parser reads (ld+json, each card's record, URL, seller, title, trim and price, the detail
// boxes). incremental: /ojete?2000-= and /nove, pages 1-2, with incremental.known.json
// (everything but the 5 newest used and 3 newest new/demo listings) as the Ledger's state.
// full: the slices used:2000 and used:2001, paged to their ends.
const incremental = new URL("./fixtures/incremental.cassette.json", import.meta.url);
const full = new URL("./fixtures/full.cassette.json", import.meta.url);
const knownRefs = new URL("./fixtures/incremental.known.json", import.meta.url);
// /ojete?2015-2015=&262000-266000kc=, recorded 2026-10-27 (T1) and trimmed the same way, filed
// under the URL of the slice used:2015: 14 listings in CZK and a Dubai dealer's in EUR.
const foreign = new URL("./fixtures/foreign-currency.cassette.json", import.meta.url);
// /ojete?2000-2000= split by price under a cap of 20 listings, recorded 2026-10-28 (T1) with
// the real adapter and trimmed the same way, each URL's identical repeats (recounts) dropped:
// replay serves a URL's last recording again. 62 listings, one of them "Dohodou".
const split = new URL("./fixtures/split.cassette.json", import.meta.url);
const now = new Date("2026-10-25T17:36:00Z");
const FULL_SLICES = ["used:2000", "used:2001"];
const FOREIGN_RUN = {
  mode: "full",
  options: { slices: ["used:2015"] },
  now: new Date("2026-10-27T21:40:00Z"),
} as const;

const SPLIT_RUN = {
  mode: "full",
  options: { slices: ["used:2000"], sliceCap: 20 },
  now: new Date("2026-10-28T23:11:06Z"),
} as const;

interface Run {
  mode: HarvestMode;
  /** Collects the URLs requested. */
  urls?: string[];
  /** Adds each yielded listing to `known`, as a Ledger recording during the run would. */
  live?: boolean;
  known?: ReadonlySet<string>;
  done?: readonly string[];
  options?: TipcarsOptions;
  /** The cassette's recording time; default `now`. */
  now?: Date;
  /** Receives the run's warnings. */
  warn?: Logger["warn"];
  /** Simulates a failed request after the earlier observations have been retained. */
  failAt?: string;
}

/** Collects into `out`, so a run that fails still shows what it yielded. */
async function harvest(
  cassette: Cassette,
  run: Run,
  out: Observation[] = [],
): Promise<Observation[]> {
  const replay = createReplayHttp(cassette);
  const at = run.now ?? now;
  // Incremental runs sweep no prices unless a test asks: the cassettes hold two pages a list.
  const source = tipcarsSource(
    run.options ?? (run.mode === "full" ? { slices: FULL_SLICES } : { priceSweep: 0 }),
  );
  for await (const o of source.harvest({
    http: {
      get(request) {
        run.urls?.push(typeof request === "string" ? request : request.url);
        if ((typeof request === "string" ? request : request.url) === run.failAt) {
          throw new Error("planned interruption");
        }
        return replay.get(request);
      },
    },
    mode: run.mode,
    checkpoint: {
      ...emptyCheckpoint,
      isKnown: (ref) => run.known?.has(ref) ?? false,
      sliceDoneAt: (slice) => (run.done?.includes(slice) ? at : null),
    },
    now: at,
    log: run.warn ? { ...silentLogger, warn: run.warn } : silentLogger,
    signal: new AbortController().signal,
  })) {
    out.push(o);
    if (run.live && o.kind === "ListingSeen") (run.known as Set<string>).add(o.ref);
  }
  return out;
}

async function known(): Promise<Set<string>> {
  return new Set(JSON.parse(await readFile(knownRefs, "utf8")) as string[]);
}

type Response = Cassette["interactions"][number]["response"];

/** The cassette with the response of the first interaction whose URL ends with `suffix` edited. */
function edit(
  cassette: Cassette,
  suffix: string,
  change: (response: Response) => Response,
): Cassette {
  const i = cassette.interactions.findIndex((x) => x.request.url.endsWith(suffix));
  if (i < 0) throw new Error(`no interaction for ${suffix}`);
  const interactions = cassette.interactions.map((x, j) =>
    j === i ? { ...x, response: change(x.response) } : x,
  );
  return { ...cassette, interactions };
}

const body = (f: (body: string) => string) => (r: Response) => ({ ...r, body: f(r.body) });

/**
 * The new list as 3 listings split into its price bands (cap 2): a and b in the cheapest, c in
 * the next; the list's own first page shows `shown`.
 */
async function newBands(shown?: (refs: [string, string, string]) => string[]) {
  const plain = await loadCassette(incremental);
  const cards = cardsOf(plain);
  const refs: [string, string, string] = ["9120302", "9120263", "12770757"];
  const [a, b, c] = refs;
  const edges = [
    0, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_200_000, 1_500_000, 2_000_000,
    3_000_000,
  ];
  let cassette = serve(plain, "https://www.tipcars.com/nove", [
    listPage(cards, 3, shown?.(refs) ?? refs),
  ]);
  edges.forEach((from, i) => {
    const to = edges[i + 1];
    const inBand = from === 0 ? [a, b] : from === 500_000 ? [c] : [];
    cassette = serve(
      cassette,
      `https://www.tipcars.com/nove?${from}-${to === undefined ? "" : to - 1}kc=`,
      [listPage(cards, inBand.length, inBand)],
    );
  });
  return { cassette, a, b, c };
}

const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const prices = (os: Observation[]) =>
  os.filter((o): o is ListingPriceSeen => o.kind === "ListingPriceSeen");
const slicesDone = (os: Observation[]) =>
  os.flatMap((o) => (o.kind === "SliceDone" ? [o.slice] : []));
const CARD = 'data-listing-item-id-value="';
/** A list page without its first `n` cards. */
const without = (n: number) => (b: string) => {
  const parts = b.split(CARD);
  parts.splice(1, n);
  return parts.join(CARD);
};
/** A list page whose card `ref` is one of the site's "Ostatní" bucket: make XX, no model. */
const other = (ref: string) => (b: string) => {
  const start = b.indexOf(`${CARD}${ref}"`);
  if (start < 0) throw new Error(`no card ${ref}`);
  const end = b.indexOf(CARD, start + CARD.length);
  const card = b
    .slice(start, end < 0 ? undefined : end)
    .replace(/(&quot;manufacturer&quot;:&quot;)\w+/, "$1XX")
    .replace(/(advertisement-name__title">\s*<h3>)[^<]*/, "$1 Ostatní ");
  return b.slice(0, start) + card + (end < 0 ? "" : b.slice(end));
};

/** Each card's markup on the list pages of `cassette`, by ref. */
function cardsOf(cassette: Cassette): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of cassette.interactions) {
    for (const chunk of x.response.body.split(CARD).slice(1)) {
      out.set(chunk.slice(0, chunk.indexOf('"')), CARD + chunk.replace("</body></html>", ""));
    }
  }
  return out;
}

/** A list page that reports `total` listings and serves the cards `refs`. */
function listPage(cards: Map<string, string>, total: number, refs: readonly string[]): string {
  const list = `{"@type":"ItemList","numberOfItems":${total},"itemListElement":[]}`;
  const markup = refs.map((ref) => cards.get(ref) ?? "");
  return `<html><head><script type="application/ld+json">${list}</script></head><body>${markup.join("")}</body></html>`;
}

/** `cassette` with `url` answered by `bodies` in turn (the last one from then on). */
function serve(cassette: Cassette, url: string, bodies: readonly string[]): Cassette {
  const template = cassette.interactions[0] as Cassette["interactions"][number];
  const others = cassette.interactions.filter((x) => x.request.url !== url);
  const answers = bodies.map((b) => ({
    request: { url },
    response: { ...template.response, url, body: b },
  }));
  return { ...cassette, interactions: [...answers, ...others] };
}

describe("tipcars source", () => {
  it("incremental run yields the listings the Ledger does not know, newest first, and stops", async () => {
    // Page 2 of each list is all known, so no page 3 is requested (replay would miss it).
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const seen = listings(os);
    expect(seen.map((o) => [o.ref, o.condition])).toEqual([
      ["55973672", "used"],
      ["100171424", "used"],
      ["55973671", "used"],
      ["26641783", "used"],
      ["26641788", "used"],
      ["9120302", "demo"],
      ["9120263", "demo"],
      ["12770757", "new"],
    ]);
    expect(slicesDone(os)).toEqual([]);
    // The same against a checkpoint that learns this run's listings as they are recorded.
    const live = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      live: true,
    });
    expect(listings(live).map((o) => o.ref)).toEqual(seen.map((o) => o.ref));
  });

  it("an Ostatní card without a model is out of scope and does not keep the incremental walk going", async () => {
    // 100171421 leads page 2 of the used list. Unknown and in the scope it would send the
    // walk on to page 3, which replay does not have.
    const cassette = edit(
      await loadCassette(incremental),
      "/ojete?str=2-20&2000-=",
      body(other("100171421")),
    );
    const knownBefore = await known();
    knownBefore.delete("100171421");
    const os = await harvest(cassette, { mode: "incremental", known: knownBefore });
    expect(listings(os).map((o) => o.ref)).not.toContain("100171421");
    expect(listings(os)).toHaveLength(8);
  });

  it("a full run leaves Ostatní cards without a model out and still finishes the slice", async () => {
    const plain = await loadCassette(full);
    const page = plain.interactions.find((x) => x.request.url.endsWith("/ojete?2000-2000="));
    const ref = page?.response.body.split(CARD)[1]?.split('"')[0] ?? "";
    const os = await harvest(edit(plain, "/ojete?2000-2000=", body(other(ref))), { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const seen = listings(os);
    expect(seen.map((o) => o.ref)).not.toContain(ref);
    expect(seen.every((o) => o.vehicle.make && o.vehicle.model)).toBe(true);
    expect(seen).toHaveLength(listings(await harvest(plain, { mode: "full" })).length - 1);
  });

  it("maps a used listing from its list card", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const kodiaq = listings(os).find((o) => o.ref === "100171424");
    expect(kodiaq).toMatchObject({
      url: "https://www.tipcars.com/skoda-kodiaq/suv/nafta/skoda-kodiaq-100171424.html",
      market: "CZ",
      condition: "used",
      vehicle: {
        make: "Škoda",
        model: "Kodiaq",
        sourceTaxonomy: { make: "BT", model: "BTS" },
        manufactureYear: 2019,
        body: "suv",
        fuel: "diesel",
        powerKw: 176,
        engineCc: 1968,
        seats: 5,
        doors: 5,
      },
      odometerKm: 51000,
      price: { amount: 773190, currency: "CZK" },
      // The card shows a "bez DPH" price under it: VAT is deductible.
      priceBasis: "gross",
      seller: "unknown",
    });
    expect(kodiaq?.photos).toHaveLength(1);
    expect(kodiaq?.photos[0]).toMatch(/^https:\/\/g\.tipcars\.com\//);
    const i30 = listings(os).find((o) => o.ref === "26641783");
    expect(i30).toMatchObject({
      vehicle: { make: "Hyundai", model: "i30", trim: "1,0 T-GDi 88kW CZ Trikolor", body: "wagon" },
      priceBasis: "unknown",
      location: { city: "DAVO CAR Olbramovice 203 Votice" },
    });
    expect(i30?.vehicle.transmission).toBeUndefined();
  });

  it("reads new and demo listings from their detail page", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const demo = listings(os).find((o) => o.ref === "9120302");
    expect(demo).toMatchObject({
      condition: "demo",
      vehicle: {
        make: "Volkswagen",
        model: "Caravelle",
        trim: "Nový T7 Style 2,0 TDI 4MOT 8AU",
        firstRegistration: { year: 2026, month: 1 },
        body: "van",
        fuel: "diesel",
        powerKw: 125,
        transmission: "automatic",
        euroClass: 6,
        color: "světle šedá metalíza",
      },
      odometerKm: 20000,
      price: { amount: 1330204, currency: "CZK" },
      priceBasis: "gross",
      seller: "dealer",
      location: { city: "Zlín", postcode: "76001" },
      inspectionValidUntil: { year: 2030, month: 1 },
    });
    expect(demo?.vehicle.manufactureYear).toBeUndefined();
    expect(demo?.photos.length).toBeGreaterThan(1);
    const fresh = listings(os).find((o) => o.ref === "12770757");
    expect(fresh).toMatchObject({
      condition: "new",
      vehicle: { make: "Hyundai", model: "Tucson", manufactureYear: 2026, fuel: "petrol" },
      seller: "dealer",
    });
    expect(fresh?.odometerKm).toBeUndefined();
  });

  it("a detail page that is gone yields ListingGone", async () => {
    const cassette = edit(await loadCassette(incremental), "-12770757.html", (r) => ({
      ...r,
      status: 404,
    }));
    const os = await harvest(cassette, { mode: "incremental", known: await known() });
    expect(os.filter((o): o is ListingGone => o.kind === "ListingGone")).toEqual([
      { kind: "ListingGone", ref: "12770757" },
    ]);
  });

  it("a detail page that states neither new nor demo gives a ListingSeen the Ledger rejects", async () => {
    const cassette = edit(
      await loadCassette(incremental),
      "-12770757.html",
      body((b) => b.replace(/Stav: [^.]+\./, "Stav: neuvedeno.")),
    );
    const os = await harvest(cassette, { mode: "incremental", known: await known() });
    const seen = listings(os);
    // Rejected for its empty url; its ref stays, so the Ledger keeps its slice not done.
    expect(seen.filter((o) => o.url === "").map((o) => o.ref)).toEqual(["12770757"]);
    expect(seen.map((o) => o.ref)).toContain("9120302");
  });

  it("full run pages every slice to its end and reports it done", async () => {
    const os = await harvest(await loadCassette(full), { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const seen = listings(os);
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(20); // more than one page
    // "Dohodou" (no price) listings are outside the scope but count towards the slice.
    expect(seen.map((o) => o.ref)).not.toContain("27327884");
    expect(seen.every((o) => o.condition === "used" && o.price.currency === "CZK")).toBe(true);
    // Each slice's listings come before its SliceDone.
    const firstDone = os.findIndex((o) => o.kind === "SliceDone");
    expect(listings(os.slice(0, firstDone)).every((o) => o.vehicle.manufactureYear === 2000)).toBe(
      true,
    );
  });

  it("full run yields the listings a pass meets as it meets them, so a later failure keeps them", async () => {
    const all = listings(await harvest(await loadCassette(full), { mode: "full" }));
    const cassette = await loadCassette(full);
    cassette.interactions = cassette.interactions.filter(
      ({ request }) => !request.url.includes("str=3-20&2000-2000="),
    );
    const out: Observation[] = [];
    await expect(harvest(cassette, { mode: "full" }, out)).rejects.toThrow(
      /No recorded interaction for .*str=3-20&2000-2000=/,
    );
    // Pages 1 and 2 of used:2000: a listing moved here from a slice that finishes stays live.
    expect(out.length).toBeGreaterThan(20);
    expect(out.every((o) => o.kind === "ListingSeen" && o.slice === "used:2000")).toBe(true);
    const in2000 = all.filter((o) => o.slice === "used:2000");
    expect(listings(out)).toEqual(in2000.slice(0, out.length));
  });

  it.each([
    [
      "paged before its detail pages",
      { maxPages: 1, sliceCap: 1_000_000 },
      /new has more than 1 pages/,
    ],
    ["split by price", {}, /No recorded interaction for .*\/nove\?/],
  ])(
    "full run proves a known new or demo listing live from its card as it is read, in a slice %s",
    async (_, options, failure) => {
      const knownBefore = await known();
      const urls: string[] = [];
      const out: Observation[] = [];
      const run = { mode: "full", known: knownBefore, urls } as const;
      await expect(
        harvest(
          await loadCassette(incremental),
          { ...run, options: { slices: ["new"], ...options } },
          out,
        ),
      ).rejects.toThrow(failure);
      // The new list's first page, before any detail page: a listing moved here from a slice
      // that finishes stays live.
      expect(urls.filter((u) => u.endsWith(".html"))).toEqual([]);
      expect(out.length).toBeGreaterThan(10);
      expect(out.every((o) => o.kind === "ListingPriceSeen" && knownBefore.has(o.ref))).toBe(true);
      expect(new Set(prices(out).map((o) => o.ref)).size).toBe(out.length);
    },
  );

  it("full run gives a known new or demo card whose currency does not parse a rejected sighting as it is read", async () => {
    const ref = "9120302";
    const cassette = edit(
      await loadCassette(incremental),
      "/nove",
      body((b) => {
        const start = b.indexOf(`${CARD}${ref}"`);
        const end = b.indexOf(CARD, start + CARD.length);
        const card = b
          .slice(start, end)
          .replace("price_currency&quot;:&quot;A&quot;", "price_currency&quot;:&quot;X&quot;");
        return b.slice(0, start) + card + b.slice(end);
      }),
    );
    const out: Observation[] = [];
    const options = { slices: ["new"], maxPages: 1, sliceCap: 1_000_000 };
    const knownBefore = new Set([...(await known()), ref]);
    await expect(
      harvest(cassette, { mode: "full", known: knownBefore, options }, out),
    ).rejects.toThrow(/new has more than 1 pages/);
    // It still proves the listing live, and keeps the slice not done.
    expect(listings(out)).toEqual([expect.objectContaining({ ref, url: "" })]);
    expect(prices(out).some((o) => o.ref === ref)).toBe(false);
  });

  it("an interrupted full run retains its finished slices and the next run finishes the census", async () => {
    const cassette = await loadCassette(full);
    const all = await harvest(cassette, { mode: "full" });
    const partial: Observation[] = [];
    const nextSlice = "https://www.tipcars.com/ojete?2001-2001=";
    await expect(harvest(cassette, { mode: "full", failAt: nextSlice }, partial)).rejects.toThrow(
      "planned interruption",
    );
    expect(slicesDone(partial)).toEqual(["used:2000"]);

    const urls: string[] = [];
    const resumed = await harvest(cassette, {
      mode: "full",
      known: new Set(listings(partial).map((o) => o.ref)),
      done: slicesDone(partial),
      urls,
    });
    expect(urls.every((url) => url.includes("2001-2001="))).toBe(true);
    expect(slicesDone(resumed)).toEqual(["used:2001"]);
    expect([...slicesDone(partial), ...slicesDone(resumed)]).toEqual(FULL_SLICES);
    expect(listings([...partial, ...resumed])).toEqual(listings(all));
  });

  it("a malformed card comes out as a ListingSeen the Ledger rejects; the run goes on", async () => {
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body((b) => b.replace(/data-measure-data-value="[^"]*"/, 'data-measure-data-value="{x"')),
    );
    const os = await harvest(cassette, { mode: "full" });
    const seen = listings(os);
    expect(seen.filter((o) => o.url === "")).toHaveLength(1);
    // It names no slice, so the Ledger keeps the part it came out in not done.
    expect(seen.find((o) => o.url === "")?.slice).toBeUndefined();
    expect(
      seen
        .filter((o) => o.url !== "")
        .every((o) => o.slice === "used:2000" || o.slice === "used:2001"),
    ).toBe(true);
    expect(seen.length).toBe(
      listings(await harvest(await loadCassette(full), { mode: "full" })).length,
    );
    expect(slicesDone(os)).toEqual(FULL_SLICES);
  });

  it("a slice over the cap is split by price, dearer half first, until each part fits", async () => {
    const cassette = await loadCassette(split);
    const urls: string[] = [];
    const os = await harvest(cassette, { ...SPLIT_RUN, urls });
    const done = slicesDone(os);
    expect(done.slice(0, 2)).toEqual(["used:2000:1000000-", "used:2000:500000-999999"]);
    expect(done.at(-1)).toBe("used:2000");
    expect(new Set(done).size).toBe(13); // the year and 12 price parts
    // Each part under the cap was harvested whole on its first page, each listing once.
    expect(urls.some((u) => u.includes("str=") && u.includes("kc="))).toBe(false);
    const inParts = cassette.interactions
      .filter((x) => x.request.url.includes("kc="))
      .map((x) => Number(/"numberOfItems":\s*(\d+)/.exec(x.response.body)?.[1]))
      .filter((n) => n <= 20)
      .reduce((sum, n) => sum + n, 0);
    const seen = listings(os);
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    expect(seen).toHaveLength(inParts);
    expect(seen.every((o) => o.vehicle.manufactureYear === 2000)).toBe(true);
    // The year reports one listing more than its parts, a "Dohodou" one no price filter
    // returns: one pass over the whole year met all 62, so it needed no proof.
    expect(urls.filter((u) => u.includes("str=")).length).toBe(3);
  });

  it("a split slice resumes from its parts done earlier in the census", async () => {
    const cassette = await loadCassette(split);
    const all = slicesDone(await harvest(cassette, SPLIT_RUN));
    const upper = cassette.interactions.find((x) => x.request.url.endsWith("&1000000-kc="));
    const inUpper = (upper?.response.body.split(CARD).slice(1) ?? []).map((c) => c.split('"')[0]);
    const os = await harvest(cassette, { ...SPLIT_RUN, done: ["used:2000:1000000-"] });
    expect(slicesDone(os)).toEqual(all.slice(1));
    // The part done earlier is paged again to tell its listings from the year's others; its
    // used listings come out again, so one that moved into it since it was done is still met.
    expect(inUpper).toHaveLength(2);
    expect(listings(os).filter((o) => inUpper.includes(o.ref))).toHaveLength(2);
  });

  describe("a completed nested part whose whole pages omit a listing", () => {
    async function setup() {
      const plain = await loadCassette(split);
      const cards = cardsOf(plain);
      const refs = [...cards.keys()]
        .filter((ref) => !/Dohodou/.test(cards.get(ref) ?? ""))
        .slice(0, 21);
      const root = "https://www.tipcars.com/ojete?2000-2000=";
      let cassette = serve(plain, root, [listPage(cards, 21, refs.slice(0, 20))]);
      for (const [band, part] of [
        ["1000000-", []],
        ["0-999999", refs],
        ["500000-999999", []],
        ["0-499999", refs],
        ["250000-499999", refs.slice(20)],
        ["0-249999", refs.slice(0, 20)],
      ] as const) {
        cassette = serve(cassette, `${root}&${band}kc=`, [
          listPage(cards, part.length, part.slice(0, 20)),
        ]);
      }
      // The larger query repeats its first card on page 2 instead of returning the 21st.
      cassette = serve(cassette, "https://www.tipcars.com/ojete?str=2-20&2000-2000=&0-499999kc=", [
        listPage(cards, 21, refs.slice(0, 1)),
      ]);
      const initial = await harvest(cassette, SPLIT_RUN);
      const done = slicesDone(initial).filter(
        (key) => key !== "used:2000" && key !== "used:2000:0-999999",
      );
      return { cards, refs, root, cassette, initial, done };
    }

    it("resumes through independently complete smaller bands", async () => {
      const { root, cassette, initial, done } = await setup();
      const urls: string[] = [];
      const resumed = await harvest(cassette, { ...SPLIT_RUN, done, urls });
      expect(new Set(listings(resumed).map((o) => o.ref))).toEqual(
        new Set(listings(initial).map((o) => o.ref)),
      );
      expect(slicesDone(resumed)).toEqual(["used:2000:0-999999", "used:2000"]);
      expect(urls).toContain(`${root}&250000-499999kc=`);
      // Recovery adds two child reads and five reconciliation reads to the short reread.
      expect(urls.filter((url) => url.endsWith("&250000-499999kc="))).toHaveLength(3);
      expect(urls.filter((url) => url.endsWith("&0-249999kc="))).toHaveLength(2);
    });

    it("leaves the parent unfinished when a stable listing is excluded by both smaller bands", async () => {
      const { cards, root, cassette, done } = await setup();
      const gap = serve(cassette, `${root}&250000-499999kc=`, [listPage(cards, 0, [])]);
      const out: Observation[] = [];
      await expect(harvest(gap, { ...SPLIT_RUN, done }, out)).rejects.toThrow(
        /used:2000:0-499999 \(listings in neither half\)/,
      );
      expect(slicesDone(out)).toEqual([]);
    });

    it("never pools the short parent pass with an incomplete smaller band", async () => {
      const { cards, refs, root, cassette, done } = await setup();
      const short = serve(cassette, `${root}&0-249999kc=`, [
        listPage(cards, 20, refs.slice(0, 19)),
      ]);
      const out: Observation[] = [];
      await expect(harvest(short, { ...SPLIT_RUN, done }, out)).rejects.toThrow(
        /used:2000:0-249999 \(20 reported at the end, 19 harvested\)/,
      );
      // The short parent and children saw 21 together, but no complete traversal did.
      expect(new Set(listings(out).map((o) => o.ref)).size).toBe(21);
      expect(slicesDone(out)).toEqual([]);
    });

    it("keeps sightings when a recovery request fails without completing the parent", async () => {
      const { refs, root, cassette, done } = await setup();
      const out: Observation[] = [];
      await expect(
        harvest(cassette, { ...SPLIT_RUN, done, failAt: `${root}&0-249999kc=` }, out),
      ).rejects.toThrow("planned interruption");
      expect(new Set(listings(out).map((o) => o.ref))).toEqual(new Set(refs));
      expect(slicesDone(out)).toEqual([]);
    });
  });

  it("a slice short on every pass over more pages is split in two by price, each part done", async () => {
    // Paging by offset can serve a listing on two pages and push another off both, the same
    // way on every pass: used:2000 comes out one short twice, so it is split at 1,000,000 Kč.
    const plain = await loadCassette(full);
    const root = "https://www.tipcars.com/ojete?2000-2000=";
    let cassette = edit(plain, "/ojete?2000-2000=", body(without(1)));
    // The lower part serves the slice's recorded pages whole; the upper one is empty.
    for (const x of plain.interactions.filter((i) => i.request.url.includes("2000-2000="))) {
      const url = x.request.url.replace("2000-2000=", "2000-2000=&0-999999kc=");
      cassette = serve(cassette, url, [x.response.body]);
    }
    cassette = serve(cassette, `${root}&1000000-kc=`, [listPage(cardsOf(plain), 0, [])]);
    const urls: string[] = [];
    const os = await harvest(cassette, { mode: "full", urls });
    // Two passes, then counted before and after its halves.
    expect(urls.filter((u) => u === root)).toHaveLength(4);
    expect(slicesDone(os)).toEqual([
      "used:2000:1000000-",
      "used:2000:0-999999",
      "used:2000",
      "used:2001",
    ]);
    const whole = await harvest(plain, { mode: "full" });
    expect(new Set(listings(os).map((o) => o.ref))).toEqual(
      new Set(listings(whole).map((o) => o.ref)),
    );
  });

  it("passes are never pooled: churn between two short passes does not finish a slice", async () => {
    // The count stays 3. Pass 1 meets A and B; then A goes and D arrives; pass 2 meets B and
    // D. Together they reach 3, yet C was never met.
    const plain = await loadCassette(full);
    const cards = cardsOf(plain);
    const [a, b, , d] = [...cards.keys()] as [string, string, string, string];
    const root = "https://www.tipcars.com/ojete?2000-2000=";
    const cassette = serve(plain, root, [listPage(cards, 3, [a, b]), listPage(cards, 3, [b, d])]);
    const os: Observation[] = [];
    const urls: string[] = [];
    await expect(harvest(cassette, { mode: "full", urls }, os)).rejects.toThrow(
      /fewer listings than reported: used:2000$/,
    );
    expect(slicesDone(os)).toEqual(["used:2001"]);
    // Paged twice; one page is too few to split for.
    expect(urls.filter((u) => u === root)).toHaveLength(2);
    expect(urls.some((u) => u.includes("kc="))).toBe(false);
  });

  describe("a year with a listing no price filter returns", () => {
    // used:2000 reports 21 (22) listings, more than the cap of 20, so it is split. Its lower
    // half meets 20 of them and its upper one none; a whole pass over the year serves X but
    // the 20th listing twice, so it comes out short and X needs proving.
    const root = "https://www.tipcars.com/ojete?2000-2000=";
    interface Change {
      /** X's detail page when first read, and when read again after the final recount. */
      detail?: Partial<Response>;
      later?: Partial<Response>;
      /** X's price band returns X. */
      inBand?: boolean;
      /** X rises from its card's price into the upper half after that half is harvested. */
      rises?: boolean;
      /**
       * The Ledger knows X, the year's first page and recounts do not show it, and the whole
       * pass fails after its first page.
       */
      passFails?: boolean;
    }
    async function year(total: number, change: Change = {}) {
      const plain = await loadCassette(full);
      const cards = cardsOf(plain);
      const priced = [...cards].filter(([, markup]) => !/Dohodou/.test(markup));
      const [x, xMarkup] = priced[20] as [string, string];
      const r = priced.slice(0, 20).map(([ref]) => ref);
      const price = /advertisement-name__price">([\s\S]*?)<\/section>/.exec(xMarkup)?.[1] ?? "";
      const kc = Number(/(\d+)Kč/.exec(price.replace(/<[^>]*>|&nbsp;|\s/g, ""))?.[1]);
      const record = /&quot;price&quot;:(\d+)/.exec(xMarkup)?.[1];
      const path = /data-offer-listing-url-param="([^"]*)"/.exec(xMarkup)?.[1] ?? "";
      const page = (refs: string[]) => listPage(cards, total, refs);
      const pass = page([...r.slice(0, 19), x]);
      let cassette = serve(
        plain,
        root,
        change.passFails ? [page(r), page(r), page(r), pass] : [pass],
      );
      const second = `https://www.tipcars.com/ojete?str=2-20&2000-2000=`;
      cassette = serve(cassette, second, [page([r[18] as string])]);
      if (change.passFails) {
        cassette.interactions = cassette.interactions.filter((i) => i.request.url !== second);
      }
      const risen = new Map(cards).set(
        x,
        xMarkup
          .replace(/(advertisement-name__price">)[\s\S]*?(<\/section>)/, "$1 1 100 000 Kč$2")
          .replace(/(&quot;price&quot;:)\d+/, (_, field) => `${field}1100000`),
      );
      cassette = serve(cassette, `${root}&1000000-kc=`, [
        listPage(cards, 0, []),
        ...(change.rises ? [listPage(risen, 1, [x])] : []),
      ]);
      cassette = serve(cassette, `${root}&0-999999kc=`, [listPage(cards, 20, r)]);
      cassette = serve(cassette, `${root}&${kc - 1}-${kc + 1}kc=`, [
        listPage(
          cards,
          change.inBand ? 2 : 1,
          change.inBand ? [r[0] as string, x] : [r[0] as string],
        ),
      ]);
      const product = `{"@type":"Product","offers":{"price":${record},"priceCurrency":"CZK"}}`;
      const detail = `<script type="application/ld+json">${product}</script><div class="detail-box__info-icon">vyrobeno:</div>2000</div>`;
      cassette = serve(cassette, new URL(path, "https://www.tipcars.com").href, [detail, detail]);
      let read = 0;
      const interactions = cassette.interactions.map((i) =>
        i.request.url.endsWith(path)
          ? { ...i, response: { ...i.response, ...(read++ === 0 ? change.detail : change.later) } }
          : i,
      );
      cassette = { ...cassette, interactions };
      const os: Observation[] = [];
      const run = harvest(
        cassette,
        {
          mode: "full",
          options: { slices: ["used:2000"], sliceCap: 20 },
          ...(change.passFails ? { known: new Set([x]) } : {}),
        },
        os,
      );
      return { x, os, run, record: Number(record) };
    }

    it("is done when that listing is proven: online, of the year, and not in its price band", async () => {
      const { x, os, run } = await year(21);
      await run;
      expect(slicesDone(os)).toEqual(["used:2000:1000000-", "used:2000:0-999999", "used:2000"]);
      expect(listings(os).map((o) => o.ref)).toContain(x);
    });

    it("proves a known listing its whole pass meets live as it is read, before a later failure", async () => {
      const { x, os, run, record } = await year(21, { passFails: true });
      await expect(run).rejects.toThrow(/No recorded interaction for .*str=2-20&2000-2000=/);
      expect(prices(os)).toEqual([
        { kind: "ListingPriceSeen", ref: x, price: { amount: record, currency: "CZK" } },
      ]);
      expect(listings(os).map((o) => o.ref)).not.toContain(x);
    });

    it("is not done when a listing rises into the upper half after it is harvested", async () => {
      // The recount balances (the upper half now holds X), but X never came out of a part:
      // 21 reported, 20 harvested. The whole pass meets X, which then counts towards no band.
      const { x, os, run } = await year(21, { rises: true });
      await expect(run).rejects.toThrow(/used:2000 \(0 listings in no price band, 1 proven\)/);
      expect(slicesDone(os)).toEqual(["used:2000:1000000-", "used:2000:0-999999"]);
      expect(listings(os).map((o) => o.ref)).toContain(x);
    });

    it("is not done when that listing leaves the year by its final check", async () => {
      const { os, run } = await year(21, {
        later: { body: '<div class="detail-box__info-icon">vyrobeno:</div>2001</div>' },
      });
      await expect(run).rejects.toThrow(
        /used:2000 \(1 listings in no price band, 0 proven; not proven: 1 outside the slice; 21 reported at the end, 20 harvested\)/,
      );
      expect(slicesDone(os)).not.toContain("used:2000");
    });

    it("is not done when that listing is repriced by its final check", async () => {
      const { run } = await year(21, {
        later: {
          body: '<script type="application/ld+json">{"@type":"Product","offers":{"price":1,"priceCurrency":"CZK"}}</script><div class="detail-box__info-icon">vyrobeno:</div>2000</div>',
        },
      });
      await expect(run).rejects.toThrow(/not proven: 1 repriced/);
    });

    it("is not done when that listing is gone by the time it is checked", async () => {
      const { x, os, run } = await year(21, { detail: { status: 404 } });
      await expect(run).rejects.toThrow(
        /used:2000 \(1 listings in no price band, 0 proven; not proven: 1 gone; 21 reported at the end, 20 harvested\)/,
      );
      expect(slicesDone(os)).not.toContain("used:2000");
      expect(os).toContainEqual({ kind: "ListingGone", ref: x });
    });

    it("is not done when that listing is gone by the final check, after the recount", async () => {
      const { x, os, run } = await year(21, { later: { status: 404 } });
      await expect(run).rejects.toThrow(
        /used:2000 \(1 listings in no price band, 0 proven; not proven: 1 gone; 21 reported at the end, 20 harvested\)/,
      );
      expect(slicesDone(os)).not.toContain("used:2000");
      expect(os).toContainEqual({ kind: "ListingGone", ref: x });
    });

    it("is not done when the band around that listing's price returns it", async () => {
      const { run } = await year(21, { inBand: true });
      await expect(run).rejects.toThrow(/not proven: 1 returned by their price band/);
    });

    it("is not done when fewer listings are proven than its parts miss", async () => {
      // 22 reported: another listing outside every band was pushed off the whole pass.
      const { os, run } = await year(22);
      await expect(run).rejects.toThrow(
        /used:2000 \(2 listings in no price band, 1 proven; 22 reported at the end, 21 harvested\)/,
      );
      expect(slicesDone(os)).not.toContain("used:2000");
    });
  });

  it("a slice short on its first pass and whole on its second is done", async () => {
    // Replay serves a URL's recordings in order: the first pass sees page 1 without a card.
    const cassette = await loadCassette(full);
    const i = cassette.interactions.findIndex((x) => x.request.url.endsWith("/ojete?2000-2000="));
    const first = cassette.interactions[i] as Cassette["interactions"][number];
    const parts = first.response.body.split(CARD);
    parts.splice(1, 1);
    const short = { ...first, response: { ...first.response, body: parts.join(CARD) } };
    const interactions = [...cassette.interactions];
    interactions.splice(i, 0, short);
    const os = await harvest({ ...cassette, interactions }, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const whole = await harvest(await loadCassette(full), { mode: "full" });
    expect(
      listings(os)
        .map((o) => o.ref)
        .sort(),
    ).toEqual(
      listings(whole)
        .map((o) => o.ref)
        .sort(),
    );
  });

  it("an empty slice is done", async () => {
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body(
        () =>
          '<script type="application/ld+json">{"@type":"ItemList","numberOfItems":0,"itemListElement":[]}</script>',
      ),
    );
    const os = await harvest(cassette, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    expect(listings(os).some((o) => o.vehicle.manufactureYear === 2000)).toBe(false);
  });

  it("a card whose price does not parse gives a ListingSeen the Ledger rejects", async () => {
    // Not "Dohodou": the card still shows a price, its record lacks it.
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body((b) => b.replace(/&quot;price&quot;:[1-9]\d*,/, "")),
    );
    const seen = listings(await harvest(cassette, { mode: "full" }));
    expect(seen.filter((o) => !Number.isFinite(o.price.amount))).toHaveLength(1);
  });

  it("prices a listing in the seller's currency, not the card's conversion to Kč", async () => {
    const os = await harvest(await loadCassette(foreign), FOREIGN_RUN);
    expect(slicesDone(os)).toEqual(["used:2015"]);
    const seen = listings(os);
    expect(seen).toHaveLength(15);
    // The card shows 264 673 Kč and 218 739 Kč bez DPH; its record and detail page say EUR.
    expect(seen.find((o) => o.ref === "56607021")).toMatchObject({
      vehicle: { make: "Jeep", model: "Wrangler", manufactureYear: 2015 },
      odometerKm: 199000,
      price: { amount: 10830, currency: "EUR" },
      priceBasis: "gross",
      location: { city: "Dubai" },
    });
    expect(seen.filter((o) => o.price.currency === "CZK")).toHaveLength(14);
  });

  it("a price in an unknown currency gives a ListingSeen the Ledger rejects", async () => {
    const cassette = edit(
      await loadCassette(foreign),
      "/ojete?2015-2015=",
      body((b) =>
        b.replace("price_currency&quot;:&quot;L&quot;", "price_currency&quot;:&quot;X&quot;"),
      ),
    );
    const seen = listings(await harvest(cassette, FOREIGN_RUN));
    const bad = seen.find((o) => o.ref === "56607021");
    expect(bad?.price).toEqual({ amount: 10830, currency: "" });
    // It names no slice, so the Ledger keeps the part it came out in not done.
    expect(bad?.slice).toBeUndefined();
    expect(seen.filter((o) => o.ref !== "56607021").every((o) => o.slice === "used:2015")).toBe(
      true,
    );
  });

  it("a changed list page fails the run", async () => {
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body(() => "<html></html>"),
    );
    await expect(harvest(cassette, { mode: "full" })).rejects.toThrow(/TipCars page changed/);
  });

  it("a bot challenge fails the run", async () => {
    const cassette = edit(await loadCassette(full), "/ojete?2000-2000=", (r) => ({
      ...r,
      status: 403,
      headers: { "cf-mitigated": "challenge" },
    }));
    await expect(harvest(cassette, { mode: "full" })).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("maxPages bounds incremental walks and fails a full slice that needs more", async () => {
    const urls: string[] = [];
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      options: { maxPages: 1 },
      urls,
    });
    expect(listings(os)).toHaveLength(8);
    expect(urls.filter((u) => !u.endsWith(".html"))).toEqual([
      "https://www.tipcars.com/ojete?2000-=",
      "https://www.tipcars.com/nove",
    ]);
    await expect(
      harvest(await loadCassette(full), {
        mode: "full",
        options: { slices: FULL_SLICES, maxPages: 1 },
      }),
    ).rejects.toThrow(/more than 1 pages/);
  });

  it("slices narrow full runs only", async () => {
    await expect(
      harvest(await loadCassette(incremental), {
        mode: "incremental",
        options: { slices: ["used:2000"] },
      }),
    ).rejects.toThrow(/full runs only/);
  });

  describe("daily prices", () => {
    const usedHead = "https://www.tipcars.com/ojete?2000-=";
    const day = (n: number) => new Date(now.getTime() + n * 86_400_000);

    it("incremental run prices the known listings it walks past, from their cards", async () => {
      const knownBefore = await known();
      const urls: string[] = [];
      const os = await harvest(await loadCassette(incremental), {
        mode: "incremental",
        known: knownBefore,
        urls,
      });
      const priced = prices(os);
      // Pages 1-2 of both lists, less the 8 new listings and any "Dohodou" card.
      expect(priced.length).toBeGreaterThan(60);
      expect(priced.every((o) => knownBefore.has(o.ref) && o.price.currency === "CZK")).toBe(true);
      expect(new Set(priced.map((o) => o.ref)).size).toBe(priced.length);
      // New and demo ones too, without their detail pages: only the 3 new listings' are read.
      expect(urls.filter((u) => u.endsWith(".html"))).toHaveLength(3);
      const listed = new Set(listings(os).map((o) => o.ref));
      expect(priced.some((o) => listed.has(o.ref))).toBe(false);
    });

    it("a known listing's price change shows in the next day's incremental run", async () => {
      const knownBefore = await known();
      const plain = await loadCassette(incremental);
      const ref = "100171421"; // leads page 2 of the used list
      const priceOf = (os: Observation[]) => prices(os).find((o) => o.ref === ref)?.price;
      const before = priceOf(await harvest(plain, { mode: "incremental", known: knownBefore }));
      expect(before?.currency).toBe("CZK");
      const repriced = edit(
        plain,
        "/ojete?str=2-20&2000-=",
        body((b) => {
          const start = b.indexOf(`${CARD}${ref}"`);
          const end = b.indexOf(CARD, start + CARD.length);
          const card = b
            .slice(start, end)
            .replace(
              /(&quot;price&quot;:)\d+/,
              (_, field) => `${field}${(before?.amount ?? 0) - 10000}`,
            );
          return b.slice(0, start) + card + b.slice(end);
        }),
      );
      const after = await harvest(repriced, {
        mode: "incremental",
        known: knownBefore,
        now: day(1),
      });
      expect(priceOf(after)).toEqual({ amount: (before?.amount ?? 0) - 10000, currency: "CZK" });
    });

    it("prices a listing in the seller's currency, as its ListingSeen does", async () => {
      const page = (await loadCassette(foreign)).interactions[0]?.response.body ?? "";
      const refs = page
        .split(CARD)
        .slice(1)
        .map((c) => c.split('"')[0] as string);
      let cassette = serve(await loadCassette(foreign), usedHead, [page]);
      cassette = serve(cassette, "https://www.tipcars.com/nove", [listPage(new Map(), 0, [])]);
      const os = await harvest(cassette, { mode: "incremental", known: new Set(refs) });
      expect(prices(os).find((o) => o.ref === "56607021")?.price).toEqual({
        amount: 10830,
        currency: "EUR",
      });
      expect(listings(os)).toEqual([]);
    });

    /** Both lists' pages: 100 used listings on 5 pages and 30 more as the new list's 2. */
    async function sweepable() {
      const cards = cardsOf(await loadCassette(full));
      const used = [...cards.keys()].slice(0, 100);
      const fresh = [...cards.keys()].slice(100, 130);
      expect(fresh).toHaveLength(30);
      let cassette = await loadCassette(full);
      for (let n = 1; n <= 5; n++) {
        const url = n === 1 ? usedHead : `https://www.tipcars.com/ojete?str=${n}-20&2000-=`;
        cassette = serve(cassette, url, [listPage(cards, 100, used.slice((n - 1) * 20, n * 20))]);
      }
      cassette = serve(cassette, "https://www.tipcars.com/nove", [
        listPage(cards, 30, fresh.slice(0, 20)),
      ]);
      cassette = serve(cassette, "https://www.tipcars.com/nove?str=2-20", [
        listPage(cards, 30, fresh.slice(20)),
      ]);
      const inScope = (refs: string[]) => refs.filter((r) => !/Dohodou/.test(cards.get(r) ?? ""));
      return { cards, cassette, refs: [...used, ...fresh], inScope };
    }

    it("bounds both heads even when every page holds an unknown listing, reserving the price sweep", async () => {
      const { cassette, refs, inScope } = await sweepable();
      const unknown = new Set([0, 20, 40, 60, 80, 100, 120].map((i) => refs[i] as string));
      const known = new Set(refs.filter((ref) => !unknown.has(ref)));
      const urls: string[] = [];
      const warnings: string[] = [];
      const os = await harvest(cassette, {
        mode: "incremental",
        known,
        options: { headRequests: 1, priceSweep: 2 },
        urls,
        warn: (message) => warnings.push(message),
      });
      expect(urls).toHaveLength(4);
      expect(urls.slice(0, 2)).toEqual([usedHead, "https://www.tipcars.com/nove"]);
      expect(warnings).toContain("tipcars incremental head ran out of requests");
      expect(prices(os).length).toBeGreaterThan(35);
      expect(listings(os).map((o) => o.ref)).toContain(inScope(refs)[0]);
      expect(slicesDone(os)).toEqual([]);
    });

    it("bounds unknown new/demo detail requests and advances on the next incremental runs", async () => {
      const plain = await loadCassette(incremental);
      const cards = cardsOf(plain);
      const fresh = ["9120302", "9120263", "12770757"];
      let cassette = serve(plain, usedHead, [listPage(cards, 0, [])]);
      cassette = serve(cassette, "https://www.tipcars.com/nove", [listPage(cards, 3, fresh)]);
      const known = new Set<string>();
      const seen: ListingSeen[] = [];
      for (let n = 0; n < fresh.length; n++) {
        const urls: string[] = [];
        const os = await harvest(cassette, {
          mode: "incremental",
          known,
          options: { headRequests: 2, priceSweep: 0 },
          now: day(n),
          urls,
        });
        expect(urls).toHaveLength(3); // Both heads and one detail page.
        expect(listings(os)).toHaveLength(1);
        expect(prices(os)).toHaveLength(n);
        expect(slicesDone(os)).toEqual([]);
        for (const o of listings(os)) {
          known.add(o.ref);
          seen.push(o);
        }
      }
      expect(seen.map((o) => o.ref)).toEqual(fresh);
      expect(seen.every((o) => o.condition === "new" || o.condition === "demo")).toBe(true);
      expect(seen).toEqual(listings(await harvest(cassette, { mode: "incremental" })));
      const urls: string[] = [];
      const swept = await harvest(cassette, {
        mode: "incremental",
        options: { headRequests: 2, priceSweep: 2 },
        urls,
      });
      expect(urls).toHaveLength(5);
      expect(listings(swept).map((o) => o.ref)).toEqual(fresh);
    });

    it("the default sweep bounds requests and covers 3,400 pages over two completed days", async () => {
      const cassette = await loadCassette(full);
      const response = (cassette.interactions[0] as Cassette["interactions"][number]).response;
      const cards = cardsOf(cassette);
      // One card keeps every page nonempty; the reported total controls sweep pagination.
      const body = listPage(cards, 68_000, [...cards.keys()].slice(0, 1));
      const paged = new Set<number>();
      for (let n = 0; n < 2; n++) {
        let requests = 0;
        for await (const _ of tipcarsSource().harvest({
          mode: "incremental",
          checkpoint: { ...emptyCheckpoint, isKnown: () => true },
          now: day(n),
          signal: new AbortController().signal,
          log: silentLogger,
          http: {
            async get(request) {
              requests++;
              const url = typeof request === "string" ? request : request.url;
              const used = url.includes("/ojete");
              if (used) paged.add(Number(new URL(url).searchParams.get("str")?.split("-")[0] ?? 1));
              return { ...response, url, body: used ? body : listPage(cards, 0, []) };
            },
          },
        })) {
          // Consume the real harvest; prices deduplicate repeated cards independently of pages.
        }
        expect(requests).toBe(2_002);
      }
      expect(paged.size).toBe(3_400);
    });

    it("sweeps both lists to their ends, so every known listing is priced in one run", async () => {
      const { cassette, refs, inScope } = await sweepable();
      const urls: string[] = [];
      const os = await harvest(cassette, {
        mode: "incremental",
        known: new Set(refs),
        options: {},
        urls,
      });
      // Each list's head walk stops at its first page (nothing new); the sweep reads the rest.
      expect(urls).toHaveLength(5 + 2);
      expect(listings(os)).toEqual([]);
      const priced = prices(os).map((o) => o.ref);
      expect(new Set(priced).size).toBe(priced.length);
      expect(priced.sort()).toEqual(inScope(refs).sort());
    });

    // 7 pages, 2 of them heads (used page 1, new page 1 = page 6). 4 requests a day plan 2
    // shares, from pages 1 and 4; 3 plan 3, from pages 1, 3 and 5; 2 plan 4, the last from
    // page 6, a head in the second list, wrapping round to the used list's page 2.
    it.each([
      [4, 2],
      [3, 3],
      [2, 4],
    ])(
      "a sweep of %i requests, too few for both lists, rotates: %i days in a row price every known listing",
      async (requests, days) => {
        const { cassette, refs, inScope } = await sweepable();
        const warnings: string[] = [];
        const priced = new Set<string>();
        for (let n = 0; n < days; n++) {
          const urls: string[] = [];
          const os = await harvest(cassette, {
            mode: "incremental",
            known: new Set(refs),
            options: { priceSweep: requests },
            urls,
            now: day(n),
            warn: (message, data) => warnings.push(`${message} ${JSON.stringify(data)}`),
          });
          expect(urls).toHaveLength(2 + requests);
          expect(prices(os).length).toBeLessThan(inScope(refs).length);
          for (const o of prices(os)) priced.add(o.ref);
        }
        expect([...priced].sort()).toEqual(inScope(refs).sort());
        expect(warnings[0]).toMatch(
          new RegExp(`cannot price every listing daily .*"short":${5 - requests},"days":${days}`),
        );
      },
    );

    it("follows a list that grows during the sweep to its new end", async () => {
      // A listing posted meanwhile pushes the used list's last one onto a page 6.
      const { cards, cassette: plain, refs, inScope } = await sweepable();
      const used = refs.slice(0, 100);
      expect(inScope(used)).toContain(used[99]);
      let cassette = serve(plain, "https://www.tipcars.com/ojete?str=5-20&2000-=", [
        listPage(cards, 101, used.slice(79, 99)),
      ]);
      cassette = serve(cassette, "https://www.tipcars.com/ojete?str=6-20&2000-=", [
        listPage(cards, 101, used.slice(99)),
      ]);
      const os = await harvest(cassette, {
        mode: "incremental",
        known: new Set(refs),
        options: {},
      });
      expect(
        prices(os)
          .map((o) => o.ref)
          .sort(),
      ).toEqual(inScope(refs).sort());
    });

    it("a listing the sweep meets that the Ledger does not know comes out whole", async () => {
      const cards = cardsOf(await loadCassette(full));
      const refs = [...cards.keys()].slice(0, 40);
      let cassette = serve(await loadCassette(full), "https://www.tipcars.com/nove", [
        listPage(cards, 0, []),
      ]);
      cassette = serve(cassette, usedHead, [listPage(cards, 40, refs.slice(0, 20))]);
      cassette = serve(cassette, "https://www.tipcars.com/ojete?str=2-20&2000-=", [
        listPage(cards, 40, refs.slice(20)),
      ]);
      const unknown = refs.slice(20).find((ref) => !/Dohodou/.test(cards.get(ref) ?? "")) ?? "";
      const os = await harvest(cassette, {
        mode: "incremental",
        known: new Set(refs.filter((ref) => ref !== unknown)),
        options: { priceSweep: 10 },
      });
      expect(listings(os).map((o) => o.ref)).toEqual([unknown]);
      expect(prices(os).map((o) => o.ref)).not.toContain(unknown);
    });
  });

  it("a new or demo listing of a part done earlier in the census is read again only if no run of it read the listing whole", async () => {
    // The new list (3 listings, cap 2) splits into its price bands; two hold the listings.
    const { cassette, a, b, c } = await newBands();
    const run = { mode: "full", options: { slices: ["new"], sliceCap: 2 } } as const;
    const first = await harvest(cassette, run);
    const done = slicesDone(first);
    expect(done.at(-1)).toBe("new");
    // Each band's marks follow its SliceDone.
    const cheapest = done.indexOf("new:0-499999");
    expect(done.slice(cheapest + 1, cheapest + 3)).toEqual([`listing:${a}`, `listing:${b}`]);
    expect(done[done.indexOf("new:500000-599999") + 1]).toBe(`listing:${c}`);
    // A later run of the census: both bands done, only a's listing read whole.
    const urls: string[] = [];
    const later = done.filter((d) => d !== "new" && d !== `listing:${b}` && d !== `listing:${c}`);
    const resumed = await harvest(cassette, {
      ...run,
      done: later,
      known: new Set([a, b, c]),
      urls,
    });
    expect(urls.filter((u) => u.endsWith(".html"))).toEqual(
      expect.arrayContaining([expect.stringContaining(b), expect.stringContaining(c)]),
    );
    expect(urls.some((u) => u.endsWith(`-${a}.html`))).toBe(false);
    expect(
      listings(resumed)
        .map((o) => o.ref)
        .sort(),
    ).toEqual([b, c].sort());
    const marks = slicesDone(resumed);
    expect(marks[0]).toBe("new");
    expect(marks.slice(1).sort()).toEqual([`listing:${b}`, `listing:${c}`].sort());
    // A marked listing the Ledger no longer knows (gone since) is read again.
    const revived = await harvest(cassette, { ...run, done: later, known: new Set([b, c]) });
    expect(listings(revived).map((o) => o.ref)).toContain(a);
  });

  it("a part done earlier in the census, paged again, proves its known new or demo listings live before their detail pages", async () => {
    // The list's first page shows only c: a and b are first met paging the cheapest band
    // again, in a later run of the census with every band done and no listing read whole.
    const { cassette, a, b, c } = await newBands(([, , c]) => [c]);
    const run = { mode: "full", options: { slices: ["new"], sliceCap: 2 } } as const;
    const bands = slicesDone(await harvest(cassette, run)).filter((d) => d.startsWith("new:"));
    const failing = edit(cassette, `-${a}.html`, (r) => ({ ...r, status: 503 }));
    const out: Observation[] = [];
    await expect(
      harvest(failing, { ...run, done: bands, known: new Set([a, b, c]) }, out),
    ).rejects.toThrow(/TipCars returned HTTP 503/);
    expect(
      prices(out)
        .map((o) => o.ref)
        .sort(),
    ).toEqual([a, b, c].sort());
  });

  it("a new or demo listing the Ledger would reject gets no mark", async () => {
    const plain = await loadCassette(incremental);
    const cards = cardsOf(plain);
    const a = "9120302";
    const odd = (cards.get(a) ?? "").replace(/(price_currency&quot;:&quot;)\w+/, "$1X");
    expect(odd).not.toBe(cards.get(a));
    cards.set(a, odd);
    const cassette = serve(plain, "https://www.tipcars.com/nove", [listPage(cards, 1, [a])]);
    const os = await harvest(cassette, { mode: "full", options: { slices: ["new"] } });
    expect(listings(os).map((o) => o.price.currency)).toEqual([""]);
    expect(slicesDone(os)).toEqual(["new"]);
  });

  it("the price sweep reads detail pages after its list pages, as its requests allow", async () => {
    // The new list's page 2 holds three unknown new or demo listings; with 3 requests the
    // sweep reads page 2, then two detail pages.
    const plain = await loadCassette(incremental);
    const cards = cardsOf(plain);
    const page2 = plain.interactions.find((x) => x.request.url.endsWith("/nove?str=2-20"));
    const known = (page2?.response.body.split(CARD).slice(1) ?? []).map(
      (c) => c.split('"')[0] as string,
    );
    const fresh = ["9120302", "9120263", "12770757"];
    let cassette = serve(plain, "https://www.tipcars.com/ojete?2000-=", [listPage(cards, 0, [])]);
    cassette = serve(cassette, "https://www.tipcars.com/nove", [listPage(cards, 40, known)]);
    cassette = serve(cassette, "https://www.tipcars.com/nove?str=2-20", [
      listPage(cards, 40, fresh),
    ]);
    const urls: string[] = [];
    const os = await harvest(cassette, {
      mode: "incremental",
      known: new Set(known),
      options: { priceSweep: 3 },
      urls,
    });
    expect(listings(os).map((o) => o.ref)).toEqual(fresh.slice(0, 2));
    expect(urls.filter((u) => u.endsWith(".html"))).toHaveLength(2);
  });

  it("names its scope after the slices it is limited to", () => {
    expect(tipcarsSource().scope).toBe("all");
    expect(tipcarsSource({ slices: ["used:2001", "used:2000"] }).scope).toBe(
      "slices:used:2000,used:2001",
    );
  });
});
