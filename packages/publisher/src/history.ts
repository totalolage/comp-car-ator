import type { ModelFile } from "@cca/bundle";
import { type IsoDate, MARKETS, type Market, type ModelId } from "@cca/vocabulary";
import { median, PRICE_FLOOR_CZK } from "./statistics.ts";

const DAY_MS = 86_400_000;

export interface HistorySampler {
  /** One used Listing; `priceHistory` oldest first, in CZK (null when not convertible). */
  add(
    modelId: ModelId,
    market: Market,
    firstSeen: IsoDate,
    gone: IsoDate | null,
    priceHistory: { date: IsoDate; priceCzk: number | null }[],
  ): void;
  history(modelId: ModelId): ModelFile["history"];
}

/**
 * Collects the weekly median-price series of `ModelFile.history` while Listings stream past,
 * keeping only the sampled prices, so gone Listings left out of the model files still count.
 * Samples every Monday and the publish day; a Listing is active on a day from its first
 * sighting until the day it went (exclusive), at its latest price on or before that day.
 * Prices below the floor are skipped (the rest of the outlier rule needs a cohort per day).
 */
export function historySampler(today: IsoDate): HistorySampler {
  const todayNumber = dayNumber(today);
  const prices = new Map<ModelId, Map<Market, Map<number, number[]>>>();

  /** Mondays in [start, end), then the publish day if it is in range and not a Monday. */
  function* sampleDays(start: number, end: number): Generator<number> {
    // Day 4 of the epoch (1970-01-05) was a Monday.
    for (let day = start + ((((4 - start) % 7) + 7) % 7); day < end; day += 7) yield day;
    if (start <= todayNumber && todayNumber < end && (todayNumber - 4) % 7 !== 0) {
      yield todayNumber;
    }
  }

  function series(modelId: ModelId, market: Market): Map<number, number[]> {
    let byMarket = prices.get(modelId);
    if (!byMarket) {
      byMarket = new Map();
      prices.set(modelId, byMarket);
    }
    let byDay = byMarket.get(market);
    if (!byDay) {
      byDay = new Map();
      byMarket.set(market, byDay);
    }
    return byDay;
  }

  return {
    add(modelId, market, firstSeen, gone, priceHistory) {
      const start = dayNumber(firstSeen);
      const end = Math.min(gone === null ? Infinity : dayNumber(gone), todayNumber + 1);
      let byDay: Map<number, number[]> | undefined;
      let next = 0;
      let czk: number | null = null;
      for (const day of sampleDays(start, end)) {
        for (let point = priceHistory[next]; point && dayNumber(point.date) <= day; ) {
          czk = point.priceCzk;
          point = priceHistory[++next];
        }
        if (czk === null || czk < PRICE_FLOOR_CZK) continue;
        byDay ??= series(modelId, market);
        const dayPrices = byDay.get(day);
        if (dayPrices) dayPrices.push(czk);
        else byDay.set(day, [czk]);
      }
    },

    history(modelId) {
      const byMarket = prices.get(modelId);
      if (!byMarket) return [];
      return MARKETS.flatMap((market) => {
        const byDay = byMarket.get(market);
        if (!byDay) return [];
        const points = [...byDay]
          .sort(([a], [b]) => a - b)
          .map(([day, dayPrices]) => ({
            date: isoDate(day),
            count: dayPrices.length,
            medianCzk: median(dayPrices),
          }));
        return [{ market, points }];
      });
    },
  };
}

function dayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function isoDate(day: number): IsoDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
