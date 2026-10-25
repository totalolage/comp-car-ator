/**
 * T2: a stealth browser behind the TierFetcher seam. Opt-in only (see LiveHttpOptions.browser):
 * it needs a local browser and, headed, a display (run under `xvfb-run`). Nothing here loads
 * until the first T2 fetch.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext, BrowserContext, Cookie, Page, Response } from "patchright";
import { detectChallenge } from "./challenge.ts";
import type { RawResponse, TierFetcher } from "./tiered.ts";

export interface BrowserOptions {
  /**
   * `patchright` (default): patched Playwright driving the system Chrome (`channel: "chrome"`).
   * `camoufox` (experimental): the Camoufox Firefox build; needs `camoufox-js` and
   * `playwright-core` installed and its browser fetched (`npx camoufox-js fetch`, ~1.3 GB).
   */
  engine?: "patchright" | "camoufox";
  /** Default: headed when DISPLAY is set (run under `xvfb-run`), headless otherwise. */
  headless?: boolean;
  /**
   * Keep browser profiles (cookies such as Akamai's `_abck`) in this directory across runs, one
   * subdirectory per locale. Default: a temporary profile removed on close.
   */
  profileDir?: string;
  /** How long a page may show a JS challenge before T2 gives up on it, ms. Default 20 000. */
  challengeWaitMs?: number;
  /** Close the browser after this long without T2 fetches, ms. Default 30 000. */
  idleCloseMs?: number;
}

interface Profile {
  context: BrowserContext;
  tempDir?: string;
  /** The browser's User-Agent, read on the first binary fetch. */
  userAgent?: Promise<string>;
}

/**
 * Navigates a browser tab to the URL and returns the rendered document. A page that still shows
 * a challenge is polled until it clears or `challengeWaitMs` passes, then returned as it is so
 * the policy can escalate or report the block. Accept-Language becomes the browser's locale;
 * the other request headers go on the page's main-frame navigations only (and, as at T0, their
 * redirects), over the browser's own, so subresources keep the browser's fingerprint. Binary
 * requests go through a request API context of their own that carries the browser's User-Agent
 * and cookies (and hands the cookies it changed back), so an abort or close() can dispose it
 * and close the connection.
 */
export function createBrowserFetcher(
  options: BrowserOptions,
  timeoutMs: number,
): { fetch: TierFetcher; close(): Promise<void> } {
  const engine = options.engine ?? "patchright";
  const headless = options.headless ?? !process.env.DISPLAY;
  const challengeWaitMs = options.challengeWaitMs ?? 20_000;
  const idleCloseMs = options.idleCloseMs ?? 30_000;
  const profiles = new Map<string, Promise<Profile>>();
  /** Request contexts of binary fetches in flight, disposed by close(). */
  const requests = new Set<Promise<APIRequestContext>>();
  let active = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  /** A running close(); a launch waits for it so a persistent profile is never opened twice. */
  let closing: Promise<void> = Promise.resolve();

  async function profile(locale: string): Promise<Profile> {
    // Wait until no close() is running, including one that started while we waited.
    for (let current = closing; ; current = closing) {
      await current;
      if (current === closing) break;
    }
    let existing = profiles.get(locale);
    if (!existing) {
      existing = launch(locale);
      // A failed launch is retried by the next fetch rather than cached.
      existing.catch(() => profiles.delete(locale));
      profiles.set(locale, existing);
    }
    return existing;
  }

  async function launch(locale: string): Promise<Profile> {
    const tempDir = options.profileDir ? undefined : await mkdtemp(join(tmpdir(), "cca-browser-"));
    const dir = tempDir ?? join(options.profileDir as string, locale);
    try {
      if (engine === "camoufox") return { context: await launchCamoufox(dir, locale), tempDir };
      const { chromium } = await import("patchright");
      const context = await chromium.launchPersistentContext(dir, {
        channel: "chrome",
        headless,
        viewport: null,
        locale,
        timeout: timeoutMs,
      });
      return { context, tempDir };
    } catch (error) {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async function launchCamoufox(dir: string, locale: string): Promise<BrowserContext> {
    // Not a dependency: the experimental engine is installed by hand where it is used.
    const specifier = "camoufox-js";
    const { Camoufox } = (await import(specifier)) as {
      Camoufox(options: Record<string, unknown>): Promise<BrowserContext>;
    };
    return Camoufox({ headless, locale, user_data_dir: dir });
  }

  function close(): Promise<void> {
    clearTimeout(idleTimer);
    const all = [...profiles.values()];
    profiles.clear();
    const inFlight = [...requests].map((api) => api.then((it) => it.dispose()).catch(() => {}));
    const previous = closing;
    closing = (async () => {
      await previous;
      await Promise.all(inFlight);
      await Promise.allSettled(
        all.map(async (pending) => {
          const { context, tempDir } = await pending;
          try {
            await context.close();
          } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true });
          }
        }),
      );
    })();
    return closing;
  }

  const fetch: TierFetcher = async ({ url, headers, binary, signal }) => {
    clearTimeout(idleTimer);
    active++;
    try {
      const locale = headers["accept-language"]?.split(",")[0]?.trim() || "cs-CZ";
      const current = await profile(locale);
      signal?.throwIfAborted();
      if (binary) return await fetchBinary(current, requests, url, headers, timeoutMs, signal);
      const page = await current.context.newPage();
      if (signal?.aborted) {
        await page.close().catch(() => {});
        signal.throwIfAborted();
      }
      const onAbort = () => void page.close().catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await sendHeaders(page, url, headers);
        return await navigate(page, url, headers.referer, timeoutMs, challengeWaitMs);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await page.close().catch(() => {});
      }
    } finally {
      active--;
      if (active === 0) {
        idleTimer = setTimeout(() => void close(), idleCloseMs);
        idleTimer.unref();
      }
    }
  };

  return { fetch, close };
}

