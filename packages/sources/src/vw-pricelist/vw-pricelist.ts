/**
 * Volkswagen's Czech price lists (ceníky, importer Porsche Česká republika): official CZK
 * list prices incl. VAT per sales code, from the PDFs on each model's Ceníky page.
 *
 * - volkswagen.cz/modely links every passenger model as `<a href="/tiguan/tiguan" title="Vše
 *   o modelu Tiguan">`; its Ceníky page (`/tiguan/tiguan/ceniky`) links the current lists as
 *   `<a data-gtm-element="infomaterial_download" data-gtm-element-url="/dam/…/x.pdf"
 *   …>Ceník modelu Tiguan</a>`: the model's own list, action models (Family, People),
 *   sporty versions (GTI, R). Downloads not labelled "Ceník" (We Charge manuals) are not lists. A model
 *   without a Ceníky page (404) has no list yet; it stays listed, so nothing of it is withdrawn.
 * - A list's table header is `Zdvihový objem (l) | Model | Palivo | Výkon kW (k) | Převodovka |
 *   Pohon | Cena bez DPH | Cena s DPH` (electric models: `Popisek` first, sometimes no Palivo
 *   or Výkon). A trim line's name stands alone on a line above its rows; each row is one sales
 *   code. The list's date is its "Platnost od"; its model year is in the file name ("MY2027").
 * - The sales code is the Offer code; an action list repeating a code of the main list at
 *   the same price is the same Offer.
 *
 * Research notes: /home/dev/.t3/scratch/comp-car-ator/w1-10/ (vw findings, pdfs/README).
 * Verified against the live site 2026-10-25. VW Group OKAPI needs company approval; unused.
 */

import { columnOf, type PdfLine } from "../pricelist/pdf.ts";
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
import type { Source } from "../source.ts";

const SITE = "https://www.volkswagen.cz";

export function vwPricelistSource(options: PriceListOptions = {}): Source {
  return priceListSource(vw, options);
}

const vw: PriceListSite = {
  id: "vw-pricelist",
  make: "Volkswagen",
  async models(ctx, wanted) {
    const page = await ctx.http.get({ url: `${SITE}/modely`, signal: ctx.signal });
    if (page.status !== 200)
      throw new Error(`vw-pricelist: model overview answered ${page.status}`);
    const names = new Map<string, string>();
    for (const m of page.body.matchAll(/<a\b[^>]*>/g)) {
      const route = /\bhref="\/([a-z0-9-]+)\/\1"/.exec(m[0])?.[1];
      const name = /\btitle="Vše o modelu ([^"]+)"/.exec(m[0])?.[1];
      if (route && name && !names.has(route)) names.set(route, decode(name));
    }
    if (names.size === 0) throw new Error("vw-pricelist: the model overview links no models");
    const models: ModelLists[] = [];
    for (const [key, name] of names) {
      if (!wanted(key)) {
        models.push({ key, name, documents: [] });
        continue;
      }
      const lists = await ctx.http.get({ url: `${SITE}/${key}/${key}/ceniky`, signal: ctx.signal });
      // No Ceníky page (yet): listed, but nothing to read and nothing to withdraw.
      if (lists.status === 404) {
        models.push({ key, name, documents: [] });
        continue;
      }
      if (lists.status !== 200)
        throw new Error(`vw-pricelist: ${key} price lists answered ${lists.status}`);
      models.push({ key, name, documents: documentsOf(lists.body) });
    }
    return models;
  },
  read,
};

function documentsOf(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(
    /<a\b([^>]*\bdata-gtm-element="infomaterial_download"[^>]*)>([\s\S]*?)<\/a>/g,
  )) {
    const path = /\bdata-gtm-element-url="([^"]+\.pdf)"/i.exec(m[1] as string)?.[1];
    const label = decode((m[2] as string).replace(/<[^>]*>/g, " "));
    if (!path || !/ceník/i.test(label)) continue;
    const url = new URL(decode(path), SITE).href;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

type Kind = "engine" | "code" | "fuel" | "power" | "gearbox" | "drive" | "net" | "price";

function headerKind(text: string): Kind | undefined {
  if (/^(Zdvihový objem|Popisek)/i.test(text)) return "engine";
  if (text === "Model") return "code";
  if (text === "Palivo") return "fuel";
  if (/^Výkon/.test(text)) return "power";
  if (text === "Převodovka") return "gearbox";
  if (text === "Pohon") return "drive";
  if (text === "Cena bez DPH") return "net";
  if (text === "Cena s DPH") return "price";
  return undefined;
}

const SALES_CODE = /^(?=[A-Z0-9]*\d)[A-Z0-9]{8}$/;

function read(lines: PdfLine[], model: ModelLists, url: string): Edition {
  const validFrom = validFromOf(lines);
  if (!validFrom) throw new Error('no "Platnost od" date');
  const year = /MY_?(?:20)?(\d{2})(?!\d)/i.exec(
    decodeURIComponent(url.split("/").at(-1) ?? ""),
  )?.[1];
  const edition: Edition = { validFrom, offers: [], rejected: [] };
  let header: PdfLine | undefined;
  let kinds: (Kind | undefined)[] = [];
  let line = "";
  for (const row of lines) {
    const rowKinds = row.cells.map((c) => headerKind(c.text));
    if (rowKinds.includes("code") && rowKinds.includes("price")) {
      header = row;
      kinds = rowKinds;
      line = "";
      continue;
    }
    if (!header || row.page !== header.page) continue;
    const cells: Partial<Record<Kind, string>> = {};
    for (const c of row.cells) {
      const kind = kinds[columnOf(c, header.cells)];
      if (kind) cells[kind] = cells[kind] ? `${cells[kind]} ${c.text}` : c.text;
    }
    const code = cells.code;
    if (!code || !SALES_CODE.test(code)) {
      if (czk(cells.price ?? "") !== undefined) {
        // A priced row this reader cannot key would look dropped: reject it.
        edition.rejected.push({
          row: row.cells.map((c) => c.text).join(" | "),
          reason: "priced row without a sales code",
        });
      } else if (row.cells.length === 1 && cells.engine && !/\d{3}/.test(cells.engine)) {
        // A trim line's name stands alone in the first column.
        line = cells.engine;
      }
      continue;
    }
    const engine = cells.engine ?? "";
    const text = row.cells.map((c) => c.text).join(" | ");
    const price = czk(cells.price ?? "");
    const powerKw = Number(
      /^(\d+)\s*\//.exec(cells.power ?? "")?.[1] ?? /(\d+) ?kW\b/.exec(engine)?.[1],
    );
    if (price === undefined) {
      edition.rejected.push({ row: text, reason: "price does not read" });
      continue;
    }
    if (!(powerKw > 0)) {
      edition.rejected.push({ row: text, reason: "no power" });
      continue;
    }
    const fuel = cells.fuel ? fuelOf(cells.fuel) : /\bkWh\b/.test(engine) ? "bev" : undefined;
    const transmission = gearboxOf(cells.gearbox ?? "");
    const drive = driveOf(cells.drive ?? "");
    const offer: Offer = { code, model: model.name, engine, line, price, powerKw };
    if (fuel) offer.fuel = fuel;
    if (transmission) offer.transmission = transmission;
    if (drive) offer.drive = drive;
    if (year) offer.modelYear = 2000 + Number(year);
    edition.offers.push(offer);
  }
  return edition;
}

function decode(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}
