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
  // Writing the run log depends on this, so an error that cannot be printed must not throw here.
  try {
    return describeChain(error);
  } catch {
    return safeString(error);
  }
}

function describeChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (;;) {
    if (seen.has(current)) {
      parts.push("[cause cycle]");
      break;
    }
    if (parts.length === MAX_LINKS) {
      parts.push("…");
      break;
    }
    seen.add(current);
    const hasCause = current instanceof Error && current.cause !== undefined;
    const cause = hasCause ? (current as Error).cause : undefined;
    const text = describeLink(current, seen.size > 1);
    // A plain wrapper that repeats its cause's message (the Ledger's RunFailedError) adds only
    // noise; one with its own name or code still prints. Kept when the cause loops back.
    const repeats =
      current instanceof Error &&
      cause instanceof Error &&
      !seen.has(cause) &&
      current.message === cause.message &&
      text === `Error: ${current.message}`;
    if (!repeats) parts.push(text);
    if (!hasCause) break;
    current = cause;
  }
  return parts.join(SEPARATOR);
}

function describeLink(value: unknown, isCause: boolean): string {
  if (!(value instanceof Error)) return describeValue(value);
  let text = safeString(value);
  // Node and undici put the informative part of a socket error in `code` (UND_ERR_CONNECT_TIMEOUT).
  // DOMException's numeric legacy codes say nothing its name doesn't.
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && code !== "" && !text.includes(code)) text += ` [${code}]`;
  // Connecting to every address of a host fails as one AggregateError, often with no message.
  if (isCause && value instanceof AggregateError && Array.isArray(value.errors)) {
    const inner = new Set(
      value.errors.map((e) => (e instanceof Error ? safeString(e) : describeValue(e))),
    );
    if (inner.size > 0) text += ` (${[...inner].join(", ")})`;
  }
  return text;
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Circular or BigInt-holding objects fall back to String.
    }
  }
  return safeString(value);
}

/** String(value), or its tag when it has no usable toString (Object.create(null)). */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unprintable value]";
    }
  }
}
