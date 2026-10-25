/**
 * Škoda Auto's Czech price lists (ceníky): official CZK list prices incl. VAT per engine and
 * trim line, from the PDFs linked on skoda-auto.cz/nabidka/ceniky-katalogy, one per model.
 *
 * - The index links each model's list as `<a …href="…/_doc/<guid>">Kodiaq - Ceník</a>`; the
 *   accessory catalogues next to them are not price lists.
 * - A list holds one or more grids (Octavia: Liftback, Combi and edition tables; Enyaq: SUV
 *   and Coupé). A grid's header is `Motor | Druh | Převodovka | Pohon | <trim lines…>`, or
 *   `Verze | Pohon | Baterie | Dojezd | <trim lines…>` for electric models; a trim line's name
 *   can sit on two lines ("Laurin" over "& Klement"). Each engine row prices it in every trim
 *   line that offers it, "–" where none does. The list's own date is its "Platnost od".
 * - Rows carry no sales codes, so an Offer's code is built from what the row prices: model
 *   (with Combi/Coupé), engine, fuel, manual/automatic, drive and trim line. A price on a grid
 *   page that no row read rejects the list's withdrawals (the row would look dropped).
 * - Model year and body come from the public configurator (CC3) the site links to: its model
 *   tiles state the model year and group models by body. Missing CC3 data only leaves those
 *   two fields out.
 *
 * Research notes: /home/dev/.t3/scratch/comp-car-ator/w1-10/ (skoda findings, pdfs/README).
 * Verified against the live site 2026-10-25.
 */
import { type Body, slugify } from "@cca/vocabulary";
import { columnOf, type PdfCell, type PdfLine } from "../pricelist/pdf.ts";
import {
  czk,
  driveOf,
  type Edition,
  fuelOf,
  gearboxOf,
  type ModelLists,
  type Offer,
  type PriceListOptions,
  type PriceListSite,
  priceListSource,
  validFromOf,
} from "../pricelist/pricelist.ts";
import type { HarvestContext, Source } from "../source.ts";

const INDEX = "https://www.skoda-auto.cz/nabidka/ceniky-katalogy";
const CC3_VERSION = "https://cc.skoda-auto.com/c3pobe/version?Country=CZE";
const cc3Homepage = (version: string) =>
  `https://c3poweb.blob.core.windows.net/webcache/${version}/homepage-CZE-cs-CZ.json`;

export function skodaPricelistSource(options: PriceListOptions = {}): Source {
  return priceListSource(skoda, options);
}

const skoda: PriceListSite = {
  id: "skoda-pricelist",
  make: "Škoda",
  async models(ctx) {
    const page = await ctx.http.get({ url: INDEX, signal: ctx.signal });
    if (page.status !== 200) throw new Error(`skoda-pricelist: index answered ${page.status}`);
    const lists = new Map<string, string>();
    let complete = true;
    for (const m of page.body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const href = /\bhref="([^"]*\/_doc\/[^"]+)"/.exec(m[1] as string)?.[1];
      if (!href) continue;
      const text = decode((m[2] as string).replace(/<[^>]*>/g, " "));
      if (!/ceník/i.test(text)) continue;
      const name = /^(.+?)\s*[-–—]\s*ceník/i.exec(text)?.[1];
      if (!name) {
        ctx.log.warn("skoda-pricelist: price-list link without a model name", { text });
        complete = false;
      } else if (!lists.has(name)) lists.set(name, new URL(href, INDEX).href);
    }
    if (lists.size === 0) throw new Error("skoda-pricelist: the index links no price lists");
    const named = await configuratorModels(ctx);
    return {
      models: [...lists].map(([name, url]) => ({
        key: slugify(name),
        name,
        documents: [url],
        named,
      })),
      complete,
    };
  },
  read,
};

const CC3_BODIES: Record<string, Body> = { Hatchback: "hatchback", Kombi: "wagon", SUV: "suv" };

