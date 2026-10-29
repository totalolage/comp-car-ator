/**
 * Car model generations from Wikidata (CC0): names and production years, used by the register
 * adapter to name the generations it derives from type-approval types, and to join types that
 * fall in one Wikidata generation. Wikidata is sparse (in 2026-10 it dates Octavia II but not
 * III/IV, and no BMW generation); a generation it does not know keeps its type code.
 *
 * Generations are items of class car model (Q3231690) or car model series (Q59773381) that
 * are part of the series (P179) of a model, or that a model has as part (P527), with a start
 * (P580, else inception P571) and optionally an end (P582, else discontinued P2669).
 */
import { slugify } from "@cca/vocabulary";
import type { HarvestContext } from "../source.ts";

const ENDPOINT = "https://query.wikidata.org/sparql";

const QUERY = `SELECT ?model ?modelLabel ?gen ?genLabel (MIN(?s) AS ?from) (MAX(?e) AS ?to) WHERE {
  VALUES ?cls { wd:Q3231690 wd:Q59773381 }
  ?gen wdt:P31 ?cls .
  { ?gen wdt:P179 ?model } UNION { ?model wdt:P527 ?gen }
  ?model wdt:P31 ?mcls . VALUES ?mcls { wd:Q3231690 wd:Q59773381 }
  ?gen wdt:P580|wdt:P571 ?sd . BIND(YEAR(?sd) AS ?s)
  OPTIONAL { ?gen wdt:P582|wdt:P2669 ?ed . BIND(YEAR(?ed) AS ?e) }
  ?model rdfs:label ?modelLabel FILTER(LANG(?modelLabel) = "en")
  ?gen rdfs:label ?genLabel FILTER(LANG(?genLabel) = "en")
} GROUP BY ?model ?modelLabel ?gen ?genLabel`;

/** One dated generation, keyed by its model's full English label ("Volkswagen Golf"). */
export interface WikidataGeneration {
  /** slugify of the model label, e.g. "volkswagen-golf". */
  modelKey: string;
  /** Roman numeral when the label numbers the generation ("VII" for "Golf Mk7"). */
  numeral?: string;
  /** Words listings use for it besides the numeral: "Mk7", chassis codes "W205", "B8". */
  words: string[];
  from: number;
  to?: number;
}

interface Binding {
  modelLabel?: { value: string };
  genLabel?: { value: string };
  from?: { value: string };
  to?: { value: string };
}

export async function wikidataGenerations(ctx: HarvestContext): Promise<WikidataGeneration[]> {
  ctx.signal.throwIfAborted();
  const url = `${ENDPOINT}?${new URLSearchParams({ query: QUERY, format: "json" })}`;
  const page = await ctx.http.get({
    url,
    locale: "en",
    // Wikidata asks for an identifying User-Agent (https://meta.wikimedia.org/wiki/User-Agent_policy).
    headers: {
      accept: "application/sparql-results+json",
      "user-agent": "car-db/0.1 (https://github.com/totalolage/comp-car-ator)",
    },
    signal: ctx.signal,
  });
  if (page.status !== 200) throw new Error(`Wikidata returned HTTP ${page.status}`);
  const bindings = (JSON.parse(page.body) as { results: { bindings: Binding[] } }).results.bindings;
  const generations: WikidataGeneration[] = [];
  for (const b of bindings) {
    const model = b.modelLabel?.value;
    const label = b.genLabel?.value;
    const from = Number(b.from?.value);
    if (!model || !label || !Number.isInteger(from)) continue;
    const named = generationName(model, label);
    if (!named) continue;
    const to = b.to ? Number(b.to.value) : undefined;
    generations.push({
      modelKey: slugify(model),
      ...named,
      from,
      ...(to !== undefined && Number.isInteger(to) && to >= from ? { to } : {}),
    });
  }
  ctx.log.info("wikidata generations", { rows: bindings.length, dated: generations.length });
  return generations;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const ORDINALS = "first second third fourth fifth sixth seventh eighth ninth tenth".split(" ");

/**
 * What a generation label adds to its model's label: "Škoda Octavia II" → II, "Volkswagen
 * Golf Mk7" → VII + Mk7, "BMW 3 Series (E90)" → E90, "Mercedes-Benz W205" → W205, "Ford Focus
 * 2nd generation" → II. Undefined for labels that name a derivative ("Corolla Cross").
 */
export function generationName(
  modelLabel: string,
  label: string,
): Pick<WikidataGeneration, "numeral" | "words"> | undefined {
  const make = modelLabel.split(" ")[0] as string;
  const rest = label.startsWith(modelLabel)
    ? label.slice(modelLabel.length)
    : label.startsWith(make)
      ? label.slice(make.length)
      : undefined;
  if (rest === undefined) return undefined;
  const text = rest.replace(/[()]/g, " ").trim();
  if (!text) return undefined;
  const mk = /^Mk ?(\d{1,2})$/i.exec(text);
  if (mk) return numbered(Number(mk[1]));
  if (ROMAN.includes(text)) return numbered(ROMAN.indexOf(text) + 1);
  const ordinal = /^(\d{1,2})(?:st|nd|rd|th) generation$/i.exec(text);
  if (ordinal) return numbered(Number(ordinal[1]));
  const spelled = /^(\w+) generation$/i.exec(text);
  if (spelled && ORDINALS.includes((spelled[1] as string).toLowerCase())) {
    return numbered(ORDINALS.indexOf((spelled[1] as string).toLowerCase()) + 1);
  }
  // "Mercedes-Benz type 204": the model series, which listings write as W204.
  const series = /^type (\d{3})$/i.exec(text);
  if (series) return { words: [`W${series[1]}`] };
  const codes = text.split(/[\s/]+/);
  if (codes.every((c) => /^[A-Z]{1,2}\d{1,3}[A-Z]?$/.test(c))) return { words: codes };
  return undefined;
}

function numbered(n: number): Pick<WikidataGeneration, "numeral" | "words"> | undefined {
  const numeral = ROMAN[n - 1];
  return numeral ? { numeral, words: [`Mk${n}`] } : undefined;
}
