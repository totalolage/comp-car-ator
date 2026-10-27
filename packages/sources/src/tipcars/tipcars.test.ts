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
const now = new Date("2026-10-25T17:36:00Z");
const FULL_SLICES = ["used:2000", "used:2001"];
const FOREIGN_RUN = {
  mode: "full",
  options: { slices: ["used:2015"] },
  now: new Date("2026-10-27T21:40:00Z"),
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

  it("a slice that stays short of its count is paged twice, then fails the run after the others", async () => {
    // Drop one card from the first page of used:2000: every pass then sees one listing less
    // than the slice reports.
    const cassette = edit(
      await loadCassette(full),
      "/ojete?2000-2000=",
      body((b) => {
        const parts = b.split(CARD);
        parts.splice(1, 1);
        return parts.join(CARD);
      }),
    );
    const os: Observation[] = [];
    await expect(harvest(cassette, { mode: "full" }, os)).rejects.toThrow(
      /fewer listings than reported: used:2000/,
    );
    expect(slicesDone(os)).toEqual(["used:2001"]);
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

  it("a second pass must reach its own count: the first pass's cards cannot fill it", async () => {
    // Pass 1 misses card X on page 1. Before pass 2 one listing is gone (every page reports
    // one less) and pass 2 misses X and Y. Together the passes have all but X: one less than
    // pass 2 reports, so a union would pass for complete while X is still unseen.
    const cassette = await loadCassette(full);
    const without = (b: string, n: number) => {
      const parts = b.split(CARD);
      parts.splice(1, n);
      return parts.join(CARD);
    };
    const fewer = (b: string) =>
      b.replace(/"numberOfItems":\s*(\d+)/, (_, n) => `"numberOfItems": ${Number(n) - 1}`);
    const interactions = cassette.interactions.flatMap((x) => {
      if (!x.request.url.includes("2000-2000=")) return [x];
      const firstPage = x.request.url.endsWith("/ojete?2000-2000=");
      const pass1 = firstPage ? { ...x.response, body: without(x.response.body, 1) } : x.response;
      const pass2 = {
        ...x.response,
        body: fewer(firstPage ? without(x.response.body, 2) : x.response.body),
      };
      return [
        { ...x, response: pass1 },
        { ...x, response: pass2 },
      ];
    });
    const os: Observation[] = [];
    await expect(harvest({ ...cassette, interactions }, { mode: "full" }, os)).rejects.toThrow(
      /fewer listings than reported: used:2000/,
    );
    expect(slicesDone(os)).toEqual(["used:2001"]);
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
