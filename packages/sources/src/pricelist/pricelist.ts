/**
 * Czech manufacturer price lists (ceníky) as a Source. A brand's site lists its current price
 * lists, one or more PDF documents per model; this module fetches and reads them, turns each
 * priced row into a ListPrice and withdraws Offers a newer list dropped. The brand adapters
 * (skoda-pricelist, vw-pricelist) supply only where the lists are and how one reads.
 *
 * - Every run reads every current list: a brand has a few dozen PDFs and changes them about
 *   monthly. Manufacturers keep no archive, so the editions before the current one come from
 *   the Ledger (`checkpoint.offersInForce()`).
 * - An Offer's ref is `<model key>/<offer code>`; the model key says which documents an Offer
 *   came from. Withdrawals happen in full runs only (a full run is a census of the lists):
 *   an Offer in force that a model's documents no longer list, when every one of those
 *   documents was fetched and read without a rejected row, ends the day before the model's
 *   newest list starts; an Offer of a model the brand's index no longer lists ends the day
 *   before the run, provided some other model read cleanly. A list that fails to read
 *   withdraws nothing (ADR 0003).
 * - A document that cannot be fetched or read is skipped with a warning; the run fails only
 *   when no document of the brand reads, which is what a site redesign looks like.
 */
import {
  type Body,
  type Drive,
  type Fuel,
  type IsoDate,
  type ListPrice,
  pragueDate,
  type Transmission,
  type VehicleDescriptor,
} from "@cca/vocabulary";
import type { HarvestContext, Source, SourceId } from "../source.ts";
import { type PdfLine, pdfLines } from "./pdf.ts";

/** What one brand adapter tells the price-list Source. */
export interface PriceListSite {
  readonly id: SourceId;
  /** Make as the brand writes it ("Škoda", "Volkswagen"). */
  readonly make: string;
  /**
   * Every model the brand's index lists, with its current price lists; `wanted` says whose
   * lists the run reads, so the site can skip fetching the others'. Throws when the index
   * cannot be read.
   */
  models(ctx: HarvestContext, wanted: (key: string) => boolean): Promise<ModelLists[]>;
  /**
   * Reads the offers of one of the model's documents from its text lines. Throws when the
   * layout is not the expected one.
   */
  read(lines: PdfLine[], model: ModelLists, url: string): Edition;
}

export interface ModelLists {
  /** Stable kebab-case key ("kodiaq", "id-buzz"): the first segment of its Offers' refs. */
  key: string;
  /** Model name as the brand writes it. */
  name: string;
  /** URLs of the model's current price-list PDFs. */
  documents: string[];
  /**
   * Model year and body by model name as the brand's site states them, for Offers that leave
   * them out ("Octavia Combi" → wagon, 2027).
   */
  named?: Readonly<Record<string, { modelYear?: number; body?: Body }>>;
}

/** One document's reading. */
export interface Edition {
  /** The list's "Platnost od" day. */
  validFrom: IsoDate;
  offers: Offer[];
  /** Rows that looked like offers but did not read, as printed, with the reason. */
  rejected: { row: string; reason: string }[];
}

/** One priced row, in the brand's words except for the mapped value sets. */
export interface Offer {
  /**
   * Key of the Offer within its model, stable across editions: the sales code where the list
   * prints one, else built from what the row prices (engine, gearbox, drive, trim line).
   */
  code: string;
  /** Model name; differs from the ModelLists name when a document covers several ("Octavia Combi"). */
  model: string;
  /** Engine as printed ("2,0 TDI/110 kW"). */
  engine: string;
  /** Trim or equipment line ("Selection", "Life"). */
  line: string;
  /** Gross list price, CZK. */
  price: number;
  fuel?: Fuel;
  powerKw?: number;
  transmission?: Transmission;
  drive?: Drive;
  body?: Body;
  modelYear?: number;
}

export interface PriceListOptions {
  /**
   * Read only these model keys. Narrows `scope` to them, so withdrawals never touch other
   * models. For bounded recordings and smoke runs.
   */
  models?: readonly string[];
}

