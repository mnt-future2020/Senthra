// ── Reading a base64 data URI without trusting what the caller says about it ────────────────────
//
// Every file in this app arrives as a base64 data URI in a JSON body, alongside fields describing it:
// `fileType: "pdf"`, `fileSizeBytes: 42000`. Those fields are CLAIMS. A courier that reads the label
// and never opens the box will happily carry anything, and for a long time that is what the
// attachment endpoints did — the declared type and size were validated against each other and never
// against the payload.
//
// Two of those claims can be settled here, and one of them cannot:
//
//   SIZE  can be measured exactly. Base64 of N bytes decodes to exactly N bytes, so a caller cannot
//         declare 40 KB and send 12 MB — the payload's own length gives it away. Worth enforcing:
//         the GRN's 20 MB per-receipt ceiling is summed from stored sizes, so a wrong figure there
//         is a real cap that silently does not hold.
//
//   TYPE  cannot be settled from the URI's media type. `data:application/pdf;base64,…` — that
//         `application/pdf` is text the caller wrote, so reading it only relocates the same claim.
//         What CAN settle it is the file's own leading bytes: PDF, DOCX, PNG and JPEG each begin
//         with a fixed signature that a real file of that type has and a mislabelled one does not.

/** Split a data URI into its media type and base64 payload. Null if it isn't one. */
function parseDataUri(dataUri: string): { mediaType: string; b64: string } | null {
  if (!dataUri.startsWith("data:")) return null;
  const comma = dataUri.indexOf(",");
  if (comma < 0) return null;
  const header = dataUri.slice(5, comma);
  if (!header.includes("base64")) return null; // percent-encoded data URIs are not accepted anywhere
  return { mediaType: header.replace(/;base64$/i, ""), b64: dataUri.slice(comma + 1) };
}

/**
 * Decoded size in bytes — the real one, derived from the payload.
 *
 * Returns 0 for anything that isn't a base64 data URI, which reads as "nothing was sent" and fails
 * the `min(1)` every caller applies. Never throws: this runs inside zod refinements on untrusted
 * input, and a parse error there would surface as a 500 rather than a validation message.
 */
export function dataUriBytes(dataUri: string): number {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return 0;
  const b64 = parsed.b64.replace(/\s/g, "");
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** The media type the caller stated. A claim — use `detectAttachmentType` to decide what it IS. */
export function dataUriMediaType(dataUri: string): string | null {
  return parseDataUri(dataUri)?.mediaType.toLowerCase() ?? null;
}

/** The four file types every attachment surface accepts. */
export type AttachmentFileType = "pdf" | "docx" | "png" | "jpg";

// Leading bytes that identify each accepted format.
//   PDF   "%PDF-"
//   DOCX  a ZIP container, so the local-file-header magic "PK\x03\x04"
//   PNG   the 8-byte signature
//   JPEG  the SOI marker plus the first marker byte
const SIGNATURES: { type: AttachmentFileType; bytes: number[] }[] = [
  { type: "docx", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "jpg", bytes: [0xff, 0xd8, 0xff] },
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// How far into the file to look for the PDF header. The spec puts it at offset 0, but writers do
// prepend bytes and every real reader scans for it, so rejecting those would refuse invoices that
// open fine everywhere else. The other three formats are strict at offset 0 — a ZIP or PNG with junk
// in front is genuinely broken — so only PDF gets the search.
const PDF_SEARCH_BYTES = 1024;

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * Decode just the head of the payload — enough for any signature and the PDF search window.
 *
 * Sliced on a 4-character boundary so the base64 decodes cleanly, and deliberately NOT the whole
 * file: a 10 MB attachment would otherwise be fully materialised on every validation pass, for the
 * sake of its first eight bytes.
 */
function decodeHead(b64: string): Buffer {
  const clean = b64.replace(/\s/g, "");
  const chars = Math.ceil((PDF_SEARCH_BYTES * 4) / 3 / 4) * 4;
  return Buffer.from(clean.slice(0, chars), "base64");
}

/**
 * What the file actually is, read from its own bytes. Null when it matches none of the four —
 * which is the answer for an executable, an SVG, a text file, or a truncated upload.
 */
export function detectAttachmentType(dataUri: string): AttachmentFileType | null {
  const parsed = parseDataUri(dataUri);
  if (!parsed) return null;
  const head = decodeHead(parsed.b64);
  if (head.length === 0) return null;

  for (const { type, bytes } of SIGNATURES) {
    if (startsWith(head, bytes)) return type;
  }
  // PDF last, and searched rather than anchored — see PDF_SEARCH_BYTES.
  if (head.subarray(0, PDF_SEARCH_BYTES).includes(Buffer.from(PDF_MAGIC))) return "pdf";
  return null;
}

/**
 * Does the payload match the type the caller declared?
 *
 * `jpeg` is accepted as a spelling of `jpg` because both name one format and the pickers offer both
 * extensions. Anything the signature table doesn't recognise is a mismatch, not a pass — an unknown
 * file is exactly what must not be stored under a trusted label.
 */
export function attachmentTypeMatches(dataUri: string, declared: string): boolean {
  const actual = detectAttachmentType(dataUri);
  if (!actual) return false;
  const want = declared.toLowerCase() === "jpeg" ? "jpg" : declared.toLowerCase();
  return actual === want;
}
