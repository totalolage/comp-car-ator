/**
 * ČNB (Czech National Bank) daily FX fixing: the reference Source adapter.
 *
 * - incremental, first run or last run within a day: the latest daily fixing (1 request).
 * - incremental after a gap: the year file(s) covering the gap (1 request per year), so
 *   missed days are back-filled.
 * - full: year files from `fullSinceYear` to the current year.
 *
 * Endpoints and format: import-and-china.md §6 in the research notes; both are
 * pipe-separated with a decimal comma, and the rate is per `množství` units.
 */
import { type FxRate, type IsoDate, pragueDate } from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

const BASE =
  "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu";

const DAY_MS = 86_400_000;

export interface CnbOptions {
  /** First year fetched by a full run. Default: the year before the run. */
  fullSinceYear?: number;
}

export function cnbSource(options: CnbOptions = {}): Source {
  return {
    id: "cnb",
    async *harvest(ctx: HarvestContext): AsyncIterable<FxRate> {
      const today = pragueDate(ctx.now);
      const thisYear = Number(today.slice(0, 4));
      const last = ctx.checkpoint.lastRunAt;

      if (ctx.mode === "incremental" && (!last || ctx.now.getTime() - last.getTime() <= DAY_MS)) {
        const page = await getOk(ctx, `${BASE}/denni_kurz.txt`);
        yield* parseDaily(page);
        return;
      }

      const since =
        ctx.mode === "full"
          ? `${options.fullSinceYear ?? thisYear - 1}-01-01`
          : pragueDate(last as Date);
      for (let year = Number(since.slice(0, 4)); year <= thisYear; year++) {
        ctx.signal.throwIfAborted();
        const page = await getOk(ctx, `${BASE}/rok.txt?rok=${year}`);
        for (const rate of parseYear(page)) {
          if (rate.validFor >= since && rate.validFor <= today) yield rate;
        }
      }
    },
  };
}

async function getOk(ctx: HarvestContext, url: string): Promise<string> {
  ctx.signal.throwIfAborted();
  const page = await ctx.http.get({ url, locale: "cs" });
  if (page.status !== 200) throw new Error(`ČNB returned HTTP ${page.status} for ${url}`);
  ctx.log.info("cnb fetched", { url });
  return page.body;
}

/**
 * Daily file:
 *   23.10.2026 #205
 *   země|měna|množství|kód|kurz
 *   EMU|euro|1|EUR|24,335
 */
export function parseDaily(text: string): FxRate[] {
  const lines = text.trim().split(/\r?\n/);
  const validFor = czechDate((lines[0] ?? "").split(" ")[0] ?? "");
  return lines.slice(2).map((line) => {
    const [, , amount, currency, rate] = line.split("|");
    return fxRate(currency, validFor, rate, amount);
  });
}

/**
 * Year file; the header names currencies with their unit and repeats whenever the
 * currency set changes mid-year:
 *   Datum|1 AUD|...|100 HUF|...
 *   02.01.2026|13,797|...|6,304|...
 */
export function parseYear(text: string): FxRate[] {
  const rates: FxRate[] = [];
  let columns: { amount: string; currency: string }[] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const [first, ...cells] = line.split("|");
    if (first === "Datum") {
      columns = cells.map((cell) => {
        const [amount = "", currency = ""] = cell.trim().split(" ");
        return { amount, currency };
      });
      continue;
    }
    const validFor = czechDate(first ?? "");
    cells.forEach((cell, i) => {
      const column = columns[i];
      if (column && cell.trim() !== "") {
        rates.push(fxRate(column.currency, validFor, cell, column.amount));
      }
    });
  }
  return rates;
}

function fxRate(
  currency: string | undefined,
  validFor: IsoDate,
  rate: string | undefined,
  amount: string | undefined,
): FxRate {
  const czkPerUnit = czechNumber(rate) / czechNumber(amount);
  if (!currency || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(czkPerUnit)) {
    throw new Error(`Unparseable ČNB row: ${currency} ${rate}/${amount} on ${validFor}`);
  }
  return { kind: "FxRate", currency, validFor, czkPerUnit: round(czkPerUnit) };
}

function czechNumber(text: string | undefined): number {
  return Number((text ?? "").trim().replace(/\s/g, "").replace(",", "."));
}

/** "23.10.2026" → "2026-10-23" */
function czechDate(text: string): IsoDate {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!match) throw new Error(`Unparseable ČNB date: ${text}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
