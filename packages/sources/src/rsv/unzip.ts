/**
 * Streams the first file of a ZIP archive (the register's monthly export holds one CSV),
 * inflating as bytes arrive, so neither the archive nor the CSV is ever held in memory.
 * Supports DEFLATE (method 8), the only method the export uses; reading stops at the end of
 * the first file's compressed data, and the caller closes the download.
 */
import { createInflateRaw } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;

export async function* unzipFirst(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const input = chunks[Symbol.asyncIterator]();
  let head: Uint8Array = new Uint8Array(0);
  // The local file header: 30 fixed bytes, then the name and the extra field.
  while (head.length < 30 || head.length < 30 + nameAndExtra(head)) {
    const next = await input.next();
    if (next.done) throw new Error("ZIP archive ends inside its first header");
    head = concat(head, next.value);
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0, true) !== LOCAL_HEADER) throw new Error("Not a ZIP archive");
  const method = view.getUint16(8, true);
  if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);

  const inflate = createInflateRaw();
  let ended = false;
  inflate.once("end", () => {
    ended = true;
  });
  const pump = (async () => {
    let chunk: Uint8Array | undefined = head.subarray(30 + nameAndExtra(head));
    while (chunk && !ended) {
      if (!inflate.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            inflate.off("drain", done);
            inflate.off("end", done);
            resolve();
          };
          inflate.on("drain", done);
          inflate.once("end", done);
        });
      }
      if (ended) break;
      const next = await input.next();
      chunk = next.done ? undefined : next.value;
    }
    if (!ended) inflate.end();
  })();
  pump.catch((error: unknown) => inflate.destroy(error as Error));
  try {
    for await (const out of inflate) yield out as Uint8Array;
    await pump;
  } finally {
    inflate.destroy();
    await input.return?.();
  }
}

function nameAndExtra(head: Uint8Array): number {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return view.getUint16(26, true) + view.getUint16(28, true);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
