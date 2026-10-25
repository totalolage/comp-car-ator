import { type Cassette, createReplayHttp, loadCassette } from "@cca/http";
import type { ListPrice } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode } from "../source.ts";
import { vwPricelistSource } from "./vw-pricelist.ts";

// Responses fetched from the live site 2026-10-25 (model overview, the Tiguan and ID. Polo
// Ceníky pages and their four lists: Tiguan, Tiguan Family, Tiguan People, ID. Polo) and
// recorded through the real adapter in a full run, then trimmed: the overview keeps those two
// model cards, each Ceníky page its download links, and each PDF its "Platnost od" page and
// the pages with table headers (Ghostscript pdfwrite, -dFILTERIMAGE -dFILTERVECTOR).
const cassetteFile = new URL("./fixtures/lists.cassette.json", import.meta.url);
const now = new Date("2026-10-25T18:00:00Z");

interface Run {
  mode?: HarvestMode;
  inForce?: ListPrice[];
  cassette?: Cassette;
  warnings?: string[];
}

async function harvest(run: Run = {}): Promise<ListPrice[]> {
  const out: ListPrice[] = [];
  for await (const o of vwPricelistSource().harvest({
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

async function edit(suffix: string, change: (r: Response) => Response): Promise<Cassette> {
  const cassette = await loadCassette(cassetteFile);
  const i = cassette.interactions.findIndex((x) => x.request.url.endsWith(suffix));
  if (i < 0) throw new Error(`no interaction for ${suffix}`);
  const interactions = cassette.interactions.map((x, j) =>
    j === i ? { ...x, response: change(x.response) } : x,
  );
  return { ...cassette, interactions };
}

function edition(ref: string, validFrom: string): ListPrice {
  return {
    kind: "ListPrice",
    ref,
    vehicle: { make: "Volkswagen", model: "Tiguan", trim: "made up", fuel: "diesel", powerKw: 110 },
    price: { amount: 1_000_000, currency: "CZK" },
    market: "CZ",
    validFrom,
  };
}

describe("vw-pricelist source", () => {
  it("reads every sales-code row of every list on a model's Ceníky page", async () => {
    const offers = await harvest();
    expect(offers).toHaveLength(46);
    expect(offers.filter((o) => o.ref.startsWith("tiguan/"))).toHaveLength(39);
    // The main list and both action lists (Family …F1, People …P3/R3).
    expect(offers.map((o) => o.ref)).toEqual(
      expect.arrayContaining(["tiguan/CT1CPT03", "tiguan/CT1CAMF1", "tiguan/CT1EZYR3"]),
    );
    expect(offers.find((o) => o.ref === "tiguan/CT1CPT03")).toEqual({
      kind: "ListPrice",
      ref: "tiguan/CT1CPT03",
      vehicle: {
        make: "Volkswagen",
        model: "Tiguan",
        trim: "2,0 TSI 4MOTION / 150 kW Life",
        modelYear: 2027,
        fuel: "petrol",
        powerKw: 150,
        transmission: "automatic",
        drive: "awd",
      },
      price: { amount: 1_197_000, currency: "CZK" },
      market: "CZ",
      validFrom: "2026-10-01",
    });
    // Mild hybrids under their combustion fuel; electric rows without fuel or power columns.
    expect(offers.find((o) => o.ref === "tiguan/CT1CAMF1")?.vehicle).toMatchObject({
      trim: "1,5 eTSI mHEV / 96 kW Family",
      fuel: "petrol",
    });
    expect(offers.find((o) => o.ref === "id-polo/ES19PJ02")).toMatchObject({
      vehicle: { model: "ID. Polo", trim: "ID. Polo GTI 52 kWh 166 kW", fuel: "bev", powerKw: 166 },
      price: { amount: 999_000 },
      validFrom: "2026-10-08",
    });
  });

  it("full runs withdraw codes the lists dropped, incremental runs never", async () => {
    const inForce = [
      edition("tiguan/CT1A4Z03", "2026-07-01"),
      edition("touareg/RC857JE2", "2025-12-16"),
      edition("tiguan/CT1CPT03", "2026-07-01"),
    ];
    const full = await harvest({ inForce });
    expect(full.filter((o) => o.validTo)).toEqual([
      // Day before the model's newest list.
      { ...(inForce[0] as ListPrice), validTo: "2026-09-30" },
      // Its model left the overview.
      { ...(inForce[1] as ListPrice), validTo: "2026-10-24" },
    ]);
    expect((await harvest({ mode: "incremental", inForce })).some((o) => o.validTo)).toBe(false);
  });

  it("an unreadable list keeps its model's Offers in force", async () => {
    const warnings: string[] = [];
    const offers = await harvest({
      cassette: await edit("Tiguan_Akcni_Family_MY2027_01102026.pdf", (r) => ({
        ...r,
        status: 404,
        headers: { "content-type": "text/html" },
        body: "<html>404</html>",
        bodyBase64: undefined,
      })),
      inForce: [
        edition("tiguan/CT1CAMF1", "2026-09-01"),
        edition("id-polo/ES11CDA2", "2026-09-01"),
      ],
      warnings,
    });
    expect(warnings).toContain("vw-pricelist: price list not available");
    expect(offers.filter((o) => o.ref.startsWith("tiguan/") && !o.validTo)).toHaveLength(28);
    expect(offers.filter((o) => o.validTo).map((o) => o.ref)).toEqual(["id-polo/ES11CDA2"]);
  });

  it("fails when the model overview links no models", async () => {
    const cassette = await edit("/modely", (r) => ({ ...r, body: "<html><body></body></html>" }));
    await expect(harvest({ cassette })).rejects.toThrow("links no models");
  });
});
