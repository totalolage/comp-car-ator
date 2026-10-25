import type { IsoDate } from "./vehicle.ts";

/** The calendar date in Prague for an instant. Every IsoDate in the app is a Prague day. */
export function pragueDate(instant: Date): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(instant);
}

/** Whole days from `from` to `to` (both IsoDate). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
