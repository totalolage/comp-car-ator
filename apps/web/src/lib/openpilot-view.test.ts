import type { OpenpilotRow, VariantRow } from "@cca/bundle";
import { describe, expect, it } from "vitest";
import { openpilotBadge, openpilotSection, yearSpans } from "./openpilot-view.ts";

describe("model years", () => {
  it("compresses runs and keeps single years", () => {
    expect(yearSpans([2015, 2016, 2017, 2018, 2019, 2021])).toBe("2015–19, 2021");
    expect(yearSpans([2020])).toBe("2020");
    expect(yearSpans([2018, 2019, 2022, 2023])).toBe("2018–19, 2022–23");
    expect(yearSpans([1998, 1999, 2000, 2001])).toBe("1998–2001");
    expect(yearSpans([])).toBe("");
  });
});

describe("catalog row badge", () => {
  const variant = (openpilot?: VariantRow["openpilot"]) => ({ openpilot }) as VariantRow;

  it("marks comma-supported and community Variants, with the years in its title", () => {
    expect(openpilotBadge(variant({ level: "upstream", years: [2019, 2020, 2021] }), "en")).toEqual(
      {
        level: "upstream",
        text: "openpilot",
        title: "comma.ai openpilot: supported per comma's list, model years 2019–21",
      },
    );
    expect(openpilotBadge(variant({ level: "community", years: [2017] }), "cs")).toEqual({
      level: "community",
      text: "openpilot · komunita",
      title: "comma.ai openpilot: komunitní podpora podle seznamu comma, modelové roky 2017",
    });
  });

  it("gives no badge to other levels or unlisted Variants", () => {
    for (const level of ["custom", "underReview", "dashcam", "incompatible"] as const)
      expect(openpilotBadge(variant({ level, years: [2020] }), "cs")).toBeNull();
    expect(openpilotBadge(variant(), "cs")).toBeNull();
  });
});

describe("model page section", () => {
  const generations = [
    { id: "toyota/corolla/e210", name: "E210", from: 2018 },
    { id: "toyota/corolla/e170", name: "E170", from: 2013, to: 2019 },
  ];
  const row = (extra: Partial<OpenpilotRow>): OpenpilotRow => ({
    make: "Toyota",
    model: "Corolla Hybrid",
    years: [2020, 2021, 2022],
    level: "upstream",
    market: "US",
    url: "https://comma.ai/vehicles#toyota",
    generationIds: ["toyota/corolla/e210"],
    variantIds: [],
    ...extra,
  });

  it("states every detail the list gives, in the page's language", () => {
    const [entry] = openpilotSection(
      [
        row({
          package: "Toyota Safety Sense P",
          harness: "Toyota A",
          longitudinal: "openpilot",
          minSteerKmh: 0,
          minEnableKmh: 0,
          europe: true,
          market: "Europe",
        }),
      ],
      generations,
      "cs",
    ).entries;
    expect(entry).toEqual({
      level: "upstream",
      levelLabel: "Podporováno",
      title: "Toyota Corolla Hybrid 2020–22",
      facts: [
        { term: "Generace", value: "E210" },
        { term: "Výbava", value: "Toyota Safety Sense P" },
        { term: "Kabeláž", value: "Toyota A" },
        { term: "Podélné řízení", value: "openpilot řídí plyn a brzdy" },
        { term: "Řídí od", value: "0 km/h" },
        { term: "Zapíná se od", value: "0 km/h" },
      ],
      market: "comma uvádí pro evropský trh.",
      url: "https://comma.ai/vehicles#toyota",
    });
  });

  it("warns when the list does not name a market, and leaves out what it does not state", () => {
    const { entries, check, note } = openpilotSection(
      [
        row({ level: "community", longitudinal: "stock", minSteerKmh: 51 }),
        row({ europe: true, market: "Non-US", generationIds: [], longitudinal: "optional" }),
      ],
      generations,
      "en",
    );
    expect(entries.map((e) => [e.levelLabel, e.facts, e.market])).toEqual([
      [
        "Community",
        [
          { term: "Generations", value: "E210" },
          { term: "Longitudinal control", value: "stock ACC" },
          { term: "Steers from", value: "51 km/h" },
        ],
        "comma's list does not say which market this row is for (its default is the US); European versions can differ.",
      ],
      [
        "Supported",
        [{ term: "Longitudinal control", value: "optional (alpha)" }],
        "Listed by comma for markets outside the US.",
      ],
    ]);
    expect(check).toBe("Check on comma.ai");
    expect(note).toBe("Matched by model and model years; the car's package matters too.");
  });

  it("writes speeds in the page's number style", () => {
    const [entry] = openpilotSection([row({ minSteerKmh: 12.5 })], [], "cs").entries;
    expect(entry?.facts).toEqual([{ term: "Řídí od", value: "12,5 km/h" }]);
  });

  it("names an unknown market as the list gives it", () => {
    const [entry] = openpilotSection([row({ europe: true, market: "Nordics" })], [], "en").entries;
    expect(entry?.market).toBe("Listed by comma for the Nordics market.");
  });
});
