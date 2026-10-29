// The scheduled pipeline through its CLI-level functions: plan → harvestToLog → releaseRuns →
// restoreLedger, against both ReleaseStore adapters (a local directory and the GitHub adapter
// talking to a fake of the GitHub Releases API).
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLoader } from "@cca/bundle";
import { unpackBundle } from "@cca/bundle/node";
import { openCatalog } from "@cca/catalog";
import { createReplayHttp, loadCassette } from "@cca/http";
import { openLedger } from "@cca/ledger";
import { publish } from "@cca/publisher";
import { cnbSource, type Source } from "@cca/sources";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSETS, findRelease, type Manifest, releaseRuns, restoreLedger } from "./data-release.ts";
import { githubReleaseStore } from "./github-release-store.ts";
import { SAMPLE } from "./ingest.ts";
import { localReleaseStore, type ReleaseStore } from "./release-store.ts";
import { harvestToLog, recordLog } from "./run-log.ts";

const noHttp = createReplayHttp({ version: 1, interactions: [] });
const day = (date: string) => new Date(`${date}T03:00:00Z`);

/** A ReleaseStore plus test-only access to what it holds. */
interface Harness {
  store: ReleaseStore;
  /** Makes uploading this asset fail (once). */
  breakUpload(asset: string): void;
  tamper(tag: string, asset: string): Promise<void>;
  drafts(): Promise<number>;
  close(): Promise<void>;
}

async function localHarness(root: string): Promise<Harness> {
  const inner = localReleaseStore(root);
  let broken: string | null = null;
  return {
    store: {
      ...inner,
      // An asset that cannot be read part-way through, as a disk or network failure would.
      create: (tag, files, notes) => {
        const failing = broken;
        broken = null;
        return inner.create(
          tag,
          files.map((f) => (f.name === failing ? { ...f, path: join(root, "missing") } : f)),
          notes,
        );
      },
    },
    breakUpload: (asset) => {
      broken = asset;
    },
    tamper: (tag, asset) => writeFile(join(root, tag, asset), "tampered"),
    drafts: async () => (await readdir(root)).filter((e) => e.startsWith(".draft-")).length,
    close: async () => {},
  };
}

interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  upload_url: string;
  assets: { id: number; name: string; bytes: Buffer }[];
}

/** The slice of the GitHub REST API the adapter uses, in memory. */
interface GithubHarness extends Harness {
  /** The publishing update goes through but its response is lost (and the follow-up lookup). */
  losePublishResponse(alsoLookup: boolean): void;
  addRelease(tag: string, draft: boolean): void;
  tags(): string[];
}

