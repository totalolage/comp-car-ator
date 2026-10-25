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
    checkpoint: { ...emptyCheckpoint, ...checkpoint },
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

  it("first incremental run pages newest-first through new, demo and used listings", async () => {
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

  it("incremental run stops at the first page whose listings are all known and unchanged", async () => {
    const first = listings((await harvest("incremental")).observations);
    const pageOne = new Set(first.slice(0, OPTIONS.pageSize).map((o) => o.ref));
    const { observations, urls } = await harvest("incremental", {
      lastRunAt: null,
      isKnown: (ref) => !pageOne.has(ref),
    });
    expect(listings(observations).map((o) => o.ref)).toEqual([...pageOne]);
    expect(searches(urls)).toHaveLength(2);
  });

  it("incremental run after a last run ends at the first page older than it", async () => {
    // Pages of 4 by sorting_date: 10-24, 10-19, 10-14 07:37, 10-13 | 10-13, 10-05, ...
    const { observations, urls } = await harvest("incremental", {
      lastRunAt: new Date("2026-10-14T12:00:00Z"),
    });
    expect(searches(urls)).toHaveLength(2);
    expect(listings(observations)).toHaveLength(8);
  });

  it("incremental run keeps walking past a page of recent listings without a price", async () => {
    const { observations, urls } = await harvest(
      "incremental",
      { lastRunAt: new Date("2026-10-14T12:00:00Z") },
      (cassette) =>
        editBodies(cassette, firstSearchPage, (body) => {
          for (const item of body.results)
            Object.assign(item, { price: null, price_by_agreement: true });
        }),
    );
    expect(searches(urls)).toHaveLength(2);
    expect(listings(observations)).toHaveLength(4);
  });

  it("incremental run re-yields known listings changed since the last run", async () => {
    const all = listings((await harvest("incremental")).observations);
    const known = { isKnown: () => true };
    const longAgo = await harvest("incremental", { ...known, lastRunAt: new Date("2020-01-01") });
    expect(listings(longAgo.observations)).toHaveLength(all.length);
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
    // Every page repeats one recently changed listing, so only its detail is needed.
    const item = {
      id: 1,
      price: 100000,
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

  it("first incremental run walks past a page where nothing has a price", async () => {
    const { observations, urls } = await harvest("incremental", {}, (cassette) =>
      editBodies(cassette, firstSearchPage, (body) => {
        for (const item of body.results) {
          Object.assign(item, { price: null, price_by_agreement: true });
        }
      }),
    );
    expect(searches(urls).length).toBeGreaterThan(1);
    expect(listings(observations)).toHaveLength(9);
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(harvest("full", {}, () => {}, controller.signal)).rejects.toThrow("stop");
  });
});
