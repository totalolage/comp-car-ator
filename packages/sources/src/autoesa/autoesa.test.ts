import { readFile } from "node:fs/promises";
import { type Cassette, createReplayHttp, loadCassette, ReplayMissError } from "@cca/http";
import type { ListingGone, ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, silentLogger } from "../source.ts";
import { type AutoesaOptions, autoesaSource } from "./autoesa.ts";

// Recorded 2026-10-25 from devbox (T0) with the real adapter; bodies trimmed to what the
// parser reads (count, pagination and card links of list pages; the dataexp_view_item record,
// spec table, VAT note and gallery of detail pages). incremental: the newest-first list,
// pages 1-3, with incremental.known.json (everything on them but 5 listings, one of them on
// page 2) as the Ledger's state. full: the slices year:2002 (one page) and year:2003 (two).
const incremental = new URL("./fixtures/incremental.cassette.json", import.meta.url);
const full = new URL("./fixtures/full.cassette.json", import.meta.url);
const knownRefs = new URL("./fixtures/incremental.known.json", import.meta.url);
const incrementalNow = new Date("2026-10-25T19:01:00Z");
const fullNow = new Date("2026-10-25T19:02:00Z");
const FULL_SLICES = ["year:2002", "year:2003"];
const FRESH = ["454464870", "414464866", "555464778", "484464874", "334464858"];

interface Run {
  mode: HarvestMode;
  /** Collects the URLs requested. */
  urls?: string[];
  /** Adds each yielded listing to `known`, as a Ledger recording during the run would. */
  live?: boolean;
  known?: ReadonlySet<string>;
  done?: readonly string[];
  options?: AutoesaOptions;
}

/** Collects into `out`, so a run that fails still shows what it yielded. */
async function harvest(
  cassette: Cassette,
  run: Run,
  out: Observation[] = [],
): Promise<Observation[]> {
  const replay = createReplayHttp(cassette);
  const now = run.mode === "full" ? fullNow : incrementalNow;
  const source = autoesaSource(run.options ?? (run.mode === "full" ? { slices: FULL_SLICES } : {}));
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
      sliceDoneAt: (slice) => (run.done?.includes(slice) ? now : null),
    },
    now,
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
const CARD = /<a href="[^"]*"\s+class="car_item"[\s\S]*?<\/a>\n?/g;
const cards = (b: string) => b.match(CARD) ?? [];
const withoutCard = (b: string) => b.replace(new RegExp(CARD.source), "");
const PAGE_1 = "?rok_od=2000&razeni=8";
const PAGE_3 = "?rok_od=2000&razeni=8&stranka=3";
const SLICE_2003 = "?rok_od=2003&rok_do=2003&razeni=7";