/** Model year and body per model name from the configurator's model tiles. */
async function configuratorModels(
  ctx: HarvestContext,
): Promise<Record<string, { modelYear?: number; body?: Body }>> {
  const named: Record<string, { modelYear?: number; body?: Body }> = {};
  try {
    // The version service answers a JSON string, or the bare id as text/plain to a browser Accept.
    const headers = { accept: "application/json" };
    const version = await ctx.http.get({ url: CC3_VERSION, headers, signal: ctx.signal });
    if (version.status !== 200) throw new Error(`version answered ${version.status}`);
    const home = await ctx.http.get({
      url: cc3Homepage(version.body.trim().replace(/^"|"$/g, "")),
      headers,
      signal: ctx.signal,
    });
    if (home.status !== 200) throw new Error(`homepage answered ${home.status}`);
    const { groups } = JSON.parse(home.body) as {
      groups: { title: string; tiles: { title: string; modelId: string }[] }[];
    };
    for (const group of groups) {
      for (const tile of group.tiles) {
        const entry = named[tile.title] ?? {};
        named[tile.title] = entry;
        const year = Number(tile.modelId.split(";")[2]);
        if (Number.isInteger(year) && year > 2000) entry.modelYear = year;
        const body = CC3_BODIES[group.title];
        if (body) entry.body = body;
      }
    }
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.log.warn("skoda-pricelist: configurator models unavailable; no model years", {
      error: String(error),
    });
  }
  return named;
}

type Kind = "engine" | "fuel" | "gearbox" | "drive" | "other" | "trim";
const HEADER_KINDS: Record<string, Kind> = {
  Motor: "engine",
  Verze: "engine",
  Druh: "fuel",
  Převodovka: "gearbox",
  Pohon: "drive",
  Baterie: "other",
  Dojezd: "other",
};

function read(lines: PdfLine[], model: ModelLists): Edition {
  const validFrom = validFromOf(lines);
  if (!validFrom) throw new Error('no "Platnost od" date');
  const edition: Edition = { validFrom, offers: [], rejected: [] };
  const used = new Set<PdfCell>();
  const pages = new Set<number>();
  lines.forEach((line, i) => {
    if (!isHeader(line)) return;
    pages.add(line.page);
    readGrid(lines, i, model, edition, used);
  });
  // A price on a grid page that no row read is a row this reader missed: its Offer would
  // look dropped, so it rejects the list's withdrawals.
  for (const line of lines) {
    if (!pages.has(line.page)) continue;
    for (const c of line.cells) {
      if (PRICE.test(c.text) && !used.has(c)) {
        edition.rejected.push({
          row: `page ${line.page}: ${c.text}`,
          reason: "price outside any row",
        });
      }
    }
  }
  return edition;
}

const PRICE = /^\d{1,3}(?: \d{3})+$/;

/** A header cell's column kind, by its first word ("Verze SUV" labels an engine column). */
function headerKind(text: string): Kind | undefined {
  return HEADER_KINDS[text.split(" ")[0] as string];
}

function isHeader(line: PdfLine): boolean {
  const kinds = line.cells.map((c) => headerKind(c.text));
  return kinds.includes("drive") && kinds.includes("engine");
}

