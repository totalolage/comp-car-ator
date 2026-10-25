import { readFile } from "node:fs/promises";
import { type Cassette, createReplayHttp, loadCassette } from "@cca/http";
import type { ListPrice } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, type Source } from "../source.ts";
import { skodaPricelistSource } from "./skoda-pricelist.ts";

// Responses fetched from the live site 2026-10-25 (index, configurator model tiles, the Kodiaq,
// Enyaq and Octavia lists) and recorded through the real adapter in a full run, then trimmed:
// the index keeps those three models' links (Octavia's accessory catalogue included), the tiles
// keep title and modelId, and each PDF keeps its "Platnost od" page and price-table pages
// (Ghostscript pdfwrite, -dFILTERIMAGE -dFILTERVECTOR). kodiaq-footnote.pdf is that Kodiaq list
// with a footnote mark ("*") set after the Selection price of the 1,5 TSI/118 kW row;
// kodiaq-stray-price.pdf has a price "1 111 000" set between two rows of its grid.
const cassetteFile = new URL("./fixtures/lists.cassette.json", import.meta.url);
const footnoteFile = new URL("./fixtures/kodiaq-footnote.pdf", import.meta.url);
const strayFile = new URL("./fixtures/kodiaq-stray-price.pdf", import.meta.url);
const now = new Date("2026-10-25T18:00:00Z");
const KODIAQ = "634e9e51-81c5-4c60-8503-4ab557399835";
const ENYAQ = "6de4c5ec-a6b4-4057-988d-0724f9d5b40d";
const OCTAVIA = "2ebe536d-8731-4795-9fa2-d6596229a9ea";

interface Run {
  mode?: HarvestMode;
  inForce?: ListPrice[];
  source?: Source;
  cassette?: Cassette;
  warnings?: string[];
}

async function harvest(run: Run = {}): Promise<ListPrice[]> {
  const out: ListPrice[] = [];
  for await (const o of (run.source ?? skodaPricelistSource()).harvest({
    http: createReplayHttp(run.cassette ?? (await loadCassette(cassetteFile))),
    mode: run.mode ?? "full",
    checkpoint: { ...emptyCheckpoint, offersInForce: () => run.inForce ?? [] },
    now,
    log: { info() {}, warn: (message) => run.warnings?.push(message) },
    signal: new AbortController().signal,
  })) {
    out.push(o as ListPrice);
  }
  return out;
}

type Response = Cassette["interactions"][number]["response"];

/** The cassette with the response for the URL ending in `suffix` changed. */
async function edit(suffix: string, change: (r: Response) => Response): Promise<Cassette> {
  const cassette = await loadCassette(cassetteFile);
  const i = cassette.interactions.findIndex((x) => x.request.url.endsWith(suffix));
  if (i < 0) throw new Error(`no interaction for ${suffix}`);
  const interactions = cassette.interactions.map((x, j) =>
    j === i ? { ...x, response: change(x.response) } : x,
  );
  return { ...cassette, interactions };
}

const notAList = (r: Response): Response => ({
  ...r,
  headers: { "content-type": "text/html" },
  body: "<html><body>Stránka nenalezena</body></html>",
  bodyBase64: undefined,
});

const KODIAQ_118 = "kodiaq/kodiaq.1-5-tsi-118-kw.petrol.a.fwd.selection";

/** An edition the Ledger holds: a listed Offer's, or one made up under `ref`. */
function edition(ref: string, validFrom: string, amount = 1_000_000): ListPrice {
  return {
    kind: "ListPrice",
    ref,
    vehicle: { make: "Škoda", model: "Kodiaq", trim: "made up", fuel: "diesel", powerKw: 110 },
    price: { amount, currency: "CZK" },
    market: "CZ",
    validFrom,
  };
}