/**
 * Puts the request headers other than Accept-Language and Referer on the page's main-frame
 * navigations to the URL's origin (a solved challenge navigates again), over the browser's
 * own headers.
 */
async function sendHeaders(page: Page, url: string, headers: Record<string, string>) {
  const extra = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== "accept-language" && name !== "referer"),
  );
  if (Object.keys(extra).length === 0) return;
  const origin = new URL(url).origin;
  await page.route(
    (target) => target.origin === origin,
    (route, request) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame()
        ? route.continue({ headers: { ...request.headers(), ...extra } })
        : route.fallback(),
  );
}

async function navigate(
  page: Page,
  url: string,
  referer: string | undefined,
  timeoutMs: number,
  challengeWaitMs: number,
): Promise<RawResponse> {
  // Track the latest main-frame document response: a solved challenge navigates again.
  let document: Response | null = null;
  page.on("response", (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      document = response;
    }
  });
  document =
    (await page.goto(url, { referer, waitUntil: "domcontentloaded", timeout: timeoutMs })) ?? null;
  const deadline = Date.now() + challengeWaitMs;
  for (;;) {
    const snapshot = await snapshotOf(page, document);
    if (snapshot && !detectChallenge(snapshot)) return snapshot;
    if (Date.now() >= deadline) {
      if (snapshot) return snapshot;
      throw new Error(`Page kept navigating for ${challengeWaitMs} ms: ${url}`);
    }
    await page.waitForTimeout(1000);
  }
}

/** The rendered page with its document response, or null while a navigation replaces it. */
async function snapshotOf(page: Page, document: Response | null): Promise<RawResponse | null> {
  try {
    return {
      url: page.url(),
      status: document?.status() ?? 200,
      headers: (await document?.allHeaders()) ?? {},
      body: await page.content(),
    };
  } catch {
    return null;
  }
}

async function fetchBinary(
  profile: Profile,
  requests: Set<Promise<APIRequestContext>>,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  const { context } = profile;
  if (!profile.userAgent) {
    profile.userAgent = userAgentOf(context);
    profile.userAgent.catch(() => {
      profile.userAgent = undefined;
    });
  }
  const userAgent = profile.userAgent;
  const cookies = context.cookies();
  // Awaited inside `created`, possibly after it rejects; don't let that count as unhandled.
  cookies.catch(() => {});
  const created = (async () => {
    const { request } = await import("patchright");
    return request.newContext({
      userAgent: await userAgent,
      storageState: { cookies: await cookies, origins: [] },
      timeout: timeoutMs,
    });
  })();
  requests.add(created);
  // Disposing the context destroys its in-flight request, which the request API has no signal for.
  const dispose = () => created.then((api) => api.dispose()).catch(() => {});
  const onAbort = () => void dispose();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const api = await created;
    signal?.throwIfAborted();
    const response = await api.get(url, { headers, timeout: timeoutMs });
    const bytes = new Uint8Array(await response.body());
    await handBack(context, await cookies, (await api.storageState()).cookies);
    const responseHeaders = response.headers();
    const text = /^text\//i.test(responseHeaders["content-type"] ?? "");
    return {
      url: response.url(),
      status: response.status(),
      headers: responseHeaders,
      body: text ? new TextDecoder().decode(bytes) : "",
      bytes,
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    requests.delete(created);
    await dispose();
  }
}

async function userAgentOf(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    return await page.evaluate(() => navigator.userAgent);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Applies to the browser what a request context changed in the cookies it was seeded with: new
 * and changed cookies are set, deleted ones cleared. Untouched cookies are left alone, so a page
 * that changed one meanwhile keeps its value.
 */
async function handBack(context: BrowserContext, before: Cookie[], after: Cookie[]) {
  const key = (cookie: Cookie) => `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
  const stamp = (cookie: Cookie) => `${cookie.value}\0${cookie.expires}`;
  const seeded = new Map(before.map((cookie) => [key(cookie), stamp(cookie)]));
  const kept = new Set(after.map(key));
  const changed = after.filter((cookie) => seeded.get(key(cookie)) !== stamp(cookie));
  if (changed.length > 0) await context.addCookies(changed);
  for (const { name, domain, path } of before.filter((cookie) => !kept.has(key(cookie)))) {
    await context.clearCookies({ name, domain, path });
  }
}
