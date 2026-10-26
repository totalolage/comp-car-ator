/**
 * Czech vehicle register (Registr silničních vozidel, Ministerstvo dopravy) open data: the
 * catalog spine. The monthly export lists every vehicle ever registered in CZ with its
 * type-approval data (make, type, commercial name, kW, fuel, body, seats, dimensions, CO2);
 * this adapter streams it, counts passenger cars from `minYear` on into Variants
 * (catalog.ts) and yields one CatalogEntry per Variant, generations named from Wikidata
 * where it knows them (wikidata.ts).
 *
 * The export is found the way the site's own page finds it: `GET /` hands out an API token
 * (`_ren` header), the reports API lists the latest monthly export with its generation date,
 * and the export downloads as a ZIP holding one multi-GB CSV (the uncompressed stable URL is
 * several times larger and the server resets connections that last over an hour).
 *
 * - full: always reads the latest export. Only a full run is a catalog census, which retires
 *   Variants re-keyed since the last one (ADR 0011). TODO(wave1-stream18): schedule rsv as a
 *   monthly full run (#18).
 * - incremental: reads it only when it was generated after the last run started.
 *
 * The register has no gearbox (Variants carry no `transmissions`). Rows it cannot map
 * (no power, unknown fuel or body) are counted and skipped; the run fails only when the
 * site or the export's columns change.
 *
 * Terms: the NKOD record states no terms of use ("Podmínky užití: Neobsahuje").
 */
import type { CatalogEntry, IsoDate } from "@cca/vocabulary";
import { pragueDate } from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";
import { createCatalog } from "./catalog.ts";
import { csvRecords } from "./csv.ts";
import { type Columns, columnsOf, type Rejection, readVehicle } from "./register.ts";
import { unzipFirst } from "./unzip.ts";
import { type WikidataGeneration, wikidataGenerations } from "./wikidata.ts";

export const RSV_SITE = "https://download.dataovozidlech.cz";

export const RSV_ATTRIBUTION =
  "Registr silničních vozidel, open data of Ministerstvo dopravy ČR (dataovozidlech.cz).";

export interface RsvOptions {
  /** First production year catalogued. Default 2000. */
  minYear?: number;
  /** Vehicles needed to back a Variant. Default 5. */
  minVehicles?: number;
  /** Downloads tried when the server drops the connection. Default 3. */
  attempts?: number;
}

export function rsvSource(options: RsvOptions = {}): Source {
  return {
    id: "rsv",
    async *harvest(ctx: HarvestContext): AsyncIterable<CatalogEntry> {
      const latest = await latestExport(ctx);
      const last = ctx.checkpoint.lastRunAt;
      if (ctx.mode === "incremental" && last && latest.generated < pragueDate(last)) {
        ctx.log.info("rsv export unchanged since last run", { generated: latest.generated });
        return;
      }
      // Required: Wikidata decides which types form one generation, so running without it
      // would re-key Variants.
      const generations = await wikidataGenerations(ctx);
      const attempts = options.attempts ?? 3;
      for (let attempt = 1; ; attempt++) {
        try {
          yield* await readExport(ctx, latest, generations, options);
          return;
        } catch (error) {
          if (!(error instanceof ExportInterrupted) || attempt >= attempts) throw error;
          ctx.log.warn("rsv download interrupted; starting over", {
            attempt,
            error: String(error.cause),
          });
        }
      }
    },
  };
}

/** The server dropped the export mid-download; it ignores Range, so a retry starts over. */
class ExportInterrupted extends Error {
  constructor(cause: unknown) {
    super("Register export download interrupted", { cause });
    this.name = "ExportInterrupted";
  }
}

interface Report {
  NormalizedNazev?: string;
  Guid?: string;
  Vygenerovano?: string;
}

