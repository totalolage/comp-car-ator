/**
 * One line for an error in run logs, CLI logs, and release manifests, keeping its `cause` chain.
 * `String(error)` keeps only the outermost message, so a network failure read "Network failure
 * after retries: <url>" without the connection error that explains it.
 */

/** Links read before the chain is cut short. */
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
    if (seen.size === MAX_LINKS) {
      parts.push("…");
      break;
    }
    seen.add(current);
    const isCause = seen.size > 1;
    let link: Link;
    try {
      link = readLink(current, isCause);
    } catch {
      // A value even `instanceof` cannot inspect (a revoked Proxy); the links above it stand.
      parts.push(isCause ? "[unreadable cause]" : safeString(current));
      break;
    }
    // A plain wrapper that repeats its cause's message (the Ledger's RunFailedError) adds only
    // noise; one with its own name or code still prints. Kept when the cause loops back, and as
    // the last link read, so a cut chain still shows its message.
    const { cause, message } = link;
    const repeats =
      message !== undefined &&
      link.text === `Error: ${message}` &&
      !seen.has(cause) &&
      seen.size < MAX_LINKS &&
      read(() => cause instanceof Error && readMessage(cause) === message) === true;
    if (!repeats) parts.push(link.text);
    if (link.unreadableCause) parts.push("[unreadable cause]");
    if (link.cause === undefined) break;
    current = link.cause;
  }
  return parts.join(SEPARATOR);
}

interface Link {
  text: string;
  message: string | undefined;
  cause: unknown;
  unreadableCause: boolean;
}

/** One link of the chain, each property read once; a getter that throws spoils only itself. */
function readLink(value: unknown, isCause: boolean): Link {
  if (!(value instanceof Error)) {
    const text = isCause ? describeValue(value) : safeString(value);
    return { text, message: undefined, cause: undefined, unreadableCause: false };
  }
  let text = safeString(value);
  // Node and undici put the informative part of a socket error in `code` (UND_ERR_CONNECT_TIMEOUT).
  // DOMException's numeric legacy codes say nothing its name doesn't.
  const code = read(() => (value as { code?: unknown }).code);
  if (typeof code === "string" && code !== "" && !text.includes(code)) text += ` [${code}]`;
  // Connecting to every address of a host fails as one AggregateError, often with no message.
  const errors = isCause && value instanceof AggregateError ? read(() => value.errors) : undefined;
  if (Array.isArray(errors)) {
    const inner = new Set(
      errors.map(
        (e) =>
          read(() => (e instanceof Error ? safeString(e) : describeValue(e))) ?? "[unreadable]",
      ),
    );
    if (inner.size > 0) text += ` (${[...inner].join(", ")})`;
  }
  let cause: unknown;
  let unreadableCause = false;
  try {
    cause = value.cause;
  } catch {
    unreadableCause = true;
  }
  return { text, message: readMessage(value), cause, unreadableCause };
}

function readMessage(error: Error): string | undefined {
  const message = read(() => error.message);
  return typeof message === "string" ? message : undefined;
}

function read(get: () => unknown): unknown {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/**
 * A non-Error cause: its own string form, or its JSON when that says nothing (an array, or
 * Object's "[object …]" tag).
 */
function describeValue(value: unknown): string {
  const text = safeString(value);
  if (typeof value !== "object" || value === null) return text;
  if (!Array.isArray(value) && !/^\[object \w+\]$/.test(text)) return text;
  try {
    return JSON.stringify(value) ?? text;
  } catch {
    // Circular or BigInt-holding objects keep their tag.
    return text;
  }
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
