/**
 * What the compare page shows for up to four Variants side by side: the line groups
 * (identity, specifications, new price, used market), each value as printed, and which lines
 * differ. It reads Variant specs and aggregates the way `catalog-view.ts` does for the
 * table, so a Bundle format change lands in these two modules and nowhere else in the UI.
 */
import type { Quantiles, VariantRow } from "@cca/bundle";
import { MARKETS, type VariantId } from "@cca/vocabulary";
import { type I18n, i18n, MISSING } from "../i18n/i18n.ts";
import { LANGS, type MessageKey } from "../i18n/messages.ts";
import type { CompareLabel } from "./store.ts";
import { bodyLabel } from "./variant-body.ts";

/** One compared Variant, in the order the person added them. `variant` is null when the id
 * is no longer in the catalog (an old shared link, a Variant the Bundle dropped). */
export interface CompareColumn {
  id: VariantId;
  variant: VariantRow | null;
  /** "Škoda Octavia IV" and "110 kW · kombi · nafta · automatická"; null when stale. */
  name: string | null;
  detail: string | null;
}

export interface CompareLine {
  id: string;
  label: string;
  /** One printed value per column; stale columns print the missing-value dash. */
  values: string[];
  /** At least two Variants still in the catalog print different values here. */
  differs: boolean;
}

export interface CompareGroup {
  id: string;
  label: string;
  lines: CompareLine[];
}

export interface CompareView {
  columns: CompareColumn[];
  groups: CompareGroup[];
}

/**
 * The side-by-side view of `ids`. Values are compared as printed, so two prices that round
 * to the same crown do not differ, and a value one Variant lacks differs from one another
 * has. Lines no Variant has a value for are left out; with `differencesOnly`, so are lines
 * that do not differ (and groups left empty), as long as two or more Variants are still in
 * the catalog: with fewer nothing can differ, and hiding every line would hide the Variant.
 */
export function compareView(
  ids: readonly VariantId[],
  byId: ReadonlyMap<VariantId, VariantRow>,
  t: I18n,
  { differencesOnly = false } = {},
): CompareView {
  const columns = ids.map((id): CompareColumn => {
    const variant = byId.get(id) ?? null;
    return {
      id,
      variant,
      name: variant && variantName(variant),
      detail: variant && variantDetail(variant, t),
    };
  });
  const present = columns.flatMap((c) => (c.variant ? [c.variant] : []));
  const onlyDiffering = differencesOnly && present.length > 1;
  const groups: CompareGroup[] = [];
  for (const group of GROUPS) {
    const lines: CompareLine[] = [];
    for (const line of group.lines(t)) {
      const shown = present.map((v) => line.value(v, t));
      if (shown.every((s) => s === MISSING)) continue;
      const differs = new Set(shown).size > 1;
      if (onlyDiffering && !differs) continue;
      lines.push({
        id: line.id,
        label: line.label,
        values: columns.map((c) => (c.variant ? line.value(c.variant, t) : MISSING)),
        differs,
      });
    }
    if (lines.length) groups.push({ id: group.id, label: t.t(group.label), lines });
  }
  return { columns, groups };
}

/**
 * How the compare tray names a Variant, e.g. "Škoda Octavia IV · 110 kW · kombi · nafta ·
 * automatická". The generation name already carries the model name.
 */
export function variantLabel(v: VariantRow, t: I18n): string {
  return `${variantName(v)} · ${variantDetail(v, t)}`;
}

const variantName = (v: VariantRow) => `${v.make} ${v.generation}`;

const variantDetail = (v: VariantRow, t: I18n) =>
  [t.kw(v.powerKw), bodyLabel(v, t), t.label("fuel", v.fuel), gearbox(v, t)]
    .filter(Boolean)
    .join(" · ");

/** The Variant's transmissions, e.g. "manuální, automatická"; empty when the catalog has none. */
const gearbox = (v: VariantRow, t: I18n) =>
  (v.transmissions ?? []).map((g) => t.label("transmission", g)).join(", ");

/**
 * Fresh names for the listed `ids` the catalog still has, for
 * `siteStore().setCompare(ids, labels)` once a page has the catalog rows.
 */
export function compareLabels(
  ids: readonly VariantId[],
  rows: Iterable<VariantRow>,
): Record<VariantId, CompareLabel> {
  const wanted = new Set(ids);
  const labels: Record<VariantId, CompareLabel> = {};
  for (const v of rows) if (wanted.has(v.id)) labels[v.id] = variantLabels(v);
  return labels;
}

/** The Variant's label in every locale, for `siteStore().toggleCompare(id, label)`. */
export function variantLabels(v: VariantRow): CompareLabel {
  return Object.fromEntries(LANGS.map((lang) => [lang, variantLabel(v, i18n(lang))]));
}

// --- lines ----------------------------------------------------------------------------

