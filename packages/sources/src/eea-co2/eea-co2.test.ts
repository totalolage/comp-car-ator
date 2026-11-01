import { createReplayHttp, type Http, type HttpRequest, loadCassette } from "@cca/http";
import type { Observation, VariantFacts } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, silentLogger } from "../source.ts";
import { type EeaCo2Options, type EeaTable, eeaCo2Source } from "./eea-co2.ts";

// Recorded 2026-11-01 from DiscoData (POSTed form queries), Škoda only, 50 rows per page.
const skoda = new URL("./fixtures/skoda.cassette.json", import.meta.url);
const missingTable = new URL("./fixtures/missing-table.cassette.json", import.meta.url);
const now = new Date("2026-11-01T23:05:00Z");
const tables: EeaTable[] = [
  { table: "co2cars_2024Fv30", year: 2024, status: "F" },
  { table: "co2cars_2025Pv31", year: 2025, status: "P" },
];
const options: EeaCo2Options = { makes: ["SKODA"], tables, pageSize: 50 };

async function harvest(
  cassette: URL | Http,
  mode: HarvestMode,
  lastRunAt: Date | null,
  opts: EeaCo2Options = options,
): Promise<Observation[]> {
  const out: Observation[] = [];
  for await (const o of eeaCo2Source(opts).harvest({
    http: cassette instanceof URL ? createReplayHttp(await loadCassette(cassette)) : cassette,
    mode,
    checkpoint: { ...emptyCheckpoint, lastRunAt },
    now,
    log: silentLogger,
    signal: new AbortController().signal,
  })) {
    out.push(o);
  }
  return out;
}

const find = (facts: VariantFacts[], year: number, model: string, fuel: string, kw: number) =>
  facts.filter(
    (f) =>
      f.vehicle.firstRegistration?.year === year &&
      f.vehicle.model === model &&
      f.vehicle.fuel === fuel &&
      f.vehicle.powerKw === kw,
  );

describe("eea-co2 source", () => {
  it("full run yields VariantFacts for every table, across pages", async () => {
    const facts = (await harvest(skoda, "full", null)) as VariantFacts[];
    expect(facts.every((f) => f.kind === "VariantFacts")).toBe(true);
    // 2024 has 75 groups over two 50-row pages, 2025 has 65.
    expect(facts.filter((f) => f.vehicle.firstRegistration?.year === 2024)).toHaveLength(75);
    expect(facts.filter((f) => f.vehicle.firstRegistration?.year === 2025)).toHaveLength(65);
    expect(new Set(facts.map((f) => f.vehicle.make))).toEqual(new Set(["Škoda"]));
  });

  it("maps fuel modes: mild hybrids keep their fuel, plug-ins and EVs get theirs", async () => {
    const facts = (await harvest(skoda, "full", null)) as VariantFacts[];
    // Octavia 1.5 TSI 110 kW comes as manual (mode M) and mild-hybrid eTSI (mode H): both petrol.
    const octavia = find(facts, 2024, "OCTAVIA", "petrol", 110);
    expect(octavia.length).toBeGreaterThanOrEqual(2);
    expect(octavia.every((f) => f.vehicle.engineCc === 1498)).toBe(true);
    const [diesel] = find(facts, 2024, "OCTAVIA", "diesel", 110);
    expect(diesel?.facts).toMatchObject({ engineCc: 1968 });
    expect(diesel?.facts.co2GKm).toBeGreaterThan(90);
    expect(diesel?.facts.massKg).toBeGreaterThan(1300);
    expect(find(facts, 2024, "OCTAVIA", "phev", 110).length).toBeGreaterThan(0);
    const enyaq = facts.filter(
      (f) => f.vehicle.fuel === "bev" && f.vehicle.model.startsWith("ENYAQ"),
    );
    expect(enyaq.length).toBeGreaterThan(0);
    for (const f of enyaq) {
      expect(f.vehicle.engineCc).toBeUndefined();
      expect(f.facts.consumptionKwh100km).toBeGreaterThan(10);
      expect(f.facts.co2GKm).toBeUndefined();
    }
  });

  it("incremental run reads only reporting years from the year before the last run", async () => {
    const facts = (await harvest(
      skoda,
      "incremental",
      new Date("2026-03-01T03:00:00Z"),
    )) as VariantFacts[];
    expect(new Set(facts.map((f) => f.vehicle.firstRegistration?.year))).toEqual(new Set([2025]));
  });

  it("skips malformed rows and keeps the valid rows around them", async () => {
    const cassette = await loadCassette(skoda);
    // The last 2024 page (25 rows): put malformed rows between valid ones.
    const last = cassette.interactions.find(
      (i) => i.request.form?.query?.includes("co2cars_2024Fv30") && i.request.form.p === "2",
    );
    if (!last) throw new Error("cassette lacks the second 2024 page");
    const json = JSON.parse(last.response.body) as { results: unknown[] };
    const valid = json.results[0] as Record<string, unknown>;
    json.results.splice(
      1,
      0,
      null,
      "OCTAVIA",
      [],
      { ...valid, Mk: 5 },
      { ...valid, Cn: 7 },
      { ...valid, Ft: 1 },
      { ...valid, kw: "110" },
    );
    last.response.body = JSON.stringify(json);
    const warnings: unknown[] = [];
    const out: Observation[] = [];
    for await (const o of eeaCo2Source({ ...options, tables: [tables[0] as EeaTable] }).harvest({
      http: createReplayHttp(cassette),
      mode: "full",
      checkpoint: emptyCheckpoint,
      now,
      log: { info() {}, warn: (_message, data) => warnings.push(data) },
      signal: new AbortController().signal,
    })) {
      out.push(o);
    }
    expect(out).toHaveLength(75);
    expect(warnings).toEqual([{ table: "co2cars_2024Fv30", malformed: 7 }]);
  });

  it("POSTs its SQL as a form, keeping quotes and brackets out of the URL", async () => {
    // DiscoData's gateway answers 403 to SQL in a query string (seen 2026-11-01).
    const replay = createReplayHttp(await loadCassette(skoda));
    const sent: HttpRequest[] = [];
    const spy: Http = {
      get: (request) => {
        sent.push(request as HttpRequest);
        return replay.get(request);
      },
    };
    await harvest(spy, "full", null);
    expect(sent).toHaveLength(4);
    for (const request of sent) {
      expect(request.url).toBe("https://discodata.eea.europa.eu/sql");
      expect(request.form?.query).toContain("FROM [CO2Emission].[latest].[co2cars_202");
      expect(request.form?.query).toContain("[MS] IN ('CZ', 'DE', 'AT')");
    }
    expect(sent.map((r) => [r.form?.p, r.form?.nrOfHits])).toEqual([
      ["1", "50"],
      ["2", "50"],
      ["1", "50"],
      ["2", "50"],
    ]);
  });

  it("fails the run when DiscoData's gateway refuses the request", async () => {
    const gateway: Http = {
      get: async () => ({
        url: "https://discodata.eea.europa.eu/sql",
        status: 403,
        headers: { server: "Microsoft-Azure-Application-Gateway/v2" },
        body: "<html><center><h1>403 Forbidden</h1></center></html>",
        tier: "T1",
      }),
    };
    await expect(harvest(gateway, "full", null)).rejects.toThrow("EEA DiscoData returned HTTP 403");
  });

  it("fails the run when DiscoData rejects the query", async () => {
    await expect(
      harvest(missingTable, "full", null, {
        makes: ["SKODA"],
        tables: [{ table: "co2cars_2099Fv99", year: 2099, status: "F" }],
      }),
    ).rejects.toThrow(/Invalid object name/);
  });
});