function readGrid(
  lines: PdfLine[],
  at: number,
  model: ModelLists,
  edition: Edition,
  used: Set<PdfCell>,
): void {
  const header = lines[at] as PdfLine;
  const last = header.cells.findLastIndex((c) => headerKind(c.text) !== undefined);
  // Cells between the known columns label the grid ("Verze | SUV | Pohon"): engine text.
  const kinds: Kind[] = header.cells.map((c, i) =>
    i > last ? "trim" : (headerKind(c.text) ?? "engine"),
  );
  const trims = header.cells.map((c) => c.text);
  const above = lines.filter(
    (l) => l.page === header.page && l.y > header.y && l.y <= header.y + 120,
  );
  const titles: string[] = header.cells
    .filter((_, i) => i < last && kinds[i] === "engine")
    .map((c) => c.text);
  for (const line of above) {
    const stacked =
      line.y <= header.y + 40 && line.cells.every((c) => trimAt(header, kinds, c) >= 0);
    if (stacked) {
      for (const c of line.cells) {
        const i = trimAt(header, kinds, c);
        trims[i] = `${c.text} ${trims[i]}`;
      }
    } else titles.push(...line.cells.map((c) => c.text));
  }
  const title = titles.join(" ");
  const name = /\bcombi\b/i.test(title)
    ? `${model.name} Combi`
    : /\bcoup[ée](?![a-z])/i.test(title)
      ? `${model.name} Coupé`
      : model.name;
  const electric = !kinds.includes("fuel") && header.cells.some((c) => c.text === "Baterie");

  // Rows: an engine line ("1,5 TSI/118 kW", "85x | 210 kW") down to the next one.
  const rows: PdfLine[][] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as PdfLine;
    if (line.page !== header.page || isHeader(line)) break;
    const first = line.cells[0]?.text ?? "";
    if (/^Ceny jsou uvedeny/i.test(first)) break;
    if (/^Spotřeba/i.test(first)) continue;
    const engine = line.cells.filter((c) => kinds[columnOf(c, header.cells)] === "engine");
    if (engine.some((c) => /\d ?kW\b/.test(c.text))) rows.push([line]);
    else rows.at(-1)?.push(line);
  }

  for (const [start, ...rest] of rows as [PdfLine, ...PdfLine[]][]) {
    const texts: Record<Kind, string[]> = {
      engine: [],
      fuel: [],
      gearbox: [],
      drive: [],
      other: [],
      trim: [],
    };
    const prices = new Map<number, PdfCell>();
    for (const c of start.cells) {
      if (kinds[columnOf(c, header.cells)] === "engine") texts.engine.push(c.text);
    }
    for (const line of [start, ...rest]) {
      for (const c of line.cells) {
        const col = columnOf(c, header.cells);
        const kind = kinds[col] as Kind;
        if (kind === "trim") {
          // Prices and dashes; text there is the configurator link beside the grid.
          if (/\d|^[–-]$/.test(c.text) && !prices.has(col)) {
            prices.set(col, c);
            used.add(c);
          }
        } else if (kind !== "engine" && !/^\d$/.test(c.text)) texts[kind].push(c.text);
      }
    }
    const engine = texts.engine.join(" ");
    const fuelText = texts.fuel.join(" ");
    const gearText = texts.gearbox.join(" ");
    const fuel = electric ? "bev" : fuelOf(fuelText);
    const transmission = gearboxOf(gearText);
    const drive = driveOf(texts.drive.join(" "));
    const powerKw = Number(/(\d+) ?kW\b/.exec(engine)?.[1]);
    for (const [col, { text }] of prices) {
      if (/^[–-]$/.test(text)) continue;
      const line = trims[col] as string;
      const row = `${name} ${engine} ${line}: ${text}`;
      const price = czk(text);
      if (price === undefined) {
        edition.rejected.push({ row, reason: "price does not read" });
        continue;
      }
      if (!(powerKw > 0)) {
        edition.rejected.push({ row, reason: "no power" });
        continue;
      }
      const offer: Offer = {
        code: [
          slugify(name),
          slugify(engine),
          fuel ?? "x",
          transmission?.[0] ?? "x",
          drive ?? "x",
          slugify(line),
        ].join("."),
        model: name,
        engine,
        line,
        price,
        powerKw,
      };
      if (fuel) offer.fuel = fuel;
      if (transmission) offer.transmission = transmission;
      if (drive) offer.drive = drive;
      edition.offers.push(offer);
    }
  }
}

/** The trim column a stacked header word sits over, or -1. */
function trimAt(header: PdfLine, kinds: Kind[], cell: PdfCell): number {
  return header.cells.findIndex((c, i) => kinds[i] === "trim" && Math.abs(c.x - cell.x) <= 4);
}

function decode(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}
