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
 * whole. A changed table header, an unknown support level, a definitions file without its
 * platform class, or upstream and dashcam rows that mostly find no platform (checkPlatforms)
 * fail the run.
 */
import type { Fuel, OpenpilotLevel, OpenpilotSupport } from "@cca/vocabulary";
import type { HarvestContext, Source } from "../source.ts";

const LIST_URL = "https://raw.githubusercontent.com/commaai/opendbc/master/docs/CARS.md";
const DETAILS_URL = "https://raw.githubusercontent.com/commaai/openpilot/master/docs/CARS.md";
const VEHICLES_URL = "https://comma.ai/vehicles";
const DEFINITIONS_URL = "https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/car";

/**
 * opendbc's brand directories whose `values.py` defines the platforms of listed cars, with the
 * makes each one names its cars under.
 */
const BRANDS: Record<string, string[]> = {
  byd: ["BYD"],
  chrysler: ["Chrysler", "Dodge", "Jeep", "Ram"],
  ford: ["Ford", "Lincoln"],
  gm: ["Buick", "Cadillac", "Chevrolet", "GMC", "Holden"],
  honda: ["Acura", "Honda"],
  hyundai: ["Genesis", "Hyundai", "Kia"],
  mazda: ["Mazda"],
  mg: ["MG"],
  nissan: ["Nissan"],
  psa: ["Peugeot"],
  rivian: ["Rivian"],
  subaru: ["Subaru"],
  tesla: ["Tesla"],
  toyota: ["Lexus", "Toyota"],
  volkswagen: ["Audi", "CUPRA", "MAN", "Porsche", "SEAT", "Škoda", "Volkswagen"],
};

/** Levels comma lists from the platforms' own car definitions: every such row has a platform. */
const PLATFORM_LEVELS = new Set<OpenpilotLevel>(["upstream", "dashcam"]);

/**
 * How many rows of PLATFORM_LEVELS may go without a platform (a name the list and the
 * definitions spell differently, one two platforms claim) before the definitions count as
 * unreadable: 2, or 2% of them.
 */
const UNPLACED_ROWS = { min: 2, share: 0.02 };

/** Fewer platforms than one per this many rows that have one means the parser merged them. */
const ROWS_PER_PLATFORM = 4;

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
      for (const brand of Object.keys(BRANDS)) {
        const url = `${DEFINITIONS_URL}/${brand}/values.py`;
        for (const [name, platform] of parsePlatforms(await getOk(ctx, url), url)) {
          // A name two platforms claim says nothing about which car it is.
          platforms.set(
            name,
            platforms.has(name) && platforms.get(name) !== platform ? null : platform,
          );
        }
      }
      const rows = parseSupportList(list, parseDetails(details), platforms);
      checkPlatforms(rows);
      yield* rows;
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
 * Fails the run when the platforms look unread rather than absent: a make on the list with
 * none of the brands' definitions, a brand whose listed cars found no platform, more unplaced
 * rows than UNPLACED_ROWS allows, or far fewer platforms than rows placed on them.
 */
