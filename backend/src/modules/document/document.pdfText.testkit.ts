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

/** The raw (inflated) page content streams — for asserting drawing operators such as a fill colour. */
export const pdfContent = (buf: Buffer): string => contentStreams(buf).join("\n");

/** All the document's text as one string — for "does it say X at all" assertions. */
export const pdfText = (buf: Buffer): string => pdfTextRuns(buf).map((r) => r.text).join("\n");

/** An image XObject embedded in the PDF, its stream already inflated. */
export interface PdfImage {
  id: number;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: string;
  /** Object id of the alpha mask (`/SMask`), when the image has one. */
  smask: number | null;
  data: Buffer;
}

/**
 * Every embedded image, decoded — so a test can check the PIXELS the PDF will actually paint, not just
 * that "an image is in there". A scrambled logo still embeds an image of the right size; only its pixel
 * data gives it away.
 */
export function pdfImages(buf: Buffer): PdfImage[] {
  const text = buf.toString("latin1");
  const out: PdfImage[] = [];
  // One object's dictionary, never spanning into the next object, ending where its stream begins.
  const re = /(\d+) 0 obj\s*<<((?:(?! 0 obj)[\s\S])*?)>>\s*stream\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const dict = m[2];
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const num = (key: string) => Number(dict.match(new RegExp(`/${key}\\s+(\\d+)`))?.[1]);
    const start = m.index + m[0].length;
    const raw = buf.subarray(start, start + num("Length"));
    const smask = dict.match(/\/SMask\s+(\d+)\s+0\s+R/);
    out.push({
      id: Number(m[1]),
      width: num("Width"),
      height: num("Height"),
      bitsPerComponent: num("BitsPerComponent"),
      colorSpace: dict.match(/\/ColorSpace\s*\/(\w+)/)?.[1] ?? "",
      smask: smask ? Number(smask[1]) : null,
      data: /\/FlateDecode/.test(dict) ? zlib.inflateSync(raw) : raw,
    });
  }
  return out;
}

/**
 * A real 8-bit RGBA PNG built from a pixel function — the format a logo reaches the PDF in once
 * `pdfSafeImageUrl` asks Cloudinary for `fl_png32`. Lets a test feed the renderer an exact, known image.
 */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height); // each row: filter byte 0, then RGBA pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixel(x, y).forEach((v, i) => (rows[y * (width * 4 + 1) + 1 + x * 4 + i] = v));
  }
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Real pages only — `/Type /Pages` is the page-tree root, not a page. */
export const pdfPageCount = (buf: Buffer): number => (buf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
