import type { RawResponse } from "./tiered.ts";

/**
 * Recognizes bot-protection responses (markers from the scrape-access probes). Returns a short
 * marker name, or null for a normal response. Body markers on a 200 are limited to strings a
 * real page never carries: Cloudflare, for one, injects its challenge-platform script into
 * normal pages, so that script alone does not count.
 */
export function detectChallenge(
  response: Pick<RawResponse, "status" | "headers" | "body">,
): string | null {
  const { status, headers, body } = response;
  const refused = status === 403 || status === 429 || status === 503;

  if (headers["cf-mitigated"] === "challenge") return "cloudflare";
  if (refused && /Just a moment\.\.\.|Attention Required! \| Cloudflare|cf-chl-/.test(body)) {
    return "cloudflare";
  }

  if (status === 403 && /akamaighost/i.test(headers.server ?? "")) return "akamai";
  // Akamai's denial page with its reference id ("Error Reference: 0.b25d1502.1792855061.14e82adb"
  // on mobile.de), also served with 200 to browsers it rejects.
  if (
    /(?:Reference #|Reference&#32;&#35;|Error Reference:\s*)\d+\.[\da-f]+\.\d+\.[\da-f]+/.test(body)
  ) {
    return "akamai";
  }

  // Akamai's interstitial: it runs the sensor, then reloads into the page (mobile.de, 200).
  if (body.includes('id="sec-if-cpt-container"')) return "akamai";

  if (body.includes("EO_Bot_Ssid")) return "edgeone";

  if (refused && (headers["x-datadome"] !== undefined || body.includes("captcha-delivery.com"))) {
    return "datadome";
  }
  if (refused && /px-captcha|_pxAppId/.test(body)) return "perimeterx";
  // Imperva injects its _Incapsula_Resource script into normal pages too.
  if (body.includes("Incapsula incident ID") || (refused && body.includes("_Incapsula_Resource"))) {
    return "imperva";
  }
  return null;
}
