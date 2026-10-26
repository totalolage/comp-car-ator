import { describe, expect, it } from "vitest";
import { columnAt, historyChart } from "./history-chart.ts";

const point = (date: string, medianCzk: number) => ({ date, count: 5, medianCzk });

describe("history chart", () => {
  it("draws one line per Market on shared scales, breaking it where a week has no point", () => {
    const chart = historyChart([
      {
        market: "CZ",
        points: [
          point("2026-09-07", 410_000),
          point("2026-09-14", 400_000),
          // 2026-09-21 had no active listings: a gap, not zero.
          point("2026-09-28", 395_000),
          point("2026-10-05", 390_000),
        ],
      },
      { market: "DE", points: [point("2026-09-14", 450_000)] },
    ]);
    expect(chart).not.toBeNull();
    const [cz, de] = chart?.lines ?? [];
    expect(cz?.d.match(/M/g)).toHaveLength(2);
    expect(cz?.d.startsWith("M0 ")).toBe(true);
    expect(cz?.points.at(-1)?.x).toBe(100);
    expect(de?.d.match(/[ML]/g)).toEqual(["M"]);
    // Higher prices sit higher (smaller y); the y ticks are round and span every value.
    expect(de?.points[0]?.y).toBeLessThan(cz?.points[0]?.y as number);
    const ticks = chart?.yTicks.map((t) => t.value) ?? [];
    expect(ticks[0]).toBeLessThanOrEqual(390_000);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(450_000);
    expect(ticks.every((v) => v % 10_000 === 0)).toBe(true);
    expect(chart?.yTicks[0]?.y).toBe(100);
    expect(chart?.yTicks.at(-1)?.y).toBe(0);
    expect(chart?.xUnit).toBe("day");
    // Hover stops: every date with a point, each with the Markets that have one.
    expect(chart?.columns.map((c) => c.date)).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(chart?.columns[1]?.points.map((p) => p.market)).toEqual(["CZ", "DE"]);
    if (chart) {
      expect(columnAt(chart, 0).date).toBe("2026-09-07");
      expect(columnAt(chart, 30).date).toBe("2026-09-14");
      expect(columnAt(chart, 99).date).toBe("2026-10-05");
    }
    expect(chart?.xTicks.length).toBeLessThanOrEqual(6);
  });

  it("centres a single point and labels months on long spans", () => {
    const single = historyChart([{ market: "AT", points: [point("2026-10-24", 600_000)] }]);
    expect(single?.lines[0]?.points[0]?.x).toBe(50);
    expect(single?.xTicks.map((t) => t.date)).toEqual(["2026-10-24"]);
    const weeks = Array.from({ length: 60 }, (_, i) =>
      point(new Date(Date.UTC(2025, 0, 6 + 7 * i)).toISOString().slice(0, 10), 300_000 + i * 1000),
    );
    const long = historyChart([{ market: "CZ", points: weeks }]);
    expect(long?.xUnit).toBe("month");
    expect(long?.xTicks.every((t) => t.date.endsWith("-01"))).toBe(true);
    expect(long?.xTicks.length).toBeLessThanOrEqual(6);
    expect(long?.lines[0]?.d.match(/M/g)).toHaveLength(1);
    expect(historyChart([{ market: "CZ", points: [] }])).toBeNull();
  });
});