async function githubHarness(): Promise<GithubHarness> {
  const releases: FakeRelease[] = [];
  let nextId = 1;
  let broken: string | null = null;
  let loseResponse = false;
  let loseLookup = false;
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  // Storage behind the asset redirect: another origin, which must not receive the token.
  const storage = createServer((req, res) => {
    const id = Number(req.url?.split("/").pop());
    const asset = releases.flatMap((r) => r.assets).find((a) => a.id === id);
    if (req.headers.authorization) return res.writeHead(400).end("token leaked to storage");
    res.writeHead(asset ? 200 : 404).end(asset?.bytes);
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? undefined : JSON.stringify(json));
    };
    if (req.headers.authorization !== "Bearer t0ken")
      return send(401, { message: "Bad credentials" });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const view = (r: FakeRelease) => ({
      ...r,
      assets: r.assets.map(({ id, name }) => ({ id, name })),
    });
    const repo = "/repos/totalolage/comp-car-ator";
    const route = (method: string, pattern: RegExp) =>
      req.method === method ? url.pathname.match(pattern) : null;
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && url.pathname === `${repo}/releases`) {
      // Pages of 2, newest first, linked like GitHub's.
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = [...releases].reverse();
      if (all.length > page * 2)
        res.setHeader(
          "link",
          `<${base}${repo}/releases?per_page=100&page=${page + 1}>; rel="next"`,
        );
      return send(200, all.slice((page - 1) * 2, page * 2).map(view));
    }
    m = route("GET", new RegExp(`^${repo}/releases/tags/(.+)$`));
    if (m) {
      const found = releases.find(
        (r) => !r.draft && r.tag_name === decodeURIComponent(m?.[1] ?? ""),
      );
      return found ? send(200, view(found)) : send(404);
    }
    if (req.method === "POST" && url.pathname === `${repo}/releases`) {
      const input = JSON.parse((await body(req)).toString());
      const id = nextId++;
      const release: FakeRelease = {
        id,
        tag_name: input.tag_name,
        draft: input.draft,
        prerelease: false,
        upload_url: `${base}/uploads/${id}/assets{?name,label}`,
        assets: [],
      };
      releases.push(release);
      return send(201, view(release));
    }
    m = route("POST", /^\/uploads\/(\d+)\/assets$/);
    if (m) {
      const release = releases.find((r) => r.id === Number(m?.[1]));
      const name = url.searchParams.get("name") ?? "";
      const bytes = await body(req);
      if (name === broken) {
        broken = null;
        return send(502, { message: "upload failed" });
      }
      if (!release || Number(req.headers["content-length"]) !== bytes.length) return send(400);
      release.assets.push({ id: nextId++, name, bytes });
      return send(201, {});
    }
    m = url.pathname.match(new RegExp(`^${repo}/releases/(\\d+)$`));
    if (m) {
      const index = releases.findIndex((r) => r.id === Number(m?.[1]));
      if (index < 0) return send(404);
      if (req.method === "DELETE") {
        releases.splice(index, 1);
        return send(204);
      }
      const release = releases[index] as FakeRelease;
      if (req.method === "GET") {
        if (loseLookup) {
          loseLookup = false;
          return res.socket?.destroy();
        }
        return send(200, view(release));
      }
      Object.assign(release, { draft: JSON.parse((await body(req)).toString()).draft });
      if (loseResponse) {
        loseResponse = false;
        return res.socket?.destroy();
      }
      return send(200, view(release));
    }
    m = route("GET", new RegExp(`^${repo}/releases/assets/(\\d+)$`));
    if (m) {
      const storagePort = (storage.address() as AddressInfo).port;
      res.writeHead(302, { location: `http://127.0.0.1:${storagePort}/blob/${m[1]}` });
      return res.end();
    }
    if (req.method === "DELETE" && url.pathname.startsWith(`${repo}/git/refs/tags/`))
      return send(204);
    return send(404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    store: githubReleaseStore({
      repo: "totalolage/comp-car-ator",
      token: "t0ken",
      tagPrefix: "data-",
      apiUrl: `http://127.0.0.1:${port}`,
    }),
    breakUpload: (asset) => {
      broken = asset;
    },
    losePublishResponse: (alsoLookup) => {
      loseResponse = true;
      loseLookup = alsoLookup;
    },
    addRelease: (tag, draft) => {
      releases.push({
        id: nextId++,
        tag_name: tag,
        draft,
        prerelease: false,
        upload_url: "",
        assets: [],
      });
    },
    tags: () => releases.map((r) => r.tag_name),
    tamper: async (tag, asset) => {
      const found = releases.find((r) => r.tag_name === tag)?.assets.find((a) => a.name === asset);
      if (found) found.bytes = Buffer.from("tampered");
    },
    drafts: async () => releases.filter((r) => r.draft).length,
    close: async () => {
      server.closeAllConnections();
      storage.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => storage.close(resolve));
    },
  };
}

