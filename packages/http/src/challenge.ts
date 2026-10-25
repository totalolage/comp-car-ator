import type { RawResponse } from "./tiered.ts";

/**
 * Recognizes bot-protection responses (markers from scrape-access research). Returns a
 * short marker name, or null for a normal response. Wave 1 stream 1 extends the list.
 */
export function detectChallenge(
  response: Pick<RawResponse, "status" | "headers" | "body">,
): string | null {
  const { status, headers, body } = response;
  if (headers["cf-mitigated"] === "challenge") return "cloudflare";
  if (status === 403 && /akamaighost/i.test(headers.server ?? "")) return "akamai";
  if ((status === 403 || status === 503) && body.includes("Just a moment")) return "cloudflare";
  if (body.includes("EO_Bot_Ssid")) return "edgeone";
  return null;
}
