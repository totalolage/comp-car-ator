import { type Cassette, createReplayHttp, loadCassette } from "@cca/http";
import type { Observation, OpenpilotSupport } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestContext, type HarvestMode, silentLogger } from "../source.ts";
import { commaOpenpilotSource } from "./comma-openpilot.ts";

// Recorded 2026-10-28 from both CARS.md files, trimmed by hand to 24 list rows and 11 detail rows,
// with each brand's values.py from opendbc 8ceee62 trimmed to the platforms of those rows.
const fixture = new URL("./fixtures/list.cassette.json", import.meta.url);
const now = new Date("2026-10-28T22:00:00Z");

async function harvest(
  mode: HarvestMode,
  edit: (cassette: Cassette) => void = () => {},
): Promise<OpenpilotSupport[]> {
  const cassette = await loadCassette(fixture);
  edit(cassette);
  const ctx: HarvestContext = {
    http: createReplayHttp(cassette),
    mode,
    checkpoint: emptyCheckpoint,
    now,
    log: silentLogger,
    signal: new AbortController().signal,
  };
  const out: Observation[] = [];
  for await (const o of commaOpenpilotSource().harvest(ctx)) out.push(o);
  return out as OpenpilotSupport[];
}

/**
 * The fixture's Hyundai definitions with Tucson Diesel's cars under X and Kia Ceed's under Y,
 * then `after`.
 */
function swapped(after: string) {
  return (b: string) =>
    `X = [${DIESEL.trim().slice(0, -1)}]\nY = [HyundaiCarDocs("Kia Ceed Plug-in Hybrid 2021")]\n${after}\n${b
      .replace(DIESEL, "      *X,\n")
      .replace(/\[HyundaiCarDocs\("Kia Ceed Plug-in Hybrid 2021".*\],\n/, "Y,\n")}`;
}

/** Tucson Diesel's line in the fixture's Hyundai definitions. */
const DIESEL =
  '      HyundaiCarDocs("Hyundai Tucson Diesel 2019", car_parts=CarParts.common([CarHarness.hyundai_l])),\n';

function byRef(rows: OpenpilotSupport[], ref: string): OpenpilotSupport | undefined {
  return rows.find((row) => row.ref === ref);
}

/**
 * Rewrites the list file (`opendbc`), the details file (`openpilot`), one brand's platform
 * definitions (`hyundai`) or every brand's (`values.py`) in the cassette.
 */
function editBody(
  file: "opendbc" | "openpilot" | "hyundai" | "values.py",
  change: (body: string) => string,
) {
  const path =
    file === "values.py"
      ? "/values.py"
      : file === "hyundai"
        ? "/opendbc/car/hyundai/values.py"
        : `/${file}/master/docs/`;
  return (cassette: Cassette) => {
    for (const { request, response } of cassette.interactions) {
      if (request.url.includes(path)) response.body = change(response.body);
    }
  };
}

