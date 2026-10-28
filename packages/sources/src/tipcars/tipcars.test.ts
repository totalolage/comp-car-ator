import { readFile } from "node:fs/promises";
import { type Cassette, createReplayHttp, HttpBlockedError, loadCassette } from "@cca/http";
import type { ListingGone, ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, silentLogger } from "../source.ts";
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
}

/** Collects into `out`, so a run that fails still shows what it yielded. */
async function harvest(
  cassette: Cassette,
  run: Run,
  out: Observation[] = [],
): Promise<Observation[]> {
  const replay = createReplayHttp(cassette);
  const at = run.now ?? now;
  const source = tipcarsSource(run.options ?? (run.mode === "full" ? { slices: FULL_SLICES } : {}));
  for await (const o of source.harvest({
    http: {
      get(request) {
        run.urls?.push(typeof request === "string" ? request : request.url);
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
    log: silentLogger,
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

const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
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
    const refs = listings(os).map((o) => o.ref);
    expect(refs).toContain("");
    expect(refs).not.toContain("12770757");
    expect(refs).toContain("9120302");
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

  it("full run skips slices the census already has", async () => {
    const all = await harvest(await loadCassette(full), { mode: "full" });
    const resumed = await harvest(await loadCassette(full), { mode: "full", done: ["used:2000"] });
    expect(slicesDone(resumed)).toEqual(["used:2001"]);
    const in2001 = listings(all).filter((o) => o.vehicle.manufactureYear === 2001);
    expect(listings(resumed).map((o) => o.ref)).toEqual(in2001.map((o) => o.ref));
  });

  it("a malformed card comes out as a ListingSeen the Ledger rejects; the run goes on", async () => {
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body((b) => b.replace(/data-measure-data-value="[^"]*"/, 'data-measure-data-value="{x"')),
    );
    const os = await harvest(cassette, { mode: "full" });
    const seen = listings(os);
    expect(seen.filter((o) => o.ref === "")).toHaveLength(1);
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
      let cassette = serve(plain, root, [page([...r.slice(0, 19), x])]);
      cassette = serve(cassette, `https://www.tipcars.com/ojete?str=2-20&2000-2000=`, [
        page([r[18] as string]),
      ]);
      cassette = serve(cassette, `${root}&1000000-kc=`, [listPage(cards, 0, [])]);
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
        { mode: "full", options: { slices: ["used:2000"], sliceCap: 20 } },
        os,
      );
      return { x, os, run };
    }

    it("is done when that listing is proven: online, of the year, and not in its price band", async () => {
      const { x, os, run } = await year(21);
      await run;
      expect(slicesDone(os)).toEqual(["used:2000:1000000-", "used:2000:0-999999", "used:2000"]);
      expect(listings(os).map((o) => o.ref)).toContain(x);
    });

    it("is not done when that listing is gone by the time it is checked", async () => {
      const { x, os, run } = await year(21, { detail: { status: 404 } });
      await expect(run).rejects.toThrow(
        /used:2000 \(1 listings in no price band, 0 proven; not proven: 1 gone\)/,
      );
      expect(slicesDone(os)).not.toContain("used:2000");
      expect(os).toContainEqual({ kind: "ListingGone", ref: x });
    });

    it("is not done when that listing is gone by the final check, after the recount", async () => {
      const { x, os, run } = await year(21, { later: { status: 404 } });
      await expect(run).rejects.toThrow(
        /used:2000 \(1 listings in no price band, 0 proven; not proven: 1 gone\)/,
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
      await expect(run).rejects.toThrow(/used:2000 \(2 listings in no price band, 1 proven\)/);
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
    expect(seen.find((o) => o.ref === "56607021")?.price).toEqual({ amount: 10830, currency: "" });
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

  it("names its scope after the slices it is limited to", () => {
    expect(tipcarsSource().scope).toBe("all");
    expect(tipcarsSource({ slices: ["used:2001", "used:2000"] }).scope).toBe(
      "slices:used:2000,used:2001",
    );
  });
});