interface LineSpec {
  id: string;
  label: string;
  value(v: VariantRow, t: I18n): string;
}

/** Line builder for one locale: `line(id, label key, value)`. */
const lineIn =
  (t: I18n) =>
  (id: string, label: MessageKey, value: LineSpec["value"]): LineSpec => ({
    id,
    label: t.t(label),
    value,
  });

const unit = (n: number | undefined, u: string, t: I18n, digits = 0) =>
  n === undefined ? MISSING : `${t.number(n, digits)} ${u}`;

/** "259 000 Kč" for a single value, "259 000 – 310 000 Kč" style for a range. */
const czkRange = (min: number | undefined, max: number | undefined, t: I18n) =>
  min === undefined || max === undefined || min === max
    ? t.czk(min ?? max)
    : `${t.czk(min)} – ${t.czk(max)}`;

const spread = (q: Quantiles | null | undefined, t: I18n) => czkRange(q?.p10, q?.p90, t);

const GROUPS: { id: string; label: MessageKey; lines(t: I18n): LineSpec[] }[] = [
  {
    id: "variant",
    label: "compare.group.variant",
    lines(t) {
      const line = lineIn(t);
      return [
        line("make", "facet.make", (v) => v.make),
        line("generation", "col.generation", (v) => v.generation),
        line("years", "facet.year", (v) => `${v.years.from}–${v.years.to ?? ""}`),
        line("body", "col.body", (v, t) => bodyLabel(v, t)),
        line("fuel", "col.fuel", (v, t) => t.label("fuel", v.fuel)),
        line("power", "col.power", (v, t) => t.kw(v.powerKw)),
        line("transmission", "col.transmission", (v, t) => gearbox(v, t) || MISSING),
        line("drive", "spec.drive", (v, t) => (v.drive ? t.label("drive", v.drive) : MISSING)),
      ];
    },
  },
  {
    id: "specs",
    label: "compare.group.specs",
    lines(t) {
      const line = lineIn(t);
      return [
        line("engineCc", "spec.engineCc", (v, t) => unit(v.engineCc, "cm³", t)),
        line("seats", "col.seats", (v, t) => t.number(v.seats)),
        line("doors", "spec.doors", (v, t) => t.number(v.doors)),
        line("euroClass", "spec.euroClass", (v) =>
          v.euroClass === undefined ? MISSING : `Euro ${v.euroClass}`,
        ),
        line("consumption", "col.consumption", (v, t) => t.l100(v.consumptionL100km)),
        line("consumptionKwh", "spec.consumptionKwh", (v, t) =>
          unit(v.consumptionKwh100km, "kWh/100\u00a0km", t, 1),
        ),
        line("co2", "spec.co2", (v, t) => unit(v.co2GKm, "g/km", t)),
        line("mass", "spec.mass", (v, t) => unit(v.massKg, "kg", t)),
        line("length", "spec.length", (v, t) => unit(v.lengthMm, "mm", t)),
      ];
    },
  },
  {
    id: "newPrice",
    label: "compare.group.newPrice",
    lines(t) {
      const line = lineIn(t);
      return [
        line("newPrice", "spec.newPrice", (v, t) =>
          czkRange(v.newPriceCzk?.min, v.newPriceCzk?.max, t),
        ),
        line("newPriceSource", "spec.newPriceSource", (v, t) =>
          v.newPriceCzk
            ? `${t.t(`newPrice.${v.newPriceCzk.source}`)} (${t.number(v.newPriceCzk.count)})`
            : MISSING,
        ),
      ];
    },
  },
  {
    id: "used",
    label: "compare.group.used",
    lines(t) {
      const line = lineIn(t);
      return [
        line("usedCount", "col.listings", (v, t) => t.number(v.used?.count ?? 0)),
        line("usedMedian", "spec.usedMedian", (v, t) => t.czk(v.used?.priceCzk?.median)),
        line("usedSpread", "spec.usedSpread", (v, t) => spread(v.used?.priceCzk, t)),
        ...MARKETS.map((market) => ({
          id: `usedMedian.${market}`,
          label: t.t("spec.marketMedian", { market: t.label("market", market) }),
          value: (v: VariantRow, t: I18n) => t.czk(v.used?.byMarket[market]?.median),
        })),
        line("landedMedian", "col.landedMedian", (v, t) => t.czk(v.used?.landedCzk?.median)),
        line("landedSpread", "spec.landedSpread", (v, t) => spread(v.used?.landedCzk, t)),
        line("odometerMedian", "spec.odometerMedian", (v, t) => t.km(v.used?.odometerKm?.median)),
        line("usedYears", "spec.usedYears", (v) => {
          const y = v.used?.years;
          return !y ? MISSING : y.min === y.max ? String(y.min) : `${y.min}–${y.max}`;
        }),
      ];
    },
  },
];
