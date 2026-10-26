/**
 * T2: a stealth browser behind the TierFetcher seam. Opt-in only (see LiveHttpOptions.browser):
 * it needs a local browser and, headed, a display (run under `xvfb-run`). Nothing here loads
 * until the first T2 fetch.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext, BrowserContext, Cookie, Page, Response } from "patchright";
import { detectChallenge } from "./challenge.ts";
import type { RawResponse, TierFetcher } from "./tiered.ts";

export interface BrowserOptions {
  /**
   * `patchright` (default): the system Chrome (`google-chrome` on PATH), started as a plain
   * process and driven by Patchright over CDP.
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
  /** Shuts the browser down. */
  close(): Promise<void>;
  tempDir?: string;
  /** The browser's User-Agent, read on the first binary fetch. */
  userAgent?: Promise<string>;
}

/**
 * Navigates a browser tab to the URL and returns the rendered document. A document that is a
 * challenge (judged from its network response, so the page is never read while the challenge's
 * script runs) is waited out until the page navigates past it or `challengeWaitMs` passes, then
 * returned as it is so the policy can escalate or report the block. Accept-Language becomes the browser's locale;
 * the other request headers go on the page's main-frame navigations only (and their redirects),
 * over the browser's own, so subresources keep the browser's fingerprint. Binary
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
      if (engine === "camoufox") {
        const context = await launchCamoufox(dir, locale);
        return { context, close: () => context.close(), tempDir };
      }
      return { ...(await launchChrome(dir, locale)), tempDir };
    } catch (error) {
      if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5 });
      throw error;
    }
  }

  /**
   * Starts Chrome as a plain process and attaches Patchright over CDP once it runs. Akamai
   * (mobile.de) denies a Chrome that Patchright launches itself, whatever its switches or locale
   * emulation, but lets this one through (docs/adr/0005-fetch-tiers.md). The locale is the
   * profile's language preference, so Accept-Language and `navigator.languages` agree.
   */
  async function launchChrome(dir: string, locale: string): Promise<Omit<Profile, "tempDir">> {
    // An explicit port: with port 0 Chrome reports `navigator.webdriver` true, and Akamai denies it.
    const port = await freePort();
    const args = [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--lang=${locale}`,
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    await acceptLanguages(dir, locale);
    const chrome = spawn("google-chrome", args, { stdio: "ignore" });
    // "close" follows both an exit and a failed spawn.
    const closed = new Promise<void>((resolve) => chrome.once("close", () => resolve()));
    const failed = new Promise<never>((_, reject) => {
      chrome.once("error", reject);
      // A Chrome already running on this profile takes the request over and exits at once.
      chrome.once("exit", (code) =>
        reject(new Error(`Chrome exited (${code}) before DevTools started`)),
      );
    });
    failed.catch(() => {});
    const stop = async () => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return await closed;
      chrome.kill();
      const killer = setTimeout(() => chrome.kill("SIGKILL"), 5_000);
      await closed;
      clearTimeout(killer);
    };
    try {
      const gone = () =>
        chrome.pid === undefined || chrome.exitCode !== null || !!chrome.signalCode;
      const endpoint = `http://127.0.0.1:${port}`;
      await Promise.race([devToolsReady(endpoint, timeoutMs, gone), failed]);
      const { chromium } = await import("patchright");
      const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome has no default browser context");
      return {
        context,
        close: async () => {
          await browser.close().catch(() => {});
          await stop();
        },
      };
    } catch (error) {
      await stop();
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
          const { close, tempDir } = await pending;
          try {
            await close();
          } finally {
            if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 5 });
          }
        }),
      );
    })();
    return closing;
  }

  const fetch: TierFetcher = async ({ url, headers, binary, stream, signal }) => {
    clearTimeout(idleTimer);
    active++;
    try {
      const locale = headers["accept-language"]?.split(",")[0]?.trim() || "cs-CZ";
      const current = await profile(locale);
      signal?.throwIfAborted();
      // T2 cannot stream: a stream request is read in full, then served as chunks.
      if (binary || stream)
        return await fetchBinary(current, requests, url, headers, timeoutMs, signal);
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
    // Judge the document from its network response first: reading the page while a challenge's
    // script runs (Akamai's sensor) can fail the challenge.
    const served = document && (await responseOf(document, timeoutMs));
    if (served && !detectChallenge(served)) {
      const snapshot = await snapshotOf(page, document);
      if (snapshot && !detectChallenge(snapshot)) return snapshot;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const snapshot = (await snapshotOf(page, document)) ?? served;
      if (snapshot) return snapshot;
      throw new Error(`Page kept navigating for ${challengeWaitMs} ms: ${url}`);
    }
    // A challenge that passes navigates to the page; wait for that without touching the page.
    await page
      .waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: remaining,
      })
      .then(() => page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }))
      .catch(() => {});
  }
}