function checkPlatforms(rows: OpenpilotSupport[]): void {
  const defined = rows.filter((row) => PLATFORM_LEVELS.has(row.level));
  for (const [brand, makes] of Object.entries(BRANDS)) {
    const listed = defined.filter((row) => makes.includes(row.make));
    if (listed.length && !listed.some((row) => row.platform)) {
      throw new Error(
        `comma-openpilot: none of ${listed.length} listed ${makes.join("/")} cars has a platform in ${DEFINITIONS_URL}/${brand}/values.py`,
      );
    }
  }
  const makes = new Set(Object.values(BRANDS).flat());
  const unknown = defined.find((row) => !makes.has(row.make));
  if (unknown) throw new Error(`comma-openpilot: no platform definitions for ${unknown.ref}`);

  const unplaced = defined.filter((row) => !row.platform);
  if (unplaced.length > Math.max(UNPLACED_ROWS.min, UNPLACED_ROWS.share * defined.length)) {
    throw new Error(
      `comma-openpilot: ${unplaced.length} of ${defined.length} cars have no platform, e.g. ${unplaced[0]?.ref}`,
    );
  }
  const placed = defined.length - unplaced.length;
  const count = new Set(defined.map((row) => row.platform).filter(Boolean)).size;
  if (count * ROWS_PER_PLATFORM < placed) {
    throw new Error(`comma-openpilot: ${placed} cars on only ${count} platforms`);
  }
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
 *
 * Read by brackets, not indents or line breaks, as Python does: a member is a statement of
 * the class (a line outside every bracket), a car is a `…CarDocs(` call anywhere inside it.
 */
function parsePlatforms(text: string, url: string): [name: string, platform: string][] {
  const start = /^class\s+CAR\b.*$/m.exec(text);
  if (!start) throw new Error(`comma-openpilot: no platform class in ${url}`);
  const offset = start.index + start[0].length;
  const source = text.slice(offset);
  // Strings and comments blanked out, offsets kept: brackets and keywords are code only.
  const code = blankStringsAndComments(source);

  // Statements of the class: the lines that begin outside every bracket, and what follows a
  // `;` there. It ends at the first such line at the left margin.
  const statements: number[] = [];
  let depth = 0;
  let end = code.length;
  for (let i = 0; i < code.length; i++) {
    const char = code[i] as string;
    if (char === ";" && depth === 0) statements.push(i + 1);
    else if (char === "\n" && depth === 0) {
      const line = /^[^\n]*/.exec(code.slice(i + 1))?.[0] ?? "";
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) {
        end = i;
        break;
      }
      statements.push(i + 1);
    } else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    if (depth < 0) throw new Error(`comma-openpilot: unbalanced brackets in ${url}`);
  }
  if (depth !== 0) throw new Error(`comma-openpilot: unbalanced brackets in ${url}`);

  const out: [string, string][] = [];
  for (const [n, from] of statements.entries()) {
    const to = statements[n + 1] ?? end;
    // A platform is `NAME = Config(…)`; any other statement holds no cars of a platform.
    const platform = /^\s*([A-Z][A-Z0-9_]*)\s*(?::[^=\n]*)?=\s*\w+\s*\(/.exec(
      code.slice(from, to),
    )?.[1];
    if (!platform) continue;
    for (const call of code.slice(from, to).matchAll(/\b\w*CarDocs\w*\s*\(/g)) {
      const open = from + call.index + call[0].length;
      const close = closingBracket(code, open);
      const name = firstString(source, code, open, close);
      if (!name) throw new Error(`comma-openpilot: unreadable car name in ${platform} in ${url}`);
      const flags = code.slice(open, close);
      out.push([name, platform]);
      const named = /^(.+?) (\d{4}\S*(?:, \d{4}\S*)*)$/.exec(name);
      if (named && /\bhybrid\s*=\s*True\b/.test(flags)) {
        out.push([`${named[1]} Hybrid ${named[2]}`, platform]);
      }
      if (named && /\bplug_in_hybrid\s*=\s*True\b/.test(flags)) {
        out.push([`${named[1]} Plug-in Hybrid ${named[2]}`, platform]);
      }
    }
  }
  return out;
}

/** Python source with the contents of strings and comments replaced by spaces, newlines kept. */
function blankStringsAndComments(text: string): string {
  return text.replace(
    /#[^\n]*|("""|''')[\s\S]*?\1|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (token) =>
      token.startsWith("#")
        ? " ".repeat(token.length)
        : blankInside(token, /^("""|''')/.test(token) ? 3 : 1),
  );
}

/** `literal` with all but its `quote`-long delimiters blanked. */
function blankInside(literal: string, quote: number): string {
  const inside = literal.slice(quote, -quote).replace(/[^\n]/g, " ");
  return literal.slice(0, quote) + inside + literal.slice(-quote);
}

/**
 * The first argument in `code[from, to)` when it is a string literal, adjacent literals joined
 * as Python joins them; undefined when it is anything else ("Toyota " + MODEL). `code`
 * locates the quotes (comments blanked), `source` gives their text.
 */
function firstString(source: string, code: string, from: number, to: number): string | undefined {
  let name: string | undefined;
  let i = from;
  for (;;) {
    while (i < to && /\s/.test(code[i] as string)) i++;
    const literal = /^[rRuU]?("""|'''|"|')/.exec(code.slice(i, i + 4));
    if (!literal) return i >= to || code[i] === "," ? name : undefined;
    const quote = literal[1] as string;
    i += literal[0].length - quote.length;
    const close = code.indexOf(quote, i + quote.length);
    if (close < 0 || close >= to) return name;
    name = (name ?? "") + source.slice(i + quote.length, close);
    i = close + quote.length;
  }
}

/** The index of the bracket closing the one just before `open`. */
function closingBracket(code: string, open: number): number {
  let depth = 1;
  for (let i = open; i < code.length; i++) {
    if ("([{".includes(code[i] as string)) depth++;
    else if (")]}".includes(code[i] as string) && --depth === 0) return i;
  }
  return code.length;
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
