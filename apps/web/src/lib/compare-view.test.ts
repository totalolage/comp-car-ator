import type { UsedStats, VariantRow } from "@cca/bundle";
import { describe, expect, it } from "vitest";
import { i18n, MISSING } from "../i18n/i18n.ts";
import { compareLabels, compareView, variantLabel, variantLabels } from "./compare-view.ts";

const cs = i18n("cs");
const en = i18n("en");

const quantiles = (median: number) => ({
  count: 5,
  p10: median - 20_000,
  median,
  p90: median + 20_000,
});

function used(median: number): UsedStats {
  return {
    count: 5,
    priceCzk: quantiles(median),
    landedCzk: quantiles(median + 10_000),
    odometerKm: quantiles(90_000),
    byMarket: { CZ: quantiles(median) },
    years: { min: 2020, max: 2023 },
    markets: { CZ: 5 },
    sources: { sauto: 5 },
    groups: [],
  };
}

function variant(id: string, extra: Partial<VariantRow> = {}): VariantRow {
  return {
    id,
    makeId: "skoda",
    modelId: "skoda/octavia",
    generationId: "skoda/octavia/mk4",
    make: "Škoda",
    model: "Octavia",
    generation: "Octavia IV",
    years: { from: 2020 },
    body: "wagon",
    fuel: "diesel",
    powerKw: 110,
    transmissions: ["automatic"],
    seats: 5,
    newPriceCzk: { min: 800_000, max: 900_000, source: "list", count: 3 },
    used: used(600_000),
    ...extra,
  };
}

const index = (...rows: VariantRow[]) => new Map(rows.map((v) => [v.id, v]));

/** The line `id` of a view, by group-independent id. */
function line(view: ReturnType<typeof compareView>, id: string) {
  return view.groups.flatMap((g) => g.lines).find((l) => l.id === id);
}

describe("compare view", () => {
  const a = variant("a");
  const b = variant("b", { fuel: "petrol", powerKw: 85, drive: "awd" });

  it("keeps the order the Variants were added in", () => {
    const view = compareView(["b", "a"], index(a, b), cs);
    expect(view.columns.map((c) => c.id)).toEqual(["b", "a"]);
    expect(view.columns[0]).toMatchObject({
      name: "Škoda Octavia IV",
      detail: "85 kW · kombi · benzín · automatická",
    });
    expect(line(view, "power")?.values).toEqual(["85 kW", "110 kW"]);
  });

  it("marks the lines where the Variants differ, as printed", () => {
    const view = compareView(["a", "b"], index(a, b), cs);
    expect(line(view, "fuel")).toMatchObject({ values: ["nafta", "benzín"], differs: true });
    expect(line(view, "make")?.differs).toBe(false);
    expect(line(view, "newPrice")).toMatchObject({
      values: ["800 000 Kč – 900 000 Kč", "800 000 Kč – 900 000 Kč"],
      differs: false,
    });
    // A value one Variant lacks differs from one the other has.
    expect(line(view, "drive")).toMatchObject({ values: [MISSING, "4×4"], differs: true });
  });

  it("compares printed values, so amounts that round alike do not differ", () => {
    const c = variant("c", { consumptionL100km: 5.04 });
    const d = variant("d", { consumptionL100km: 4.96 });
    expect(line(compareView(["c", "d"], index(c, d), en), "consumption")).toMatchObject({
      values: ["5 l/100 km", "5 l/100 km"],
      differs: false,
    });
  });

  it("prints a Variant's transmissions as one list and drops them when unknown", () => {
    const both = variant("both", { transmissions: ["manual", "automatic"] });
    const unknown = variant("unknown", { transmissions: undefined });
    const view = compareView(["both", "a", "unknown"], index(both, a, unknown), cs);
    expect(line(view, "transmission")).toMatchObject({
      values: ["manuální, automatická", "automatická", MISSING],
      differs: true,
    });
    expect(view.columns[2]?.detail).toBe("110\u00a0kW · kombi · nafta");
  });

  it("leaves out lines no Variant has a value for", () => {
    const view = compareView(["a", "b"], index(a, b), cs);
    expect(line(view, "consumptionKwh")).toBeUndefined();
    expect(line(view, "usedMedian.DE")).toBeUndefined();
    expect(line(view, "usedMedian.CZ")?.label).toBe("Medián – Česko");
  });

  it("shows only the differences on request and drops groups left empty", () => {
    const view = compareView(["a", "b"], index(a, b), cs, { differencesOnly: true });
    expect(view.groups.map((g) => g.id)).toEqual(["variant"]);
    expect(view.groups[0]?.lines.map((l) => l.id)).toEqual(["fuel", "power", "drive"]);
    const same = compareView(["a", "a2"], index(a, variant("a2")), cs, { differencesOnly: true });
    expect(same.groups).toEqual([]);
    // Down to one Variant in the catalog, nothing can differ: show it whole.
    const one = compareView(["a", "gone"], index(a), cs, { differencesOnly: true });
    expect(line(one, "make")?.values).toEqual(["Škoda", MISSING]);
  });

  it("keeps an id the catalog no longer has as a stale column outside the comparison", () => {
    const view = compareView(["a", "gone/variant", "b"], index(a, b), en);
    expect(view.columns[1]).toEqual({
      id: "gone/variant",
      variant: null,
      name: null,
      detail: null,
    });
    expect(line(view, "fuel")).toMatchObject({
      values: ["diesel", MISSING, "petrol"],
      differs: true,
    });
    expect(line(view, "make")?.differs).toBe(false);
    // With one Variant left in the catalog nothing differs.
    const alone = compareView(["a", "gone/variant"], index(a), en);
    expect(alone.groups.flatMap((g) => g.lines).some((l) => l.differs)).toBe(false);
    expect(compareView(["gone/variant"], index(a), en).groups).toEqual([]);
  });

  it("names Variants in every locale for the remembered list", () => {
    expect(variantLabel(a, en)).toBe("Škoda Octavia IV · 110 kW · estate · diesel · automatic");
    expect(variantLabels(a)).toEqual({
      cs: "Škoda Octavia IV · 110 kW · kombi · nafta · automatická",
      en: "Škoda Octavia IV · 110 kW · estate · diesel · automatic",
    });
    expect(Object.keys(compareLabels(["b", "gone"], [a, b]))).toEqual(["b"]);
  });
});