describe("autoesa source", () => {
  it("incremental run yields the listings the Ledger does not know, newest first, and stops", async () => {
    // Page 3 is all known, so no page 4 is requested (replay would miss it).
    const urls: string[] = [];
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      urls,
    });
    expect(listings(os).map((o) => o.ref)).toEqual(FRESH);
    expect(os).toHaveLength(FRESH.length);
    expect(urls.filter((u) => u.includes("/vsechna-auta"))).toHaveLength(3);
    // Only the new listings' detail pages are read.
    expect(urls.filter((u) => !u.includes("/vsechna-auta"))).toHaveLength(FRESH.length);
    // The same against a checkpoint that learns this run's listings as they are recorded.
    const live = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      live: true,
    });
    expect(listings(live).map((o) => o.ref)).toEqual(FRESH);
  });

  it("maps a used listing from its detail page", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const fabia = listings(os).find((o) => o.ref === "414464866");
    expect(fabia).toEqual({
      kind: "ListingSeen",
      ref: "414464866",
      url: "https://www.autoesa.cz/skoda/fabia/hatchback/benzin/414464866",
      market: "CZ",
      condition: "used",
      vehicle: {
        make: "Škoda",
        model: "Fabia III",
        trim: "1.2 TSI Style",
        sourceTaxonomy: { make: "skoda", model: "fabia" },
        firstRegistration: { year: 2015 },
        body: "hatchback",
        fuel: "petrol",
        powerKw: 81,
        transmission: "manual",
        seats: 5,
        doors: 5,
        co2GKm: 141,
        color: "modrá",
      },
      odometerKm: 104091,
      // The cash price; the list card shows only a lower price for businesses on credit.
      price: { amount: 194000, currency: "CZK" },
      priceBasis: "unknown",
      seller: "dealer",
      photos: expect.any(Array),
      inspectionValidUntil: { year: 2027, month: 6 },
    });
    expect(fabia?.photos[0]).toBe(
      "https://www.autoesa.cz/files/cars/414464866/414464866-1.jpg?1792951241",
    );
    expect(fabia?.photos).toHaveLength(3);
    // "4x2" does not say which axle drives.
    expect(fabia?.vehicle.drive).toBeUndefined();
  });

  it("a listing whose VAT is deductible has a gross price; others say nothing", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const passat = listings(os).find((o) => o.ref === "484464874");
    expect(passat).toMatchObject({
      vehicle: { make: "Volkswagen", model: "Passat", fuel: "diesel", transmission: "automatic" },
      price: { amount: 299000, currency: "CZK" },
      priceBasis: "gross",
    });
    expect(
      listings(os)
        .filter((o) => o.ref !== "484464874")
        .map((o) => o.priceBasis),
    ).toEqual(["unknown", "unknown", "unknown", "unknown"]);
  });

  it("a known listing promoted to the top of the list neither stops the run early nor extends it", async () => {
    const page3 = (await loadCassette(incremental)).interactions.find((x) =>
      x.request.url.endsWith(PAGE_3),
    );
    const promoted = cards(page3?.response.body ?? "")[0] as string;
    const cassette = edit(
      await loadCassette(incremental),
      PAGE_1,
      body((b) => b.replace('<div class="car_items_holder">', (m) => `${m}\n${promoted}`)),
    );
    const urls: string[] = [];
    const os = await harvest(cassette, { mode: "incremental", known: await known(), urls });
    expect(listings(os).map((o) => o.ref)).toEqual(FRESH);
    expect(urls.filter((u) => u.includes("/vsechna-auta"))).toHaveLength(3);
  });

  it("a new listing seen again on a later page keeps the walk going, though the Ledger now knows it", async () => {
    // Listings added during the run shift a new one from page 1 onto page 3: the page is not
    // all known before this run, so the walk asks for page 4 (not recorded).
    const fresh = cards(
      (await loadCassette(incremental)).interactions[0]?.response.body ?? "",
    )[0] as string;
    const cassette = edit(
      await loadCassette(incremental),
      PAGE_3,
      body((b) => b.replace('<div class="car_items_holder">', (m) => `${m}\n${fresh}`)),
    );
    const urls: string[] = [];
    const os: Observation[] = [];
    await expect(
      harvest(cassette, { mode: "incremental", known: await known(), live: true, urls }, os),
    ).rejects.toBeInstanceOf(ReplayMissError);
    expect(urls.at(-1)).toMatch(/stranka=4$/);
    expect(listings(os).map((o) => o.ref)).toEqual(FRESH);
  });

  it("a commercial vehicle yields nothing; an unknown category is rejected", async () => {
    const category = (label: string) =>
      body((b) => b.replace('"car_category": "Osobn\\u00ed"', `"car_category": "${label}"`));
    // Page 2's only new listing is a van: never known, so the walk still reads page 3.
    const van = edit(
      await loadCassette(incremental),
      "/334464858",
      category("U\\u017eitkov\\u00e9"),
    );
    const urls: string[] = [];
    const os = await harvest(van, { mode: "incremental", known: await known(), urls });
    expect(os.map((o) => ("ref" in o ? o.ref : o.kind))).toEqual(FRESH.slice(0, 4));
    expect(urls.filter((u) => u.includes("/vsechna-auta"))).toHaveLength(3);
    const odd = edit(await loadCassette(incremental), "/334464858", category("Motocykly"));
    const seen = listings(await harvest(odd, { mode: "incremental", known: await known() }));
    expect(seen.map((o) => o.ref)).toEqual([...FRESH.slice(0, 4), ""]);
  });

  it("a car the detail page dates before 2000 yields nothing; one from 2000 comes out", async () => {
    const dated = (year: number) =>
      body((b) =>
        b
          .replace(/(<strong>Rok<\/strong>\s*<span>)\d{4}/, `$1${year}`)
          .replace(/"manufature_year": \d{4}/, `"manufature_year": ${year}`),
      );
    const cassette = edit(
      edit(await loadCassette(incremental), `/${FRESH[0]}`, dated(1999)),
      `/${FRESH[1]}`,
      dated(2000),
    );
    const seen = listings(await harvest(cassette, { mode: "incremental", known: await known() }));
    expect(seen.map((o) => o.ref)).toEqual(FRESH.slice(1));
    expect(seen[0]?.vehicle.firstRegistration).toEqual({ year: 2000 });
  });

  it("a pre-2000 car still counts towards its slice's total, so the slice is done", async () => {
    const os = await harvest(await loadCassette(full), { mode: "full" });
    const first = listings(os)[0]?.ref as string;
    const dated = edit(
      await loadCassette(full),
      `/${first}`,
      body((b) => b.replace(/(<strong>Rok<\/strong>\s*<span>)\d{4}/, "$11999")),
    );
    const again = await harvest(dated, { mode: "full" });
    expect(slicesDone(again)).toEqual(FULL_SLICES);
    expect(listings(again).map((o) => o.ref)).not.toContain(first);
    expect(listings(again)).toHaveLength(31);
  });

  it("a hybrid is a plug-in only when its title says so", async () => {
    const hybrid = (title: string) =>
      body((b) =>
        b
          .replace(/"title": "[^"]*"/, `"title": "${title}"`)
          .replace("<span>benzín</span>", "<span>hybridní</span>"),
      );
    const fuelOf = async (title: string) => {
      const cassette = edit(await loadCassette(incremental), "/414464866", hybrid(title));
      const os = await harvest(cassette, { mode: "incremental", known: await known() });
      return listings(os).find((o) => o.ref === "414464866")?.vehicle;
    };
    expect((await fuelOf("Škoda Fabia III 1.4 Hybrid"))?.fuel).toBeUndefined();
    expect(await fuelOf("Škoda Fabia III 1.4 TSI iV Style")).toMatchObject({
      fuel: "phev",
      trim: "1.4 TSI iV Style",
    });
  });

  it("a sold or removed listing yields ListingGone", async () => {
    let cassette = edit(
      await loadCassette(incremental),
      "/454464870",
      body(
        () =>
          '<input id="isCarSold" type="hidden"\n           value="true"><h1>Tento vůz je prodán</h1>',
      ),
    );
    cassette = edit(cassette, "/555464778", (r) => ({ ...r, status: 404 }));
    const os = await harvest(cassette, { mode: "incremental", known: await known() });
    expect(os.filter((o): o is ListingGone => o.kind === "ListingGone")).toEqual([
      { kind: "ListingGone", ref: "454464870" },
      { kind: "ListingGone", ref: "555464778" },
    ]);
    expect(listings(os).map((o) => o.ref)).toEqual(["414464866", "484464874", "334464858"]);
  });

  it("a detail page without its record gives a ListingSeen the Ledger rejects; the run goes on", async () => {
    const cassette = edit(
      await loadCassette(incremental),
      "/414464866",
      body((b) => b.replace("var dataexp_view_item", "var renamed")),
    );
    const os = await harvest(cassette, { mode: "incremental", known: await known() });
    const refs = listings(os).map((o) => o.ref);
    expect(refs).toEqual(["454464870", "", "555464778", "484464874", "334464858"]);
  });

  it("a detail page without a cash price gives a ListingSeen the Ledger rejects", async () => {
    const cassette = edit(
      await loadCassette(incremental),
      "/414464866",
      body((b) => b.replace(/"price_cash": \d+/, '"price_cash": null')),
    );
    const seen = listings(await harvest(cassette, { mode: "incremental", known: await known() }));
    expect(seen.filter((o) => !Number.isFinite(o.price.amount)).map((o) => o.ref)).toEqual([
      "414464866",
    ]);
  });

  it("full run pages every slice to its end and reports it done", async () => {
    const os = await harvest(await loadCassette(full), { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const seen = listings(os);
    expect(seen).toHaveLength(32);
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    expect(seen.every((o) => o.condition === "used" && o.price.currency === "CZK")).toBe(true);
    // Each slice's listings come before its SliceDone.
    const firstDone = os.findIndex((o) => o.kind === "SliceDone");
    expect(listings(os.slice(0, firstDone)).map((o) => o.vehicle.firstRegistration)).toEqual(
      Array(7).fill({ year: 2002 }),
    );
    // An LPG car and a three-door one map from the same detail page format.
    expect(seen.find((o) => o.ref === "147462094")?.vehicle.fuel).toBe("lpg");
    expect(seen.find((o) => o.ref === "554454708")?.vehicle).toMatchObject({
      make: "Volkswagen",
      model: "Polo",
      doors: 3,
    });
  });

  it("full run skips slices the census already has", async () => {
    const all = await harvest(await loadCassette(full), { mode: "full" });
    const resumed = await harvest(await loadCassette(full), { mode: "full", done: ["year:2002"] });
    expect(slicesDone(resumed)).toEqual(["year:2003"]);
    const in2003 = listings(all).filter((o) => o.vehicle.firstRegistration?.year === 2003);
    expect(listings(resumed).map((o) => o.ref)).toEqual(in2003.map((o) => o.ref));
  });

  it("a card without a listing link comes out as a ListingSeen the Ledger rejects; the run goes on", async () => {
    const cassette = edit(
      await loadCassette(full),
      SLICE_2003,
      body((b) => b.replace(/<a href="\/[^"]*\/(\d+)"/, '<a href="/nabidka/$1x"')),
    );
    const os = await harvest(cassette, { mode: "full" });
    const seen = listings(os);
    expect(seen.filter((o) => o.ref === "")).toHaveLength(1);
    expect(seen).toHaveLength(32);
    // The card still counts towards its slice; the Ledger keeps the slice not done.
    expect(slicesDone(os)).toEqual(FULL_SLICES);
  });

  it("a slice that stays short of its count is paged twice, then fails the run after the others", async () => {
    const cassette = edit(await loadCassette(full), SLICE_2003, body(withoutCard));
    const urls: string[] = [];
    const os: Observation[] = [];
    await expect(harvest(cassette, { mode: "full", urls }, os)).rejects.toThrow(
      /fewer listings than reported: year:2003/,
    );
    expect(slicesDone(os)).toEqual(["year:2002"]);
    expect(urls.filter((u) => u.endsWith(SLICE_2003))).toHaveLength(2);
    // What it did see still comes out.
    expect(listings(os)).toHaveLength(31);
  });

  it("a short slice's listings come out after the done slices, so they cannot taint one", async () => {
    const cassette = edit(
      await loadCassette(full),
      "?rok_od=2002&rok_do=2002&razeni=7",
      // The slice reports one listing more than it shows.
      body((b) => b.replace("<strong>7</strong>", "<strong>8</strong>")),
    );
    const os: Observation[] = [];
    await expect(harvest(cassette, { mode: "full" }, os)).rejects.toThrow(
      /fewer listings than reported: year:2002/,
    );
    expect(slicesDone(os)).toEqual(["year:2003"]);
    const done = os.findIndex((o) => o.kind === "SliceDone");
    const in2002 = listings(os).filter((o) => o.vehicle.firstRegistration?.year === 2002);
    expect(in2002).toHaveLength(7);
    expect(in2002.every((o) => os.indexOf(o) > done)).toBe(true);
  });

  it("a slice short on its first pass and whole on its second is done", async () => {
    // Replay serves a URL's recordings in order: the first pass sees page 1 without a card.
    const cassette = await loadCassette(full);
    const i = cassette.interactions.findIndex((x) => x.request.url.endsWith(SLICE_2003));
    const first = cassette.interactions[i] as Cassette["interactions"][number];
    const short = {
      ...first,
      response: { ...first.response, body: withoutCard(first.response.body) },
    };
    const interactions = [...cassette.interactions];
    interactions.splice(i, 0, short);
    const os = await harvest({ ...cassette, interactions }, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    expect(listings(os)).toHaveLength(32);
  });

  it("an empty slice is done", async () => {
    const cassette = edit(
      await loadCassette(full),
      "?rok_od=2002&rok_do=2002&razeni=7",
      body(() => "<h2>Počet vozů&nbsp;<strong>0</strong></h2>"),
    );
    const os = await harvest(cassette, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    expect(listings(os)).toHaveLength(25);
  });

  it("a list page that reports more listings than it shows and no pagination fails the run", async () => {
    const cassette = edit(
      await loadCassette(incremental),
      PAGE_1,
      body((b) => b.replace(/<div id="snippet--paginationTop"[\s\S]*?<\/ul>/, "")),
    );
    await expect(harvest(cassette, { mode: "incremental", known: await known() })).rejects.toThrow(
      /Autoesa page changed: no pagination/,
    );
  });

  it("a later page without pagination does not cut the walk short", async () => {
    // Page 2 still has a new listing, so the walk reads page 3, as page 1 advertised.
    const cassette = edit(
      await loadCassette(incremental),
      "?rok_od=2000&razeni=8&stranka=2",
      body((b) => b.replace(/<div id="snippet--paginationTop"[\s\S]*?<\/ul>/, "")),
    );
    const urls: string[] = [];
    const os = await harvest(cassette, { mode: "incremental", known: await known(), urls });
    expect(listings(os).map((o) => o.ref)).toEqual(FRESH);
    expect(urls.filter((u) => u.includes("/vsechna-auta"))).toHaveLength(3);
  });

  it("a changed list page fails the run", async () => {
    const cassette = edit(
      await loadCassette(full),
      SLICE_2003,
      body(() => "<html></html>"),
    );
    await expect(harvest(cassette, { mode: "full" })).rejects.toThrow(/Autoesa page changed/);
  });

  it("an HTTP error the Http module could not retry away fails the run", async () => {
    const cassette = edit(await loadCassette(full), "/715446738", (r) => ({ ...r, status: 503 }));
    await expect(harvest(cassette, { mode: "full" })).rejects.toThrow(/HTTP 503/);
  });

  it("maxPages bounds incremental walks and fails a full slice that needs more", async () => {
    const urls: string[] = [];
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      options: { maxPages: 1 },
      urls,
    });
    expect(listings(os).map((o) => o.ref)).toEqual(FRESH.slice(0, 4));
    expect(urls.filter((u) => u.includes("/vsechna-auta"))).toEqual([
      "https://www.autoesa.cz/vsechna-auta?rok_od=2000&razeni=8",
    ]);
    await expect(
      harvest(await loadCassette(full), {
        mode: "full",
        options: { slices: FULL_SLICES, maxPages: 1 },
      }),
    ).rejects.toThrow(/more than 1 pages/);
  });

  it("slices narrow full runs only, and must exist", async () => {
    await expect(
      harvest(await loadCassette(incremental), {
        mode: "incremental",
        options: { slices: ["year:2002"] },
      }),
    ).rejects.toThrow(/full runs only/);
    await expect(
      harvest(await loadCassette(full), { mode: "full", options: { slices: ["year:1999"] } }),
    ).rejects.toThrow(/Unknown Autoesa slices: year:1999/);
  });

  it("names its scope after the slices it is limited to", () => {
    expect(autoesaSource().scope).toBe("all");
    expect(autoesaSource({ slices: ["year:2003", "year:2002"] }).scope).toBe(
      "slices:year:2002,year:2003",
    );
  });
});