/** A full-census Source that yields a listing per ref and SliceDone per slice, failing in `failIn`. */
function census(slices: Record<string, string[]>, failIn?: string): Source {
  return {
    id: "autoscout24-de",
    scope: "de",
    async *harvest(ctx) {
      for (const [slice, refs] of Object.entries(slices)) {
        if (ctx.checkpoint.sliceDoneAt(slice)) continue;
        for (const ref of refs)
          yield {
            kind: "ListingSeen",
            ref,
            // A "bad" ref has no URL, which the Ledger rejects.
            url: ref.startsWith("bad") ? "" : `https://www.autoscout24.de/angebote/${ref}`,
            market: "DE",
            condition: "used",
            vehicle: { make: "VW", model: "Golf" },
            price: { amount: 15_000, currency: "EUR" },
            priceBasis: "gross",
            seller: "dealer",
            photos: [],
          };
        if (slice === failIn) throw new Error("HTTP 503");
        yield { kind: "SliceDone", slice };
      }
    },
  };
}

describe.each([
  ["local directory", localHarness],
  ["GitHub", githubHarness],
] as const)("data releases (%s store)", (_, makeHarness) => {
  let dir: string;
  let h: Harness;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cca-release-"));
    h = await makeHarness(join(dir, "store"));
  });
  afterEach(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** One scheduled day: each harvest job restores the Ledger and writes a log; one release. */
  async function ingestDay(now: Date, sources: Source[], init = false) {
    const base = (await findRelease(h.store))?.tag ?? null;
    const logs: string[] = [];
    for (const source of sources) {
      const job = await mkdtemp(join(dir, "job-"));
      const ledgerPath = join(job, "ledger.sqlite");
      await restoreLedger(h.store, ledgerPath, { base, init });
      const ledger = openLedger(ledgerPath);
      const http =
        source.id === "cnb" ? createReplayHttp(await loadCassette(SAMPLE.cnbCassette)) : noHttp;
      const mode = source.id === "cnb" ? "incremental" : "full";
      const out = join(job, `${source.id}.ndjson`);
      await harvestToLog({ ledger, source, http, mode, now, out });
      ledger.close();
      logs.push(out);
    }
    return releaseRuns({
      store: h.store,
      logs,
      work: join(dir, `work-${now.getTime()}`),
      now,
      base,
      init,
    });
  }

  async function restored(tag?: string) {
    const path = join(dir, `restored-${Math.random()}.sqlite`);
    expect((await restoreLedger(h.store, path))?.tag).toBe(tag ?? (await h.store.list())[0]?.tag);
    return openLedger(path);
  }

  it("refuses to start a new Ledger unless told it is the first run", async () => {
    await expect(restoreLedger(h.store, join(dir, "l.sqlite"))).rejects.toThrow(/--init/);
    // A Ledger left by an earlier attempt in the same scratch directory is not reused.
    await writeFile(join(dir, "l.sqlite"), "left over");
    expect(await restoreLedger(h.store, join(dir, "l.sqlite"), { init: true })).toBeNull();
    await expect(readFile(join(dir, "l.sqlite"))).rejects.toThrow(/ENOENT/);
  });

  it("releases the Ledger and the Bundle it publishes, and the next run builds on them", async () => {
    const first = await ingestDay(SAMPLE.now, [cnbSource()], true);
    expect(first.tag).toBe("data-20261024-160000");
    expect(await h.store.list()).toEqual([
      { tag: first.tag, assets: [ASSETS.bundle, ASSETS.ledger, ASSETS.manifest].sort() },
    ]);

    const ledger = await restored(first.tag);
    expect(ledger.snapshot().fx.EUR?.czkPerUnit).toBe(24.335);
    const expectedBundle = new Map(publish(ledger, { now: SAMPLE.now }));
    ledger.close();
    await h.store.download(first.tag, ASSETS.bundle, join(dir, "bundle.json.gz"));
    const bundle = unpackBundle(await readFile(join(dir, "bundle.json.gz")));
    expect(bundle).toEqual(expectedBundle);
    expect((await openCatalog(memoryLoader(bundle))).manifest.fx.EUR?.czkPerUnit).toBe(24.335);

    const next = await ingestDay(day("2026-10-26"), [census({ A: ["a1"] })]);
    await h.store.download(next.tag, ASSETS.manifest, join(dir, "manifest.json"));
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest).toMatchObject({ tag: next.tag, previous: first.tag });
    expect(manifest.runs).toMatchObject([{ source: "autoscout24-de", mode: "full" }]);
    const both = await restored(next.tag);
    expect(both.snapshot().fx.EUR?.czkPerUnit).toBe(24.335);
    expect([...both.snapshot().listings()].map((l) => l.ref)).toEqual(["a1"]);
    both.close();
  });

  it("records a failed harvest as a failed run, so the census resumes the next day", async () => {
    const failed = await ingestDay(
      day("2026-10-10"),
      [census({ A: ["a1", "a2"], B: ["b1"] }, "B")],
      true,
    );
    expect(failed.runs[0]).toMatchObject({
      error: expect.stringContaining("HTTP 503"),
      summary: {
        recorded: { ListingSeen: 3, SliceDone: 1 },
        newListings: 3,
        census: "incomplete",
      },
    });
    expect((await findRelease(h.store))?.manifest.runs).toEqual(failed.runs);
    const after = await restored();
    const checkpoint = after.checkpoint("autoscout24-de", "de");
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-10"));
    expect(checkpoint.sliceDoneAt("B")).toBeNull();
    expect(checkpoint.lastRunAt).toBeNull();
    after.close();

    expect((await findRelease(h.store))?.manifest.lastCensus).toEqual({});
    const resumed = await ingestDay(day("2026-10-11"), [census({ A: ["a1", "a2"], B: ["b1"] })]);
    expect(resumed.runs[0]?.summary).toMatchObject({ census: "applied", gone: 0 });
    expect((await findRelease(h.store))?.manifest.lastCensus).toEqual({
      "autoscout24-de": "2026-10-11T03:00:00.000Z",
    });
    const ledger = await restored();
    expect(ledger.checkpoint("autoscout24-de", "de").lastRunAt).toEqual(day("2026-10-11"));
    expect([...ledger.snapshot().listings()].map((l) => l.ref).sort()).toEqual(["a1", "a2", "b1"]);
    ledger.close();
  });

  it("refuses run logs that started before their base was released", async () => {
    const first = await ingestDay(day("2026-10-10"), [census({ A: ["a1"] })], true);
    await expect(ingestDay(day("2026-10-09"), [census({ A: ["a1"] })])).rejects.toThrow(
      /before data-20261010-030000 was released; these run logs are stale/,
    );
    expect((await findRelease(h.store))?.tag).toBe(first.tag);
  });

  it("counts a complete Census with rejections as taken, so it is not retried daily", async () => {
    const run = await ingestDay(day("2026-10-11"), [census({ A: ["a1", "bad1"] })], true);
    expect(run.runs[0]?.summary).toMatchObject({ census: "skipped-rejections" });
    expect((await findRelease(h.store))?.manifest.lastCensus).toEqual({
      "autoscout24-de": "2026-10-11T03:00:00.000Z",
    });
  });

  it.each(["{broken", '{"end":"invalid"}'])(
    "refuses to publish a malformed run log as a failed harvest (%s)",
    async (tail) => {
      const out = join(dir, "broken.ndjson");
      await writeFile(
        out,
        `${JSON.stringify({ run: { source: "sauto", mode: "full", startedAt: day("2026-10-10") } })}\n${tail}\n`,
      );
      await expect(
        releaseRuns({
          store: h.store,
          logs: [out],
          work: join(dir, "work"),
          now: day("2026-10-10"),
          base: null,
          init: true,
        }),
      ).rejects.toThrow();
      expect(await findRelease(h.store)).toBeNull();
    },
  );

  it("leaves the previous release as the latest when an upload fails midway", async () => {
    const first = await ingestDay(SAMPLE.now, [cnbSource()], true);
    h.breakUpload(ASSETS.bundle);
    await expect(ingestDay(day("2026-10-26"), [census({ A: ["a1"] })])).rejects.toThrow();
    expect((await h.store.list()).map((r) => r.tag)).toEqual([first.tag]);
    expect(await h.drafts()).toBe(0);
    const ledger = await restored(first.tag);
    expect([...ledger.snapshot().listings()]).toEqual([]);
    ledger.close();
  });

  it("refuses to release run logs harvested against a release that is no longer the latest", async () => {
    const first = await ingestDay(SAMPLE.now, [cnbSource()], true);
    const out = join(dir, "stale.ndjson");
    const ledger = openLedger(":memory:");
    await harvestToLog({
      ledger,
      source: census({ A: ["a1"] }),
      http: noHttp,
      mode: "full",
      now: day("2026-10-26"),
      out,
    });
    ledger.close();
    const second = await ingestDay(day("2026-10-27"), [census({ A: ["a2"] })]);
    await expect(
      releaseRuns({
        store: h.store,
        logs: [out],
        work: join(dir, "stale"),
        now: day("2026-10-28"),
        base: first.tag,
      }),
    ).rejects.toThrow(/stale/);
    expect((await h.store.list()).map((r) => r.tag)).toEqual([second.tag, first.tag]);
  });

  it("refuses to release a retried first run's logs once a data release exists", async () => {
    const out = join(dir, "first.ndjson");
    const ledger = openLedger(":memory:");
    await harvestToLog({
      ledger,
      source: census({ A: ["a1"] }),
      http: noHttp,
      mode: "full",
      now: day("2026-10-26"),
      out,
    });
    ledger.close();
    const first = () =>
      releaseRuns({
        store: h.store,
        logs: [out],
        work: join(dir, `first-${Math.random()}`),
        now: day("2026-10-26"),
        base: null,
        init: true,
      });
    const released = await first();
    // A re-run of the failed-looking first ingest: same plan (no base), same run logs.
    await expect(first()).rejects.toThrow(/Expected no data release/);
    await expect(
      restoreLedger(h.store, join(dir, "l.sqlite"), { base: null, init: true }),
    ).rejects.toThrow(/Expected no data release/);
    expect((await h.store.list()).map((r) => r.tag)).toEqual([released.tag]);
  });

  it("refuses a Ledger asset that does not match its manifest", async () => {
    const { tag } = await ingestDay(SAMPLE.now, [cnbSource()], true);
    await h.tamper(tag, ASSETS.ledger);
    await expect(restoreLedger(h.store, join(dir, "l.sqlite"))).rejects.toThrow(/sha256/);
  });

  it("refuses a retention that would prune the release it makes", async () => {
    for (const keep of [0, Number.NaN])
      await expect(
        releaseRuns({ store: h.store, logs: [], work: dir, now: SAMPLE.now, base: null, keep }),
      ).rejects.toThrow(/keep/);
    expect(await h.store.list()).toEqual([]);
  });

  it("keeps the newest data releases", async () => {
    for (const date of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
      const logs = [join(dir, `${date}.ndjson`)];
      const ledger = openLedger(":memory:");
      await harvestToLog({
        ledger,
        source: census({}),
        http: noHttp,
        mode: "full",
        now: day(date),
        out: logs[0] as string,
      });
      ledger.close();
      await releaseRuns({
        store: h.store,
        logs,
        work: join(dir, date),
        now: day(date),
        base: (await findRelease(h.store))?.tag ?? null,
        init: true,
        keep: 2,
      });
    }
    expect((await h.store.list()).map((r) => r.tag)).toEqual([
      "data-20261022-030000",
      "data-20261021-030000",
    ]);
  });
});

