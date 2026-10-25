import {
  ODOMETER_BANDS,
  type OdometerBand,
  odometerBand,
  type PriceCell,
  type Quantiles,
} from "@cca/bundle";
import { CONDITIONS, type Condition, MARKETS, type Market, type VariantId } from "@cca/vocabulary";

/**
 * The outlier rule (docs/adr/0010-publisher-statistics.md). Asking prices below the floor are
 * placeholders, instalments or deposits. Above it, a cohort (resolution target × Market ×
 * Condition) of at least FENCE_MIN_COUNT Listings with a nonzero IQR on ln(price) drops
 * prices outside Tukey's far fences, [Q1 − 3·IQR, Q3 + 3·IQR].
 */
export const PRICE_FLOOR_CZK = 10_000;
const FENCE_MIN_COUNT = 8;
const FENCE_IQR_FACTOR = 3;

/** Cells with fewer Listings are left out of `ModelFile.stats`. */
const MIN_CELL_COUNT = 3;

export interface Fences {
  /** Bounds on ln(price CZK). */
  low: number;
  high: number;
}

/** Fences for one cohort's prices (CZK), or null when the cohort is too small or flat. */
export function fences(pricesCzk: number[]): Fences | null {
  const logs = pricesCzk
    .filter((p) => p >= PRICE_FLOOR_CZK)
    .map(Math.log)
    .sort((a, b) => a - b);
  if (logs.length < FENCE_MIN_COUNT) return null;
  const q1 = quantile(logs, 0.25);
  const q3 = quantile(logs, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return null;
  return { low: q1 - FENCE_IQR_FACTOR * iqr, high: q3 + FENCE_IQR_FACTOR * iqr };
}

export function isOutlier(priceCzk: number, cohort: Fences | null): boolean {
  if (priceCzk < PRICE_FLOOR_CZK) return true;
  if (!cohort) return false;
  const log = Math.log(priceCzk);
  return log < cohort.low || log > cohort.high;
}

/** p10, median and p90 by linear interpolation, rounded; null for no values. */
export function quantiles(values: number[]): Quantiles | null {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return {
    count: sorted.length,
    p10: Math.round(quantile(sorted, 0.1)),
    median: Math.round(quantile(sorted, 0.5)),
    p90: Math.round(quantile(sorted, 0.9)),
  };
}

export function median(values: number[]): number {
  return Math.round(quantile(Float64Array.from(values).sort(), 0.5));
}

function quantile(sorted: ArrayLike<number>, p: number): number {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const a = sorted[lo] as number;
  return a + ((sorted[hi] as number) - a) * (i - lo);
}

export interface CellInput {
  variantId: VariantId | null;
  market: Market;
  condition: Condition;
  year?: number;
  odometerKm?: number;
  priceCzk: number;
}

/**
 * The sparse cube of `ModelFile.stats` over a model's kept active Listings: per (variant
 * and whole model) × Market × Condition, every combination of year-or-all and band-or-all.
 */
export function priceCells(listings: Iterable<CellInput>): PriceCell[] {
  const cells = new Map<string, { key: CellKey; prices: number[] }>();
  for (const l of listings) {
    const band = l.odometerKm === undefined ? null : odometerBand(l.odometerKm);
    const year = l.year ?? null;
    const targets = l.variantId === null ? [null] : [l.variantId, null];
    for (const variantId of targets) {
      for (const y of year === null ? [null] : [year, null]) {
        for (const b of band === null ? [null] : [band, null]) {
          const key: CellKey = [variantId, l.market, l.condition, y, b];
          const id = key.join("|");
          let cell = cells.get(id);
          if (!cell) {
            cell = { key, prices: [] };
            cells.set(id, cell);
          }
          cell.prices.push(l.priceCzk);
        }
      }
    }
  }
  return [...cells.values()]
    .filter((c) => c.prices.length >= MIN_CELL_COUNT)
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ key: [variantId, market, condition, year, band], prices }) => ({
      variantId,
      market,
      condition,
      year,
      band,
      ...(quantiles(prices) as Quantiles),
    }));
}

type CellKey = [VariantId | null, Market, Condition, number | null, OdometerBand | null];

function compareKeys(a: CellKey, b: CellKey): number {
  return (
    compareNullFirst(a[0], b[0]) ||
    MARKETS.indexOf(a[1]) - MARKETS.indexOf(b[1]) ||
    CONDITIONS.indexOf(a[2]) - CONDITIONS.indexOf(b[2]) ||
    compareNullFirst(a[3], b[3]) ||
    compareNullFirst(
      a[4] === null ? null : ODOMETER_BANDS.indexOf(a[4]),
      b[4] === null ? null : ODOMETER_BANDS.indexOf(b[4]),
    )
  );
}

function compareNullFirst<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