describe("comma-openpilot source", () => {
  it("full run yields every car on the list with its details", async () => {
    const rows = await harvest("full");
    expect(rows).toHaveLength(23);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(23);
    // comma's own robot has no model years and is not a car.
    expect(rows.some((r) => r.make === "comma")).toBe(false);

    expect(byRef(rows, "Toyota|Camry 2018-20|All")).toEqual({
      kind: "OpenpilotSupport",
      ref: "Toyota|Camry 2018-20|All",
      make: "Toyota",
      model: "Camry",
      years: [2018, 2019, 2020],
      platform: "TOYOTA_CAMRY",
      level: "upstream",
      market: "US",
      longitudinal: "stock",
      minEnableKmh: 0,
      minSteerKmh: 0,
      harness: "Toyota A connector",
      url: "https://comma.ai/vehicles#toyota",
    });
    // Not sold in the US: an unqualified row is a European car.
    expect(byRef(rows, "Škoda|Kodiaq 2017-23|Adaptive Cruise Control (ACC) & Lane Assist")).toEqual(
      {
        kind: "OpenpilotSupport",
        ref: "Škoda|Kodiaq 2017-23|Adaptive Cruise Control (ACC) & Lane Assist",
        make: "Škoda",
        model: "Kodiaq",
        years: [2017, 2018, 2019, 2020, 2021, 2022, 2023],
        platform: "SKODA_KODIAQ_MK1",
        level: "upstream",
        package: "Adaptive Cruise Control (ACC) & Lane Assist",
        market: "Europe",
        europe: true,
        longitudinal: "optional",
        minEnableKmh: 0,
        minSteerKmh: 0,
        harness: "VW J533 connector",
        url: "https://comma.ai/vehicles#škoda",
      },
    );
  });

  it("incremental run reads the whole list, like a full one", async () => {
    expect(await harvest("incremental")).toEqual(await harvest("full"));
  });

  it("takes the market out of the model name", async () => {
    const rows = await harvest("full");
    const market = (ref: string) => {
      const row = byRef(rows, ref);
      return row && { model: row.model, market: row.market, europe: row.europe };
    };
    expect(market("Hyundai|Ioniq 5 (Southeast Asia and Europe only) 2022-24|All")).toEqual({
      model: "Ioniq 5",
      market: "Southeast Asia and Europe",
      europe: true,
    });
    expect(
      market("Hyundai|Kona Electric (with HDA II, Korea only) 2023|Smart Cruise Control (SCC)"),
    ).toEqual({ model: "Kona Electric (with HDA II)", market: "Korea", europe: false });
    expect(market("Kia|Carnival (China only) 2023|Smart Cruise Control (SCC)")).toEqual({
      model: "Carnival",
      market: "China",
      europe: false,
    });
    expect(market("Toyota|Yaris (Non-US only) 2020, 2023|All")).toEqual({
      model: "Yaris",
      market: "Non-US",
      europe: true,
    });
    expect(market("Honda|Odyssey (Taiwan) 2018-19|Honda Sensing")).toEqual({
      model: "Odyssey",
      market: "Taiwan",
      europe: false,
    });
    // Other parentheses stay; an unqualified row refers to the US and says nothing of Europe.
    expect(market("Tesla|Model 3 (with HW4) 2024-25|All")).toEqual({
      model: "Model 3 (with HW4)",
      market: "US",
      europe: undefined,
    });
  });

  it("maps support levels, years, packages and fuel", async () => {
    const rows = await harvest("full");
    const pick = (ref: string) => {
      const row = byRef(rows, ref);
      return row && { level: row.level, years: row.years, package: row.package, fuel: row.fuel };
    };
    expect(pick("Toyota|Yaris (Non-US only) 2020, 2023|All")).toEqual({
      level: "custom",
      years: [2020, 2023],
      package: undefined,
      fuel: undefined,
    });
    expect(pick("Acura|RDX 2022-24|All")?.level).toBe("dashcam");
    expect(pick("Acura|Integra 2023-25|All")?.level).toBe("community");
    // Both "Not compatible" anchors (#flexray, #can-bus-security).
    expect(pick("Audi|A4 2016-24|All")?.level).toBe("incompatible");
    expect(pick("Acura|ZDX 2024|All")?.level).toBe("incompatible");
    expect(pick("Honda|Odyssey (Taiwan) 2018-19|Honda Sensing")?.package).toBe("Honda Sensing");

    const fuel = (ref: string) => byRef(rows, ref)?.fuel;
    expect(fuel("Toyota|RAV4 Hybrid 2019-21|All")).toBe("hev");
    expect(fuel("Toyota|Prius Prime 2017-20|All")).toBe("phev");
    expect(fuel("Kia|Ceed Plug-in Hybrid 2021|Smart Cruise Control (SCC)")).toBe("phev");
    expect(fuel("Hyundai|Tucson Diesel 2019|Smart Cruise Control (SCC)")).toBe("diesel");
    expect(fuel("Volkswagen|Golf GTE 2015-20|Adaptive Cruise Control (ACC) & Lane Assist")).toBe(
      "phev",
    );
    expect(fuel("MG|5 EV 2021|All")).toBe("bev");
    expect(
      fuel("Hyundai|Kona Electric (with HDA II, Korea only) 2023|Smart Cruise Control (SCC)"),
    ).toBe("bev");
    expect(
      fuel("Audi|A3 Sportback e-tron 2017-18|Adaptive Cruise Control (ACC) & Lane Assist"),
    ).toBeUndefined();
  });

  it("joins details only on the exact make, model and package", async () => {
    const rows = await harvest("full");
    // The details file footnotes this package cell: "All[<sup>7</sup>](#footnotes)".
    expect(byRef(rows, "Subaru|Ascent 2019-21|All")).toMatchObject({
      longitudinal: "stock",
      harness: "Subaru A connector",
    });
    // The details file only has "Pilot 2023-25": no fuzzy match.
    const pilot = byRef(rows, "Honda|Pilot 2026|All");
    expect(pilot?.level).toBe("upstream");
    expect(pilot?.longitudinal).toBeUndefined();
    expect(pilot?.harness).toBeUndefined();
    // Speeds in km/h: 19 mph.
    expect(byRef(rows, "Honda|Odyssey (Taiwan) 2018-19|Honda Sensing")).toMatchObject({
      minEnableKmh: 31,
      minSteerKmh: 0,
    });
  });

  it("names each car's platform from opendbc's definitions", async () => {
    const platform = (rows: OpenpilotSupport[], ref: string) => byRef(rows, ref)?.platform;
    const rows = await harvest("full");
    expect(platform(rows, "Hyundai|Tucson Diesel 2019|Smart Cruise Control (SCC)")).toBe(
      "HYUNDAI_TUCSON",
    );
    expect(platform(rows, "Hyundai|Ioniq 5 (Southeast Asia and Europe only) 2022-24|All")).toBe(
      "HYUNDAI_IONIQ_5",
    );
    // Ford defines "Ford Kuga 2020-23" with plug_in_hybrid=True.
    expect(
      platform(
        rows,
        "Ford|Kuga Plug-in Hybrid 2020-23|Adaptive Cruise Control with Lane Centering",
      ),
    ).toBe("FORD_ESCAPE_MK4");
    // Defined outside the brands' platforms.
    expect(platform(rows, "Acura|Integra 2023-25|All")).toBeUndefined();
    expect(platform(rows, "Audi|A4 2016-24|All")).toBeUndefined();

    // A car two platforms claim is neither's, and an upstream car without one fails the run.
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) =>
          b.replace(
            "  HYUNDAI_IONIQ_5 = HyundaiCanFDPlatformConfig(\n    [",
            '  HYUNDAI_IONIQ_5 = HyundaiCanFDPlatformConfig(\n    [\n      HyundaiCarDocs("Hyundai Tucson Diesel 2019"),',
          ),
        ),
      ),
    ).rejects.toThrow(
      /1 upstream or dashcam cars have no platform: Hyundai\|Tucson Diesel 2019\|Smart Cruise Control \(SCC\)$/,
    );
  });

  it("reads two platforms on one line as two", async () => {
    const rows = await harvest(
      "full",
      editBody("hyundai", (b) =>
        b.replace(/\n\s*\)\n\s*HYUNDAI_TUCSON = /, "\n  ); HYUNDAI_TUCSON = "),
      ),
    );
    expect(byRef(rows, "Hyundai|Tucson Diesel 2019|Smart Cruise Control (SCC)")?.platform).toBe(
      "HYUNDAI_TUCSON",
    );
  });

  it("reads cars the file holds under names, as Python does", async () => {
    const rows = await harvest("full");
    const forms: ((body: string) => string)[] = [
      // A car under a name (a helper constant).
      (b) =>
        `TUCSON_DIESEL_2019 = ${DIESEL.trim().slice(0, -1)}\n\n${b.replace(DIESEL, "      TUCSON_DIESEL_2019,\n")}`,
      // A list under a name, and one spread into another.
      (b) =>
        `TUCSON_DIESEL = [${DIESEL.trim()}]\nTUCSON_CARS: list = [*TUCSON_DIESEL]\n${b
          .replace(DIESEL, "")
          .replace(
            'HyundaiPlatformConfig(\n    [\n      HyundaiCarDocs("Hyundai Tucson 2021"',
            'HyundaiPlatformConfig(\n    [\n      *TUCSON_CARS,\n      HyundaiCarDocs("Hyundai Tucson 2021"',
          )}`,
      // Two platforms' cars under names.
      swapped(""),
      // Cars and specs by keyword.
      (b) =>
        b
          .replace(
            "KIA_CEED_PHEV = HyundaiPlatformConfig(\n    [",
            "KIA_CEED_PHEV = HyundaiPlatformConfig(\n    car_docs=[",
          )
          .replace("    CarSpecs(mass=1450", "    specs=CarSpecs(mass=1450"),
      // A class header over lines, a bare annotation, a comment at the left margin, a platform
      // that overrides another with no cars of its own.
      (b) =>
        b
          .replace(
            "class CAR(Platforms):\n",
            "class CAR(\n  Platforms,\n):\n  config: HyundaiPlatformConfig\n",
          )
          .replace("  HYUNDAI_TUCSON = ", "# Tucson\n  HYUNDAI_TUCSON = ")
          .replace(
            "  HYUNDAI_IONIQ_5 = ",
            "  HYUNDAI_TUCSON_IC = HYUNDAI_TUCSON.override(car_docs=[])\n  HYUNDAI_IONIQ_5 = ",
          ),
    ];
    for (const form of forms)
      expect(await harvest("full", editBody("hyundai", form))).toEqual(rows);
  });

  it("fails on definitions it cannot read rather than drop their cars", async () => {
    const fails = (change: (body: string) => string) =>
      expect(harvest("full", editBody("hyundai", change))).rejects;
    const named = (top: string) => (b: string) =>
      `${top}\n${b.replace(DIESEL, "      TUCSON_DIESEL_2019,\n")}`;
    // A car from another file, a helper's, a name assigned twice.
    await fails(named("from .tucson import TUCSON_DIESEL_2019")).toThrow(
      /unreadable cars of HYUNDAI_TUCSON in .*hyundai\/values\.py/,
    );
    await fails(named("def TUCSON_DIESEL_2019():\n  return HyundaiCarDocs('x')")).toThrow(
      /unreadable cars of HYUNDAI_TUCSON/,
    );
    await fails(
      named("TUCSON_DIESEL_2019 = HyundaiCarDocs('a')\nTUCSON_DIESEL_2019 = HyundaiCarDocs('b')"),
    ).toThrow(/unreadable cars of HYUNDAI_TUCSON/);
    // Cars built by a call or `+`, an override that keeps its platform's cars.
    await fails((b) => b.replace(DIESEL, "      *tucson_cars(),\n")).toThrow(
      /unreadable cars of HYUNDAI_TUCSON/,
    );
    await fails((b) => b.replace(/(Diesel 2019.*\n\s*\])/, "$1 + EXTRA")).toThrow(
      /unreadable cars of HYUNDAI_TUCSON/,
    );
    await fails((b) =>
      b.replace(
        "  HYUNDAI_IONIQ_5 = ",
        "  HYUNDAI_TUCSON_IC = HYUNDAI_TUCSON.override(flags=0)\n  HYUNDAI_IONIQ_5 = ",
      ),
    ).toThrow(/unreadable cars of HYUNDAI_TUCSON_IC/);
    // Names whose cars change after they are assigned, a config call that goes on.
    await fails(swapped("X, Y = Y, X")).toThrow(/cars under X, which the file uses elsewhere, in .*hyundai\/values\.py/);
    await fails(swapped("X += []")).toThrow(/cars under X, which the file uses elsewhere/);
    await fails((b) =>
      b.replace("HyundaiFlags.HYBRID,\n  )", "HyundaiFlags.HYBRID,\n  ).override(car_docs=[])"),
    ).toThrow(/unreadable member of class CAR .*: KIA_CEED_PHEV$/);
    // A car outside the platform's cars.
    await fails((b) =>
      b
        .replace(DIESEL, "")
        .replace("    ],\n    CarSpecs(mass=3520", `    ],\n${DIESEL}    CarSpecs(mass=3520`),
    ).toThrow(/a car outside the cars of HYUNDAI_TUCSON/);
    // A platform from another file or module, one from a qualified config.
    const TUCSON = / {2}HYUNDAI_TUCSON = [\s\S]*?\n {2}\)\n/;
    await fails((b) =>
      b.replace(TUCSON, "  from .tucson_platform import HYUNDAI_TUCSON\n"),
    ).toThrow(
      /unreadable member of class CAR in .*hyundai\/values\.py: from \.tucson_platform import HYUNDAI_TUCSON$/,
    );
    await fails((b) => b.replace(TUCSON, "  HYUNDAI_TUCSON = tucson.HYUNDAI_TUCSON\n")).toThrow(
      /unreadable member of class CAR .*: HYUNDAI_TUCSON = tucson\.HYUNDAI_TUCSON$/,
    );
    await fails((b) =>
      b.replace(
        "HYUNDAI_IONIQ_5 = HyundaiCanFDPlatformConfig(",
        "HYUNDAI_IONIQ_5 = configs.HyundaiCanFDPlatformConfig(",
      ),
    ).toThrow(/unreadable member of class CAR .*: HYUNDAI_IONIQ_5 = configs\./);
  });

  it("reads platforms however the definitions are indented, wrapped or quoted", async () => {
    const reformatted = await harvest(
      "full",
      editBody("values.py", (b) =>
        b
          // Four spaces per level, a car's name on its own line, single quotes, a type.
          .replace(/^( +)/gm, (indent) => indent + indent)
          .replace(/^(\s*\w*CarDocs\w*\()"([^"]*)"/gm, "$1\n            '$2'")
          .replace("HYUNDAI_TUCSON = ", "HYUNDAI_TUCSON: HyundaiPlatformConfig = ")
          // A comment before a name, a name split in two literals, a raw string.
          .replace(
            "CarDocs(\n            'Toyota Camry",
            "CarDocs(  # 8th gen\n            'Toyota Camry",
          )
          .replace("'Hyundai Tucson Diesel 2019'", "'Hyundai Tucson' ' Diesel 2019'")
          .replace("'Kia Ceed Plug-in Hybrid 2021'", "r'Kia Ceed Plug-in Hybrid 2021'")
          .replace("'Toyota RAV4 Hybrid 2019-21'", '"""Toyota RAV4 Hybrid 2019-21"""'),
      ),
    );
    const tabs = await harvest(
      "full",
      editBody("values.py", (b) =>
        b.replace(/^( +)/gm, (indent) => "\t".repeat(indent.length / 2)),
      ),
    );
    const rows = await harvest("full");
    expect(rows.filter((r) => r.platform)).toHaveLength(20);
    expect(reformatted).toEqual(rows);
    expect(tabs).toEqual(rows);
  });

  it("fails rather than drop the platforms of a brand, a make or a car", async () => {
    // No platforms at all, or cars under another name.
    await expect(
      harvest(
        "full",
        editBody("values.py", (b) =>
          b.replace(/^class CAR\(Platforms\):[\s\S]*/m, "class CAR(Platforms):\n  pass\n"),
        ),
      ),
    ).rejects.toThrow(/unreadable member of class CAR in .*: pass$/);
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) => b.replaceAll("CarDocs(", "CarInfo(")),
      ),
    ).rejects.toThrow(/unreadable cars of HYUNDAI_KONA_EV_2ND_GEN in .*hyundai\/values\.py/);
    // Cars the list names otherwise.
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) => b.replaceAll('CarDocs("Hyundai ', 'CarDocs("HYUNDAI ')),
      ),
    ).rejects.toThrow(/3 upstream or dashcam cars have no platform: Hyundai\|/);
    // A make no brand's definitions are read for.
    await expect(
      harvest(
        "full",
        editBody("opendbc", (b) => b.replace("|Subaru|Ascent", "|Volvo|Ascent")),
      ),
    ).rejects.toThrow(/no platform definitions for Volvo\|Ascent 2019-21\|All/);
    // Every platform read as one.
    await expect(
      harvest(
        "full",
        editBody("values.py", (b) =>
          b.replace(/^(\s+)[A-Z][A-Z0-9_]* = (\w+PlatformConfig\()/gm, "$1CAR = $2"),
        ),
      ),
    ).rejects.toThrow(/CAR twice in .*\/values\.py/);
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) => b.replace("HyundaiPlatformConfig(", "HyundaiPlatformConfig((")),
      ),
    ).rejects.toThrow(/unbalanced brackets in .*hyundai\/values\.py/);
    // A car whose name is not a string literal.
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) =>
          b.replace('CarDocs("Hyundai Tucson 2021"', "CarDocs(TUCSON_NAME"),
        ),
      ),
    ).rejects.toThrow(/unreadable car name in HYUNDAI_TUCSON in .*hyundai\/values\.py/);
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) =>
          b.replace('CarDocs("Hyundai Tucson 2021"', 'CarDocs("Hyundai " + TUCSON'),
        ),
      ),
    ).rejects.toThrow(/unreadable car name in HYUNDAI_TUCSON/);
  });

  it("fails on platform definitions without their platform class", async () => {
    await expect(
      harvest(
        "full",
        editBody("hyundai", (b) => b.replace("class CAR(Platforms):", "class Car(Platforms):")),
      ),
    ).rejects.toThrow(/no platform class in .*hyundai\/values\.py/);
  });

  it("links a make's section of comma.ai/vehicles only when it lists the make", async () => {
    const rows = await harvest("full");
    // comma.ai/vehicles shows makes with an upstream car; BYD has none.
    expect(byRef(rows, "BYD|Atto 3 2022-25|All")?.url).toBe("https://comma.ai/vehicles");
    expect(byRef(rows, "Kia|Carnival (China only) 2023|Smart Cruise Control (SCC)")?.url).toBe(
      "https://comma.ai/vehicles#kia",
    );
  });

  it("fails on a changed table header", async () => {
    await expect(
      harvest(
        "full",
        editBody("opendbc", (b) => b.replace("|Support Level|", "|Support|")),
      ),
    ).rejects.toThrow(/table header changed/);
    await expect(
      harvest(
        "full",
        editBody("openpilot", (b) => b.replace("|No ALC below|", "|No ALC under|")),
      ),
    ).rejects.toThrow(/table header changed/);
  });

  it("maps a car under review", async () => {
    const rows = await harvest(
      "full",
      editBody("opendbc", (b) => b.replace("[Dashcam mode](#dashcam)", "[Under review](#dashcam)")),
    );
    expect(byRef(rows, "Acura|RDX 2022-24|All")?.level).toBe("underReview");
  });

  it("fails on an unknown support level", async () => {
    await expect(
      harvest(
        "full",
        editBody("opendbc", (b) => b.replace("[Dashcam mode](#dashcam)", "[Beta](#beta)")),
      ),
    ).rejects.toThrow(/unknown support level/);
  });

  it("fails when a table has fewer cars than its file declares", async () => {
    await expect(
      harvest(
        "full",
        editBody("opendbc", (b) => b.replace(/^\|Toyota\|Camry 2018-20\|.*\n/m, "")),
      ),
    ).rejects.toThrow(/24 cars declared, 23 rows/);
    // A blank line cuts the details table short.
    await expect(
      harvest(
        "full",
        editBody("openpilot", (b) =>
          b.replace("\n|Toyota|Camry 2018-20|", "\n\n|Toyota|Camry 2018-20|"),
        ),
      ),
    ).rejects.toThrow(/11 cars declared, 8 rows/);
  });
});