export function priceListSource(site: PriceListSite, options: PriceListOptions = {}): Source {
  const only = options.models ? new Set(options.models) : undefined;
  return {
    id: site.id,
    scope: only ? `models:${[...only].sort().join(",")}` : "all",
    harvest: (ctx) => harvest(site, ctx, only),
  };
}

async function* harvest(
  site: PriceListSite,
  ctx: HarvestContext,
  only: ReadonlySet<string> | undefined,
): AsyncGenerator<ListPrice> {
  const index = await site.models(ctx, (key) => !only || only.has(key));
  const models = only ? index.filter((m) => only.has(m.key)) : index;
  /** Price of each ref yielded. */
  const emitted = new Map<string, number>();
  /** Newest list day of each model whose documents all read cleanly. */
  const clean = new Map<string, IsoDate>();
  let read = 0;

  for (const model of models) {
    let ok = model.documents.length > 0;
    if (!ok) ctx.log.warn(`${site.id}: no price lists for a listed model`, { model: model.key });
    let newest = "";
    for (const url of model.documents) {
      const edition = await readDocument(site, ctx, model, url);
      if (!edition) {
        ok = false;
        continue;
      }
      read++;
      if (edition.validFrom > newest) newest = edition.validFrom;
      for (const { row, reason } of edition.rejected) {
        ctx.log.warn(`${site.id}: rejected row`, { url, row, reason });
        ok = false;
      }
      for (const offer of edition.offers) {
        const ref = `${model.key}/${offer.code}`;
        const seen = emitted.get(ref);
        // Action lists repeat some rows of the model's main list; the same price is no conflict.
        if (seen === offer.price) continue;
        const problem =
          offerProblem(offer) ?? (seen === undefined ? undefined : "two prices in one run");
        if (problem) {
          ctx.log.warn(`${site.id}: rejected offer`, { url, ref, reason: problem });
          ok = false;
          continue;
        }
        emitted.set(ref, offer.price);
        yield {
          kind: "ListPrice",
          ref,
          vehicle: describe(site.make, model, offer),
          price: { amount: offer.price, currency: "CZK" },
          market: "CZ",
          validFrom: edition.validFrom,
        };
      }
    }
    if (ok) clean.set(model.key, newest);
  }
  if (models.length > 0 && read === 0) {
    throw new Error(`${site.id}: none of the ${models.length} models' price lists could be read`);
  }
  if (ctx.mode !== "full") return;

  const listed = new Set(index.map((m) => m.key));
  const runDay = pragueDate(ctx.now);
  for (const edition of ctx.checkpoint.offersInForce()) {
    const key = edition.ref.slice(0, edition.ref.indexOf("/"));
    if (emitted.has(edition.ref) || (only && !only.has(key))) continue;
    const newest = clean.get(key);
    const end = newest
      ? dayBefore(newest)
      : !listed.has(key) && clean.size > 0
        ? dayBefore(runDay)
        : undefined;
    if (end === undefined) continue;
    if (end < edition.validFrom) {
      ctx.log.warn(`${site.id}: offer missing from the list it started in; not withdrawn`, {
        ref: edition.ref,
        validFrom: edition.validFrom,
      });
      continue;
    }
    yield { ...edition, validTo: end };
  }
}

async function readDocument(
  site: PriceListSite,
  ctx: HarvestContext,
  model: ModelLists,
  url: string,
): Promise<Edition | undefined> {
  const page = await ctx.http.get({ url, binary: true, signal: ctx.signal });
  const bytes = page.bytes;
  if (page.status !== 200 || !bytes || !isPdf(bytes)) {
    ctx.log.warn(`${site.id}: price list not available`, { url, status: page.status });
    return undefined;
  }
  try {
    const edition = site.read(await pdfLines(bytes), model, url);
    if (edition.offers.length === 0) throw new Error("no priced rows");
    return edition;
  } catch (error) {
    ctx.log.warn(`${site.id}: price list did not read`, { url, error: String(error) });
    return undefined;
  }
}

