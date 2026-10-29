/**
 * comma.ai openpilot supported-car list: one OpenpilotSupport per row.
 *
 * - The list: opendbc's generated docs/CARS.md, one table `|Make|Model|Package|Support Level|`
 *   with every known car (upstream, community, custom, under review, dashcam, incompatible).
 * - Details: openpilot's older docs/CARS.md, upstream rows only, with ACC, the speeds below
 *   which openpilot does not accelerate or steer (mph), and the harness. Joined on the exact
 *   make, model and package cells; a row without a match gets no details.
 *
 * - Platforms: opendbc's car definitions (`opendbc/car/<brand>/values.py`), where each
 *   platform lists the cars it covers by the same name the list shows. A platform is one car
 *   to openpilot, and the Ledger reads its Generation from all its rows together. Cars defined
 *   outside a brand's platforms (most incompatible and community rows) get none.
 *
 * The list is a census and small (a few requests), so incremental and full runs both read it
 * whole. A changed table header, an unknown support level or a definitions file without its
 * platform class fails the run.
 */
import type { Fuel, OpenpilotLevel, OpenpilotSupport } from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

const LIST_URL = "https://raw.githubusercontent.com/commaai/opendbc/master/docs/CARS.md";
const DETAILS_URL = "https://raw.githubusercontent.com/commaai/openpilot/master/docs/CARS.md";
const VEHICLES_URL = "https://comma.ai/vehicles";
const DEFINITIONS_URL = "https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car";

/** opendbc's brand directories whose `values.py` defines the platforms of listed cars. */
const BRANDS = [
  "byd",
  "chrysler",
  "ford",
  "gm",
  "honda",
  "hyundai",
  "mazda",
  "mg",
  "nissan",
  "psa",
  "rivian",
  "subaru",
  "tesla",
  "toyota",
  "volkswagen",
];

const LIST_HEADER = "|Make|Model|Package|Support Level|";
const DETAILS_HEADER =
  '|Make|Model|Supported Package|ACC|No ACC accel below|No ALC below|Steering Torque|Resume from stop|<a href="##"><img width=2000></a>Hardware Needed<br>&nbsp;|Video|Setup Video|';

const LEVELS = new Map<string, OpenpilotLevel>([
  ["Upstream", "upstream"],
  ["Community", "community"],
  ["Custom", "custom"],
  ["Under review", "underReview"],
  ["Dashcam mode", "dashcam"],
  ["Not compatible", "incompatible"],
]);

const LONGITUDINAL = new Map<string, OpenpilotSupport["longitudinal"]>([
  ["openpilot", "openpilot"],
  ["openpilot available", "optional"],
  ["Stock", "stock"],
]);

/**
 * The list refers unqualified rows to the US market, but these makes are not sold in the US:
 * their unqualified rows describe European cars.
 */
const EUROPEAN_MAKES = new Set(["Škoda", "SEAT", "CUPRA", "Peugeot", "MAN"]);

/** Market qualifiers written without "only" ("Odyssey (Taiwan)"). */
const BARE_MARKETS = new Set(["Singapore", "Taiwan"]);

/** comma's own robot, listed with no model years: not a car. */
const NOT_CARS = new Set(["comma|body|All"]);

const KMH_PER_MPH = 1.609344;

export function commaOpenpilotSource(): Source {
  return {
    id: "comma-openpilot",
    async *harvest(ctx: HarvestContext): AsyncIterable<OpenpilotSupport> {
      const list = await getOk(ctx, LIST_URL);
      const details = await getOk(ctx, DETAILS_URL);
      const platforms = new Map<string, string | null>();
      for (const brand of BRANDS) {
        const url = `${DEFINITIONS_URL}/${brand}/values.py`;
        for (const [name, platform] of parsePlatforms(await getOk(ctx, url), url)) {
          // A name two platforms claim says nothing about which car it is.
          platforms.set(
            name,
            platforms.has(name) && platforms.get(name) !== platform ? null : platform,
          );
        }
      }
      yield* parseSupportList(list, parseDetails(details), platforms);
    },
  };
}

async function getOk(ctx: HarvestContext, url: string): Promise<string> {
  ctx.signal.throwIfAborted();
  const page = await ctx.http.get({ url, locale: "en", signal: ctx.signal });
  if (page.status !== 200) throw new Error(`comma-openpilot: HTTP ${page.status} for ${url}`);
  ctx.log.info("comma-openpilot fetched", { url });
  return page.body;
}

type Details = Pick<OpenpilotSupport, "longitudinal" | "minSteerKmh" | "minEnableKmh" | "harness">;

/**
 *   # Support Information for 406 Known Cars
 *
 *   |Make|Model|Package|Support Level|
 *   |---|---|---|:---:|
 *   |Toyota|Camry 2018-20|All|[Upstream](#upstream)|
 */
