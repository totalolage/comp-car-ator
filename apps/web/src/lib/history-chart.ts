/**
 * Geometry of the price history chart: one line per Market over time. Coordinates are
 * percentages of the plot area (0-100, y down), so the component can stretch an SVG with
 * `preserveAspectRatio="none"` for the lines and place HTML labels and hover targets at the
 * same points, keeping text readable at any width. No chart library; this module owns the
 * scales, tick choice and gaps, the component only maps the result to elements.
 */
import type { Market } from "@cca/vocabulary";
import type { HistorySeries } from "./listing-view.ts";

export interface ChartPoint {
  x: number;
  y: number;
  date: string;
  count: number;
  medianCzk: number;
}

export interface HistoryChart {
  /** Dates (YYYY-MM-DD) to label on the x axis: first days of months, or point days. */
  xTicks: { x: number; date: string }[];
  /** "month" when the chart spans two months or more: label ticks with month and year. */
  xUnit: "day" | "month";
  /** Round CZK values to label on the y axis, bottom to top. */
  yTicks: { y: number; value: number }[];
  /**
   * `d` breaks wherever a Market had a week without active Listings (a gap, not zero).
   * `dots` are the points to mark: every point of a short series; in a longer one the last
   * point and any point no line segment touches, which would otherwise not show at all.
   */
  lines: { market: Market; d: string; points: ChartPoint[]; dots: ChartPoint[] }[];
  /** Every date with a point, oldest first, with each Market's point on it: the hover stops. */
  columns: { x: number; date: string; points: (ChartPoint & { market: Market })[] }[];
}

const DAY = 86_400_000;
/** Points are Mondays plus the publish day, so anything over a week apart skipped a Monday. */
const MAX_STEP_DAYS = 7;
/** Series up to this many points mark every point; longer ones only the last and isolated. */
const DOTS_MAX = 30;
const MAX_X_TICKS = 6;
const MONTHS_FROM = 60 * DAY;

/** Null when no Market has a point. */
export function historyChart(series: readonly HistorySeries[]): HistoryChart | null {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;

  const times = all.map((p) => Date.parse(p.date));
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t0 === t1) {
    t0 -= 3 * DAY;
    t1 += 3 * DAY;
  }
  const x = (date: string) => ((Date.parse(date) - t0) / (t1 - t0)) * 100;

  const values = all.map((p) => p.medianCzk);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const v0 = ticks[0] as number;
  const v1 = ticks[ticks.length - 1] as number;
  const y = (value: number) => 100 - ((value - v0) / (v1 - v0)) * 100;

  const lines = series.map((s) => {
    const points = s.points.map((p) => ({ ...p, x: round(x(p.date)), y: round(y(p.medianCzk)) }));
    const starts = s.points.map((p, i) => {
      const prev = s.points[i - 1];
      return !prev || (Date.parse(p.date) - Date.parse(prev.date)) / DAY > MAX_STEP_DAYS;
    });
    const d = points.map((p, i) => `${starts[i] ? "M" : "L"}${p.x} ${p.y}`).join("");
    const last = points.length - 1;
    const dots = points.filter(
      (_, i) => points.length <= DOTS_MAX || i === last || (starts[i] && starts[i + 1]),
    );
    return { market: s.market, d, points, dots };
  });

  const byDate = new Map<string, HistoryChart["columns"][number]>();
  for (const line of lines) {
    for (const p of line.points) {
      let column = byDate.get(p.date);
      if (!column) {
        column = { x: p.x, date: p.date, points: [] };
        byDate.set(p.date, column);
      }
      column.points.push({ ...p, market: line.market });
    }
  }
  const columns = [...byDate.values()].sort((a, b) => a.x - b.x);

  return {
    columns,
    xTicks: dateTicks(t0, t1, all).map((date) => ({ x: round(x(date)), date })),
    xUnit: t1 - t0 >= MONTHS_FROM ? "month" : "day",
    yTicks: ticks.map((value) => ({ y: round(y(value)), value })),
    lines,
  };
}

/** 3-6 round values (steps of 1, 2 or 5 × 10^k) spanning [lo, hi]. */
function niceTicks(lo: number, hi: number): number[] {
  if (lo === hi) {
    lo -= Math.max(1000, lo * 0.05);
    hi += Math.max(1000, hi * 0.05);
  }
  const raw = (hi - lo) / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step; v += step) {
    ticks.push(v);
    if (v >= hi) break;
  }
  return ticks;
}

/**
 * First days of months when the chart spans two months or more, else the dates that have
 * points; thinned evenly to at most six labels.
 */
function dateTicks(t0: number, t1: number, points: readonly { date: string }[]): string[] {
  let dates: string[];
  if (t1 - t0 >= MONTHS_FROM) {
    dates = [];
    const d = new Date(t0);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  } else {
    dates = [...new Set(points.map((p) => p.date))].sort();
  }
  const step = Math.ceil(dates.length / MAX_X_TICKS);
  return dates.filter((_, i) => i % step === 0);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The hover stop nearest to `x` (percent of the plot width). */
export function columnAt(chart: HistoryChart, x: number): HistoryChart["columns"][number] {
  let best = chart.columns[0] as HistoryChart["columns"][number];
  for (const column of chart.columns) {
    if (Math.abs(column.x - x) < Math.abs(best.x - x)) best = column;
  }
  return best;
}