describe("skoda-pricelist source", () => {
  it("reads every priced cell of each grid as an Offer", async () => {
    const offers = await harvest();
    const byModel: Record<string, number> = {};
    for (const o of offers) byModel[o.vehicle.model] = (byModel[o.vehicle.model] ?? 0) + 1;
    expect(byModel).toEqual({
      Kodiaq: 23,
      Enyaq: 9,
      "Enyaq Coupé": 9,
      Octavia: 37,
      "Octavia Combi": 37,
    });
    expect(new Set(offers.map((o) => o.ref)).size).toBe(offers.length);
    expect(offers.every((o) => o.market === "CZ" && o.price.currency === "CZK")).toBe(true);

    expect(offers.find((o) => o.ref === KODIAQ_118)).toEqual({
      kind: "ListPrice",
      ref: KODIAQ_118,
      vehicle: {
        make: "Škoda",
        model: "Kodiaq",
        trim: "1,5 TSI/118 kW Selection",
        modelYear: 2027,
        body: "suv",
        fuel: "petrol",
        powerKw: 118,
        transmission: "automatic",
        drive: "fwd",
      },
      price: { amount: 995_000, currency: "CZK" },
      market: "CZ",
      validFrom: "2026-10-21",
    });
    // A trim line whose name stands on two lines, and an electric grid labelled Coupé.
    expect(
      offers.find((o) => o.ref === "kodiaq/kodiaq.1-5-tsi-150-kw-iv.phev.a.fwd.laurin-klement")
        ?.price.amount,
    ).toBe(1_440_000);
    expect(
      offers.find((o) => o.ref === "enyaq/enyaq-coupe.85x-220-kw.bev.x.awd.laurin-klement"),
    ).toMatchObject({
      vehicle: {
        model: "Enyaq Coupé",
        trim: "85x 220 kW Laurin & Klement",
        body: "suv",
        fuel: "bev",
        powerKw: 220,
        drive: "awd",
      },
      price: { amount: 1_549_000 },
    });
    // The Octavia list has its own date; Combi and edition grids come out as Octavia Combi.
    expect(
      offers.find(
        (o) => o.ref === "octavia/octavia-combi.2-0-tdi-110-kw.diesel.a.fwd.edice-30-let",
      ),
    ).toMatchObject({
      vehicle: { model: "Octavia Combi", body: "wagon", trim: "2,0 TDI/110 kW Edice 30 let" },
      price: { amount: 989_900 },
      validFrom: "2026-10-23",
    });
    // "–": the trim line does not offer that engine.
    expect(
      offers.some((o) => o.ref === "kodiaq/kodiaq.1-5-tsi-200-kw-iv.phev.a.fwd.selection"),
    ).toBe(false);
  });

  it("gives an Offer the same ref in every run, so a new edition replaces the old one", async () => {
    const first = await harvest();
    const second = await harvest({ inForce: [edition(KODIAQ_118, "2026-09-01", 979_000)] });
    expect(second.map((o) => o.ref)).toEqual(first.map((o) => o.ref));
    expect(second.filter((o) => o.ref === KODIAQ_118)).toEqual([
      expect.objectContaining({
        validFrom: "2026-10-21",
        price: { amount: 995_000, currency: "CZK" },
      }),
    ]);
  });

  it("full runs withdraw Offers a newer list dropped, incremental runs never", async () => {
    const inForce = [
      edition("kodiaq/kodiaq.2-0-tdi-85-kw.diesel.m.fwd.selection", "2026-09-01"),
      edition("citigo/citigo-e-iv.bev.x.fwd.style", "2026-03-01"),
      // Missing from the very list it started in: seen gone by this run.
      edition("kodiaq/kodiaq.made-up.x.x.x.rs", "2026-10-21"),
    ];
    const full = await harvest({ inForce });
    expect(full.filter((o) => o.validTo)).toEqual([
      // Ends the day before the first current list issued after it started.
      { ...(inForce[0] as ListPrice), validTo: "2026-10-20" },
      // Its model left the index: ends the day before the run.
      { ...(inForce[1] as ListPrice), validTo: "2026-10-24" },
      { ...(inForce[2] as ListPrice), validTo: "2026-10-24" },
    ]);
    expect((await harvest({ mode: "incremental", inForce })).some((o) => o.validTo)).toBe(false);
  });

  it("a list that does not read is skipped and withdraws nothing", async () => {
    const warnings: string[] = [];
    const offers = await harvest({
      cassette: await edit(ENYAQ, notAList),
      inForce: [edition("enyaq/enyaq.60-140-kw.bev.x.rwd.selection", "2026-09-01")],
      warnings,
    });
    expect(offers.some((o) => o.vehicle.model.startsWith("Enyaq"))).toBe(false);
    expect(offers.some((o) => o.validTo)).toBe(false);
    expect(offers.filter((o) => o.vehicle.model === "Kodiaq")).toHaveLength(23);
    expect(warnings).toContain("skoda-pricelist: price list not available");
  });

  it("rejects a malformed row without failing the run, and then withdraws nothing of its model", async () => {
    const footnote = Buffer.from(await readFile(footnoteFile)).toString("base64");
    const warnings: string[] = [];
    const offers = await harvest({
      cassette: await edit(KODIAQ, (r) => ({ ...r, bodyBase64: footnote })),
      inForce: [
        edition("kodiaq/kodiaq.2-0-tdi-85-kw.diesel.m.fwd.selection", "2026-09-01"),
        edition("octavia/octavia.1-0-tsi-81-kw.petrol.m.fwd.essence", "2026-09-01"),
      ],
      warnings,
    });
    expect(warnings).toContain("skoda-pricelist: rejected row");
    expect(offers.some((o) => o.ref === KODIAQ_118)).toBe(false);
    expect(offers.filter((o) => o.vehicle.model === "Kodiaq" && !o.validTo)).toHaveLength(22);
    expect(offers.filter((o) => o.validTo).map((o) => o.ref)).toEqual([
      "octavia/octavia.1-0-tsi-81-kw.petrol.m.fwd.essence",
    ]);
  });

  it("a price no row read rejects its list's withdrawals: the row would look dropped", async () => {
    const stray = Buffer.from(await readFile(strayFile)).toString("base64");
    const warnings: string[] = [];
    const offers = await harvest({
      cassette: await edit(KODIAQ, (r) => ({ ...r, bodyBase64: stray })),
      inForce: [edition("kodiaq/kodiaq.2-0-tdi-85-kw.diesel.m.fwd.selection", "2026-09-01")],
      warnings,
    });
    expect(warnings).toContain("skoda-pricelist: rejected row");
    expect(offers.filter((o) => o.vehicle.model === "Kodiaq")).toHaveLength(23);
    expect(offers.some((o) => o.validTo)).toBe(false);
  });

  it("a price-list link it cannot name keeps every model in the index", async () => {
    const warnings: string[] = [];
    const offers = await harvest({
      cassette: await edit("/nabidka/ceniky-katalogy", (r) => ({
        ...r,
        body: r.body.replace(">Enyaq - Ceník<", ">Ceník Enyaq<"),
      })),
      inForce: [
        edition("citigo/citigo-e-iv.bev.x.fwd.style", "2026-03-01"),
        edition("enyaq/enyaq.60-140-kw.bev.x.rwd.selection", "2026-09-01"),
      ],
      warnings,
    });
    expect(warnings).toContain("skoda-pricelist: price-list link without a model name");
    expect(offers.some((o) => o.vehicle.model.startsWith("Enyaq"))).toBe(false);
    expect(offers.some((o) => o.validTo)).toBe(false);
  });

  it("fails when no list reads: the site has changed", async () => {
    let cassette = await edit(KODIAQ, notAList);
    for (const id of [ENYAQ, OCTAVIA]) {
      const i = cassette.interactions.findIndex((x) => x.request.url.endsWith(id));
      cassette = {
        ...cassette,
        interactions: cassette.interactions.map((x, j) =>
          j === i ? { ...x, response: notAList(x.response) } : x,
        ),
      };
    }
    await expect(harvest({ cassette })).rejects.toThrow("none of the 3 models' price lists");
  });

  it("a narrowed run reads only its models and withdraws only theirs", async () => {
    const source = skodaPricelistSource({ models: ["kodiaq"] });
    expect(source.scope).toBe("models:kodiaq");
    const offers = await harvest({
      source,
      inForce: [edition("octavia/octavia.1-0-tsi-81-kw.petrol.m.fwd.essence", "2026-09-01")],
    });
    expect(new Set(offers.map((o) => o.vehicle.model))).toEqual(new Set(["Kodiaq"]));
    expect(offers.some((o) => o.validTo)).toBe(false);
  });
});
