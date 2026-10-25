import { readFile } from "node:fs/promises";
import { type Cassette, createReplayHttp, loadCassette } from "@cca/http";
import type { ListingGone, ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, silentLogger } from "../source.ts";
import { type AaaautoOptions, aaaautoSource } from "./aaaauto.ts";

// Recorded 2026-10-25 from devbox (T0) with the real adapter; each list page trimmed to the
// page state the parser reads (`car-list`, its cars cut to the fields read and two photos)
// and the branch list to id, title, city and zip. incremental: the used and the demo list,
// pages 1-2 each, with incremental.known.json (everything but the 4 newest used and 2 newest
// demo cars) as the Ledger's state. full: the slices year:2004 (one page) and year:2005 (two).
const incremental = new URL("./fixtures/incremental.cassette.json", import.meta.url);
const full = new URL("./fixtures/full.cassette.json", import.meta.url);
const knownRefs = new URL("./fixtures/incremental.known.json", import.meta.url);
const INCREMENTAL_NOW = new Date("2026-10-25T19:40:01Z");
const FULL_NOW = new Date("2026-10-25T19:40:26Z");
const FULL_SLICES = ["year:2004", "year:2005"];

const USED_1 = "/ojete-vozy/2000?exclude-categoryId-array=16&sort=14&page=1";
const USED_2 = "/ojete-vozy/2000?exclude-categoryId-array=16&sort=14&page=2";
const Y2004 = "/ojete-vozy/2004?yearTo=2004&exclude-categoryId-array=16&sort=14&page=1";
const Y2005_1 = "/ojete-vozy/2005?yearTo=2005&exclude-categoryId-array=16&sort=14&page=1";
const Y2005_2 = "/ojete-vozy/2005?yearTo=2005&exclude-categoryId-array=16&sort=14&page=2";
const BRANCHES = "/api/branches/lite";

interface Run {
  mode: HarvestMode;
  /** Collects the URLs requested. */
  urls?: string[];
  /** Adds each yielded listing to `known`, as a Ledger recording during the run would. */
  live?: boolean;
  known?: ReadonlySet<string>;
  done?: readonly string[];
  options?: AaaautoOptions;
}

