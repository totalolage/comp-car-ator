import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createReplayHttp } from "@cca/http";
import { openLedger } from "@cca/ledger";
import type { HarvestMode, Source } from "@cca/sources";
import type { ListingSeen } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { harvestJob } from "./harvest-job.ts";
import type { HarvestModes } from "./schedule.ts";

const noHttp = createReplayHttp({ version: 1, interactions: [] });

function seen(ref: string): ListingSeen {
  return {
    kind: "ListingSeen",
    ref,
    url: `https://www.sauto.cz/osobni/detail/${ref}`,
    market: "CZ",
    condition: "used",
    vehicle: { make: "Škoda", model: "Octavia" },
    price: { amount: 300_000, currency: "CZK" },
    priceBasis: "gross",
    seller: "dealer",
    photos: [],
  };
}

/** A Source whose Run of each mode does what `runs` says. */
function source(runs: Record<HarvestMode, "ok" | "throw" | "endless">): Source {
  return {
    id: "sauto",
    async *harvest(ctx) {
      const behaviour = runs[ctx.mode];
      yield seen(`${ctx.mode}-1`);
      if (behaviour === "throw") throw new Error("HTTP 503");
      if (behaviour === "endless")
        for (let i = 2; ; i++) {
          await sleep(5);
          yield seen(`${ctx.mode}-${i}`);
        }
      yield { kind: "SliceDone", slice: "used/0-" };
    },
  };
}

async function job(runs: Record<HarvestMode, "ok" | "throw" | "endless">, modes: HarvestModes) {
  const dir = await mkdtemp(join(tmpdir(), "cca-job-"));
  const ledger = openLedger(":memory:");
  const starts = [new Date("2026-10-27T03:00:00Z"), new Date("2026-10-27T03:40:00Z")];
  const reports = await harvestJob({
    ledger,
    source: source(runs),
    http: noHttp,
    modes,
    out: join(dir, "sauto.ndjson"),
    clock: () => starts.shift() ?? new Date(),
    catchUpMs: 50,
  });
  ledger.close();
  const logs: Record<string, string[]> = {};
  for (const name of (await readdir(dir)).sort())
    logs[name] = (await readFile(join(dir, name), "utf8")).trim().split("\n");
  return { reports, logs };
}

describe("harvest job", () => {
  it("writes one mode's Run to the given log", async () => {
    const { reports, logs } = await job({ incremental: "ok", full: "ok" }, "full");
    expect(Object.keys(logs)).toEqual(["sauto.ndjson"]);
    expect(reports.map((r) => [r.mode, r.error])).toEqual([["full", null]]);
  });

  it("runs incremental,full as two Runs, each to its own log and with its own start", async () => {
    const { reports, logs } = await job({ incremental: "ok", full: "ok" }, "incremental,full");
    expect(reports.map((r) => [r.mode, r.error])).toEqual([
      ["incremental", null],
      ["full", null],
    ]);
    expect(Object.keys(logs)).toEqual(["sauto.full.ndjson", "sauto.incremental.ndjson"]);
    const head = (name: string) => JSON.parse(logs[name]?.[0] ?? "{}").run;
    expect(head("sauto.incremental.ndjson")).toMatchObject({
      mode: "incremental",
      startedAt: "2026-10-27T03:00:00.000Z",
    });
    expect(head("sauto.full.ndjson")).toMatchObject({
      mode: "full",
      startedAt: "2026-10-27T03:40:00.000Z",
    });
  });

  it("runs the full Run after a failed incremental one", async () => {
    const { reports, logs } = await job({ incremental: "throw", full: "ok" }, "incremental,full");
    expect(reports.map((r) => [r.mode, r.error])).toEqual([
      ["incremental", "Error: HTTP 503"],
      ["full", null],
    ]);
    expect(logs["sauto.full.ndjson"]?.at(-1)).toBe('{"end":"complete"}');
  });

  it("cuts the incremental Run off at its limit and leaves the rest of the job to the full Run", async () => {
    const { reports, logs } = await job({ incremental: "endless", full: "ok" }, "incremental,full");
    expect(reports[0]?.error).toMatch(/abort|timeout/i);
    expect(reports[1]?.error).toBeNull();
    expect(logs["sauto.full.ndjson"]?.at(-1)).toBe('{"end":"complete"}');
  });
});