/** The latest technical-data export: its download URL and the day it was generated. */
async function latestExport(ctx: HarvestContext): Promise<{ url: string; generated: IsoDate }> {
  ctx.signal.throwIfAborted();
  const home = await ctx.http.get({ url: `${RSV_SITE}/`, signal: ctx.signal });
  const token = home.headers._ren;
  if (home.status !== 200 || !token) {
    throw new Error(`Register site changed: no API token on its page (HTTP ${home.status})`);
  }
  const list = await ctx.http.get({
    url: `${RSV_SITE}/api/datareport/regularLatestReports`,
    headers: { _ren: token, referer: `${RSV_SITE}/`, accept: "application/json, text/plain, */*" },
    signal: ctx.signal,
  });
  if (list.status !== 200) throw new Error(`Register reports API returned HTTP ${list.status}`);
  const reports = JSON.parse(list.body) as Report[];
  const report = Array.isArray(reports)
    ? reports.find((r) => r.NormalizedNazev === "vypisvozidel")
    : undefined;
  const generated = /^\d{4}-\d{2}-\d{2}/.exec(report?.Vygenerovano ?? "")?.[0];
  if (!report?.Guid || !/^[\w-]+$/.test(report.Guid) || !generated) {
    throw new Error("Register reports API lists no technical-data export");
  }
  return { url: `${RSV_SITE}/vypiszregistru/${report.Guid}`, generated };
}

/** Downloads and reads the export once; Variants come out only when it was read to the end. */
async function readExport(
  ctx: HarvestContext,
  latest: { url: string; generated: IsoDate },
  generations: WikidataGeneration[],
  options: RsvOptions,
): Promise<CatalogEntry[]> {
  ctx.signal.throwIfAborted();
  const page = await ctx.http.get({ url: latest.url, stream: true, signal: ctx.signal });
  const download = (page.chunks as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  try {
    if (page.status !== 200) throw new Error(`Register export returned HTTP ${page.status}`);
    return await countExport(
      ctx,
      unzipFirst(interruptible(ctx, download)),
      latest.generated,
      generations,
      options,
    );
  } finally {
    // Stops the download when reading ends early (abort, error).
    await download.return?.();
  }
}

/** Marks network failures while reading, so they can be told from a changed export. */
async function* interruptible(
  ctx: HarvestContext,
  download: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  while (true) {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await download.next();
    } catch (error) {
      ctx.signal.throwIfAborted();
      throw new ExportInterrupted(error);
    }
    if (next.done) return;
    yield next.value;
  }
}

async function countExport(
  ctx: HarvestContext,
  chunks: AsyncIterable<Uint8Array>,
  generated: IsoDate,
  generations: WikidataGeneration[],
  options: RsvOptions,
): Promise<CatalogEntry[]> {
  const snapshotYear = Number(generated.slice(0, 4));
  const minYear = options.minYear ?? 2000;
  const catalog = createCatalog({
    minYear,
    minVehicles: options.minVehicles ?? 5,
    year: snapshotYear,
  });
  const rejected: Partial<Record<Rejection, number>> = {};
  let columns: Columns | undefined;
  let rows = 0;
  let cars = 0;
  for await (const record of csvRecords(chunks)) {
    if (!columns) {
      columns = columnsOf(record);
      continue;
    }
    rows++;
    if (rows % 100_000 === 0) ctx.signal.throwIfAborted();
    const vehicle = readVehicle(record, columns, minYear);
    if (vehicle === "skip") continue;
    if (typeof vehicle === "string") {
      rejected[vehicle] = (rejected[vehicle] ?? 0) + 1;
      continue;
    }
    cars++;
    catalog.add(vehicle);
  }
  if (!columns) throw new Error("Register export is empty");
  const entries = catalog.entries(generations);
  ctx.log.info("rsv export read", {
    generated,
    rows,
    cars,
    rejected,
    candidates: catalog.candidates,
    omittedVehicles: catalog.omittedVehicles,
    variants: entries.length,
  });
  return entries;
}
