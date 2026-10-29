// A live listing that moves out of a slice a census finishes, into one it never finishes, stays
// live as long as the adapter met it anywhere: Source (replayed) → Ledger, through `harvest`
// and `record`/`snapshot`. Each census week the slice it left finishes without it, and the run
// fails after meeting it where it moved.
import { type Cassette, createReplayHttp, type Interaction, loadCassette } from "@cca/http";
import { type Ledger, openLedger } from "@cca/ledger";
import { bazosSource, type Source, silentLogger, tipcarsSource } from "@cca/sources";
import type { ListingSeen, Observation } from "@cca/vocabulary";
import { afterEach, describe, expect, it } from "vitest";

const fixture = (source: string, name: string) =>
  new URL(
    `../../../packages/sources/src/${source}/fixtures/${name}.cassette.json`,
    import.meta.url,
  );
const day = (date: string) => new Date(`${date}T03:00:00Z`);
const plusDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let ledger: Ledger;
afterEach(() => ledger?.close());

function listing(ref: string, slice: string): ListingSeen {
  return {
    kind: "ListingSeen",
    ref,
    url: `https://example.test/${ref}`,
    market: "CZ",
    condition: "used",
    vehicle: { make: "Škoda", model: "Octavia" },
    price: { amount: 100_000, currency: "CZK" },
    priceBasis: "gross",
    seller: "dealer",
    photos: [],
    slice,
  };
}

interface Move {
  source: Source;
  cassette: Cassette;
  now: Date;
  ref: string;
  /** The slice the listing left, which each census finishes without it. */
  left: string;
  failure: RegExp;
}

/**
 * Two census weeks: on Sunday `left` finishes and the harvest of the rest fails, then the daily
 * retries finish nothing; the third Sunday's run settles the second census. The listing's gone
 * date at the end, and what each Sunday's harvest yielded.
 */
async function twoStalledCensuses(move: Move) {
  const { source, left } = move;
  const scope = source.scope;
  ledger = openLedger(":memory:");
  await ledger.record({ source: source.id, mode: "full", scope, startedAt: day("2026-09-27") }, [
    listing(move.ref, left),
    { kind: "SliceDone", slice: left },
  ]);
  const failed = async (date: string, observations: AsyncIterable<Observation>, error: RegExp) =>
    expect(
      ledger.record({ source: source.id, mode: "full", scope, startedAt: day(date) }, observations),
    ).rejects.toThrow(error);
  async function* nothing() {
    yield* [];
    throw new Error("no slice finished");
  }
  const sundays: Observation[][] = [];
  for (const sunday of ["2026-10-04", "2026-10-11"]) {
    const checkpoint = ledger.checkpoint(source.id, scope);
    const out: Observation[] = [];
    async function* harvest() {
      // The slice it left finishes; the harvest takes the others.
      const done = { kind: "SliceDone", slice: left } as const;
      out.push(done);
      yield done;
      for await (const o of source.harvest({
        http: createReplayHttp(move.cassette),
        mode: "full",
        checkpoint: {
          ...checkpoint,
          sliceDoneAt: (s) => (s === left ? day(sunday) : checkpoint.sliceDoneAt(s)),
        },
        now: move.now,
        log: silentLogger,
        signal: new AbortController().signal,
      })) {
        out.push(o);
        yield o;
      }
    }
    await failed(sunday, harvest(), move.failure);
    await failed(plusDays(sunday, 1), nothing(), /no slice finished/);
    await failed(plusDays(sunday, 6), nothing(), /no slice finished/);
    sundays.push(out);
  }
  await failed("2026-10-18", nothing(), /no slice finished/);
  const gone = [...ledger.snapshot().listings()].find((l) => l.ref === move.ref)?.gone;
  return { gone, sundays };
}

