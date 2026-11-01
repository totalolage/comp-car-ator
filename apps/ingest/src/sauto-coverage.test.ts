// Sauto incremental, Source → Ledger through `harvest` and `record`: a walk that cannot show it
// met every listing dated since the last run fails, so the Ledger keeps what it read and the
// last run's cutoff, and the next run walks from there again. Listings that share a
// `sorting_date` may come in any order between two searches; the review's case below moves an
// unseen one above the next page while the listing at the page's end goes.
import type { Http } from "@cca/http";
import { type Ledger, openLedger, RunFailedError } from "@cca/ledger";
import { type SautoOptions, sautoSource, silentLogger } from "@cca/sources";
import { afterEach, expect, it } from "vitest";

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