function parseSupportList(
  text: string,
  details: Map<string, Details>,
  platforms: Map<string, string | null>,
): OpenpilotSupport[] {
  const rows = tableRows(text, /^# Support Information for (\d+) Known Cars$/m, LIST_HEADER, 4);

  const makesWithUpstream = new Set(
    rows.filter((cells) => supportLevel(cells[3] as string) === "upstream").map(([make]) => make),
  );
  const seen = new Set<string>();
  const out: OpenpilotSupport[] = [];
  for (const [make = "", modelCell = "", packageCell = "", levelCell = ""] of rows) {
    const ref = `${make}|${modelCell}|${packageCell}`;
    if (seen.has(ref)) throw new Error(`comma-openpilot: duplicate row ${ref}`);
    seen.add(ref);
    if (NOT_CARS.has(ref)) continue;

    const { model, years, market } = parseModel(modelCell);
    const europe =
      market !== undefined
        ? /\bEurope\b/i.test(market) || market === "Non-US"
        : EUROPEAN_MAKES.has(make) || undefined;
    const fuel = parseFuel(make, model);
    const platform = platforms.get(`${make} ${modelCell}`);
    out.push({
      kind: "OpenpilotSupport",
      ref,
      make,
      model,
      ...(fuel ? { fuel } : {}),
      years,
      ...(platform ? { platform } : {}),
      level: supportLevel(levelCell),
      ...(packageCell !== "All" ? { package: packageCell } : {}),
      market: market ?? (europe ? "Europe" : "US"),
      ...(europe !== undefined ? { europe } : {}),
      ...details.get(ref),
      url: makesWithUpstream.has(make) ? `${VEHICLES_URL}#${make.toLowerCase()}` : VEHICLES_URL,
    });
  }
  return out;
}

/**
 * Car names by platform from a brand's definitions: each platform of `class CAR` lists its
 * cars by the name the list shows ("Hyundai Tucson 2021" is Make plus the Model cell):
 *   class CAR(Platforms):
 *     HYUNDAI_TUCSON = HyundaiPlatformConfig(
 *       [
 *         HyundaiCarDocs("Hyundai Tucson 2021", min_enable_speed=19 * CV.MPH_TO_MS, …),
 * Ford adds a Hybrid and a Plug-in Hybrid car for `hybrid=True` and `plug_in_hybrid=True`
 * ("Ford Kuga Hybrid 2020-23").
 */
function parsePlatforms(text: string, url: string): [name: string, platform: string][] {
  const start = /^class CAR\(.*$/m.exec(text);
  if (!start) throw new Error(`comma-openpilot: no platform class in ${url}`);
  // The class runs to the next line that is not indented.
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(/\n\S/);
  const body = end < 0 ? rest : rest.slice(0, end);
  const out: [string, string][] = [];
  let platform: string | undefined;
  for (const line of body.split("\n")) {
    platform = /^ {2}([A-Z][A-Z0-9_]*) = \w+\(/.exec(line)?.[1] ?? platform;
    if (!platform) continue;
    for (const [, name = ""] of line.matchAll(/\b\w*CarDocs\w*\(\s*"([^"]+)"/g)) {
      out.push([name, platform]);
      const named = /^(.+?) (\d{4}\S*(?:, \d{4}\S*)*)$/.exec(name);
      if (named && /\bhybrid=True\b/.test(line))
        out.push([`${named[1]} Hybrid ${named[2]}`, platform]);
      if (named && /\bplug_in_hybrid=True\b/.test(line)) {
        out.push([`${named[1]} Plug-in Hybrid ${named[2]}`, platform]);
      }
    }
  }
  return out;
}

/**
 * Upstream rows of openpilot's detailed list, by `make|model|package`, footnote marks dropped
 * from every cell ("Subaru|Ascent 2019-21|All[<sup>7</sup>](#footnotes)"):
 *   |Toyota|Camry 2018-20|All|Stock|0 mph[<sup>11</sup>](#footnotes)|0 mph|…|<details>…- 1 Toyota A connector<br>…</details>|…|
 */
function parseDetails(text: string): Map<string, Details> {
  const out = new Map<string, Details>();
  for (const cells of tableRows(text, /^# (\d+) Supported Cars$/m, DETAILS_HEADER, 11)) {
    const [make, model, pkg, acc = "", accelBelow = "", steerBelow = "", , , hardware = ""] =
      cells.map(withoutFootnotes);
    const key = `${make}|${model}|${pkg}`;
    const longitudinal = LONGITUDINAL.get(acc);
    if (!longitudinal) throw new Error(`comma-openpilot: unknown ACC "${acc}" for ${key}`);
    if (out.has(key)) throw new Error(`comma-openpilot: duplicate details row ${key}`);
    const harness = /-\s*\d+\s+([^<]*?\bconnector)\b/.exec(hardware)?.[1];
    out.set(key, {
      longitudinal,
      minEnableKmh: kmh(accelBelow),
      minSteerKmh: kmh(steerBelow),
      ...(harness ? { harness } : {}),
    });
  }
  return out;
}

/**
 * The cells of the table under `header`, up to the first line that is not a table row. The
 * file states its car count in a `heading`; a table with another count is cut short or changed.
 */
function tableRows(text: string, heading: RegExp, header: string, columns: number): string[][] {
  const declared = heading.exec(text)?.[1];
  if (!declared)
    throw new Error(`comma-openpilot: car count heading not found, expected ${heading}`);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) throw new Error(`comma-openpilot: table header changed, expected ${header}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.trim().slice(1, -1).split("|");
    if (cells.length !== columns) {
      throw new Error(`comma-openpilot: expected ${columns} cells, got ${cells.length}: ${line}`);
    }
    rows.push(cells.map((cell) => cell.trim()));
  }
  if (rows.length !== Number(declared)) {
    throw new Error(
      `comma-openpilot: ${declared} cars declared, ${rows.length} rows under ${header}`,
    );
  }
  return rows;
}

/** "[Upstream](#upstream)", "[Not compatible](#flexray)", or a bare label. */
function supportLevel(cell: string): OpenpilotLevel {
  const label = /^\[([^\]]+)\]\(#[^)]*\)$/.exec(cell)?.[1] ?? cell;
  const level = LEVELS.get(label);
  if (!level) throw new Error(`comma-openpilot: unknown support level "${cell}"`);
  return level;
}

/**
 * "Ioniq 5 (Southeast Asia and Europe only) 2022-24" → model "Ioniq 5", market "Southeast Asia
 * and Europe", years [2022, 2023, 2024]. Other parentheses stay in the model ("Model 3 (with
 * HW4)"); "(with HDA II, Korea only)" keeps "(with HDA II)".
 */
function parseModel(cell: string): { model: string; years: number[]; market?: string } {
  const match = /^(.*?)\s+(\d{4}(?:-\d{2})?(?:,\s*\d{4}(?:-\d{2})?)*)$/.exec(cell);
  if (!match) throw new Error(`comma-openpilot: no model years in "${cell}"`);
  const markets: string[] = [];
  const model = (match[1] as string)
    .replace(/\s*\(([^)]*)\)/g, (_, inner: string) => {
      const kept = inner
        .split(",")
        .map((part) => part.trim())
        .filter((part) => {
          const market =
            /^(.+?)\s+only$/i.exec(part)?.[1] ?? (BARE_MARKETS.has(part) ? part : null);
          if (market) markets.push(market);
          return !market;
        });
      return kept.length ? ` (${kept.join(", ")})` : "";
    })
    .trim();
  return {
    model,
    years: expandYears(match[2] as string, cell),
    ...(markets.length ? { market: markets.join(", ") } : {}),
  };
}

/** "2015-17, 2019-20" → [2015, 2016, 2017, 2019, 2020] */
function expandYears(text: string, cell: string): number[] {
  const years: number[] = [];
  for (const range of text.split(",")) {
    const [from = "", to] = range.trim().split("-");
    const first = Number(from);
    const last = to === undefined ? first : Math.floor(first / 100) * 100 + Number(to);
    if (last < first || (years.length && first <= (years.at(-1) as number))) {
      throw new Error(`comma-openpilot: unordered model years in "${cell}"`);
    }
    for (let year = first; year <= last; year++) years.push(year);
  }
  return years;
}

/**
 * Fuel only from words in the model name. Volkswagen's GTE and eHybrid are its plug-in hybrid
 * names (Golf GTE, Arteon eHybrid); "e-tron" names both a plug-in and an electric Audi, so
 * it stays undefined.
 */
function parseFuel(make: string, model: string): Fuel | undefined {
  if (/\bPlug-in Hybrid\b|\bPHEV\b|\bGTE\b|\beHybrid\b/i.test(model)) return "phev";
  if (make === "Toyota" && /\bPrime\b/.test(model)) return "phev";
  if (/\bHybrid\b/.test(model)) return "hev";
  if (/\bDiesel\b/.test(model)) return "diesel";
  if (/\bElectric\b|\bEV\b|\bEUV\b|(?:^|\s)e-[A-Z]/.test(model)) return "bev";
  return undefined;
}

/** "26 mph" → km/h, rounded. */
function kmh(cell: string): number {
  const mph = /^(\d+(?:\.\d+)?) mph$/.exec(cell)?.[1];
  if (mph === undefined) throw new Error(`comma-openpilot: unparseable speed "${cell}"`);
  return Math.round(Number(mph) * KMH_PER_MPH);
}

function withoutFootnotes(cell: string): string {
  return cell.replace(/\[<sup>[^<]*<\/sup>\]\([^)]*\)/g, "").trim();
}
