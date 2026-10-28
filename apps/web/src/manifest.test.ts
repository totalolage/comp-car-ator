import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// What browsers need to offer installing the site (Chrome's installability criteria; iOS
// reads the same manifest for Add to Home Screen).
const pub = new URL("../public/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", pub), "utf8")) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(src: string): Promise<string> {
  const bytes = await readFile(new URL(src.slice(1), pub));
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("web app manifest", () => {
  it("installs as a standalone app over the whole site", () => {
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
  });

  it("uses the masthead green and the paper colour", async () => {
    const tokens = await readFile(new URL("styles/tokens.css", import.meta.url), "utf8");
    expect(tokens).toContain(`--sign: light-dark(${manifest.theme_color},`);
    expect(tokens).toContain(`--paper: light-dark(${manifest.background_color},`);
  });

  it("has 192 and 512 px icons and a maskable one, at their declared sizes", async () => {
    const any = manifest.icons.filter((i) => (i.purpose ?? "any").split(" ").includes("any"));
    expect(any.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose?.split(" ").includes("maskable"))).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(await pngSize(icon.src)).toBe(icon.sizes);
    }
    // iOS takes its home screen icon from the apple-touch-icon link, not the manifest.
    expect(await pngSize("/apple-touch-icon.png")).toBe("180x180");
  });
});
