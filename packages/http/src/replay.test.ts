import { describe, expect, it } from "vitest";
import {
  type Cassette,
  createReplayHttp,
  type Http,
  HttpBlockedError,
  ReplayMissError,
  recordingHttp,
} from "./index.ts";

const cassette: Cassette = {
  version: 1,
  interactions: [
    {
      request: { url: "https://a.example/list?b=2&a=1" },
      response: {
        url: "https://a.example/list?b=2&a=1",
        status: 200,
        headers: {},
        body: "first",
        tier: "T0",
      },
    },
    {
      request: { url: "https://a.example/list?a=1&b=2" },
      response: {
        url: "https://a.example/list?a=1&b=2",
        status: 200,
        headers: {},
        body: "second",
        tier: "T0",
      },
    },
    {
      request: { url: "https://a.example/blocked" },
      response: {
        url: "https://a.example/blocked",
        status: 403,
        headers: { server: "AkamaiGHost" },
        body: "Access denied",
        tier: "T0",
      },
    },
  ],
};

describe("replay Http", () => {
  it("matches URLs regardless of query order and serves repeats in recorded order", async () => {
    const http = createReplayHttp(cassette);
    expect((await http.get("https://a.example/list?a=1&b=2")).body).toBe("first");
    expect((await http.get("https://a.example/list?b=2&a=1")).body).toBe("second");
    expect((await http.get("https://a.example/list?a=1&b=2")).body).toBe("second");
  });

  it("rejects unknown requests with ReplayMissError", async () => {
    await expect(createReplayHttp(cassette).get("https://a.example/other")).rejects.toBeInstanceOf(
      ReplayMissError,
    );
  });

  it("treats a recorded bot challenge as blocked, like the live adapter", async () => {
    await expect(
      createReplayHttp(cassette).get("https://a.example/blocked"),
    ).rejects.toBeInstanceOf(HttpBlockedError);
  });

  it("records what an Http served, without cookies, into a replayable cassette", async () => {
    const inner: Http = {
      get: async () => ({
        url: "https://b.example/",
        status: 200,
        headers: { "set-cookie": "s=1", "content-type": "text/plain" },
        body: "hello",
        tier: "T0",
      }),
    };
    const recorder = recordingHttp(inner);
    await recorder.http.get("https://b.example/");
    const recorded = recorder.cassette();
    expect(recorded.interactions[0]?.response.headers).toEqual({ "content-type": "text/plain" });
    expect((await createReplayHttp(recorded).get("https://b.example/")).body).toBe("hello");
  });

  it("round-trips binary responses (PDF, ZIP) through a cassette", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const inner: Http = {
      get: async () => ({
        url: "https://c.example/x.pdf",
        status: 200,
        headers: {},
        body: "",
        bytes,
        tier: "T0",
      }),
    };
    const recorder = recordingHttp(inner);
    await recorder.http.get({ url: "https://c.example/x.pdf", binary: true });
    const page = await createReplayHttp(recorder.cassette()).get({
      url: "https://c.example/x.pdf",
      binary: true,
    });
    expect(page.bytes).toEqual(bytes);
    expect(page.body).toBe("");
  });
});
