// TEST-ONLY. Reads the placed text back out of a rendered PDF so a test can assert on the actual
// LAYOUT, not just "a PDF came out". The renderer's real failure modes are positional — text
// overlapping other text, text landing on the page footer, a block orphaned onto a blank page —
// and none of those change the byte length or throw. Not imported by any production module.
//
// pdfkit writes one content stream per page and embeds the unsubsetted standard Helvetica, so the
// hex strings in the text operators decode as plain WinAnsi. Streams that fail to inflate (font
// programs, images) carry no layout and are skipped.

import zlib from "node:zlib";

export interface PdfTextRun {
  /** 1-based page number. */
  page: number;
  x: number;
  /** PDF user space: y grows UPWARD from the bottom of the page. */
  y: number;
  text: string;
}

function contentStreams(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf("endstream", start);
    if (e === -1) break;
    try {
      const text = zlib.inflateSync(buf.subarray(start, e)).toString("latin1");
      if (text.includes(" Tm") && text.includes("TJ")) out.push(text);
    } catch {
      // Not a deflated content stream — nothing to read.
    }
    i = e + 9;
  }
  return out;
}

/** Every text run in the document, in draw order, with the page and position it was placed at. */
export function pdfTextRuns(buf: Buffer): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  contentStreams(buf).forEach((stream, page) => {
    let at: { x: number; y: number } | null = null;
    for (const raw of stream.split("\n")) {
      const tm = raw.match(/^1 0 0 1 ([\d.-]+) ([\d.-]+) Tm$/);
      if (tm) at = { x: Number(tm[1]), y: Number(tm[2]) };
      const tj = raw.match(/^\[(.*)\] TJ$/);
      if (!tj || !at) continue;
      // A TJ array interleaves hex strings with kerning offsets; keep only the strings.
      const text = [...tj[1].matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((m) => Buffer.from(m[1], "hex").toString("latin1"))
        .join("");
      if (text) runs.push({ page: page + 1, x: at.x, y: at.y, text });
    }
  });
  return runs;
}

/** All the document's text as one string — for "does it say X at all" assertions. */
export const pdfText = (buf: Buffer): string => pdfTextRuns(buf).map((r) => r.text).join("\n");

/** Real pages only — `/Type /Pages` is the page-tree root, not a page. */
export const pdfPageCount = (buf: Buffer): number => (buf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