describe("GitHub release store", () => {
  let dir: string;
  let h: GithubHarness;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cca-gh-"));
    h = await githubHarness();
    await writeFile(join(dir, "a.txt"), "a");
  });
  afterEach(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  const create = (tag: string) =>
    h.store.create(tag, [{ name: "a.txt", path: join(dir, "a.txt") }]);

  it("keeps a release whose publish went through when the response was lost", async () => {
    h.losePublishResponse(false);
    await create("data-1");
    expect(await h.store.list()).toEqual([{ tag: "data-1", assets: ["a.txt"] }]);
  });

  it("never deletes a release whose state it could not check", async () => {
    h.losePublishResponse(true);
    await expect(create("data-1")).rejects.toThrow();
    expect(h.tags()).toEqual(["data-1"]);
    expect(await h.store.list()).toEqual([{ tag: "data-1", assets: ["a.txt"] }]);
  });

  it("cleans up only its own unfinished drafts, and sees past the first page", async () => {
    h.addRelease("v1.0.0", true);
    h.addRelease("data-0", true);
    for (const tag of ["data-1", "data-2", "data-3"]) await create(tag);
    expect(h.tags()).toEqual(["v1.0.0", "data-1", "data-2", "data-3"]);
    expect((await h.store.list()).map((r) => r.tag)).toEqual(["data-3", "data-2", "data-1"]);
    await h.store.delete("data-1");
    expect(h.tags()).toEqual(["v1.0.0", "data-2", "data-3"]);
  });
});

