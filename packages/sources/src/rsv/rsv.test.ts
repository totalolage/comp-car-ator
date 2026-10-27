import { Readable } from "node:stream";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import { type Cassette, createReplayHttp, type Http, loadCassette, type Page } from "@cca/http";
import { type CatalogEntry, type Observation, variantIdOf } from "@cca/vocabulary";
import { describe, expect, it } from "vitest";
import { emptyCheckpoint, type HarvestMode, type Logger } from "../source.ts";
import { RSV_SITE, type RsvOptions, rsvSource } from "./rsv.ts";
import { unzipFirst } from "./unzip.ts";

// The site's page, its reports API and the export ZIP of 2026-10-01, with real register rows
// (identifiers blanked; 1 in 50 vehicles of a few models) plus three broken rows, and the
// Wikidata generations of those models; recorded 2026-10-25.
const fixture = new URL("./fixtures/register.cassette.json", import.meta.url);
const now = new Date("2026-10-25T12:00:00Z");
const options: RsvOptions = { minVehicles: 2 };

interface Run {
  entries: CatalogEntry[];
  logs: { message: string; data?: Record<string, unknown> }[];
}

async function harvest(
  http: Http,
  mode: HarvestMode = "full",
  lastRunAt: Date | null = null,
  opts: RsvOptions = options,
): Promise<Run> {
  const logs: Run["logs"] = [];
  const log: Logger = {
    info: (message, data) => logs.push({ message, data }),
    warn: (message, data) => logs.push({ message, data }),
  };
  const entries: CatalogEntry[] = [];
  for await (const o of rsvSource(opts).harvest({
    http,
    mode,
    checkpoint: { ...emptyCheckpoint, lastRunAt },
    now,
    log,
    signal: new AbortController().signal,
  }) as AsyncIterable<Observation>) {
    expect(o.kind).toBe("CatalogEntry");
    entries.push(o as CatalogEntry);
  }
  return { entries, logs };
}

const cassette = () => loadCassette(fixture);
const replay = async (edit?: (c: Cassette) => void) => {
  const c = await cassette();
  edit?.(c);
  return createReplayHttp(c);
};

const variantsOf = (entries: CatalogEntry[], make: string, model: string) =>
  entries.map((e) => e.variant).filter((v) => v.make === make && v.model === model);

