/**
 * What the site shows of comma.ai's openpilot supported-car list (ADR 0016): the catalog
 * row badge, the facet's option labels and the model page section. The strings live here,
 * not in messages.ts: that catalog ships to every island in both languages and a model page
 * sits just under its JS budget (DESIGN.md). The badge and the labels reach the catalog
 * island only; the section's strings are used at build time and ship to no page.
 */
import type { ModelFile, OpenpilotRow, VariantRow } from "@cca/bundle";
import type { OpenpilotFacet } from "@cca/catalog";
import { OPENPILOT_LEVELS } from "@cca/vocabulary";
import { i18n } from "../i18n/i18n.ts";
import type { Lang } from "../i18n/locale.ts";

/** The facet's values, best level first, then Variants no list row matched. */
export const OPENPILOT_FACETS: readonly OpenpilotFacet[] = [...OPENPILOT_LEVELS, "unlisted"];

const LEVEL: Record<Lang, Record<OpenpilotFacet, string>> = {
  cs: {
    upstream: "Podporováno",
    community: "Komunita",
    custom: "Vyžaduje úpravy",
    underReview: "V přezkumu",
    dashcam: "Jen kamera (dashcam)",
    incompatible: "Nekompatibilní",
    unlisted: "Neuvedeno",
  },
  en: {
    upstream: "Supported",
    community: "Community",
    custom: "Custom setup",
    underReview: "Under review",
    dashcam: "Dashcam only",
    incompatible: "Incompatible",
    unlisted: "Not listed",
  },
};

/** A facet option's or a list row's level label; an unknown value shows as itself. */
export function openpilotLabel(value: string, lang: Lang): string {
  return LEVEL[lang][value as OpenpilotFacet] ?? value;
}

/** Ascending model years as compact spans: [2015…2019, 2021] is "2015–19, 2021". */
export function yearSpans(years: readonly number[]): string {
  const spans: string[] = [];
  for (let i = 0; i < years.length; ) {
    const from = years[i] as number;
    let to = from;
    while (years[i + 1] === to + 1) to = years[++i] as number;
    i++;
    const sameCentury = Math.floor(from / 100) === Math.floor(to / 100);
    spans.push(from === to ? `${from}` : `${from}–${sameCentury ? String(to).slice(2) : to}`);
  }
  return spans.join(", ");
}

/** Per level: the badge's text and the level's meaning in its title. */
type Badge = Record<"upstream" | "community", [string, string]> & { title: string };
const BADGE: Record<Lang, Badge> = {
  cs: {
    upstream: ["openpilot", "podporováno"],
    community: ["openpilot · komunita", "komunitní podpora"],
    title: "comma.ai openpilot: {level} podle seznamu comma, modelové roky {years}",
  },
  en: {
    upstream: ["openpilot", "supported"],
    community: ["openpilot · community", "community-supported"],
    title: "comma.ai openpilot: {level} per comma's list, model years {years}",
  },
};

/**
 * The catalog row badge: only for Variants comma's list supports (`upstream`) or its
 * community forks do (`community`); other levels get no badge.
 */
export function openpilotBadge(
  v: VariantRow,
  lang: Lang,
): { level: "upstream" | "community"; text: string; title: string } | null {
  const level = v.openpilot?.level;
  if (level !== "upstream" && level !== "community") return null;
  const [text, meaning] = BADGE[lang][level];
  const years = yearSpans(v.openpilot?.years ?? []);
  return {
    level,
    text,
    title: BADGE[lang].title.replace("{level}", meaning).replace("{years}", years),
  };
}

const SECTION = {
  cs: {
    generations: "Generace",
    package: "Výbava",
    harness: "Kabeláž",
    longitudinal: "Podélné řízení",
    openpilot: "openpilot řídí plyn a brzdy",
    optional: "volitelně (alfa)",
    stock: "původní ACC",
    minSteer: "Řídí od",
    minEnable: "Zapíná se od",
    listed: "comma uvádí pro {market}.",
    unstated:
      "Seznam comma u tohoto vozu neuvádí trh (výchozí je USA); evropské verze se mohou lišit.",
    markets: {
      Europe: "evropský trh",
      "Non-US": "trhy mimo USA",
      "Southeast Asia and Europe": "trh jihovýchodní Asie a Evropy",
    } as Record<string, string>,
    market: "trh {market}",
    check: "Ověřte na comma.ai",
    note: "Shoda je podle modelu a modelových roků; záleží i na výbavě vozu.",
  },
  en: {
    generations: "Generations",
    package: "Package",
    harness: "Harness",
    longitudinal: "Longitudinal control",
    openpilot: "openpilot controls gas and brakes",
    optional: "optional (alpha)",
    stock: "stock ACC",
    minSteer: "Steers from",
    minEnable: "Engages from",
    listed: "Listed by comma for {market}.",
    unstated:
      "comma's list does not say which market this row is for (its default is the US); European versions can differ.",
    markets: {
      Europe: "the European market",
      "Non-US": "markets outside the US",
      "Southeast Asia and Europe": "the Southeast Asian and European markets",
    } as Record<string, string>,
    market: "the {market} market",
    check: "Check on comma.ai",
    note: "Matched by model and model years; the car's package matters too.",
  },
};

export interface OpenpilotEntry {
  level: OpenpilotRow["level"];
  levelLabel: string;
  /** comma's make and model with the listed years: "Toyota Corolla Hybrid 2020–22". */
  title: string;
  facts: { term: string; value: string }[];
  market: string;
  url: string;
}

/** The model page section: one entry per list row, in the Bundle's order (best level first). */
export function openpilotSection(
  rows: readonly OpenpilotRow[],
  generations: ModelFile["generations"],
  lang: Lang,
): { entries: OpenpilotEntry[]; check: string; note: string } {
  const s = SECTION[lang];
  const t = i18n(lang);
  const kmh = (n: number) => `${t.number(n, 1)}\u00a0km/h`;
  const entries = rows.map((row): OpenpilotEntry => {
    const gens = generations.filter((g) => row.generationIds.includes(g.id)).map((g) => g.name);
    const facts: { term: string; value: string }[] = [];
    if (gens.length > 0) facts.push({ term: s.generations, value: gens.join(", ") });
    if (row.package) facts.push({ term: s.package, value: row.package });
    if (row.harness) facts.push({ term: s.harness, value: row.harness });
    if (row.longitudinal) facts.push({ term: s.longitudinal, value: s[row.longitudinal] });
    if (row.minSteerKmh !== undefined)
      facts.push({ term: s.minSteer, value: kmh(row.minSteerKmh) });
    if (row.minEnableKmh !== undefined)
      facts.push({ term: s.minEnable, value: kmh(row.minEnableKmh) });
    const market = s.markets[row.market] ?? s.market.replace("{market}", row.market);
    return {
      level: row.level,
      levelLabel: openpilotLabel(row.level, lang),
      title: `${row.make} ${row.model} ${yearSpans(row.years)}`,
      facts,
      // Rows only for other markets (`europe: false`) never reach the Bundle (ADR 0016).
      market: row.europe ? s.listed.replace("{market}", market) : s.unstated,
      url: row.url,
    };
  });
  return { entries, check: s.check, note: s.note };
}
