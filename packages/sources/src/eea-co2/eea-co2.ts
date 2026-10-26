/**
 * EEA CO2 monitoring of new passenger cars (Regulation (EU) 2019/631), via EEA DiscoData SQL.
 *
 * One row per make, commercial name, fuel, power and engine size registered in CZ/DE/AT in a
 * reporting year, aggregated on the server (GROUP BY), so no bulk download is needed. The
 * dataset has no body, seats or gearbox, so it cannot identify a Variant: it yields
 * VariantFacts (engine size, WLTP CO2, mass, consumption) that the Ledger resolves.
 *
 * - full: every configured reporting table.
 * - incremental: tables for reporting years from the year before the last run on (EEA
 *   publishes once a year, provisional in spring and final in autumn).
 *
 * Licence: CC BY 4.0; see EEA_CO2_ATTRIBUTION.
 * TODO(wave1-stream14): show EEA_CO2_ATTRIBUTION on the site (#14) before publishing a Bundle
 * with EEA-derived Specs.
 */
import type { Fuel, VariantFacts } from "@cca/vocabulary";
import { makeName } from "../catalog-names.ts";
import type { HarvestContext, Source } from "../source.ts";

export const EEA_CO2_ATTRIBUTION =
  "Monitoring of CO2 emissions from passenger cars (Regulation (EU) 2019/631), European " +
  "Environment Agency, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Copyright " +
  "holder: Directorate-General for Climate Action (DG CLIMA).";

const ENDPOINT = "https://discodata.eea.europa.eu/sql";

/** One reporting year: the DiscoData table holding it and its edition (F final, P provisional). */
export interface EeaTable {
  table: string;
  year: number;
  status: "F" | "P";
}

/** Newest edition per reporting year as of 2026-10 (docs: DiscoData table list). */
export const EEA_TABLES: readonly EeaTable[] = [
  { table: "co2cars", year: 2021, status: "F" },
  { table: "co2cars_2022Fv26", year: 2022, status: "F" },
  { table: "co2cars_2023Fv28", year: 2023, status: "F" },
  { table: "co2cars_2024Fv30", year: 2024, status: "F" },
  { table: "co2cars_2025Pv31", year: 2025, status: "P" },
];

export interface EeaCo2Options {
  tables?: readonly EeaTable[];
  /** Registration countries counted. Default the app's markets. */
  countries?: readonly string[];
  /** Raw `Mk` values to restrict to (fixtures). Default every make. */
  makes?: readonly string[];
  /** A group needs this many registrations to count; single imports are noise. Default 10. */
  minRegistrations?: number;
  /** Rows per DiscoData page. Default 10,000. */
  pageSize?: number;
}

/** A result row as DiscoData sends it; `rowOf` checks each field before use. */
interface Row {
  Mk: string;
  Cn: string;
  Ft: string;
  Fm: string;
  kw: number | null;
  cc: number | null;
  mass: number | null;
  co2: number | null;
  fc: number | null;
  z: number | null;
}

export function eeaCo2Source(options: EeaCo2Options = {}): Source {
  const tables = options.tables ?? EEA_TABLES;
  const pageSize = options.pageSize ?? 10_000;
  return {
    id: "eea-co2",
    async *harvest(ctx: HarvestContext): AsyncIterable<VariantFacts> {
      const last = ctx.checkpoint.lastRunAt;
      const since = ctx.mode === "incremental" && last ? last.getUTCFullYear() - 1 : 0;
      for (const table of tables.filter((t) => t.year >= since)) {
        let rows = 0;
        let skipped = 0;
        let malformed = 0;
        for (let page = 1; ; page++) {
          const batch = await getPage(ctx, query(table, options), page, pageSize);
          for (const raw of batch) {
            const row = rowOf(raw);
            const facts = row && toFacts(row, table.year);
            if (facts) yield facts;
            else if (row) skipped++;
            else malformed++;
          }
          rows += batch.length;
          if (batch.length < pageSize) break;
        }
        if (malformed > 0) {
          ctx.log.warn("eea-co2 rows malformed", { table: table.table, malformed });
        }
        ctx.log.info("eea-co2 table done", { table: table.table, rows, skipped, malformed });
      }
    },
  };
}

