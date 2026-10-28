import {
  type Cassette,
  createReplayHttp,
  type Http,
  HttpBlockedError,
  type Interaction,
  loadCassette,
} from "@cca/http";
import type { ListingSeen, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  emptyCheckpoint,
  type HarvestContext,
  type HarvestMode,
  silentLogger,
} from "../source.ts";
import { sautoSource } from "./sauto.ts";

// Recorded 2026-10-25 against live Sauto: an incremental and a full run of
// sautoSource(OPTIONS), personal fields (phone, user, VIN, description) stripped.
const fixture = new URL("./fixtures/dacia-spring.cassette.json", import.meta.url);
const now = new Date("2026-10-25T13:27:00Z");
const OPTIONS = { manufacturerModel: "dacia:spring", pageSize: 4, sliceLimit: 8 };
/** A last run before every listing of the fixture: an incremental run yields all it does not know. */
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

async function harvest(
  mode: HarvestMode,
  checkpoint: Partial<Checkpoint> = {},
  edit: (cassette: Cassette) => void = () => {},
  signal = new AbortController().signal,
): Promise<{ observations: Observation[]; urls: string[] }> {
  const cassette = structuredClone(await loadCassette(fixture));
  edit(cassette);
  const replay = createReplayHttp(cassette);
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
    checkpoint: { ...emptyCheckpoint, lastRunAt: LONG_AGO, ...checkpoint },
    now,
    log: silentLogger,
    signal,
  };
  const observations: Observation[] = [];
  for await (const o of sautoSource(OPTIONS).harvest(ctx)) observations.push(o);
  return { observations, urls };
}

const listings = (os: Observation[]) =>
  os.filter((o): o is ListingSeen => o.kind === "ListingSeen");
const slices = (os: Observation[]) => os.flatMap((o) => (o.kind === "SliceDone" ? [o.slice] : []));
const searches = (urls: string[]) => urls.filter((u) => u.includes("/items/search?"));

type ApiItem = Record<string, unknown>;
/** Search pages carry `results`, details `result`. */
type ApiBody = { results: ApiItem[]; result: ApiItem };

/** Rewrites the JSON body of every recorded response whose URL matches. */
function editBodies(
  cassette: Cassette,
  match: (url: string) => boolean,
  fn: (body: ApiBody) => void,
) {
  for (const i of cassette.interactions.filter((i) => match(i.request.url))) {
    const body = JSON.parse(i.response.body);
    fn(body);
    i.response.body = JSON.stringify(body);
  }
}

function replaceResponse(
  cassette: Cassette,
  match: (url: string) => boolean,
  response: Partial<Interaction["response"]>,
) {
  for (const i of cassette.interactions.filter((i) => match(i.request.url))) {
    Object.assign(i.response, response);
  }
}

/** A synthetic listing as the API serves it, in search results and as its own detail. */
const car = (id: number, fields: ApiItem = {}): ApiItem => ({
  id,
  price: 100000,
  create_date: "2026-10-25T09:00:00",
  sorting_date: "2026-10-25T10:00:00",
  manufacturing_date: "2021-01-01",
  manufacturer_cb: { name: "Dacia", seo_name: "dacia", value: 15 },
  model_cb: { name: "Spring", seo_name: "spring", value: 9057 },
  condition_cb: { name: "Nové", value: 1 },
  ...fields,
});
const cars = (...ids: number[]) => ids.map((id) => car(id));

/**
 * Runs sautoSource({ pageSize: 4 }) against a synthetic API: `search` answers each search
 * query; a detail serves the last search item with its id, merged with `details[id]`.
 * `consume` sees each observation before the harvest resumes, as the Ledger would.
 */
async function harvestSite(
  mode: HarvestMode,
  search: (query: URLSearchParams) => { total: number; results: ApiItem[] },
  options: {
    checkpoint?: Partial<Checkpoint>;
    details?: Record<string, ApiItem>;
    consume?: (o: Observation) => void;
  } = {},
): Promise<{ observations: Observation[]; urls: string[]; error?: unknown }> {
  const served = new Map<string, ApiItem>();
  const urls: string[] = [];
  const http: Http = {
    async get(request) {
      const url = typeof request === "string" ? request : request.url;
      urls.push(url);
      const { pathname, searchParams } = new URL(url);
      const id = pathname.split("/").pop() ?? "";
      let body: unknown;
      if (id === "search") {
        const page = search(searchParams);
        for (const item of page.results) served.set(String(item.id), item);
        body = { pagination: { total: page.total }, results: page.results };
      } else {
        body = { result: { ...served.get(id), ...options.details?.[id] } };
      }
      return { url, status: 200, headers: {}, body: JSON.stringify(body), tier: "T0" };
    },
  };
  const ctx: HarvestContext = {
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, ...options.checkpoint },
    now,
    log: silentLogger,
    signal: new AbortController().signal,
  };
  const observations: Observation[] = [];
  try {
    for await (const o of sautoSource({ pageSize: 4 }).harvest(ctx)) {
      observations.push(o);
      options.consume?.(o);
    }
  } catch (error) {
    return { observations, urls, error };
  }
  return { observations, urls };
}

