/**
 * Streaming CSV reader for the register export: RFC 4180 (comma, double-quote quoting, quotes
 * doubled inside quotes, CRLF or LF rows, line breaks allowed inside quotes), UTF-8 with an
 * optional BOM. Holds one record at a time, so memory stays flat however large the file is.
 */
export async function* csvRecords(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string[]> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let first = true;
  const parser = recordParser();
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    if (first && buffer.length > 0) {
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      first = false;
    }
    let start = 0;
    for (let end = buffer.indexOf("\n", start); end !== -1; end = buffer.indexOf("\n", start)) {
      const record = parser.line(buffer.slice(start, end));
      start = end + 1;
      if (record) yield record;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  const last = parser.end(buffer);
  if (last) yield last;
}

/** Feeds lines to records; a quoted field spanning lines keeps the record open. */
function recordParser() {
  let pending: string | undefined;
  return {
    line(raw: string): string[] | undefined {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const text = pending === undefined ? line : `${pending}\n${line}`;
      if (pending === undefined && !line.includes('"')) {
        return line === "" ? undefined : line.split(",");
      }
      const fields = parseQuoted(text);
      pending = fields ? undefined : text;
      return fields;
    },
    end(rest: string): string[] | undefined {
      const tail = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
      if (pending === undefined) return tail === "" ? undefined : this.line(tail);
      const fields = parseQuoted(`${pending}\n${tail}`);
      if (!fields) throw new Error("CSV ends inside a quoted field");
      return fields;
    },
  };
}

/** Splits one record with quotes; undefined while a quoted field is still open. */
function parseQuoted(text: string): string[] | undefined {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      fields.push(field);
      field = "";
    } else field += c;
  }
  if (quoted) return undefined;
  fields.push(field);
  return fields;
}
