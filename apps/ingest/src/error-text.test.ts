import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HttpNetworkError } from "@cca/http";
import { RunFailedError } from "@cca/ledger";
import { describe, expect, it } from "vitest";
import { describeError } from "./error-text.ts";

const summary = {} as ConstructorParameters<typeof RunFailedError>[1];

describe("describeError", () => {
  it("prints an error without a cause as String(error)", () => {
    expect(describeError(new Error("HTTP 503"))).toBe("Error: HTTP 503");
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("thrown string")).toBe("thrown string");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("follows a nested cause chain, outermost first", () => {
    const socket = Object.assign(new Error("connect ETIMEDOUT 192.0.2.1:443"), {
      code: "ETIMEDOUT",
    });
    const error = new HttpNetworkError(
      "https://example.com/list",
      new TypeError("fetch failed", { cause: socket }),
    );
    expect(describeError(error)).toBe(
      "HttpNetworkError: Network failure after retries: https://example.com/list" +
        "; caused by: TypeError: fetch failed" +
        "; caused by: Error: connect ETIMEDOUT 192.0.2.1:443",
    );
  });

  it("adds a system error's code only when its message lacks it", () => {
    const timeout = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(describeError(timeout)).toBe("Error: Connect Timeout Error [UND_ERR_CONNECT_TIMEOUT]");
    expect(describeError(new DOMException("This operation was aborted", "AbortError"))).toBe(
      "AbortError: This operation was aborted",
    );
  });

  it("lists the errors inside an AggregateError", () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" });
    const all = Object.assign(new AggregateError([refused("::1:443"), refused("127.0.0.1:443")]), {
      code: "ECONNREFUSED",
    });
    expect(describeError(new TypeError("fetch failed", { cause: all }))).toBe(
      "TypeError: fetch failed; caused by: AggregateError [ECONNREFUSED] " +
        "(Error: connect ECONNREFUSED ::1:443, Error: connect ECONNREFUSED 127.0.0.1:443)",
    );
  });

  it("prints a non-Error cause as its value", () => {
    expect(describeError(new Error("outer", { cause: "socket hang up" }))).toBe(
      "Error: outer; caused by: socket hang up",
    );
    expect(describeError(new Error("outer", { cause: { status: 503 } }))).toBe(
      'Error: outer; caused by: {"status":503}',
    );
    expect(describeError(new Error("outer", { cause: 42 }))).toBe("Error: outer; caused by: 42");
  });

  it("stops at a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(describeError(a)).toBe("Error: a; caused by: Error: b; caused by: [cause cycle]");
    const self = new Error("self");
    self.cause = self;
    expect(describeError(self)).toBe("Error: self; caused by: [cause cycle]");
  });

  it("cuts a long chain short", () => {
    let error = new Error("e0");
    for (let i = 1; i < 20; i++) error = new Error(`e${i}`, { cause: error });
    const parts = describeError(error).split("; caused by: ");
    expect(parts).toHaveLength(9);
    expect(parts[0]).toBe("Error: e19");
    expect(parts[7]).toBe("Error: e12");
    expect(parts[8]).toBe("…");
  });

  it("skips a wrapper that repeats its cause's message", () => {
    const failure = new HttpNetworkError("https://example.com/", new Error("socket hang up"));
    expect(describeError(new RunFailedError(failure, summary))).toBe(
      "HttpNetworkError: Network failure after retries: https://example.com/" +
        "; caused by: Error: socket hang up",
    );
  });
});

describe("CLI run", () => {
  it("logs a failed run with the error its Ledger run wraps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cca-cli-"));
    const cassette = join(dir, "empty.cassette.json");
    await writeFile(cassette, JSON.stringify({ version: 1, interactions: [] }));
    const cli = join(import.meta.dirname, "cli.ts");
    const args = ["run", "--source", "cnb", "--ledger", ":memory:", "--replay", cassette];
    const run = promisify(execFile)(process.execPath, [cli, ...args]);
    const failed = (await run.catch((error: unknown) => error)) as { code: number; stderr: string };
    await rm(dir, { recursive: true, force: true });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(
      /WARN cnb incremental run failed \{"error":"ReplayMissError: No recorded interaction for /,
    );
  });
});
