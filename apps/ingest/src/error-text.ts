/**
 * One line for an error in run logs, CLI logs, and release manifests, keeping its `cause` chain.
 * `String(error)` keeps only the outermost message, so a network failure read "Network failure
 * after retries: <url>" without the connection error that explains it.
 */

/** Links printed before the chain is cut short. */
const MAX_LINKS = 8;
const SEPARATOR = "; caused by: ";

/**
 * `String(error)` followed by each cause, outermost first: "HttpNetworkError: Network failure
 * after retries: <url>; caused by: TypeError: fetch failed; caused by: Error: connect ETIMEDOUT
 * 192.0.2.1:443". An error without a cause prints as `String(error)` (plus a system error's
 * `code` when the message lacks it).
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (;;) {
    if (seen.has(current)) {
      parts.push("[cause cycle]");
      break;
    }
    if (seen.size === MAX_LINKS) {
      parts.push("…");
      break;
    }
    seen.add(current);
    const cause = current instanceof Error ? current.cause : undefined;
    // A wrapper that repeats its cause's message (the Ledger's RunFailedError) adds only noise.
    // Kept when the cause loops back, so a cycle still prints the error once.
    const repeats =
      current instanceof Error &&
      cause instanceof Error &&
      !seen.has(cause) &&
      current.message === cause.message;
    if (!repeats) parts.push(describeLink(current));
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return parts.join(SEPARATOR);
}

function describeLink(value: unknown): string {
  if (!(value instanceof Error)) return describeValue(value);
  let text = String(value);
  // Node and undici put the informative part of a socket error in `code` (UND_ERR_CONNECT_TIMEOUT).
  // DOMException's numeric legacy codes say nothing its name doesn't.
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && code !== "" && !text.includes(code)) text += ` [${code}]`;
  // Connecting to every address of a host fails as one AggregateError, often with no message.
  if (value instanceof AggregateError && Array.isArray(value.errors) && value.errors.length > 0) {
    const inner = [
      ...new Set(value.errors.map((e) => (e instanceof Error ? String(e) : describeValue(e)))),
    ];
    text += ` (${inner.join(", ")})`;
  }
  return text;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined && json !== "{}") return json;
    } catch {
      // Circular or BigInt-holding objects fall back to String.
    }
  }
  return String(value);
}