/** Collects into `out`, so a run that fails still shows what it yielded. */
async function harvest(
  cassette: Cassette,
  run: Run,
  out: Observation[] = [],
): Promise<Observation[]> {
  const replay = createReplayHttp(cassette);
  const now = run.mode === "full" ? FULL_NOW : INCREMENTAL_NOW;
  const source = aaaautoSource(run.options ?? (run.mode === "full" ? { slices: FULL_SLICES } : {}));
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

type Interaction = Cassette["interactions"][number];
type Response = Interaction["response"];
type Car = Record<string, unknown> & { id?: unknown; price: Record<string, unknown> };

const STATE = '<script id="ng-state" type="application/json">';

/** The page's state, its cars changed by `change`. */
function withCars(body: string, change: (cars: Car[]) => Car[]): string {
  const start = body.indexOf(STATE) + STATE.length;
  const end = body.indexOf("</script>", start);
  const state = JSON.parse(body.slice(start, end));
  const message = state["car-list"].message;
  message.items = change(message.items);
  return `${body.slice(0, start)}${JSON.stringify(state)}${body.slice(end)}`;
}

function carsOf(body: string): Car[] {
  let cars: Car[] = [];
  withCars(body, (c) => {
    cars = c;
    return c;
  });
  return cars;
}

const at = (cassette: Cassette, suffix: string): Interaction => {
  const x = cassette.interactions.find((i) => i.request.url.endsWith(suffix));
  if (!x) throw new Error(`no interaction for ${suffix}`);
  return x;
};

/** The cassette with the response of the interaction whose URL ends with `suffix` edited. */
function edit(
  cassette: Cassette,
  suffix: string,
  change: (response: Response) => Response,
): Cassette {
  const target = at(cassette, suffix);
  const interactions = cassette.interactions.map((x) =>
    x === target ? { ...x, response: change(x.response) } : x,
  );
  return { ...cassette, interactions };
}

const cars = (f: (cars: Car[]) => Car[]) => (r: Response) => ({
  ...r,
  body: withCars(r.body, f),
});

const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const slicesDone = (os: Observation[]) =>
  os.flatMap((o) => (o.kind === "SliceDone" ? [o.slice] : []));
const lists = (urls: string[]) => urls.filter((u) => !u.endsWith(BRANCHES));

describe("aaaauto source", () => {
  it("incremental run yields the listings the Ledger does not know, newest first, and stops", async () => {
    // Page 2 of each list is all known, so no page 3 is requested (replay would miss it).
    const urls: string[] = [];
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      urls,
    });
    const seen = listings(os);
    expect(seen.map((o) => [o.ref, o.condition])).toEqual([
      ["34920375", "used"],
      ["34920358", "used"],
      ["34920337", "used"],
      ["34920336", "used"],
      ["34920540", "demo"],
      ["34920539", "demo"],
    ]);
    expect(slicesDone(os)).toEqual([]);
    expect(lists(urls)).toHaveLength(4);
    // The same against a checkpoint that learns this run's listings as they are recorded.
    const live = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      live: true,
    });
    expect(listings(live).map((o) => o.ref)).toEqual(seen.map((o) => o.ref));
  });

  it("maps a used listing from its list record", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    const ix35 = listings(os).find((o) => o.ref === "34920337");
    expect(ix35).toEqual({
      kind: "ListingSeen",
      ref: "34920337",
      url: "https://www.aaaauto.cz/detail/hyundai/ix35/34920337",
      market: "CZ",
      condition: "used",
      vehicle: {
        make: "Hyundai",
        model: "ix35",
        trim: "1.7 CRDi",
        sourceTaxonomy: { make: "47", model: "1893" },
        firstRegistration: { year: 2015 },
        body: "suv",
        fuel: "diesel",
        powerKw: 85,
        transmission: "manual",
        engineCc: 1685,
        seats: 5,
        doors: 5,
        euroClass: 5,
        consumptionL100km: 4.8,
        color: "černá",
      },
      odometerKm: 195292,
      // The cash price, not the financing-only "Akční cena" (104 000).
      price: { amount: 144000, currency: "CZK" },
      // VAT not deductible: the site states nothing more.
      priceBasis: "unknown",
      seller: "dealer",
      location: { city: "Sokolov", postcode: "35601" },
      photos: [
        "https://aaaautoeuimg.vshcdn.net/thumb/900611206_1024x768x95.jpg",
        "https://aaaautoeuimg.vshcdn.net/thumb/900611206_2_1024x768x95.jpg",
      ],
    });
    // A car still abroad is sold in CZ like the rest, but does not stand at its branch.
    const x3 = listings(os).find((o) => o.ref === "34920375");
    expect(x3).toMatchObject({ market: "CZ", vehicle: { drive: "awd", trim: "xDrive20d" } });
    expect(x3?.location).toBeUndefined();
  });

  it("maps VAT, hybrids and bodies as the site states them", async () => {
    // Every car of the recorded pages, none known.
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      options: { maxPages: 2 },
    });
    const byRef = new Map(listings(os).map((o) => [o.ref, o]));
    expect(byRef.size).toBe(140);
    // VAT deductible: the cash price is incl. VAT, its "bez DPH" price shown under it.
    expect(byRef.get("34919735")).toMatchObject({
      priceBasis: "gross",
      price: { amount: 300000 },
      vehicle: { model: "X5", trim: "xDrive40e M Paket", fuel: "phev" },
    });
    expect(byRef.get("34919001")?.vehicle.fuel).toBe("hev");
    // A mild hybrid keeps its engine's fuel.
    expect(byRef.get("34919095")?.vehicle.fuel).toBe("petrol");
    expect(byRef.get("34920285")?.vehicle.fuel).toBe("lpg");
    // "Sedan/Liftback" does not say which.
    expect(byRef.get("34919266")?.vehicle.body).toBeUndefined();
    expect(byRef.get("34919266")?.vehicle.fuel).toBe("petrol");
    const conditions = new Set(listings(os).map((o) => o.condition));
    expect(conditions).toEqual(new Set(["used", "demo"]));
  });

  it("maps a Mototechna demonstrator, linked on mototechna.cz", async () => {
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
    });
    expect(listings(os).find((o) => o.ref === "34920540")).toMatchObject({
      url: "https://mototechna.cz/car/900611105",
      condition: "demo",
      vehicle: { make: "Toyota", model: "Land Cruiser", firstRegistration: { year: 2023 } },
      odometerKm: 77043,
      price: { amount: 1200000, currency: "CZK" },
      seller: "dealer",
      location: { city: "Brno" },
    });
    const enyaq = listings(os).find((o) => o.ref === "34920539");
    expect(enyaq).toMatchObject({
      condition: "demo",
      priceBasis: "gross",
      vehicle: { make: "Škoda", model: "Enyaq", fuel: "bev", powerKw: 109 },
    });
    // The site gives the electric car "EURO6" and a consumption in litres.
    expect(enyaq?.vehicle.euroClass).toBeUndefined();
    expect(enyaq?.vehicle.consumptionL100km).toBeUndefined();
  });

  it("a new car repeated on the next page does not keep the walk going", async () => {
    // 34920375 is new on page 1; page 2 shows it again among known cars (it moved down as a
    // car was added). Counting it as new there would request page 3, which replay misses.
    const cassette = await loadCassette(incremental);
    const repeat = carsOf(at(cassette, USED_1).response.body)[0] as Car;
    const moved = edit(
      cassette,
      USED_2,
      cars((c) => [repeat, ...c]),
    );
    for (const live of [false, true]) {
      const os = await harvest(moved, { mode: "incremental", known: await known(), live });
      const refs = listings(os).map((o) => o.ref);
      expect(refs.filter((r) => r === "34920375")).toHaveLength(1);
      expect(refs).toHaveLength(6);
    }
  });

  it("a known car promoted onto a page of new ones does not stop the walk early", async () => {
    const cassette = await loadCassette(incremental);
    const knownCar = carsOf(at(cassette, USED_2).response.body)[0] as Car;
    const promoted = edit(
      cassette,
      USED_1,
      cars((c) => [knownCar, ...c]),
    );
    const urls: string[] = [];
    const os = await harvest(promoted, { mode: "incremental", known: await known(), urls });
    expect(listings(os).map((o) => o.ref)).not.toContain(String(knownCar.id));
    expect(listings(os)).toHaveLength(6);
    expect(lists(urls)).toHaveLength(4);
  });

  it("a page of nothing but repeats has not reached known cars: the walk goes on", async () => {
    // Page 2 shows only the new cars of page 1 again (a page's worth of cars was added
    // meanwhile) and the cars it pushed down are on page 3.
    const cassette = await loadCassette(incremental);
    const page1 = at(cassette, USED_1).response.body;
    const page2 = at(cassette, USED_2);
    const shifted = edit(cassette, USED_2, (r) => ({
      ...r,
      body: withCars(page1, (c) => c.slice(0, 4)),
    }));
    shifted.interactions.push({
      request: { url: page2.request.url.replace("page=2", "page=3") },
      response: page2.response,
    });
    const urls: string[] = [];
    const os = await harvest(shifted, { mode: "incremental", known: await known(), urls });
    expect(urls.some((u) => u.endsWith("page=3"))).toBe(true);
    expect(listings(os)).toHaveLength(6);
  });

  it("full run pages every slice to its end and reports it done", async () => {
    const os = await harvest(await loadCassette(full), { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const seen = listings(os);
    expect(seen).toHaveLength(24 + 56);
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    expect(seen.every((o) => o.condition === "used" && o.price.currency === "CZK")).toBe(true);
    // Each slice's listings come before its SliceDone.
    const firstDone = os.findIndex((o) => o.kind === "SliceDone");
    expect(firstDone).toBe(24);
    expect(
      listings(os.slice(0, firstDone)).every((o) => o.vehicle.firstRegistration?.year === 2004),
    ).toBe(true);
  });

  it("full run skips slices the census already has", async () => {
    const urls: string[] = [];
    const resumed = await harvest(await loadCassette(full), {
      mode: "full",
      done: ["year:2004"],
      urls,
    });
    expect(slicesDone(resumed)).toEqual(["year:2005"]);
    expect(listings(resumed)).toHaveLength(56);
    expect(urls.some((u) => u.includes("/2004?"))).toBe(false);
  });

  it("a car whose price does not parse comes out without a ref, which the Ledger rejects; the run goes on", async () => {
    const cassette = edit(
      await loadCassette(full),
      Y2005_1,
      cars(([first, ...rest]) => [
        { ...(first as Car), price: { ...(first as Car).price, cash: "na dotaz" } },
        ...rest,
      ]),
    );
    const os = await harvest(cassette, { mode: "full" });
    const seen = listings(os);
    const placeholder = seen.filter((o) => o.ref === "");
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]?.price.amount).toBeNaN();
    expect(seen).toHaveLength(80);
    // Its ref still counts towards the slice; the Ledger keeps the slice not done.
    expect(slicesDone(os)).toEqual(FULL_SLICES);
  });

  it("a slice that stays short of its count is paged twice, then comes out after the others and fails the run", async () => {
    // A car without an id cannot count towards its slice (and is rejected): every pass sees
    // one listing less than the slice reports.
    const cassette = edit(
      await loadCassette(full),
      Y2004,
      cars(([first, ...rest]) => [{ ...(first as Car), id: undefined }, ...rest]),
    );
    const urls: string[] = [];
    const os: Observation[] = [];
    await expect(harvest(cassette, { mode: "full", urls }, os)).rejects.toThrow(
      /fewer listings than reported: year:2004/,
    );
    expect(slicesDone(os)).toEqual(["year:2005"]);
    expect(urls.filter((u) => u.endsWith(Y2004))).toHaveLength(2);
    // Its listings, the rejected one among them, follow year:2005's SliceDone, so the Ledger
    // does not count the rejection towards year:2005.
    const done2005 = os.findIndex((o) => o.kind === "SliceDone");
    const placeholder = os.findIndex((o) => o.kind === "ListingSeen" && o.ref === "");
    expect(placeholder).toBeGreaterThan(done2005);
    const after = listings(os.slice(done2005));
    expect(after).toHaveLength(24);
    const mapped = after.filter((o) => o.ref !== "");
    expect(mapped.every((o) => o.vehicle.firstRegistration?.year === 2004)).toBe(true);
  });

  it("a slice short on its first pass and whole on its second is done", async () => {
    // Replay serves a URL's recordings in order: the first pass sees page 1 without a car.
    const cassette = await loadCassette(full);
    const first = at(cassette, Y2005_1);
    const short = { ...first, response: cars((c) => c.slice(1))(first.response) };
    const interactions = [...cassette.interactions];
    interactions.splice(interactions.indexOf(first), 0, short);
    const os = await harvest({ ...cassette, interactions }, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    expect(listings(os)).toHaveLength(80);
  });

  it("a second pass must reach its own count: the first pass's cars cannot fill it", async () => {
    // Pass 1 misses car X on page 1. Before pass 2 one car is gone (every page reports one
    // less) and pass 2 misses X and Y. Together the passes have all but X: one less than
    // pass 2 reports, so a union would pass for complete while X is still unseen.
    const cassette = await loadCassette(full);
    const fewer = (body: string) =>
      body.replace(/"totalItems":(\d+)/, (_, n) => `"totalItems":${Number(n) - 1}`);
    const interactions = cassette.interactions.flatMap((x) => {
      if (!x.request.url.includes("/2005?")) return [x];
      const firstPage = x.request.url.endsWith(Y2005_1);
      const pass1 = firstPage ? cars((c) => c.slice(1))(x.response) : x.response;
      const pass2 = firstPage ? cars((c) => c.slice(2))(x.response) : x.response;
      return [
        { ...x, response: pass1 },
        { ...x, response: { ...pass2, body: fewer(pass2.body) } },
      ];
    });
    const os: Observation[] = [];
    await expect(harvest({ ...cassette, interactions }, { mode: "full" }, os)).rejects.toThrow(
      /fewer listings than reported: year:2005/,
    );
    expect(slicesDone(os)).toEqual(["year:2004"]);
  });

  it("an empty slice is done", async () => {
    const cassette = edit(await loadCassette(full), Y2004, (r) => ({
      ...r,
      body: withCars(r.body, () => []).replace(
        /"pagination":\{[^}]*\}/,
        '"pagination":{"limit":35,"skip":0,"page":1,"hasMore":false,"totalPages":0,"totalItems":0}',
      ),
    }));
    const os = await harvest(cassette, { mode: "full" });
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    expect(listings(os)).toHaveLength(56);
  });

  it("a car the site marks sold yields ListingGone", async () => {
    const cassette = edit(
      await loadCassette(full),
      Y2005_2,
      cars(([first, ...rest]) => [{ ...(first as Car), isSold: true }, ...rest]),
    );
    const os = await harvest(cassette, { mode: "full" });
    const gone = os.filter((o): o is ListingGone => o.kind === "ListingGone");
    expect(gone).toHaveLength(1);
    expect(listings(os).map((o) => o.ref)).not.toContain(gone[0]?.ref);
    expect(slicesDone(os)).toEqual(FULL_SLICES);
  });

  it("without the branch list the listings come out without location", async () => {
    const cassette = edit(await loadCassette(full), BRANCHES, (r) => ({ ...r, status: 503 }));
    const os = await harvest(cassette, { mode: "full" });
    expect(listings(os)).toHaveLength(80);
    expect(listings(os).every((o) => o.location === undefined)).toBe(true);
    expect(slicesDone(os)).toEqual(FULL_SLICES);
    const whole = await harvest(await loadCassette(full), { mode: "full" });
    expect(listings(whole).some((o) => o.location !== undefined)).toBe(true);
  });

  it("a changed list page fails the run", async () => {
    const changed = edit(await loadCassette(full), Y2005_2, (r) => ({
      ...r,
      body: "<html></html>",
    }));
    await expect(harvest(changed, { mode: "full" })).rejects.toThrow(/AAA Auto page changed/);
    const noIds = edit(
      await loadCassette(full),
      Y2005_2,
      cars((c) => c.map((car) => ({ ...car, id: undefined }))),
    );
    await expect(harvest(noIds, { mode: "full" })).rejects.toThrow(/no car on it has an id/);
  });

  it("an HTTP error on a list page fails the run", async () => {
    const cassette = edit(await loadCassette(full), Y2005_2, (r) => ({ ...r, status: 500 }));
    await expect(harvest(cassette, { mode: "full" })).rejects.toThrow(/HTTP 500/);
  });

  it("maxPages bounds incremental walks and fails a full slice that needs more", async () => {
    const urls: string[] = [];
    const os = await harvest(await loadCassette(incremental), {
      mode: "incremental",
      known: await known(),
      options: { maxPages: 1 },
      urls,
    });
    expect(listings(os)).toHaveLength(6);
    expect(lists(urls).map((u) => new URL(u).pathname)).toEqual([
      "/ojete-vozy/2000",
      "/ojete-vozy/predvadeci-vozy-mototechna/",
    ]);
    await expect(
      harvest(await loadCassette(full), {
        mode: "full",
        options: { slices: FULL_SLICES, maxPages: 1 },
      }),
    ).rejects.toThrow(/year:2005 has more than 1 pages/);
  });

  it("slices narrow full runs only, and must exist", async () => {
    await expect(
      harvest(await loadCassette(incremental), {
        mode: "incremental",
        options: { slices: ["year:2004"] },
      }),
    ).rejects.toThrow(/full runs only/);
    await expect(
      harvest(await loadCassette(full), { mode: "full", options: { slices: ["year:1999"] } }),
    ).rejects.toThrow(/Unknown AAA Auto slices: year:1999/);
  });

  it("names its scope after the slices it is limited to", () => {
    expect(aaaautoSource().scope).toBe("all");
    expect(aaaautoSource({ slices: ["year:2005", "year:2004"] }).scope).toBe(
      "slices:year:2004,year:2005",
    );
  });
});
