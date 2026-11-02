// Sauto incremental, Source → Ledger through `harvest` and `record`: the walk covers the whole
// order, so a listing without a well-formed date is read wherever it sits, and a walk that
// cannot show it met every listing fails, so the Ledger keeps what it read and the last run's
// cutoff, and the next run walks from there again. Listings that share a
// `sorting_date` may come in any order between two searches; the review's case below moves an
// unseen one above the next page while the listing at the page's end goes.
import type { Http } from "@cca/http";
import { type Ledger, openLedger, RunFailedError } from "@cca/ledger";
import { type SautoOptions, sautoSource, silentLogger } from "@cca/sources";
import { afterEach, describe, expect, it } from "vitest";

type Item = Record<string, unknown>;

const lastRun = new Date("2026-10-24T03:00:00Z");
const now = new Date("2026-10-25T13:27:00Z");
const tie = "2026-10-25T10:00:00";
const old = "2020-01-01T00:00:00";
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const car = (id: number, fields: Item = {}): Item => ({
  id,
  price: 100_000,
  create_date: "2026-10-25T09:00:00",
  sorting_date: tie,
  manufacturing_date: "2021-01-01",
  manufacturer_cb: { name: "Dacia", seo_name: "dacia", value: 15 },
  model_cb: { name: "Spring", seo_name: "spring", value: 9057 },
  condition_cb: { name: "Nové", value: 1 },
  ...fields,
});

let ledger: Ledger;
afterEach(() => ledger?.close());

/** A synthetic Sauto API: `search` answers each search; a detail serves its search item. */
function site(search: (query: URLSearchParams) => { total: number; results: Item[] }): Http {
  const served = new Map<string, Item>();
  return {
    async get(request) {
      const url = typeof request === "string" ? request : request.url;
      const { pathname, searchParams } = new URL(url);
      const id = pathname.split("/").pop() ?? "";
      let body: unknown;
      if (id === "search") {
        const page = search(searchParams);
        for (const item of page.results) served.set(String(item.id), item);
        body = { pagination: { total: page.total }, results: page.results };
      } else {
        body = { result: served.get(id) };
      }
      return { url, status: 200, headers: {}, body: JSON.stringify(body), tier: "T0" };
    },
  };
}

/** One incremental Run recorded as the ingest records it, its checkpoint the Ledger's. */
function record(http: Http, options: SautoOptions) {
  const source = sautoSource(options);
  return ledger.record(
    { source: source.id, mode: "incremental", startedAt: now },
    source.harvest({
      http,
      mode: "incremental",
      checkpoint: ledger.checkpoint(source.id),
      now,
      log: silentLogger,
      signal: new AbortController().signal,
    }),
  );
}

const refs = () =>
  [...ledger.snapshot().listings()].map((l) => l.ref).sort((a, b) => Number(a) - Number(b));

/**
 * The review's small-page case at `pageSize`: 30 listings share one date (and a price, unless
 * `price` sets one each); once the first page is read, the unseen listing just past it moves to
 * the top of the order.
 * `bands` serves the price halves the walk asks for; without it this API ignores them.
 */
function reordered(
  pageSize: number,
  {
    bands = false,
    price = () => 100_000,
  }: { bands?: boolean; price?: (id: number) => number } = {},
) {
  const list = range(1, 30).map((id) => car(id, { price: price(id) }));
  let searches = 0;
  return site((q) => {
    if (searches++ === 1) {
      const [moved] = list.splice(pageSize, 1);
      list.unshift(moved as Item);
    }
    const offset = Number(q.get("offset"));
    const from = Number(q.get("price_from") ?? 0);
    const to = Number(q.get("price_to") ?? Number.POSITIVE_INFINITY);
    const inBand = bands
      ? list.filter((item) => (item.price as number) >= from && (item.price as number) <= to)
      : list;
    return { total: inBand.length, results: inBand.slice(offset, offset + pageSize) };
  });
}

