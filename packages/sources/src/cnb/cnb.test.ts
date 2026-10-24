import { createReplayHttp, loadCassette } from "@cca/http";
import type { FxRate, Observation } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { type HarvestContext, type HarvestMode, silentLogger } from "../source.ts";
import { cnbSource } from "./cnb.ts";

// Recorded 2026-10-24 (a Saturday; the latest fixing is Friday 2026-10-23).
const latest = new URL("./fixtures/incremental-latest.cassette.json", import.meta.url);
const gap = new URL("./fixtures/incremental-gap.cassette.json", import.meta.url);
const now = new Date("2026-10-24T16:00:00Z");

async function harvest(
  cassette: URL,
  mode: HarvestMode,
  lastRunAt: Date | null,
  source = cnbSource(),
  signal = new AbortController().signal,
): Promise<Observation[]> {
  const ctx: HarvestContext = {
    http: createReplayHttp(await loadCassette(cassette)),
    mode,
    checkpoint: { lastRunAt, isKnown: () => false },
    now,
    log: silentLogger,
    signal,
  };
  const out: Observation[] = [];
  for await (const o of source.harvest(ctx)) out.push(o);
  return out;
}

describe("cnb source", () => {
  it("first incremental run yields the latest daily fixing, per unit", async () => {
    const rates = (await harvest(latest, "incremental", null)) as FxRate[];
    expect(rates.length).toBeGreaterThan(25);
    expect(new Set(rates.map((r) => r.validFor))).toEqual(new Set(["2026-10-23"]));
    expect(rates.find((r) => r.currency === "EUR")).toEqual({
      kind: "FxRate",
      currency: "EUR",
      validFor: "2026-10-23",
      czkPerUnit: 24.335,
    });
    // Quoted per 100 units in the file; normalized to one unit.
    const huf = rates.find((r) => r.currency === "HUF");
    expect(huf?.czkPerUnit).toBeLessThan(1);
  });

  it("incremental run after a gap back-fills the missed days from the year file", async () => {
    const rates = (await harvest(gap, "incremental", new Date("2026-10-15T03:00:00Z"))) as FxRate[];
    const days = [...new Set(rates.map((r) => r.validFor))].sort();
    expect(days[0]).toBe("2026-10-15");
    expect(days.at(-1)).toBe("2026-10-23");
    expect(days.length).toBeGreaterThan(5);
  });

  it("full run yields every fixing since the configured year", async () => {
    const rates = (await harvest(
      gap,
      "full",
      null,
      cnbSource({ fullSinceYear: 2026 }),
    )) as FxRate[];
    const days = [...new Set(rates.map((r) => r.validFor))].sort();
    expect(days[0]?.startsWith("2026-01-")).toBe(true);
    expect(days.at(-1)).toBe("2026-10-23");
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      harvest(latest, "incremental", null, cnbSource(), controller.signal),
    ).rejects.toThrow("stop");
  });
});
