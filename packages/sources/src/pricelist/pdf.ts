import { getDocumentProxy } from "unpdf";

/** A run of text on one line of a PDF page, in page units from the left edge. */
export interface PdfCell {
  x: number;
  end: number;
  text: string;
}

/** One printed line: the cells sharing a baseline, left to right. */
export interface PdfLine {
  page: number;
  /** Baseline height from the page's bottom edge. */
  y: number;
  cells: PdfCell[];
}

/**
 * The text lines of a PDF, page by page from the top. Glyph runs the PDF splits mid-word
 * ("Be" "nzín", "1" "5" "0 kW") are joined into one cell, with a space across a word gap;
 * runs further apart than half a character height are separate cells: the table columns.
 */
export async function pdfLines(bytes: Uint8Array): Promise<PdfLine[]> {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const lines: PdfLine[] = [];
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      const { items } = await (await pdf.getPage(page)).getTextContent();
      const runs: { x: number; y: number; width: number; size: number; text: string }[] = [];
      for (const item of items) {
        if (!("str" in item)) continue;
        const text = clean(item.str);
        if (!text.trim()) continue;
        const [a = 0, b = 0, , , x = 0, y = 0] = item.transform as number[];
        runs.push({ x, y, width: item.width, size: Math.hypot(a, b) || 10, text });
      }
      lines.push(...toLines(page, runs));
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return lines;
}

function toLines(
  page: number,
  runs: { x: number; y: number; width: number; size: number; text: string }[],
): PdfLine[] {
  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  const rows: (typeof runs)[] = [];
  for (const run of runs) {
    const row = rows.at(-1);
    if (row && Math.abs((row[0] as (typeof runs)[number]).y - run.y) <= 1.5) row.push(run);
    else rows.push([run]);
  }
  return rows.map((row) => {
    row.sort((p, q) => p.x - q.x);
    const cells: PdfCell[] = [];
    let size = 0;
    let previous: (typeof runs)[number] | undefined;
    for (const run of row) {
      // Text overprinted in place (faux bold) is one run, not two.
      const repeat = previous && previous.text === run.text && Math.abs(previous.x - run.x) < 0.5;
      previous = run;
      if (repeat) continue;
      const cell = cells.at(-1);
      const gap = cell ? run.x - cell.end : Number.POSITIVE_INFINITY;
      if (cell && gap <= Math.max(size, run.size) * 0.15) cell.text += run.text;
      else if (cell && gap <= Math.max(size, run.size) * 0.5) cell.text += ` ${run.text}`;
      else cells.push({ x: run.x, end: run.x, text: run.text });
      const last = cells.at(-1) as PdfCell;
      last.end = Math.max(last.end, run.x + run.width);
      size = run.size;
    }
    for (const cell of cells) cell.text = cell.text.replace(/\s+/g, " ").trim();
    return { page, y: (row[0] as (typeof runs)[number]).y, cells };
  });
}

/** No-break and thin spaces (thousands separators) become plain spaces. */
function clean(text: string): string {
  return text.replace(/[\u00a0\u2007\u2009\u202f]/g, " ");
}

/** Index of the header cell whose centre is nearest the cell's centre: its table column. */
export function columnOf(cell: PdfCell, headers: readonly PdfCell[]): number {
  const centre = (c: PdfCell) => (c.x + c.end) / 2;
  let best = 0;
  headers.forEach((header, i) => {
    const d = Math.abs(centre(header) - centre(cell));
    if (d < Math.abs(centre(headers[best] as PdfCell) - centre(cell))) best = i;
  });
  return best;
}
