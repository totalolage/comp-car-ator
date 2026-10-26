/**
 * Chunk sources for streamed Pages (`HttpRequest.stream`), shared by the tiered policy, the
 * replay adapter and the recorder. Internal to the package.
 */

const CHUNK_BYTES = 64 * 1024;

/** Whether a response to a `stream` request streams: 2xx and not HTML (a challenge page). */
export function streams(status: number, contentType: string | null | undefined): boolean {
  return status >= 200 && status < 300 && !/html/i.test(contentType ?? "");
}

/** Serves a buffered body in pieces, so stream consumers see chunk boundaries either way. */
export async function* chunksOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    yield bytes.subarray(at, at + CHUNK_BYTES);
  }
}

/**
 * Relays a chunk source: stops with the abort reason when `signal` aborts, and closing the
 * iteration early closes the source, even before the first read (an unstarted async generator
 * would skip its cleanup). `tap` sees each chunk and the end, however it comes.
 */
export function relayChunks(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  tap?: { chunk?(chunk: Uint8Array): void; end?(): void },
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      const inner = source[Symbol.asyncIterator]();
      let open = true;
      const close = async (cancel: boolean) => {
        if (!open) return;
        open = false;
        tap?.end?.();
        if (cancel) await inner.return?.();
      };
      const iterator: AsyncIterableIterator<Uint8Array> = {
        async next() {
          if (!open) return { done: true, value: undefined };
          try {
            signal?.throwIfAborted();
            const next = await inner.next();
            if (next.done) await close(false);
            else tap?.chunk?.(next.value);
            return next;
          } catch (error) {
            await close(true).catch(() => undefined);
            signal?.throwIfAborted();
            throw error;
          }
        },
        async return() {
          await close(true);
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };
}

/**
 * A network body as chunks under an idle timeout: each read that waits `ms` without data aborts
 * `controller` (which the fetch listens to, so the connection closes) and rejects with a
 * TimeoutError. Time the consumer spends between reads does not count. Once `controller` aborts
 * (timeout or the caller's signal), a pending read rejects with its reason at once, even if the
 * client underneath has not noticed yet. `onEnd` runs once the stream ends, fails or is stopped.
 */
export function idleChunks(
  body: AsyncIterable<Uint8Array>,
  controller: AbortController,
  ms: number,
  onEnd?: () => void,
): AsyncIterable<Uint8Array> {
  const signal = controller.signal;
  return {
    [Symbol.asyncIterator]() {
      // A ReadableStream's iterator cancels the download when the consumer stops early.
      const inner = body[Symbol.asyncIterator]();
      let reading = false;
      const iterator: AsyncIterableIterator<Uint8Array> = {
        async next() {
          if (signal.aborted) {
            onEnd?.();
            throw signal.reason;
          }
          // One listener per read, removed after it, so a long download accumulates nothing.
          let onAbort = () => {};
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
          });
          signal.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => controller.abort(idleTimeout(ms)), ms);
          reading = true;
          try {
            const next = await Promise.race([inner.next(), aborted]);
            if (next.done) onEnd?.();
            return next;
          } catch (error) {
            onEnd?.();
            throw error;
          } finally {
            reading = false;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        },
        async return() {
          onEnd?.();
          // A stream's return() waits for a pending read; aborting first ends that read now.
          if (reading) controller.abort(new DOMException("Stream closed", "AbortError"));
          const closing = inner.return?.();
          // After an abort, a read the client has not given up on would hold `return` back.
          if (signal.aborted) closing?.catch(() => undefined);
          else await closing;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };
}

export function idleTimeout(ms: number): DOMException {
  return new DOMException(`No data for ${ms} ms`, "TimeoutError");
}

/** Closes a chunk source nobody will read, so its download stops. */
export async function cancelChunks(chunks: AsyncIterable<Uint8Array> | undefined): Promise<void> {
  await chunks?.[Symbol.asyncIterator]().return?.();
}
