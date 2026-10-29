/**
 * When each Source runs. The ingest workflow fires once a day and asks `plan` which harvests
 * to run, so the cadence lives here, next to the Source registry, and the private repo holds
 * only wiring (docs/adr/0014-daily-ingest-pipeline.md).
 */
import type { HarvestMode, SourceId } from "@cca/sources";
import { pragueDate } from "@cca/vocabulary";

export interface Schedule {
  /** Run incrementally every day (except on full days). */
  daily: boolean;
  /** Census cadence: Sundays, the 1st of the month, or never. */
  full: "weekly" | "monthly" | "never";
  /** Most minutes the incremental Run before a full one may take. Default 60. */
  catchUpMinutes?: number;
}

/** Listing sites: incremental daily, a census every Sunday. */
const LISTINGS: Schedule = { daily: true, full: "weekly" };

/** Sources that differ from LISTINGS. */
export const schedules: Record<SourceId, Schedule> = {
  cnb: { daily: true, full: "never" },
  // Only a full run of the register is a catalog census, which retires stale entries (#46).
  rsv: { daily: false, full: "monthly" },
  // EEA publishes once a year.
  "eea-co2": { daily: false, full: "monthly" },
  // Price lists change with model years and campaigns; a weekly read is enough.
  "skoda-pricelist": { daily: false, full: "weekly" },
  "vw-pricelist": { daily: false, full: "weekly" },
  // openpilot's car list is regenerated every few weeks; each read is the whole list.
  "comma-openpilot": { daily: false, full: "weekly" },
  // Experimental and T2-only (headed Chrome); run by manual dispatch only (ADR 0015).
  "mobile-de": { daily: false, full: "never" },
  // Its incremental reads an ad page for each candidate the Ledger does not know, and ads
  // whose text states no year or odometer never become known: about 70 minutes a day, read
  // twice over the day after a failed Run (ADR 0014).
  bazos: { ...LISTINGS, catchUpMinutes: 150 },
  // Its incremental prices every known listing from both lists' pages, some 3,400 a day at
  // 1.7 s each: about 105 minutes with the new listings (its `PRICE_SWEEP` caps the sweep).
  tipcars: { ...LISTINGS, catchUpMinutes: 120 },
};

/** How long the incremental Run of a Source's `incremental,full` job may take, in ms. */
export function catchUpMs(source: SourceId): number {
  return (schedules[source]?.catchUpMinutes ?? 60) * 60_000;
}

/**
 * What one harvest job runs: one mode, or an incremental Run and then a full one. The second
 * keeps a daily Source fresh while its Census spans several days (ADR 0014).
 */
export type HarvestModes = HarvestMode | "incremental,full";

export interface Harvest {
  source: SourceId;
  mode: HarvestModes;
}

/**
 * The harvests due on `date` for these Sources, in registry order. A census is due when the
 * Source has had none (`lastCensus`, by Source id) since its latest scheduled census day, so a
 * failed or skipped census runs again the next day instead of waiting a week or a month. A
 * daily Source runs incrementally first on its census days: a census longer than a day skips
 * the slices it already read, and the incremental run sees the listings posted in them since.
 * That holds for its first census too, which resumes like any other. The incremental run
 * stops after `catchUpMs`, which a Source's schedule may lengthen when its daily read is long. Days are Prague calendar days.
 */
export function plan(
  sourceIds: readonly SourceId[],
  date: Date,
  lastCensus: Record<SourceId, string> = {},
): Harvest[] {
  const today = pragueDate(date);
  const due: Harvest[] = [];
  for (const source of sourceIds) {
    const { daily, full } = schedules[source] ?? LISTINGS;
    const census = lastCensus[source];
    const scheduled = full === "never" ? null : lastScheduledDay(today, full);
    if (scheduled && (!census || pragueDate(new Date(census)) < scheduled))
      due.push({ source, mode: daily ? "incremental,full" : "full" });
    else if (daily) due.push({ source, mode: "incremental" });
  }
  return due;
}

/** The latest Sunday or 1st of the month on or before `today` (YYYY-MM-DD). */
function lastScheduledDay(today: string, full: "weekly" | "monthly"): string {
  if (full === "monthly") return `${today.slice(0, 8)}01`;
  const noon = new Date(`${today}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() - noon.getUTCDay());
  return noon.toISOString().slice(0, 10);
}