describe("run logs", () => {
  it("rejects, rather than reporting a failed harvest, when the log cannot be written", async () => {
    const ledger = openLedger(":memory:");
    const out = join(tmpdir(), "cca-missing-dir", "x", "cnb.ndjson");
    const run = harvestToLog({
      ledger,
      source: census({ A: ["a1"] }),
      http: noHttp,
      mode: "full",
      now: day("2026-10-26"),
      out,
    });
    await expect(run).rejects.toThrow(/ENOENT/);
    ledger.close();
  });

  /** Wraps a Source so `controller` aborts when it reaches observation `at`; it never checks. */
  function abortingAt(source: Source, at: number, controller: AbortController): Source {
    return {
      ...source,
      async *harvest(ctx) {
        let index = 0;
        for await (const observation of source.harvest(ctx)) {
          if (index++ === at) controller.abort();
          yield observation;
        }
        if (index === at) controller.abort();
      },
    };
  }

  /** Harvests into a log until the deadline, then records the log into a fresh Ledger. */
  async function harvestPastDeadline(slices: Record<string, string[]>, abortAt: number) {
    const dir = await mkdtemp(join(tmpdir(), "cca-deadline-"));
    const out = join(dir, "run.ndjson");
    const controller = new AbortController();
    const ledger = openLedger(":memory:");
    const report = await harvestToLog({
      ledger,
      source: abortingAt(census(slices), abortAt, controller),
      http: noHttp,
      mode: "full",
      now: day("2026-10-26"),
      out,
      signal: controller.signal,
    });
    await expect(recordLog(ledger, out)).rejects.toThrow(/harvest failed/);
    await rm(dir, { recursive: true, force: true });
    return { report, ledger };
  }

  it("fails a harvest past its deadline even when the Source ignores the signal", async () => {
    // Aborts as the Source reaches b1: b1 is kept, slice B never finishes.
    const { report, ledger } = await harvestPastDeadline({ A: ["a1"], B: ["b1"] }, 2);
    expect(report).toMatchObject({ observations: 3, error: expect.stringMatching(/abort/i) });
    const checkpoint = ledger.checkpoint("autoscout24-de", "de");
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-26"));
    expect(checkpoint.sliceDoneAt("B")).toBeNull();
    expect(checkpoint.lastRunAt).toBeNull();
    expect([...ledger.snapshot().listings()].map((l) => l.ref).sort()).toEqual(["a1", "b1"]);
    ledger.close();
  });

  it("never completes a census whose deadline passed after its last observation", async () => {
    const { report, ledger } = await harvestPastDeadline({ A: ["a1"] }, 2);
    expect(report).toMatchObject({ observations: 2, error: expect.stringMatching(/abort/i) });
    const checkpoint = ledger.checkpoint("autoscout24-de", "de");
    expect(checkpoint.sliceDoneAt("A")).toEqual(day("2026-10-26"));
    expect(checkpoint.lastRunAt).toBeNull();
    ledger.close();
  });
});
