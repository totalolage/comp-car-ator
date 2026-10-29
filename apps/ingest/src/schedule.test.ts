import { describe, expect, it } from "vitest";
import { catchUpMs, plan } from "./schedule.ts";

describe("schedule", () => {
  it("gives the incremental Run before a census an hour, TipCars two, Bazoš two and a half", () => {
    expect(catchUpMs("sauto")).toBe(60 * 60_000);
    expect(catchUpMs("tipcars")).toBe(120 * 60_000);
    expect(catchUpMs("bazos")).toBe(150 * 60_000);
  });

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

  it("runs incrementally before the first census too, every day until it completes", () => {
    // The first census resumes from its finished slices; the incremental run sees what was
    // posted in them since.
    for (const day of ["2026-10-25", "2026-10-26", "2026-10-27"]) {
      expect(plan(ids, new Date(`${day}T01:00:00Z`))).toEqual([
        { source: "cnb", mode: "incremental" },
        { source: "sauto", mode: "incremental,full" },
      ]);
    }
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