/** A document response as the network delivered it, or null when its body is gone. */
async function responseOf(response: Response, timeoutMs: number): Promise<RawResponse | null> {
  let timer: NodeJS.Timeout | undefined;
  // A body that never ends must not hold the page past the timeout.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const read = (async () => ({
    url: response.url(),
    status: response.status(),
    headers: await response.allHeaders(),
    body: await response.text(),
  }))().catch(() => null);
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
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
    // Text or HTML (a challenge or error page) keeps its text for challenge detection.
    const text = /^text\/|html/i.test(responseHeaders["content-type"] ?? "");
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

/**
 * Sets the profile's languages (Accept-Language, `navigator.languages`) to `locale` and its
 * language: Chrome on Linux ignores `--lang` for them.
 */
async function acceptLanguages(dir: string, locale: string) {
  const file = join(dir, "Default", "Preferences");
  // biome-ignore lint/suspicious/noExplicitAny: Chrome's own preferences file.
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    // Only a new profile has none; anything else would lose the profile's other preferences.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const language = locale.split("-")[0] as string;
  const languages = language === locale ? locale : `${locale},${language}`;
  prefs.intl = { ...prefs.intl, accept_languages: languages, selected_languages: languages };
  await mkdir(join(dir, "Default"), { recursive: true });
  await writeFile(`${file}.cca`, JSON.stringify(prefs));
  await rename(`${file}.cca`, file);
}

/** A TCP port free on the loopback interface right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Waits until Chrome answers on its DevTools endpoint. */
async function devToolsReady(endpoint: string, timeoutMs: number, gone: () => boolean) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (gone()) throw new Error("Chrome exited before DevTools started");
    if (Date.now() >= deadline) throw new Error(`Chrome did not open DevTools in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
 * and changed cookies are set, missing ones cleared. A cookie is touched only while the browser
 * still holds it as seeded (or lost it to expiry), so a change a page made meanwhile and that is
 * in the jar at hand-back is kept, and a seeded cookie that expired during the fetch does not
 * clear a refreshed copy. A page that deleted a cookie past its expiry looks like expiry here.
 */
async function handBack(context: BrowserContext, before: Cookie[], after: Cookie[]) {
  const key = (cookie: Cookie) => `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
  const stamp = ({ value, expires, httpOnly, secure, sameSite }: Cookie) =>
    JSON.stringify([value, expires, httpOnly, secure, sameSite]);
  const seeded = new Map(before.map((cookie) => [key(cookie), cookie]));
  const handed = new Set(after.map(key));
  const current = new Map((await context.cookies()).map((cookie) => [key(cookie), stamp(cookie)]));
  const untouched = (k: string) => {
    const cookie = seeded.get(k);
    if (current.has(k)) return cookie !== undefined && current.get(k) === stamp(cookie);
    return cookie === undefined || (cookie.expires > 0 && cookie.expires * 1000 <= Date.now());
  };
  const changed = after.filter((cookie) => {
    const k = key(cookie);
    const was = seeded.get(k);
    return (was === undefined || stamp(was) !== stamp(cookie)) && untouched(k);
  });
  if (changed.length > 0) await context.addCookies(changed);
  for (const cookie of before) {
    const k = key(cookie);
    if (!handed.has(k) && current.has(k) && untouched(k)) {
      await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
  }
}