const NEW_LOW = "new/0-134217728";
/** The search for the `nove` band below PRICE_TOP; every other band is empty. */
const newLow = (query: URLSearchParams) =>
  query.get("condition_seo") === "nove" && query.get("price_from") === "0";
const empty = { total: 0, results: [] };
/** A search over `list`, served in pages of 4 from the query's offset. */
const paged = (list: ApiItem[]) => (query: URLSearchParams) => {
  const offset = Number(query.get("offset"));
  return { total: list.length, results: list.slice(offset, offset + 4) };
};
const ALL_SLICES = ["new", "demo", "used"].flatMap((c) => [`${c}/0-134217728`, `${c}/134217728-`]);

const isDetail = (ref: string) => (url: string) => url.endsWith(`/api/v1/items/${ref}`);
const firstSearchPage = (url: string) =>
  url.includes("/items/search?") && !url.includes("price_from") && url.includes("offset=0");

describe("sauto source", () => {
  it("is lazy: no request before the first next()", async () => {
    let requests = 0;
    const http: Http = {
      async get() {
        requests++;
        throw new Error("unexpected");
      },
    };
    sautoSource(OPTIONS).harvest({
      http,
      mode: "full",
      checkpoint: emptyCheckpoint,
      now,
      log: silentLogger,
      signal: new AbortController().signal,
    });
    expect(requests).toBe(0);
  });

  it("incremental run pages newest-first through new, demo and used listings", async () => {
    const { observations, urls } = await harvest("incremental");
    const seen = listings(observations);
    expect(seen.length).toBeGreaterThan(OPTIONS.pageSize);
    expect(searches(urls).length).toBeGreaterThan(1);
    expect(new Set(seen.map((o) => o.condition))).toEqual(new Set(["new", "demo", "used"]));
    expect(new Set(seen.map((o) => o.ref)).size).toBe(seen.length);
    for (const o of seen) {
      expect(o.url).toBe(`https://www.sauto.cz/osobni/detail/dacia/spring/${o.ref}`);
      expect(o.vehicle).toMatchObject({ make: "Dacia", model: "Spring", fuel: "bev" });
      expect(o.price.currency).toBe("CZK");
      expect(o.photos.every((p) => p.startsWith("https://"))).toBe(true);
    }
  });

  it("maps a listing's detail onto ListingSeen", async () => {
    const seen = listings((await harvest("incremental")).observations);
    const byRef = (ref: string) => seen.find((o) => o.ref === ref);
    expect(byRef("210998559")).toEqual({
      kind: "ListingSeen",
      ref: "210998559",
      url: "https://www.sauto.cz/osobni/detail/dacia/spring/210998559",
      market: "CZ",
      condition: "demo",
      vehicle: {
        make: "Dacia",
        model: "Spring",
        trim: "Electric 65 (27 kWh), SoH 96%",
        sourceTaxonomy: { make: "15", model: "9057" },
        firstRegistration: { year: 2025, month: 10 },
        body: "hatchback",
        fuel: "bev",
        powerKw: 48,
        transmission: "automatic",
        seats: 4,
        doors: 5,
        consumptionKwh100km: 14.5,
        color: "Červená",
      },
      odometerKm: 4945,
      price: { amount: 400000, currency: "CZK" },
      // "Možnost odpočtu DPH": the price includes VAT a buyer can reclaim.
      priceBasis: "gross",
      seller: "dealer",
      location: { region: "Hlavní město Praha" },
      photos: [
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/nPYADvcUkmDj2BMFYYHmLC2e/6b57.jpeg",
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/nPYADvcUkmBcG9PJpWHmLC26/e48d.jpeg",
        "https://d19-a.sdn.cz/d_19/c_img_qE_B/kPVqmweP7JB4z4nDicHmLC3d/6e13.jpeg",
      ],
      listedAt: "2026-08-26",
      inspectionValidUntil: { year: 2029, month: 10 },
    });
    expect(byRef("211099650")).toMatchObject({
      condition: "new",
      seller: "dealer",
      priceBasis: "gross",
      odometerKm: 5,
      vehicle: { trim: "Extreme electric 100", powerKw: 75, manufactureYear: 2026 },
    });
    // A private seller (no premise) who does not offer a VAT deduction.
    expect(byRef("210518621")).toMatchObject({
      condition: "used",
      seller: "private",
      priceBasis: "unknown",
      location: { region: "Středočeský kraj", city: "Příbram" },
      vehicle: { firstRegistration: { year: 2025, month: 1 }, drive: "fwd" },
    });
  });

  // Pages of 4 by sorting_date (created): 10-24 (09-29), 10-19 (05-30), 10-14 (05-09),
  // 10-13 (09-14) | 10-13 (10-13) 211264902, 10-05 (10-05), 10-05 (04-22), 09-14 (09-14) | ...
  const LAST_RUN = new Date("2026-10-12T00:00:00Z"); // less the margin, 10-12 00:00 in Prague

  it("incremental run after a last run reads down to it and fetches only listings created since", async () => {
    const { observations, urls } = await harvest("incremental", { lastRunAt: LAST_RUN });
    // The 3rd page is wholly older than the last run.
    expect(searches(urls)).toHaveLength(3);
    // Page 1 was moved up by edits and top-ups: older listings, left to the census.
    expect(urls.filter((u) => !u.includes("/items/search?"))).toEqual([
      "https://www.sauto.cz/api/v1/items/211264902",
    ]);
    expect(listings(observations).map((o) => o.ref)).toEqual(["211264902"]);
  });

  it("first incremental run reads back a day", async () => {
    // Nothing moved within the day before the recording (the newest is 10-24 11:22).
    const { observations, urls } = await harvest("incremental", { lastRunAt: null });
    expect(searches(urls)).toHaveLength(1);
    expect(observations).toEqual([]);
  });

  it("incremental run keeps walking past a page of recent listings without a price", async () => {
    const { observations, urls } = await harvest(
      "incremental",
      { lastRunAt: LAST_RUN },
      (cassette) =>
        editBodies(cassette, firstSearchPage, (body) => {
          for (const item of body.results)
            Object.assign(item, { price: null, price_by_agreement: true });
        }),
    );
    expect(searches(urls)).toHaveLength(3);
    expect(listings(observations).map((o) => o.ref)).toEqual(["211264902"]);
  });

  it("incremental run leaves known listings to the census, however recently changed", async () => {
    const known = { isKnown: () => true };
    const longAgo = await harvest("incremental", known);
    expect(longAgo.observations).toEqual([]);
    expect(longAgo.urls.every((u) => u.includes("/items/search?"))).toBe(true);
    expect(searches(longAgo.urls)).toHaveLength(4);
    const justNow = await harvest("incremental", { ...known, lastRunAt: now });
    expect(justNow.observations).toEqual([]);
    expect(searches(justNow.urls)).toHaveLength(1);
  });

  it("full run halves bands over the slice limit and reports each finished slice", async () => {
    const { observations, urls } = await harvest("full");
    const done = slices(observations);
    expect(new Set(done).size).toBe(done.length);
    // A leaf band paged in overlapping steps (pageSize 4, step 3); overlaps yield once.
    expect(searches(urls).some((u) => u.includes("price_from") && u.includes("offset=3"))).toBe(
      true,
    );
    const refs = listings(observations).map((o) => o.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(done).toContain("new/134217728-");
    expect(done).toContain("demo/134217728-");
    expect(done.some((s) => s.startsWith("used/") && s !== "used/0-134217728")).toBe(true);
    expect(done).not.toContain("used/0-134217728");
    // The census sees what the incremental run saw.
    const incremental = listings((await harvest("incremental")).observations);
    expect(new Set(listings(observations).map((o) => o.ref))).toEqual(
      new Set(incremental.map((o) => o.ref)),
    );
    // Every listing belongs to the slice whose SliceDone follows it.
    let open: ListingSeen[] = [];
    for (const o of observations) {
      if (o.kind === "ListingSeen") open.push(o);
      if (o.kind === "SliceDone") {
        const [condition, band] = o.slice.split("/") as [string, string];
        const [from, to] = band.split("-").map((n) => (n === "" ? Infinity : Number(n)));
        for (const l of open) {
          expect(l.condition).toBe(condition);
          expect(l.price.amount).toBeGreaterThanOrEqual(from as number);
          expect(l.price.amount).toBeLessThan(to as number);
        }
        open = [];
      }
    }
    expect(open).toEqual([]);
  });

  it("full run halves a band over 2,000 results by default, so a slice's details fit in a run", async () => {
    // At 1 request a second a 9,500-result slice took near 3 hours: a run cut off in one
    // lost it all.
    const whole = (q: URLSearchParams) => newLow(q) && q.get("price_to") === "134217727";
    const { observations, error } = await harvestSite("full", (q) =>
      whole(q) ? { total: 2_001, results: [] } : empty,
    );
    expect(error).toBeUndefined();
    expect(slices(observations)).toEqual([
      "new/0-67108864",
      "new/67108864-134217728",
      ...ALL_SLICES.filter((s) => s !== NEW_LOW),
    ]);
  });

  it("full run resumes a census: slices done earlier are skipped", async () => {
    const all = await harvest("full");
    const done = slices(all.observations);
    const skipped = new Set(done.filter((s) => s.startsWith("used/")));
    const resumed = await harvest("full", {
      sliceDoneAt: (slice) => (skipped.has(slice) ? new Date("2026-10-24T03:00:00Z") : null),
    });
    expect(slices(resumed.observations)).toEqual(done.filter((s) => !skipped.has(s)));
    expect(listings(resumed.observations).every((o) => o.condition !== "used")).toBe(true);
    expect(resumed.urls.length).toBeLessThan(all.urls.length);
  });

  it("a malformed item comes out as an observation the Ledger rejects; the run goes on", async () => {
    const all = listings((await harvest("incremental")).observations);
    const victim = all[1] as ListingSeen;
    const { observations } = await harvest("incremental", {}, (cassette) => {
      const strip = (item: ApiItem) => {
        delete item.manufacturer_cb;
        delete item.model_cb;
      };
      editBodies(
        cassette,
        (url) => url.includes("/items/search?"),
        (body) => {
          for (const item of body.results) if (String(item.id) === victim.ref) strip(item);
        },
      );
      editBodies(cassette, isDetail(victim.ref), (body) => strip(body.result));
      editBodies(cassette, firstSearchPage, (body) => {
        delete body.results[0]?.id;
      });
    });
    const out = listings(observations);
    // Ledger validation rejects an empty ref and an empty make/model (packages/ledger/src/validate.ts).
    expect(out.filter((o) => o.ref === "")).toHaveLength(1);
    expect(out.find((o) => o.ref === victim.ref)?.vehicle.make).toBe("");
    expect(out.filter((o) => o.ref !== "" && o.vehicle.make !== "")).toHaveLength(all.length - 2);
  });

  it("a malformed search entry neither ends its slice's paging nor its census", async () => {
    const full = await harvest("full");
    const paged = searches(full.urls).find(
      (u) => u.includes("price_from") && u.includes("offset=3"),
    );
    const pageOne = paged?.replace("offset=3", "offset=0");
    expect(pageOne).toBeDefined();
    let dropped = "";
    const { observations, urls } = await harvest("full", {}, (cassette) =>
      editBodies(
        cassette,
        (url) => url === pageOne,
        (body) => {
          dropped = String(body.results[0]?.id);
          (body.results as unknown[])[0] = null;
        },
      ),
    );
    expect(urls).toContain(paged);
    const out = listings(observations);
    expect(out.filter((o) => o.ref === "")).toHaveLength(1);
    expect(out.some((o) => o.ref === dropped)).toBe(false);
    expect(out.length).toBe(listings(full.observations).length);
    expect(slices(observations)).toEqual(slices(full.observations));
  });

  it("skips listings without a price and reports a removed listing gone", async () => {
    const all = listings((await harvest("incremental")).observations);
    const [unpriced, removed] = all as [ListingSeen, ListingSeen];
    const { observations } = await harvest("incremental", {}, (cassette) => {
      editBodies(
        cassette,
        (url) => url.includes("/items/search?"),
        (body) => {
          for (const item of body.results) {
            if (String(item.id) === unpriced.ref)
              Object.assign(item, { price: null, price_by_agreement: true });
          }
        },
      );
      replaceResponse(cassette, isDetail(removed.ref), {
        status: 404,
        body: JSON.stringify({ status_code: 404, status_message: "Not found" }),
      });
    });
    expect(observations.some((o) => o.kind === "ListingSeen" && o.ref === unpriced.ref)).toBe(
      false,
    );
    expect(observations).toContainEqual({ kind: "ListingGone", ref: removed.ref });
    expect(listings(observations)).toHaveLength(all.length - 2);
  });

  it("a price shown without VAT is net, even when the VAT is deductible", async () => {
    const [first] = listings((await harvest("incremental")).observations) as [ListingSeen];
    const { observations } = await harvest("incremental", {}, (cassette) =>
      editBodies(cassette, isDetail(first.ref), (body) =>
        Object.assign(body.result, { price_is_vat_deductible: true, price_is_without_vat: true }),
      ),
    );
    expect(listings(observations)[0]).toMatchObject({ ref: first.ref, priceBasis: "net" });
  });

  it("fails the run when the API answers with a page that is not JSON", async () => {
    await expect(
      harvest("incremental", {}, (cassette) =>
        replaceResponse(cassette, firstSearchPage, {
          headers: { "content-type": "text/html" },
          body: "<!doctype html><title>Seznam - souhlas</title>",
        }),
      ),
    ).rejects.toThrow(/non-JSON/);
  });

  it("fails the run when the API is blocked", async () => {
    await expect(
      harvest("full", {}, (cassette) =>
        replaceResponse(cassette, () => true, {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
      ),
    ).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("incremental run fails at the 10,000-result window after a last run, but not on a first run", async () => {
    // Every page repeats one new listing, so only its detail is needed.
    const item = {
      id: 1,
      price: 100000,
      create_date: "2026-10-25T13:00:00",
      sorting_date: "2026-10-25T14:00:00",
      manufacturer_cb: { name: "Dacia", seo_name: "dacia", value: 15 },
      model_cb: { name: "Spring", seo_name: "spring", value: 9057 },
      condition_cb: { name: "Ojeté", value: 2 },
    };
    const json = (url: string, body: unknown): Interaction => ({
      request: { url },
      response: { url, status: 200, headers: {}, body: JSON.stringify(body), tier: "T0" },
    });
    const interactions = [json("https://www.sauto.cz/api/v1/items/1", { result: item })];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const params = new URLSearchParams({
        category_id: "838",
        condition_seo: "nove,predvadeci,ojete",
        operating_lease: "false",
        vehicle_age_from: "2000",
        limit: "100",
        offset: String(offset),
      });
      interactions.push(
        json(`https://www.sauto.cz/api/v1/items/search?${params}`, {
          pagination: { total: 10_001 },
          results: Array.from({ length: 100 }, () => item),
        }),
      );
    }
    const run = async (checkpoint: Partial<Checkpoint>) => {
      const out: Observation[] = [];
      const ctx: HarvestContext = {
        http: createReplayHttp({ version: 1, interactions }),
        mode: "incremental",
        checkpoint: { ...emptyCheckpoint, ...checkpoint },
        now,
        log: silentLogger,
        signal: new AbortController().signal,
      };
      for await (const o of sautoSource({ pageSize: 100 }).harvest(ctx)) out.push(o);
      return out;
    };
    await expect(run({ lastRunAt: new Date("2026-10-25T12:00:00Z") })).rejects.toThrow(/window/);
    expect(listings(await run({}))).toHaveLength(1);
  });

  it("full run leaves a band whose pages hold fewer results than its total not done, and fails", async () => {
    const { observations, urls, error } = await harvestSite("full", (q) =>
      newLow(q) ? { total: 6, results: cars(1001, 1002) } : empty,
    );
    expect(String(error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(observations).map((o) => o.ref)).toEqual(["1001", "1002"]);
    expect(slices(observations)).toEqual(ALL_SLICES.filter((s) => s !== NEW_LOW));
    // Paged once more before giving up.
    expect(searches(urls).filter((u) => newLow(new URL(u).searchParams))).toHaveLength(2);
  });

  it("full run does not count a page served twice towards its band's total", async () => {
    // Offsets 0 and 3 (pageSize 4, step 3) both answer 1–4, of a total of 6.
    const { observations, error } = await harvestSite("full", (q) =>
      newLow(q) ? { total: 6, results: cars(1, 2, 3, 4) } : empty,
    );
    expect(String(error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(observations).map((o) => o.ref)).toEqual(["1", "2", "3", "4"]);
    expect(slices(observations)).not.toContain(NEW_LOW);
  });

  it("full run finishes a short band when paging it again reaches its total", async () => {
    let passes = 0;
    const { observations, error } = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      passes++;
      // The first pass misses 3 and serves 1 without a price; the second has it priced.
      const unpriced = car(1, { price: null, price_by_agreement: true });
      return { total: 3, results: passes === 1 ? [unpriced, car(2)] : cars(1, 2, 3) };
    });
    expect(error).toBeUndefined();
    expect(listings(observations).map((o) => o.ref)).toEqual(["1", "2", "3"]);
    expect(slices(observations)).toEqual(ALL_SLICES);
  });

  it("full run judges each pass alone, against the highest total its pages reported", async () => {
    // Two short passes that together hold all 3 results.
    let passes = 0;
    const apart = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      passes++;
      return { total: 3, results: passes === 1 ? cars(1, 2) : cars(2, 3) };
    });
    expect(String(apart.error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(listings(apart.observations).map((o) => o.ref)).toEqual(["1", "2", "3"]);
    expect(slices(apart.observations)).not.toContain(NEW_LOW);
    // The first page reports 6, the next only 5; 5 distinct do not reach 6.
    const shrunk = await harvestSite("full", (q) => {
      if (!newLow(q)) return empty;
      return q.get("offset") === "0"
        ? { total: 6, results: cars(1, 2, 3, 4) }
        : { total: 5, results: cars(4, 5) };
    });
    expect(String(shrunk.error)).toMatch(/fewer results than reported: new\/0-134217728$/);
    expect(slices(shrunk.observations)).not.toContain(NEW_LOW);
  });

  it("incremental run yields each new listing once, though the order repeats it", async () => {
    // The second page repeats the first (the order moved); the third holds unseen listings.
    const pages: Record<string, ApiItem[]> = {
      0: cars(1, 2, 3, 4),
      4: cars(1, 2, 3, 4),
      8: cars(5, 6, 7, 8),
      12: [],
    };
    const recorded = new Set<string>();
    const { observations, error } = await harvestSite(
      "incremental",
      (q) => ({ total: 12, results: pages[q.get("offset") ?? ""] ?? [] }),
      {
        checkpoint: { lastRunAt: LONG_AGO, isKnown: (ref) => recorded.has(ref) },
        consume: (o) => {
          if (o.kind === "ListingSeen") recorded.add(o.ref);
        },
      },
    );
    expect(error).toBeUndefined();
    expect(listings(observations).map((o) => o.ref)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
  });

  it("keeps listings made before 2000 out, and counts them towards a band's total", async () => {
    // A first page of nothing in scope, which must not end a first run's walk.
    const list = [
      car(1, { manufacturing_date: "1999-12-01" }),
      // Without a year of manufacture, the first registration's year counts.
      car(3, { manufacturing_date: null, in_operation_date: "1999-06-01" }),
      car(6, { manufacturing_date: "1990-01-01" }),
      car(7, { price: null, price_by_agreement: true }),
      car(2, { manufacturing_date: "2000-01-01" }),
      car(4, { manufacturing_date: null, in_operation_date: "2000-03-01" }),
      // Only the detail dates this one.
      car(5, { manufacturing_date: null }),
    ];
    const details = { 5: { manufacturing_date: "1998-01-01" } };
    const incremental = await harvestSite("incremental", paged(list), { details });
    expect(incremental.error).toBeUndefined();
    expect(listings(incremental.observations).map((o) => o.ref)).toEqual(["2", "4"]);
    expect(searches(incremental.urls).every((u) => u.includes("vehicle_age_from=2000"))).toBe(true);
    expect(incremental.urls.some((u) => /\/items\/[1367]$/.test(u))).toBe(false);
    const full = await harvestSite("full", (q) => (newLow(q) ? paged(list)(q) : empty), {
      details,
    });
    expect(full.error).toBeUndefined();
    expect(listings(full.observations).map((o) => o.ref)).toEqual(["2", "4"]);
    expect(slices(full.observations)).toEqual(ALL_SLICES);
    expect(searches(full.urls).every((u) => u.includes("vehicle_age_from=2000"))).toBe(true);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(harvest("full", {}, () => {}, controller.signal)).rejects.toThrow("stop");
  });
});