function query(table: EeaTable, options: EeaCo2Options): string {
  const countries = (options.countries ?? ["CZ", "DE", "AT"]).map(sqlString).join(", ");
  const makes = options.makes ? ` AND [Mk] IN (${options.makes.map(sqlString).join(", ")})` : "";
  const min = options.minRegistrations ?? 10;
  return [
    "SELECT [Mk], [Cn], [Ft], [Fm], [Ep (KW)] AS kw, [Ec (cm3)] AS cc,",
    "AVG([M (kg)]) AS mass, AVG([Ewltp (g/km)]) AS co2, AVG([Fc]) AS fc,",
    "AVG([Z (Wh/km)]) AS z, SUM([R]) AS r",
    `FROM [CO2Emission].[latest].[${table.table}]`,
    `WHERE [Year] = ${table.year} AND [Status] = '${table.status}' AND [MS] IN (${countries})${makes}`,
    "GROUP BY [Mk], [Cn], [Ft], [Fm], [Ep (KW)], [Ec (cm3)]",
    `HAVING SUM([R]) >= ${min}`,
    "ORDER BY [Mk], [Cn], [Ft], [Fm], kw, cc",
  ].join(" ");
}

async function getPage(
  ctx: HarvestContext,
  sql: string,
  page: number,
  pageSize: number,
): Promise<unknown[]> {
  ctx.signal.throwIfAborted();
  const params = new URLSearchParams({ query: sql, p: String(page), nrOfHits: String(pageSize) });
  const url = `${ENDPOINT}?${params}`;
  const response = await ctx.http.get({ url, locale: "en", signal: ctx.signal });
  if (response.status !== 200) throw new Error(`EEA DiscoData returned HTTP ${response.status}`);
  const json = JSON.parse(response.body) as { results?: unknown; errors?: { error: string }[] };
  if (!Array.isArray(json.results)) {
    throw new Error(`EEA DiscoData query failed: ${json.errors?.[0]?.error ?? response.body}`);
  }
  return json.results;
}

/**
 * Fuel type and mode to the shared Fuel. Mode H on a single fuel is a mild hybrid (eTSI,
 * mHEV), which the catalog files under its combustion fuel; "petrol/electric" is a full (H)
 * or plug-in (P) hybrid.
 */
function fuelOf(ft: string, fm: string): Fuel | undefined {
  const type = ft.trim().toLowerCase();
  const mode = fm.trim().toUpperCase();
  if (type === "electric") return "bev";
  if (type === "petrol/electric" || type === "diesel/electric") {
    return mode === "P" ? "phev" : mode === "H" ? "hev" : undefined;
  }
  if (type === "petrol" || type === "e85") return "petrol";
  if (type === "diesel") return "diesel";
  if (type === "lpg") return "lpg";
  if (type === "ng" || type === "ng-biomethane" || type === "cng") return "cng";
  if (type === "hydrogen") return "hydrogen";
  return undefined;
}

/**
 * The row when its fields have the types the query selects: text or null for the names, a
 * number or null for the figures. Anything else (a null row, a number where a name belongs)
 * is malformed and skipped, so one bad row does not end the run.
 */
function rowOf(raw: unknown): Row | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const texts = [r.Mk, r.Cn, r.Ft, r.Fm];
  const numbers = [r.kw, r.cc, r.mass, r.co2, r.fc, r.z];
  if (!texts.every((v) => v === null || v === undefined || typeof v === "string")) return undefined;
  if (!numbers.every((v) => v === null || v === undefined || typeof v === "number")) {
    return undefined;
  }
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const number = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    Mk: text(r.Mk),
    Cn: text(r.Cn),
    Ft: text(r.Ft),
    Fm: text(r.Fm),
    kw: number(r.kw),
    cc: number(r.cc),
    mass: number(r.mass),
    co2: number(r.co2),
    fc: number(r.fc),
    z: number(r.z),
  };
}

function toFacts(row: Row, year: number): VariantFacts | undefined {
  const make = row.Mk ? makeName(row.Mk) : undefined;
  const model = row.Cn.trim();
  const fuel = fuelOf(row.Ft, row.Fm);
  const powerKw = positive(row.kw);
  if (!make || !model || !fuel || !powerKw) return undefined;
  const engineCc = fuel === "bev" ? undefined : positive(row.cc);
  const facts: VariantFacts["facts"] = {
    engineCc: engineCc && Math.round(engineCc),
    co2GKm: fuel === "bev" ? undefined : nonNegative(row.co2, 0),
    massKg: positive(row.mass) && Math.round(row.mass as number),
    consumptionL100km: fuel === "bev" ? undefined : nonNegative(row.fc, 1),
    // Z is Wh/km; the vocabulary uses kWh/100 km.
    consumptionKwh100km: positive(row.z) && Math.round(row.z as number) / 10,
  };
  return {
    kind: "VariantFacts",
    vehicle: {
      make,
      model,
      fuel,
      powerKw,
      engineCc,
      firstRegistration: { year },
    },
    facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)),
  };
}

function positive(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: number | null, digits: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
