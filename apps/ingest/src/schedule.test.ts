import { describe, expect, it } from "vitest";
import { plan } from "./schedule.ts";

describe("schedule", () => {
  const ids = ["cnb", "sauto"];
  const census = (iso: string) => ({ sauto: iso });

  it("runs listings incrementally and takes a census on Sundays, after an incremental run", () => {
    const lastSunday = census("2026-10-18T03:00:00Z");
    expect(plan(ids, new Date("2026-10-24T01:00:00Z"), lastSunday)).toEqual([
      { source: "cnb", mode: "incremental" },
      { source: "sauto", mode: "incremental" },
    ]);
    expect(plan(ids, new Date("2026-10-25T01:00:00Z"), lastSunday)).toEqual([
      { source: "cnb", mode: "incremental" },
      { source: "sauto", mode: "incremental,full" },
    ]);
  });

  it("leaves the experimental mobile-de Source unscheduled", () => {
    expect(
      plan(
        ["sauto", "mobile-de"],
        new Date("2026-10-25T01:00:00Z"),
        census("2026-10-18T03:00:00Z"),
      ),
    ).toEqual([{ source: "sauto", mode: "incremental,full" }]);
  });

  it("repeats a census that has not completed since its scheduled day, still after an incremental run", () => {
    const monday = new Date("2026-10-26T01:00:00Z");
    expect(plan(["sauto"], monday, census("2026-10-18T03:00:00Z"))).toEqual([
      { source: "sauto", mode: "incremental,full" },
    ]);
    expect(plan(["sauto"], monday, census("2026-10-25T03:00:00Z"))).toEqual([
      { source: "sauto", mode: "incremental" },
    ]);
  });

  it("runs a Source's first census alone: without one the Ledger cannot stop an incremental run early", () => {
    expect(plan(["sauto"], new Date("2026-10-26T01:00:00Z"))).toEqual([
      { source: "sauto", mode: "full" },
    ]);
  });

  it("takes the register's catalog Census on the 1st and otherwise leaves it alone", () => {
    expect(
      plan(["rsv"], new Date("2026-11-01T02:23:00Z"), { rsv: "2026-10-01T02:23:00Z" }),
    ).toEqual([{ source: "rsv", mode: "full" }]);
    expect(
      plan(["rsv"], new Date("2026-11-02T02:23:00Z"), { rsv: "2026-11-01T02:23:00Z" }),
    ).toEqual([]);
  });

  it("uses the Prague calendar day", () => {
    // 23:30 UTC on Saturday is already Sunday in Prague.
    expect(
      plan(["sauto"], new Date("2026-10-24T23:30:00Z"), census("2026-10-18T03:00:00Z")),
    ).toEqual([{ source: "sauto", mode: "incremental,full" }]);
  });
});