/** Bazoš's recorded Kia pages, served as Škoda's too, Škoda's first page edited by `skoda`. */
async function bazos(skoda: (first: Interaction) => Interaction[]): Promise<Cassette> {
  const [list, details] = await Promise.all([
    loadCassette(fixture("bazos", "full")),
    loadCassette(fixture("bazos", "details")),
  ]);
  const copies = list.interactions.map(({ request, response }) => ({
    request: { ...request, url: request.url.replace("/kia/", "/skoda/") },
    response: { ...response, url: response.url.replace("/kia/", "/skoda/") },
  }));
  const root = "https://auto.bazos.cz/skoda/";
  const first = copies.find(({ request }) => request.url === root) as Interaction;
  return {
    version: 1,
    interactions: [
      ...list.interactions,
      ...details.interactions,
      ...copies.filter(({ request }) => request.url !== root),
      ...skoda(first),
    ],
  };
}

describe("a known listing that moved into a slice the census never finishes", () => {
  // On Kia's (and so Škoda's) first page.
  const bazosRef = "225558540";
  const bazosMove = (cassette: Cassette, failure: RegExp): Move => ({
    source: bazosSource({ categories: ["kia", "skoda"], parts: 1 }),
    cassette,
    now: new Date("2026-10-25T17:00:00Z"),
    ref: bazosRef,
    left: "kia;part=0/1",
    failure,
  });
  const bazosPrice = { kind: "ListingPriceSeen", ref: bazosRef } as const;

  it("Bazoš: stays live when a later list page fails", async () => {
    const cassette = await bazos((first) => [first]);
    cassette.interactions = cassette.interactions.filter(
      ({ request }) => request.url !== "https://auto.bazos.cz/skoda/32/",
    );
    const { gone, sundays } = await twoStalledCensuses(
      bazosMove(cassette, /No recorded interaction for https:\/\/auto.bazos.cz\/skoda\/32\//),
    );
    for (const out of sundays) expect(out).toContainEqual(expect.objectContaining(bazosPrice));
    expect(gone).toBeNull();
  });

  it("Bazoš: stays live when its page comes out uneven and the read again gets HTTP 503", async () => {
    const cassette = await bazos((first) => {
      const body = first.response.body;
      const rows = body.split('<div class="inzeraty inzeratyflex">');
      const other = rows.findIndex((row, i) => i > 0 && !row.includes(`/inzerat/${bazosRef}/`));
      rows.splice(other, 1);
      const uneven = rows.join('<div class="inzeraty inzeratyflex">');
      return [
        { ...first, response: { ...first.response, body: uneven } },
        { ...first, response: { ...first.response, status: 503, body: "" } },
      ];
    });
    const { gone, sundays } = await twoStalledCensuses(
      bazosMove(cassette, /Bazoš returned HTTP 503 for https:\/\/auto.bazos.cz\/skoda\/$/),
    );
    for (const out of sundays) {
      expect(out.filter((o) => o.kind === "ListingPriceSeen")).toEqual([
        expect.objectContaining(bazosPrice),
      ]);
    }
    expect(gone).toBeNull();
  });

  it("TipCars: a new or demo one stays live when paging fails before its detail page", async () => {
    // On the new list's first page; the slice is paged before its detail pages, and has more
    // pages than the run may read.
    const ref = "9120302";
    const { gone, sundays } = await twoStalledCensuses({
      source: tipcarsSource({ slices: ["used:2000", "new"], maxPages: 1, sliceCap: 1_000_000 }),
      cassette: await loadCassette(fixture("tipcars", "incremental")),
      now: new Date("2026-10-25T17:36:00Z"),
      ref,
      left: "used:2000",
      failure: /TipCars new has more than 1 pages/,
    });
    for (const out of sundays) {
      expect(out).toContainEqual(expect.objectContaining({ kind: "ListingPriceSeen", ref }));
      expect(out.some((o) => o.kind === "ListingSeen" && o.ref === ref)).toBe(false);
    }
    expect(gone).toBeNull();
  });
});