// Pages of 1 and 2 cannot step on at all; pages of 3 to 20 overlap by one listing.
it.each([1, 2, 3, 4, 10, 20])(
  "pages of %i: a tie that reorders past an unseen listing fails the run, keeping the last run's cutoff",
  async (pageSize) => {
    ledger = openLedger(":memory:");
    await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
    const failure = await record(reordered(pageSize), { pageSize }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RunFailedError);
    expect(String((failure as RunFailedError).cause)).toMatch(/cannot be split/);
    expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
  },
);

it.each([1, 2, 3, 4, 10, 20])(
  "pages of %i: where price halves split the tie, every listing is read and the cutoff advances",
  async (pageSize) => {
    ledger = openLedger(":memory:");
    await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
    const http = reordered(pageSize, { bands: true, price: (id) => 100_000 + id * 1_000 });
    const summary = await record(http, { pageSize });
    expect(summary.newListings).toBe(30);
    expect(refs()).toEqual(range(1, 30).map(String));
    expect(ledger.checkpoint("sauto").lastRunAt).toEqual(now);
  },
);

it("a Sauto walk that cannot place listings sharing a date fails, keeping its reads and the last run's cutoff", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
  // Pages of 20, overlap 1: 1–20 share a date; by the page at 19, unseen 21 has moved above
  // it and 20 is gone; the page at 38 is older than the last run. This API ignores the price
  // halves that could split the tie, so nothing shows 21 was met.
  const http = site((q) => {
    const offset = Number(q.get("offset"));
    if (offset === 0) return { total: 60, results: range(1, 20).map((id) => car(id)) };
    if (offset === 19) return { total: 60, results: [19, ...range(22, 40)].map((id) => car(id)) };
    return { total: 60, results: [car(40, { sorting_date: old }), car(41, { sorting_date: old })] };
  });
  const failure = await record(http, { pageSize: 20 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RunFailedError);
  expect(String((failure as RunFailedError).cause)).toMatch(/fill its page/);
  expect((failure as RunFailedError).summary.newListings).toBe(20);
  expect(refs()).toEqual(range(1, 20).map(String));
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
});

it("a Sauto walk that steps above a tie meets the listing that moved inside it, and advances the cutoff", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  // 1–15 a second apart, 16–25 one tie, 26–40 older than the last run. After the first page,
  // unseen 21 moves to the tie's top: the page at the old stride would still repeat 19 and 20.
  const list = [
    ...range(1, 15).map((id) =>
      car(id, {
        sorting_date: new Date(Date.UTC(2026, 9, 25, 11) - id * 1000).toISOString().slice(0, 19),
      }),
    ),
    ...range(16, 25).map((id) => car(id)),
    ...range(26, 40).map((id) => car(id, { sorting_date: old })),
  ];
  let searches = 0;
  const http = site((q) => {
    const offset = Number(q.get("offset"));
    if (searches++ === 1) {
      const [moved] = list.splice(20, 1);
      list.splice(15, 0, moved as Item);
    }
    return { total: list.length, results: list.slice(offset, offset + 20) };
  });
  const summary = await record(http, { pageSize: 20 });
  expect(summary.newListings).toBe(25);
  expect(refs()).toEqual(range(1, 25).map(String));
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(now);
});

it("a Sauto walk that loses its place after progress fails, keeping its reads and the last run's cutoff", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  // 400 listings a second apart. Before the 11th search, 2–201 go: the order shifted up
  // further than three pages back, so no page shows the walk where it was.
  const dated = (id: number) =>
    car(id, {
      sorting_date: new Date(Date.UTC(2026, 9, 25, 11) - id * 1000).toISOString().slice(0, 19),
    });
  let list = range(1, 400).map(dated);
  const offsets: number[] = [];
  const http = site((q) => {
    const offset = Number(q.get("offset"));
    offsets.push(offset);
    if (offsets.length === 11) list = [dated(1), ...range(202, 400).map(dated)];
    return { total: list.length, results: list.slice(offset, offset + 20) };
  });
  const failure = await record(http, { pageSize: 20 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RunFailedError);
  expect(String((failure as RunFailedError).cause)).toMatch(
    /lost its place in the order at offset 123/,
  );
  expect(offsets.slice(-4)).toEqual([180, 161, 142, 123]);
  // Ten pages read before the order moved, and kept.
  expect(refs()).toEqual(range(1, 182).map(String));
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
});