/** The one place a price-list Offer becomes a VehicleDescriptor. */
function describe(make: string, model: ModelLists, offer: Offer): VehicleDescriptor {
  // Electric versions are often named in full ("ID. Polo Life 37 kWh 85 kW"), trim included.
  const named = offer.engine.toLowerCase().includes(offer.line.toLowerCase());
  const vehicle: VehicleDescriptor = {
    make,
    model: offer.model,
    trim: named ? offer.engine : `${offer.engine} ${offer.line}`,
  };
  const facts = model.named?.[offer.model];
  const modelYear = offer.modelYear ?? facts?.modelYear;
  const body = offer.body ?? facts?.body;
  if (modelYear !== undefined) vehicle.modelYear = modelYear;
  if (body) vehicle.body = body;
  if (offer.fuel) vehicle.fuel = offer.fuel;
  if (offer.powerKw !== undefined) vehicle.powerKw = offer.powerKw;
  if (offer.transmission) vehicle.transmission = offer.transmission;
  if (offer.drive) vehicle.drive = offer.drive;
  return vehicle;
}

function offerProblem(offer: Offer): string | undefined {
  if (!/^[^/\s]+$/.test(offer.code)) return `bad offer code "${offer.code}"`;
  if (!Number.isFinite(offer.price) || offer.price <= 0) return `bad price ${offer.price}`;
  if (offer.powerKw !== undefined && !(offer.powerKw > 0 && offer.powerKw < 2000)) {
    return `bad power ${offer.powerKw}`;
  }
  if (!offer.model.trim()) return "no model";
  return undefined;
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function dayBefore(day: IsoDate): IsoDate {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

// Czech price-list wording, shared by the brand readers.

/** "1 095 000", "1 095 000 Kč" → 1095000; "–" and other non-prices → undefined. */
export function czk(text: string): number | undefined {
  const m = /^(\d{1,3}(?: \d{3})*|\d+)(?:,-)?(?: Kč)?$/.exec(text.trim());
  return m ? Number((m[1] as string).replace(/ /g, "")) : undefined;
}

/** The "Platnost od 21. 10. 2026" day printed on a list, as IsoDate. */
export function validFromOf(lines: PdfLine[]): IsoDate | undefined {
  for (const line of lines) {
    const text = line.cells.map((c) => c.text).join(" ");
    const m = /platnost od:? *(\d{1,2}) ?\. ?(\d{1,2}) ?\. ?(\d{4})/i.exec(text);
    if (m)
      return `${m[3]}-${(m[2] as string).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}`;
  }
  return undefined;
}

/** Gearbox wording ("7stupňová automatická DSG", "Aut. DSG7", "6stupňová manuální", "Man. 6"). */
export function gearboxOf(text: string): Transmission | undefined {
  if (/automat|\bdsg|\baut\.|\bcvt|e-?cvt|\bat\b/i.test(text)) return "automatic";
  if (/manu|mech|\bman\.|\bmt\b/i.test(text)) return "manual";
  return undefined;
}

/** Driven wheels ("přední", "4×4", "Všech kol", "zadní"). */
export function driveOf(text: string): Drive | undefined {
  if (/4\s*[×x]\s*4|všech kol|4motion|awd/i.test(text)) return "awd";
  if (/přední|fwd/i.test(text)) return "fwd";
  if (/zadní|rwd/i.test(text)) return "rwd";
  return undefined;
}

/**
 * Fuel wording ("Benzín Mild hybrid", "Benzin (mild) Hybrid", "Plug-in hybrid", "Elektro").
 * Mild hybrids go under their combustion fuel, as the catalog lists them.
 */
export function fuelOf(text: string): Fuel | undefined {
  const t = text.toLowerCase();
  if (/plug-?\s?in|phev/.test(t)) return "phev";
  if (/elektr|\bbev\b/.test(t)) return "bev";
  if (/cng|g-tec|tgi/.test(t)) return "cng";
  if (/lpg/.test(t)) return "lpg";
  const mild = /mild|mhev/.test(t);
  if (!mild && /hybrid/.test(t)) return "hev";
  if (/benz[ií]n|petrol/.test(t)) return "petrol";
  if (/naft|diesel/.test(t)) return "diesel";
  return undefined;
}