describe("rsv source", () => {
  it("builds Variants from the register's passenger cars", async () => {
    const { entries } = await harvest(await replay());
    expect(entries.length).toBeGreaterThan(20);
    const makes = new Set(entries.map((e) => e.variant.make));
    for (const make of ["Škoda", "Volkswagen", "Mercedes-Benz", "BMW", "Hyundai", "Toyota"]) {
      expect(makes).toContain(make);
    }
    for (const e of entries) {
      expect(e.variant.transmissions).toBeUndefined();
      expect(e.variant.years.from).toBeGreaterThanOrEqual(2000);
      expect(e.variant.powerKw).toBeGreaterThan(0);
    }
    expect(variantsOf(entries, "Škoda", "Octavia").length).toBeGreaterThan(3);
  });

  it("makes generations of type-approval types, named by Wikidata where it dates them", async () => {
    const { entries } = await harvest(await replay());
    const generations = new Map(
      entries.map((e) => [`${e.variant.model}/${e.variant.generation.slug}`, e.variant.generation]),
    );
    // Wikidata dates Octavia II and Golf IV, not Octavia I; a dated generation is keyed by
    // Wikidata's word for it, an undated type by its code.
    expect(generations.get("Octavia/mk2")).toMatchObject({
      name: "Octavia II (Mk2, 1Z)",
      from: 2004,
    });
    expect(generations.get("Octavia/1u")?.name).toBe("Octavia 1U");
    expect(generations.get("Golf/mk4")?.name).toBe("Golf IV (Mk4, 1J)");
    // VW kept type 1K for Golf V (2003-2009) and VI (2008-2012) and type 3C for Passat B6
    // (2005-2010) and B7 (2010-2015): split by production year, overlap years left out.
    expect(generations.get("Golf/mk5")).toMatchObject({ name: "Golf V (Mk5, 1K)", to: 2007 });
    expect(generations.get("Golf/mk6")).toMatchObject({ name: "Golf VI (Mk6, 1K)", from: 2011 });
    expect(generations.get("Passat/b6")).toMatchObject({ name: "Passat B6 (3C)", to: 2009 });
    expect(generations.get("Passat/b7")).toMatchObject({ name: "Passat B7 (3C)", from: 2011 });
    expect([...generations.keys()].filter((k) => /^(Golf\/1k|Passat\/3c)/.test(k))).toEqual([]);
    // The B5's run-out registrations (type 3BG, 2004-2005) are not the B6.
    expect(generations.get("Passat/3bg")?.name).toBe("Passat 3BG");
    // Mercedes-Benz types are model series; listings write the chassis code.
    expect(generations.get("C-Class/203")?.name).toBe("C-Class W203");
    // BMW body letters (346L sedan, 346C coupé) are one type.
    expect([...generations.keys()].filter((k) => k.startsWith("3 Series/"))).toEqual(
      expect.arrayContaining(["3 Series/346", "3 Series/390"]),
    );
    expect([...generations.keys()].some((k) => /^3 Series\/346[a-z]$/.test(k))).toBe(false);
  });

  it("leaves out Specs and years it cannot place in one Generation", async () => {
    const { entries, logs } = await harvest(await replay());
    const read = logs.find((l) => l.message === "rsv export read")?.data;
    // Golf 1K vehicles of 2008-2009 fall in both Golf V's and VI's years.
    expect(read?.omittedVehicles).toBeGreaterThanOrEqual(11);
    const variant = (model: string, slug: string, body: string, kw: number) =>
      variantsOf(entries, "Volkswagen", model).find(
        (v) =>
          v.generation.slug === slug && v.body === body && v.fuel === "diesel" && v.powerKw === kw,
      );
    // Golf 1K diesels of 77 kW: V's are the 1.9 TDI, VI's (all from 2011) the 1.6 TDI.
    expect(variant("Golf", "mk5", "hatchback", 77)).toMatchObject({ engineCc: 1896 });
    expect(variant("Golf", "mk6", "wagon", 77)).toMatchObject({ engineCc: 1598 });
    // Passat 3C wagons of 103 kW were built as B6 and B7; their Spec counters cannot be split.
    for (const slug of ["b6", "b7"]) {
      const v = variant("Passat", slug, "wagon", 103);
      expect(v).toBeDefined();
      expect([v?.engineCc, v?.seats, v?.massKg]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("keys Variants by evidence that does not flip as counts change between exports", async () => {
    const { header, row } = await realRow();
    const ids = async (oneZ: number, zz: number, bindings: unknown[] = []) => {
      const rows = [...Array(oneZ).fill(row), ...Array(zz).fill(row.replace(",1Z,", ",ZZ,"))];
      const http = syntheticHttp(header, rows.join("\r\n"), 1, bindings);
      const { entries } = await harvest(http, "full", null, { minVehicles: 1 });
      return entries.map((e) => variantIdOf(e.variant));
    };
    // Without Wikidata each type is its own Generation, keyed by its code either way.
    const byType = await ids(6, 5);
    expect(byType).toHaveLength(2);
    expect(await ids(5, 6)).toEqual(byType);
    // Types that start as one dated generation are one, whichever has more vehicles.
    const { entries } = await harvest(syntheticHttp(header, row, 1), "full", null, {
      minVehicles: 1,
    });
    const year = entries[0]?.variant.years.from as number;
    const octaviaII = {
      modelLabel: { value: "Škoda Octavia" },
      genLabel: { value: "Škoda Octavia II" },
      from: { value: String(year - 1) },
    };
    const dated = await ids(6, 5, [octaviaII]);
    expect(dated).toEqual([expect.stringMatching(/^skoda\/octavia\/mk2\//)]);
    expect(await ids(5, 6, [octaviaII])).toEqual(dated);
  });

  it("leaves a type's years to a later generation another type starts as", async () => {
    const { header, row } = await realRow();
    const yearAt = header.split(",").indexOf("Rok výroby");
    expect(yearAt).toBeGreaterThan(0);
    const vehicle = (type: string, year: number) => {
      const fields = row.replace(",1Z,", `,${type},`).split(",");
      fields[yearAt] = String(year);
      return fields.join(",");
    };
    // Type AA starts as Octavia II (2004-2010), type BB as Octavia III (2009-).
    const rows = [
      ...[2005, 2006, 2009, 2010, 2011].flatMap((y) => [vehicle("AA", y), vehicle("AA", y)]),
      ...[2009, 2010, 2011].flatMap((y) => [vehicle("BB", y), vehicle("BB", y)]),
    ];
    const generation = (label: string, from: number, to?: number) => ({
      modelLabel: { value: "Škoda Octavia" },
      genLabel: { value: `Škoda Octavia ${label}` },
      from: { value: String(from) },
      ...(to ? { to: { value: String(to) } } : {}),
    });
    const http = syntheticHttp(header, rows.join("\r\n"), 1, [
      generation("II", 2004, 2010),
      generation("III", 2009),
    ]);
    const { entries, logs } = await harvest(http, "full", null, { minVehicles: 1 });
    const years = (slug: string) =>
      entries.filter((e) => e.variant.generation.slug === slug).map((e) => e.variant.years);
    // AA's 2009-2011 vehicles are in III's years too (III is BB's), BB's 2009-2010 in II's:
    // all left out.
    expect(years("mk2")).toEqual([{ from: 2005, to: 2006 }]);
    expect(years("mk3")).toEqual([{ from: 2011, to: 2011 }]);
    expect(logs.find((l) => l.message === "rsv export read")?.data?.omittedVehicles).toBe(10);

    // Without II's end, III's start still takes AA's later years away, but II no longer
    // contests BB's.
    const open = await harvest(
      syntheticHttp(header, rows.join("\r\n"), 1, [
        generation("II", 2004),
        generation("III", 2009),
      ]),
      "full",
      null,
      { minVehicles: 1 },
    );
    const openYears = (slug: string) =>
      open.entries.filter((e) => e.variant.generation.slug === slug).map((e) => e.variant.years);
    expect(openYears("mk2")).toEqual([{ from: 2005, to: 2006 }]);
    expect(openYears("mk3")).toEqual([{ from: 2009, to: 2011 }]);
  });

  it("keeps models apart that share a type, whichever has more vehicles", async () => {
    const { header, row } = await realRow();
    const car = (make: string, name: string, type: string) =>
      withColumns(header, row, {
        "Tovární značka": make,
        "Obchodní označení": name,
        "Typ kód": type,
      });
    const modelsOf = async (rows: string[]) => {
      const http = syntheticHttp(header, rows.join("\r\n"), 1);
      const { entries } = await harvest(http, "full", null, { minVehicles: 1 });
      const models = new Map<string, Set<string>>();
      for (const { variant: v } of entries) {
        models.set(v.model, (models.get(v.model) ?? new Set()).add(v.generation.slug));
      }
      return Object.fromEntries([...models].map(([m, s]) => [m, [...s].sort()]));
    };
    // A Tiguan Allspace approved as a Tiguan: the type cannot tell them apart, nor can counts.
    for (const [tiguans, allspaces] of [
      [6, 4],
      [4, 6],
    ] as const) {
      expect(
        await modelsOf([
          ...Array(tiguans).fill(car("VOLKSWAGEN", "TIGUAN", "5N")),
          ...Array(allspaces).fill(car("VOLKSWAGEN", "TIGUAN ALLSPACE", "5N")),
        ]),
      ).toEqual({ Tiguan: ["5n"], "Tiguan Allspace": ["5n"] });
    }
    // A few "RANGE ROVER" rows of the Sport's type stay what the register says; neither name
    // takes the other's vehicles. Badges fold into the model on its types ("EVOQUE HSE
    // DYNAMIC", "XC90 D4"), not on a type of their own ("IONIQ 5"), and a lone digit is no badge
    // ("QASHQAI +2"); trim words go per row.
    expect(
      await modelsOf([
        ...Array(6).fill(car("LAND ROVER", "RANGE ROVER", "LG")),
        ...Array(2).fill(car("LAND ROVER", "RANGE ROVER", "LW")),
        ...Array(5).fill(car("LAND ROVER", "RANGE ROVER SPORT", "LW")),
        ...Array(4).fill(car("LAND ROVER", "RANGE ROVER VELAR", "LY")),
        ...Array(3).fill(car("LAND ROVER", "RANGE ROVER EVOQUE", "LV")),
        car("LAND ROVER", "RANGE ROVER", "LV"),
        car("LAND ROVER", "RANGE ROVER EVOQUE HSE DYNAMIC", "LV"),
        ...Array(3).fill(car("VOLVO", "XC90", "L")),
        ...Array(2).fill(car("VOLVO", "XC90 D4", "L")),
        ...Array(3).fill(car("HYUNDAI", "IONIQ", "AE")),
        ...Array(2).fill(car("HYUNDAI", "IONIQ 5", "NE")),
        ...Array(3).fill(car("NISSAN", "QASHQAI", "J10")),
        ...Array(2).fill(car("NISSAN", "QASHQAI +2", "J10")),
        ...Array(3).fill(car("ŠKODA", "OCTAVIA", "NX")),
        ...Array(2).fill(car("ŠKODA", "OCTAVIA SCOUT", "NX")),
      ]),
    ).toEqual({
      "Range Rover": ["lg", "lv", "lw"],
      "Range Rover Sport": ["lw"],
      "Range Rover Velar": ["ly"],
      "Range Rover Evoque": ["lv"],
      XC90: ["l"],
      Ioniq: ["ae"],
      "Ioniq 5": ["ne"],
      Qashqai: ["j10"],
      "Qashqai +2": ["j10"],
      Octavia: ["nx"],
    });
  });

  it("names the make, not the company or model the register's make field holds", async () => {
    expect(
      await namesOf([
        ["ŠKODA AUTO A.S.", "OCTAVIA"],
        ["ŠKODA OCTAVIA", "OCTAVIA COMBI"],
        ["VW GOLF", "GOLF"],
        ["FORD-CNG-TECHNIK", "FOCUS"],
        ["MINI COOPER", "COOPER"],
        ["TESLA MOTORS", "MODEL S"],
        ["AUTOMOBILI LAMBORGHINI S.P.A.", "HURACAN"],
        ["JAGUAR LAND ROVER LIMITED", "RANGE ROVER SPORT"],
        ["JAGUAR LAND ROVER LIMITED", "F-PACE"],
        ["MICRO COMPACT CAR SMART", "SMART FORTWO"],
        ["QUATTRO", "AUDI RS4"],
        ["LADA - VAZ", "NIVA"],
        ["MARUTI-SUZUKI", "ALTO"],
        ["DAIMLER CHRYSLER", "A 170"],
        ["GM DAEWOO", "KALOS"],
        // A make followed by another make is a company of both: left as it is.
        ["BMW ALPINA", "B3"],
        ["HONDA ACURA", "MDX"],
        // A company of several makes whose model word decides none.
        ["DAIMLER CHRYSLER", "GRAND CHEROKEE"],
      ]),
    ).toEqual([
      "Škoda|Octavia",
      "Škoda|Octavia",
      "Volkswagen|Golf",
      "Ford|Focus",
      "Mini|Cooper",
      "Tesla|Model S",
      "Lamborghini|Huracan",
      "Land Rover|Range Rover Sport",
      "Jaguar|F-Pace",
      "Smart|Fortwo",
      "Audi|RS4",
      "Lada|Niva",
      "Suzuki|Alto",
      "Mercedes-Benz|A-Class",
      "Daewoo|Kalos",
      "BMW Alpina|B3",
      "Honda Acura|MDX",
      "Daimler Chrysler|Grand Cherokee",
    ]);
  });

  it("names one model one way, without engine, power and trim words", async () => {
    const cases: [string, string, string][] = [
      ["BMW", "3", "BMW|3 Series"],
      ["BMW", "RADA 3", "BMW|3 Series"],
      ["BMW", "3 ER REIHE", "BMW|3 Series"],
      ["BMW", "M 135 I", "BMW|1 Series"],
      ["BMW", "X 5", "BMW|X5"],
      ["BMW", "X5 M", "BMW|X5 M"],
      ["BMW", "X3 20D", "BMW|X3"],
      ["BMW", "I4 EDRIVE35", "BMW|i4"],
      ["BMW", "IX XDRIVE40", "BMW|iX"],
      ["AUDI", "Q4 35 E-TRON", "Audi|Q4 e-tron"],
      ["AUDI", "Q4 SPORTBACK 40 E-TRON", "Audi|Q4 Sportback e-tron"],
      // Audi lists the S model next to the base model: which one a vehicle is stays open.
      ["AUDI", "A3, S3", "Audi|A3, S3"],
      ["AUDI", "TT", "Audi|TT"],
      ["CITROEN", "C 5", "Citroën|C5"],
      ["FIAT", "500 L", "Fiat|500L"],
      ["FIAT", "IDEA", "Fiat|Idea"],
      ["JAECOO", "JAECOO7", "Jaecoo|7"],
      ["MG", "MG4", "MG|MG4"],
      ["MERCEDES-BENZ", "AMG C 43 4MATIC", "Mercedes-Benz|C-Class"],
      ["MERCEDES-BENZ", "AMG GT 63 S", "Mercedes-Benz|AMG GT"],
      ["LEXUS", "RX450H", "Lexus|RX"],
      ["LEXUS", "IS 250", "Lexus|IS"],
      ["MINI", "COUNTRYMAN COOPER S", "Mini|Countryman"],
      ["MINI", "JCW CLUBMAN", "Mini|Clubman"],
      ["VOLKSWAGEN", "ID. BUZZ PRO 150 KW", "Volkswagen|ID. Buzz"],
      ["VOLKSWAGEN", "PASAT", "Volkswagen|Passat"],
      ["HYUNDAI", "TUCSON, IX35", "Hyundai|Tucson"],
      ["KIA", "PRO CEED", "Kia|Pro Ceed"],
      ["VOLVO", "XC 60", "Volvo|XC60"],
      ["MAZDA", "CX 9", "Mazda|CX-9"],
      ["TOYOTA", "RAV 4", "Toyota|RAV4"],
    ];
    expect(await namesOf(cases.map(([make, name]) => [make, name]))).toEqual(
      cases.map((c) => c[2]),
    );
  });

  it("drops a model name without letters and joins spellings of one model id", async () => {
    const { header, row } = await realRow();
    const car = (make: string, name: string, type: string) =>
      withColumns(header, row, {
        "Tovární značka": make,
        "Obchodní označení": name,
        "Typ kód": type,
      });
    const rows = [
      car("VOLKSWAGEN", "UP!", "121"),
      car("VOLKSWAGEN", "UP!", "121"),
      car("VOLKSWAGEN", "UP", "121"),
      car("VOLKSWAGEN", ".", "121"),
      // One id, but a type each: both spellings stay.
      car("FORD", "KA", "RU8"),
      car("FORD", "KA+", "UK2"),
    ];
    const { entries, logs } = await harvest(
      syntheticHttp(header, rows.join("\r\n"), 1),
      "full",
      null,
      {
        minVehicles: 1,
      },
    );
    expect(new Set(entries.map((e) => e.variant.model))).toEqual(new Set(["Up!", "Ka", "Ka+"]));
    expect(entries.map((e) => variantIdOf(e.variant))).toEqual([
      ...new Set(entries.map((e) => variantIdOf(e.variant))),
    ]);
    expect(JSON.stringify(logs)).toContain("no-model");
  });

  it("spells makes and models the way the Resolver's aliases know them", async () => {
    const { entries } = await harvest(await replay());
    const makes = new Set(entries.map((e) => e.variant.make));
    expect([...makes].filter((m) => /^(vw|volkswagen)$/i.test(m))).toEqual(["Volkswagen"]);
    const models = new Set(entries.map((e) => `${e.variant.make} ${e.variant.model}`));
    for (const model of [
      "Škoda Octavia",
      "Volkswagen Golf",
      "Volkswagen Golf Plus",
      "Mercedes-Benz C-Class",
      "BMW 3 Series",
      "Hyundai i30",
      "Kia Ceed",
    ]) {
      expect(models).toContain(model);
    }
    // Body, engine and trim words never end up in a model name.
    for (const model of models) expect(model).not.toMatch(/combi|variant|tdi|\d\.\d|cdi|cw$/i);
  });

  it("maps body, fuel, power and Specs onto the vocabulary", async () => {
    const { entries } = await harvest(await replay());
    const octavia = variantsOf(entries, "Škoda", "Octavia").find(
      (v) =>
        v.generation.slug === "mk2" &&
        v.body === "wagon" &&
        v.fuel === "diesel" &&
        v.powerKw === 77,
    );
    expect(octavia).toMatchObject({
      engineCc: 1896,
      seats: 5,
      euroClass: 4,
      drive: "fwd",
      years: { from: 2005 },
    });
    const bmw = variantsOf(entries, "BMW", "3 Series");
    expect(new Set(bmw.map((v) => v.drive))).toEqual(new Set(["rwd"]));
    expect(new Set(bmw.map((v) => v.body))).toEqual(new Set(["sedan", "wagon", "coupe"]));
  });

  it("skips rows it cannot map and reports them, without failing the run", async () => {
    const { logs } = await harvest(await replay());
    const read = logs.find((l) => l.message === "rsv export read")?.data;
    // The fixture adds one row each with "0 / 0" kW, fuel "XYZ" and 20 of 99 columns; the
    // real rows of pre-EU national approvals add more without a type or body.
    const rejected = read?.rejected as Record<string, number>;
    expect(rejected["short-row"]).toBe(1);
    expect(rejected["no-power"]).toBeGreaterThanOrEqual(1);
    expect(rejected["unknown-fuel"]).toBeGreaterThanOrEqual(1);
    expect(read?.cars).toBeGreaterThan(400);
  });

  it("incremental run skips an export generated before the last run", async () => {
    const { entries, logs } = await harvest(
      await replay(),
      "incremental",
      new Date("2026-10-02T03:00:00Z"),
    );
    expect(entries).toEqual([]);
    expect(logs.map((l) => l.message)).toContain("rsv export unchanged since last run");
  });

  it("incremental run reads an export generated since the last run", async () => {
    const { entries } = await harvest(
      await replay(),
      "incremental",
      new Date("2026-09-02T03:00:00Z"),
    );
    expect(entries.length).toBeGreaterThan(20);
  });

  it("fails the run when the export's columns change", async () => {
    const http = await replay((c) => {
      const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
      if (!zip?.response.bodyBase64) throw new Error("fixture has no export");
      zip.response.bodyBase64 = Buffer.from(
        zipOf("Datum 1. registrace,Kategorie vozidla\r\n2020-01-01,M1\r\n"),
      ).toString("base64");
    });
    await expect(harvest(http)).rejects.toThrow(/Register export changed: no column/);
  });

  it("fails the run when the site stops listing the export", async () => {
    const http = await replay((c) => {
      const api = c.interactions.find((i) => i.request.url.includes("regularLatestReports"));
      if (!api) throw new Error("fixture has no reports API");
      api.response.body = "[]";
    });
    await expect(harvest(http)).rejects.toThrow(/lists no technical-data export/);
  });

  it("fails the run without Wikidata, which decides which types are one generation", async () => {
    const http = await replay((c) => {
      const wd = c.interactions.find((i) => i.request.url.includes("wikidata"));
      if (!wd) throw new Error("fixture has no Wikidata");
      Object.assign(wd.response, { status: 500, body: "" });
    });
    await expect(harvest(http)).rejects.toThrow(/Wikidata returned HTTP 500/);
  });

  it("starts the download over when the server drops it", async () => {
    const reference = await harvest(await replay());
    const flakyHttp = flaky(await replay(), 1);
    const { entries, logs } = await harvest(flakyHttp.http);
    expect(entries).toEqual(reference.entries);
    expect(flakyHttp.downloads()).toBe(2);
    expect(flakyHttp.closed()).toBe(2);
    expect(logs.map((l) => l.message)).toContain("rsv download interrupted; starting over");
  });

  it("fails after the last attempt without yielding a partial catalog", async () => {
    const flakyHttp = flaky(await replay(), 3);
    const yielded: Observation[] = [];
    const run = (async () => {
      for await (const o of rsvSource(options).harvest(context(flakyHttp.http))) yielded.push(o);
    })();
    await expect(run).rejects.toThrow(/download interrupted/);
    expect(yielded).toEqual([]);
    expect(flakyHttp.downloads()).toBe(3);
    expect(flakyHttp.closed()).toBe(3);
  });

  it("fails on a truncated archive instead of yielding a partial catalog", async () => {
    const http = await replay((c) => {
      const zip = exportOf(c);
      const bytes = Buffer.from(zip.response.bodyBase64 ?? "", "base64");
      zip.response.bodyBase64 = bytes.subarray(0, bytes.length / 2).toString("base64");
    });
    const yielded: Observation[] = [];
    const run = (async () => {
      for await (const o of rsvSource(options).harvest(context(http))) yielded.push(o);
    })();
    await expect(run).rejects.toThrow(/unexpected end/i);
    expect(yielded).toEqual([]);
  });

  it("reads a ZIP written with a data descriptor and a central directory, in tiny chunks", async () => {
    const reference = await harvest(await replay());
    const csv = await unzipText(
      Buffer.from(exportOf(await cassette()).response.bodyBase64 ?? "", "base64"),
    );
    const deflated = deflateRawSync(Buffer.from(csv, "utf8"));
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    const central = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.alloc(60)]);
    const zip = Buffer.concat([localHeader(), deflated, descriptor, central]);
    const http = await replay((c) => {
      exportOf(c).response.bodyBase64 = zip.toString("base64");
    });
    const { entries } = await harvest(rechunked(http, 7));
    expect(entries).toEqual(reference.entries);
  });

  it("streams the export: memory stays flat over 200,000 rows", async () => {
    const { header, row } = await realRow();
    const http = syntheticHttp(header, row, 200_000);
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 20);
    const { entries, logs } = await harvest(http, "full", null, { minVehicles: 5 });
    clearInterval(timer);
    expect(logs.find((l) => l.message === "rsv export read")?.data).toMatchObject({
      rows: 200_000,
      cars: 200_000,
    });
    expect(entries).toHaveLength(1);
    // ~100 MB of CSV went through; the adapter holds one record per candidate Variant.
    expect(peak - before).toBeLessThan(80 * 2 ** 20);
  }, 60_000);
});

function context(http: Http) {
  return {
    http,
    mode: "full" as const,
    checkpoint: emptyCheckpoint,
    now,
    log: { info() {}, warn() {} },
    signal: new AbortController().signal,
  };
}

function exportOf(c: Cassette) {
  const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
  if (!zip) throw new Error("fixture has no export");
  return zip;
}

/** The export download breaks after 20 kB on its first `failures` attempts. */
function flaky(inner: Http, failures: number) {
  let downloads = 0;
  let closed = 0;
  const http: Http = {
    async get(request) {
      const page = await inner.get(request);
      if (typeof request === "string" || !request.stream || !page.chunks) return page;
      const attempt = ++downloads;
      const source = page.chunks;
      async function* chunks() {
        let bytes = 0;
        try {
          for await (const chunk of source) {
            if (attempt <= failures && bytes > 20_000) throw new TypeError("terminated");
            bytes += chunk.length;
            yield chunk;
          }
        } finally {
          closed++;
        }
      }
      return { ...page, chunks: chunks() };
    },
  };
  return { http, downloads: () => downloads, closed: () => closed };
}

/** Serves streamed bodies in `size`-byte chunks. */
function rechunked(inner: Http, size: number): Http {
  return {
    async get(request) {
      const page = await inner.get(request);
      if (!page.chunks) return page;
      const source = page.chunks;
      async function* chunks() {
        for await (const chunk of source) {
          for (let at = 0; at < chunk.length; at += size) yield chunk.subarray(at, at + size);
        }
      }
      return { ...page, chunks: chunks() };
    },
  };
}

/** The fixture's header and its first data row, as CSV lines. */
async function realRow(): Promise<{ header: string; row: string }> {
  const c = await cassette();
  const zip = c.interactions.find((i) => i.request.url.includes("/vypiszregistru/"));
  const csv = await unzipText(Buffer.from(zip?.response.bodyBase64 ?? "", "base64"));
  const [header, ...rows] = csv.replace(/^\ufeff/, "").split("\r\n");
  // An Octavia II: a row the adapter keeps.
  const row = rows.find((r) => !r.includes('"') && r.includes("OCTAVIA") && r.includes(",1Z,"));
  if (!header || !row) throw new Error("fixture has no plain Octavia II row");
  return { header, row };
}

/**
 * "Make|Model" of the catalog for each register (make, commercial name) pair: one vehicle per
 * pair, each with a type of its own so no two pairs fold together.
 */
async function namesOf(pairs: [string, string][]): Promise<string[]> {
  const { header, row } = await realRow();
  const rows = pairs.map(([make, name], i) =>
    withColumns(header, row, {
      "Tovární značka": make,
      "Obchodní označení": name,
      "Typ kód": `T${i}`,
    }),
  );
  const { entries } = await harvest(syntheticHttp(header, rows.join("\r\n"), 1), "full", null, {
    minVehicles: 1,
  });
  const byType = new Map(entries.map((e) => [e.variant.generation.slug, e.variant]));
  return pairs.map((_, i) => {
    const v = byType.get(`t${i}`);
    return v ? `${v.make}|${v.model}` : "(none)";
  });
}

/** `row` (a plain CSV line without quotes) with the named columns set, quoted as CSV. */
function withColumns(header: string, row: string, values: Record<string, string>): string {
  const columns = header.split(",").map((c) => c.trim());
  const fields = row.split(",");
  for (const [name, value] of Object.entries(values)) {
    const i = columns.indexOf(name);
    if (i < 0) throw new Error(`no column ${name}`);
    fields[i] = /[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
  return fields.join(",");
}

async function unzipText(zip: Buffer): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const chunk of unzipFirst(Readable.from([new Uint8Array(zip)]))) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

/** A one-file ZIP (local header + DEFLATE data; enough for a streaming reader). */
function zipOf(text: string): Uint8Array {
  return Buffer.concat([localHeader(), deflateRawSync(Buffer.from(text, "utf8"))]);
}

function localHeader(): Buffer {
  const name = Buffer.from("DK_1.csv");
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x08, 6); // sizes follow the data
  head.writeUInt16LE(8, 8); // DEFLATE
  head.writeUInt16LE(name.length, 26);
  return Buffer.concat([head, name]);
}

/**
 * The site, its API and an export ZIP of `rows` copies of `row` (one or more CSV lines),
 * deflated on the fly; Wikidata answers with `bindings`.
 */
function syntheticHttp(header: string, row: string, rows: number, bindings: unknown[] = []): Http {
  const json = (url: string, body: unknown, headers: Record<string, string> = {}): Page => ({
    url,
    status: 200,
    headers,
    body: JSON.stringify(body),
    tier: "T0",
  });
  return {
    async get(request) {
      const url = typeof request === "string" ? request : request.url;
      if (url === `${RSV_SITE}/`) return json(url, "", { _ren: "token" });
      if (url.includes("regularLatestReports")) {
        return json(url, [
          { NormalizedNazev: "vypisvozidel", Guid: "synthetic", Vygenerovano: "2026-10-01T15:48" },
        ]);
      }
      if (url.includes("/vypiszregistru/synthetic")) {
        async function* csv() {
          yield Buffer.from(`﻿${header}\r\n`);
          const per = Math.min(rows, 1000);
          const block = Buffer.from(`${row}\r\n`.repeat(per));
          for (let i = 0; i < rows / per; i++) yield block;
        }
        const deflated = Readable.from(csv()).pipe(createDeflateRaw());
        async function* chunks() {
          yield new Uint8Array(localHeader());
          for await (const chunk of deflated) yield new Uint8Array(chunk as Buffer);
        }
        return { url, status: 200, headers: {}, body: "", chunks: chunks(), tier: "T0" };
      }
      return json(url, { results: { bindings } });
    },
  };
}
