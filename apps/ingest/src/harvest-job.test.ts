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
import { recordLog } from "./run-log.ts";
import { type HarvestModes, plan } from "./schedule.ts";

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

  it("a first census that failed after a finished slice: the next day's incremental Run sees a listing posted in that slice", async () => {
    // Listings by slice, in posting order. The full Run skips finished slices and times out
    // when it reaches `cutOff`; the incremental Run reads newest first up to a known listing.
    const posted = [
      { ref: "a1", slice: "A" },
      { ref: "b1", slice: "B" },
    ];
    let cutOff: string | null = "B";
    const site: Source = {
      id: "sauto",
      async *harvest(ctx) {
        if (ctx.mode === "incremental") {
          for (const { ref } of [...posted].reverse()) {
            if (ctx.checkpoint.isKnown(ref)) return;
            yield seen(ref);
          }
          return;
        }
        for (const slice of ["A", "B"]) {
          if (ctx.checkpoint.sliceDoneAt(slice)) continue;
          if (slice === cutOff) throw new Error("The operation was aborted due to timeout");
          for (const listing of posted) if (listing.slice === slice) yield seen(listing.ref);
          yield { kind: "SliceDone", slice };
        }
      },
    };
    const ledger = openLedger(":memory:");
    // One day of the pipeline: plan (no census yet), the harvest job, its logs recorded in order.
    const day = async (date: string) => {
      const [due] = plan(["sauto"], new Date(`${date}T01:00:00Z`));
      expect(due).toEqual({ source: "sauto", mode: "incremental,full" });
      const dir = await mkdtemp(join(tmpdir(), "cca-job-"));
      const starts = [new Date(`${date}T03:00:00Z`), new Date(`${date}T03:40:00Z`)];
      const reports = await harvestJob({
        ledger,
        source: site,
        http: noHttp,
        modes: due?.mode ?? "full",
        out: join(dir, "sauto.ndjson"),
        clock: () => starts.shift() ?? new Date(),
      });
      // Each log's census outcome, or why recording it failed.
      const recorded: string[] = [];
      for (const { mode } of reports)
        recorded.push(
          await recordLog(ledger, join(dir, `sauto.${mode}.ndjson`)).then(
            (summary) => summary.census,
            (error) => String(error),
          ),
        );
      return { reports, recorded };
    };

    const first = await day("2026-10-26");
    expect(first.reports.map((r) => r.error)).toEqual([
      null,
      "Error: The operation was aborted due to timeout",
    ]);
    expect(first.recorded).toEqual(["not-full", expect.stringMatching(/harvest failed/)]);
    posted.push({ ref: "a2", slice: "A" });
    cutOff = null;
    const second = await day("2026-10-27");
    // The full Run skips slice A (b1 and SliceDone B), so only the incremental Run sees a2.
    expect(second.reports.map((r) => [r.mode, r.observations, r.error])).toEqual([
      ["incremental", 1, null],
      ["full", 2, null],
    ]);
    // The census completes, and a2, seen after its first full Run, is not missed.
    expect(second.recorded).toEqual(["not-full", "applied"]);
    expect(ledger.checkpoint("sauto").isKnown("a2")).toBe(true);
    ledger.close();
  });
});
