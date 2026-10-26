import { getEventListeners } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveHttp,
  createReplayHttp,
  type Http,
  HttpBlockedError,
  HttpNetworkError,
  type Page,
  recordingHttp,
} from "./index.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Writes `count` pieces of `size` bytes, each filled with its index, one per event-loop turn or
 * `gapMs` apart.
 */
function pieces(
  res: ServerResponse,
  count: number,
  size: number,
  onClose?: () => void,
  gapMs?: number,
) {
  res.writeHead(200, { "content-type": "text/csv" });
  let i = 0;
  res.on("close", () => onClose?.());
  const next = () => {
    if (i === count) return void res.end();
    res.write(Buffer.alloc(size, i++ % 256), () =>
      gapMs === undefined ? setImmediate(next) : setTimeout(next, gapMs),
    );
  };
  next();
}

async function read(page: Page): Promise<{ bytes: Buffer; chunks: number }> {
  const parts: Uint8Array[] = [];
  for await (const chunk of page.chunks as AsyncIterable<Uint8Array>) parts.push(chunk);
  return { bytes: Buffer.concat(parts), chunks: parts.length };
}

const live = (): Http => createLiveHttp({ hostIntervalMs: 0 });

describe("streamed responses", () => {
  it("delivers a large body in chunks without buffering it", async () => {
    const url = await serve((_req, res) => pieces(res, 40, 50_000));
    const page = await live().get({ url, stream: true });
    expect(page.status).toBe(200);
    expect(page.body).toBe("");
    expect(page.bytes).toBeUndefined();
    const { bytes, chunks } = await read(page);
    expect(bytes.length).toBe(2_000_000);
    expect(chunks).toBeGreaterThan(1);
    expect(bytes[49_999]).toBe(0);
    expect(bytes[50_000]).toBe(1);
  });

  it("retries a 5xx before the first byte, then streams", async () => {
    let calls = 0;
    const url = await serve((_req, res) => {
      if (calls++ === 0) return void res.writeHead(503).end("busy");
      pieces(res, 3, 1000);
    });
    const page = await live().get({ url, stream: true });
    expect(calls).toBe(2);
    expect((await read(page)).bytes.length).toBe(3000);
  });

  it("detects a challenge page on a stream request", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403, { "content-type": "text/html" }).end("<title>Just a moment...</title>");
    });
    await expect(live().get({ url, stream: true })).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("reads an error page in full and still serves it as chunks", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" }).end("no such report");
    });
    const page = await live().get({ url, stream: true });
    expect(page.status).toBe(404);
    expect(page.body).toBe("no such report");
    expect((await read(page)).bytes.toString()).toBe("no such report");
  });

  it("stops with the abort reason and closes the download when aborted mid-stream", async () => {
    let closed: () => void = () => {};
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => pieces(res, 10_000, 10_000, closed));
    const controller = new AbortController();
    const page = await live().get({ url, stream: true, signal: controller.signal });
    const reason = new Error("stop");
    const consume = (async () => {
      let n = 0;
      for await (const _chunk of page.chunks as AsyncIterable<Uint8Array>) {
        if (++n === 3) controller.abort(reason);
      }
    })();
    await expect(consume).rejects.toBe(reason);
    await serverClosed;
  });

  it("closes the download when the consumer stops reading", async () => {
    let closed: () => void = () => {};
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => pieces(res, 10_000, 10_000, closed));
    const page = await live().get({ url, stream: true });
    for await (const _chunk of page.chunks as AsyncIterable<Uint8Array>) break;
    await serverClosed;
  });

  it("closes the download when the consumer gives up before reading", async () => {
    let closed: () => void = () => {};
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => pieces(res, 10_000, 10_000, closed));
    const page = await recordingHttp(live()).http.get({ url, stream: true });
    await (page.chunks as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]().return?.();
    await serverClosed;
  });

  it("records a streamed body into a cassette that replays as several chunks", async () => {
    const url = await serve((_req, res) => pieces(res, 5, 40_000));
    const recorder = recordingHttp(live());
    const original = await read(await recorder.http.get({ url, stream: true }));

    const replay = createReplayHttp(recorder.cassette());
    const page = await replay.get({ url, stream: true });
    expect(page.body).toBe("");
    const replayed = await read(page);
    expect(replayed.bytes.equals(original.bytes)).toBe(true);
    expect(replayed.chunks).toBe(4); // 200 KB in 64 KiB pieces
    // The same recording serves a non-stream request too.
    expect((await replay.get({ url, binary: true })).bytes?.length).toBe(200_000);
  });

  it("limits each chunk read by the timeout, not the whole download", async () => {
    // 6 pieces 150 ms apart take ~750 ms, well past the 300 ms timeout.
    const url = await serve((_req, res) => pieces(res, 6, 1000, undefined, 150));
    const http = createLiveHttp({ hostIntervalMs: 0, timeoutMs: 300 });
    expect((await read(await http.get({ url, stream: true }))).bytes.length).toBe(6000);
  });

  it("stops with a TimeoutError and closes the download when the body stalls", async () => {
    let closed: () => void = () => {};
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/csv" }).write("first");
    });
    const http = createLiveHttp({ hostIntervalMs: 0, timeoutMs: 200 });
    const page = await http.get({ url, stream: true });
    await expect(read(page)).rejects.toMatchObject({ name: "TimeoutError" });
    await serverClosed;
  });

  it("does not count time the consumer spends between reads", async () => {
    const url = await serve((_req, res) => pieces(res, 3, 1000));
    const http = createLiveHttp({ hostIntervalMs: 0, timeoutMs: 100 });
    const page = await http.get({ url, stream: true });
    let total = 0;
    for await (const chunk of page.chunks as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(total).toBe(3000);
  });

  it("times out waiting for the headers", async () => {
    const url = await serve(() => {});
    const http = createLiveHttp({ hostIntervalMs: 0, timeoutMs: 200, attempts: 1 });
    await expect(http.get({ url, stream: true })).rejects.toBeInstanceOf(HttpNetworkError);
  });

  it.each(["T0", "T1"] as const)(
    "ends the request at %s when its headers time out, closing the server's socket",
    async (tier) => {
      let closedAt: number | undefined;
      const url = await serve((req) => {
        req.socket.on("close", () => {
          closedAt = Date.now();
        });
      });
      const http = createLiveHttp({ hostIntervalMs: 0, timeoutMs: 200, attempts: 1 });
      await expect(http.get({ url, stream: true, minTier: tier })).rejects.toBeInstanceOf(
        HttpNetworkError,
      );
      const rejectedAt = Date.now();
      await vi.waitFor(() => expect(closedAt).toBeDefined(), { timeout: 2_000 });
      expect((closedAt as number) - rejectedAt).toBeLessThan(500);
    },
  );

  it("refuses a T1 body too large to read in full", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": 2 ** 31 });
      res.write(Buffer.alloc(1000));
    });
    const http = createLiveHttp({ hostIntervalMs: 0, attempts: 1 });
    const error = await http.get({ url, stream: true, minTier: "T1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpNetworkError);
    expect(String((error as Error).cause)).toMatch(/too large to read in full/);
  });

  it("reads a stream request in full at T1 and serves it as chunks", async () => {
    const url = await serve((_req, res) => pieces(res, 40, 50_000));
    const page = await createLiveHttp({ hostIntervalMs: 0 }).get({
      url,
      stream: true,
      minTier: "T1",
    });
    expect(page.tier).toBe("T1");
    const { bytes, chunks } = await read(page);
    expect(bytes.length).toBe(2_000_000);
    expect(chunks).toBeGreaterThan(1);
  });

  it("bypasses the raw response cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-http-stream-"));
    try {
      let calls = 0;
      const url = await serve((_req, res) => {
        calls++;
        pieces(res, 2, 1000);
      });
      const http = createLiveHttp({ hostIntervalMs: 0, cache: { dir } });
      await read(await http.get({ url, stream: true }));
      await read(await http.get({ url, stream: true }));
      expect(calls).toBe(2);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes the download at once when stopped during a read", async () => {
    let closed: () => void = () => {};
    const serverClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/csv" }).flushHeaders();
    });
    const page = await createLiveHttp({ hostIntervalMs: 0, timeoutMs: 60_000 }).get({
      url,
      stream: true,
    });
    const iterator = (page.chunks as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    const pending = iterator.next();
    pending.catch(() => undefined);
    await iterator.return?.();
    await serverClosed;
  });

  it("detects a challenge served as XHTML", async () => {
    const url = await serve((_req, res) => {
      res
        .writeHead(200, { "content-type": "application/xhtml+xml" })
        .end('<html><script>document.cookie="EO_Bot_Ssid=1"</script></html>');
    });
    const http = createLiveHttp({ hostIntervalMs: 0, maxConsecutiveBlocks: 1, browser: false });
    await expect(http.get({ url, stream: true })).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("leaves no listener on the caller's signal once a stream ends or stops", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/missing") return void res.writeHead(404).end("gone");
      pieces(res, 3, 1000);
    });
    const http = live();
    const { signal } = new AbortController();
    await read(await http.get({ url, stream: true, signal }));
    for await (const _chunk of (await http.get({ url, stream: true, signal })).chunks ?? []) break;
    await read(await http.get({ url: `${url}/missing`, stream: true, signal }));
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });
});
