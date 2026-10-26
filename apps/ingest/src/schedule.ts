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
  // Experimental and T2-only (headed Chrome); run by manual dispatch only (ADR 0015).
  "mobile-de": { daily: false, full: "never" },
};

export interface Harvest {
  source: SourceId;
  mode: HarvestMode;
}

/**
 * The harvests due on `date` for these Sources, in registry order. A census is due when the
 * Source has had none (`lastCensus`, by Source id) since its latest scheduled census day, so a
 * failed or skipped census runs again the next day instead of waiting a week or a month. Days
 * are Prague calendar days.
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
      due.push({ source, mode: "full" });
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