/** A synthetic Sauto API over `list` (newest first) that serves the pages and price bands asked for. */
function banded(list: Item[]) {
  return site((q) => {
    const offset = Number(q.get("offset"));
    const from = Number(q.get("price_from") ?? 0);
    const to = Number(q.get("price_to") ?? Number.POSITIVE_INFINITY);
    const inBand = q.has("price_from")
      ? list.filter((item) => (item.price as number) >= from && (item.price as number) <= to)
      : list;
    return { total: inBand.length, results: inBand.slice(offset, offset + Number(q.get("limit"))) };
  });
}

/** `sorting_date` the given seconds before 11:00 on 2026-10-25, as the site writes it. */
const secondsBefore = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 25, 11) - seconds * 1000).toISOString().slice(0, 19);
/** A `sorting_date` the given seconds before 2020, long before the last run. */
const longBefore = (seconds: number) =>
  new Date(Date.UTC(2020, 0, 1) - seconds * 1000).toISOString().slice(0, 19);

// The review's case: listings without a well-formed date sorted past the listings older than
// the last run. Nothing shows where Sauto would sort one, so the walk reads the whole order.
describe.each([
  ["without a date", undefined],
  ["with a malformed date", "2026-10-25 10:00"],
])("a Sauto listing %s past the cutoff", (_, date) => {
  it.each([1, 2, 3, 4, 10, 20, 100, 1_000])(
    "pages of %i: it is read, and the cutoff advances",
    async (pageSize) => {
      ledger = openLedger(":memory:");
      await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
      // 1–50 since the last run, 51–150 older; 200 sits among the older ones, 201 at the end.
      const price = (id: number) => 100_000 + id * 1_000;
      const list = [
        ...range(1, 50).map((id) => car(id, { price: price(id), sorting_date: secondsBefore(id) })),
        ...range(51, 150).map((id) => car(id, { price: price(id), sorting_date: old })),
      ];
      list.splice(80, 0, car(200, { price: price(200), sorting_date: date }));
      list.push(car(201, { price: price(201), sorting_date: date }));
      const summary = await record(banded(list), { pageSize });
      expect(refs()).toEqual([...range(1, 50), 200, 201].map(String));
      expect(summary.newListings).toBe(52);
      expect(ledger.checkpoint("sauto").lastRunAt).toEqual(now);
    },
  );

  it("at the default page size, one past the first page of 1,000 is read", async () => {
    ledger = openLedger(":memory:");
    await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
    const list = range(1, 1_100).map((id) =>
      car(id, { sorting_date: id <= 50 ? secondsBefore(id) : longBefore(id) }),
    );
    list.push(car(1_101, { sorting_date: date }));
    const offsets: string[] = [];
    const api = banded(list);
    const http: Http = {
      get(request) {
        const url = typeof request === "string" ? request : request.url;
        if (url.includes("/search?")) offsets.push(new URL(url).searchParams.get("offset") ?? "");
        return api.get(request);
      },
    };
    await record(http, {});
    // Pages at 0 and 949 (overlapping by a twentieth), then the top again.
    expect(offsets).toEqual(["0", "949", "0"]);
    expect(refs()).toEqual([...range(1, 50), 1_101].map(String));
    expect(ledger.checkpoint("sauto").lastRunAt).toEqual(now);
  });

  it("met before a walk fails, it is read, and the last run's cutoff stays", async () => {
    ledger = openLedger(":memory:");
    await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
    // Pages of 20: 1–10 since the last run, then older listings with 30 among them; the page
    // after is not newest first, so the walk cannot show it met the rest.
    const http = site((q) => {
      const offset = Number(q.get("offset"));
      if (offset === 0) {
        return {
          total: 60,
          results: [
            ...range(1, 10).map((id) => car(id, { sorting_date: secondsBefore(id) })),
            ...range(11, 19).map((id) => car(id, { sorting_date: old })),
            car(30, { sorting_date: date }),
          ],
        };
      }
      return {
        total: 60,
        results: range(40, 59).map((id) => car(id, { sorting_date: secondsBefore(-id) })),
      };
    });
    const failure = await record(http, { pageSize: 20 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RunFailedError);
    expect(String((failure as RunFailedError).cause)).toMatch(/not newest first/);
    expect(refs()).toEqual([...range(1, 10), 30].map(String));
    expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
  });
});

/** Pages of 20 over 1–10 since the last run and 11–60 older; `change` runs before search `n`. */
function moving(
  change: (n: number, list: Item[]) => Item[],
  fields: (id: number) => Item = () => ({}),
) {
  let list = [
    ...range(1, 10).map((id) => car(id, { sorting_date: secondsBefore(id), ...fields(id) })),
    ...range(11, 60).map((id) => car(id, { sorting_date: longBefore(id), ...fields(id) })),
  ];
  let n = 0;
  return site((q) => {
    list = change(++n, list);
    const offset = Number(q.get("offset"));
    return { total: list.length, results: list.slice(offset, offset + 20) };
  });
}

it("a Sauto walk that ends short of its band's count fails, keeping its reads and the last run's cutoff", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  // 70 has no date, so no date shows where it goes: before the third search it moves from the
  // end to just past the first page, which the walk has passed. Every page still follows on.
  const undated = car(70, { sorting_date: undefined });
  const http = moving((n, list) => {
    if (n === 1) return [...list, undated];
    if (n === 3) return [...list.slice(0, 25), undated, ...list.slice(25, -1)];
    return list;
  });
  const failure = await record(http, { pageSize: 20 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RunFailedError);
  expect(String((failure as RunFailedError).cause)).toMatch(/met 60 of the 61 listings in band -/);
  expect(refs()).toEqual(range(1, 10).map(String));
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
});

it("a Sauto listing topped up from below the walk is read from the top, and the cutoff advances", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  // Before the second search, unseen 50 is topped up: it leaves the part still to walk.
  const http = moving((n, list) => {
    if (n !== 2) return list;
    const at = list.findIndex((item) => item.id === 50);
    const [topped] = list.splice(at, 1);
    return [{ ...topped, sorting_date: secondsBefore(-1) }, ...list];
  });
  const summary = await record(http, { pageSize: 20 });
  expect(summary.newListings).toBe(11);
  expect(refs()).toEqual([...range(1, 10), 50].map(String));
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(now);
});

it("a Sauto page shorter than its total says fails the walk, keeping the last run's cutoff", async () => {
  ledger = openLedger(":memory:");
  await ledger.record({ source: "sauto", mode: "incremental", startedAt: lastRun }, []);
  const list = range(1, 30).map((id) => car(id, { sorting_date: secondsBefore(id) }));
  const http = site((q) => {
    const offset = Number(q.get("offset"));
    // The page at 18 serves 5 of the 12 results past it.
    return { total: 30, results: list.slice(offset, offset === 0 ? 20 : offset + 5) };
  });
  const failure = await record(http, { pageSize: 20 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RunFailedError);
  expect(String((failure as RunFailedError).cause)).toMatch(/offset 18 holds 5 of the 12 results/);
  expect(ledger.checkpoint("sauto").lastRunAt).toEqual(lastRun);
});
