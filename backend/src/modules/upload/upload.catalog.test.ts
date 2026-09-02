import { describe, expect, it } from "vitest";

import {
  BINARY_HEADERS,
  CONTENT_SIGNATURES,
  CSV_HEADER_GUARDS,
  MIN_PRINTABLE_HEADER_BYTES,
  UPLOAD_PURPOSES,
  isPrintableAscii,
  isTextByte,
  resourceTypeFor,
} from "./upload.catalog.js";

// The catalog is the ONLY place an upload's size limit lives, and a limit set too low fails in a way
// nobody reports: the picker refuses the file, the user assumes their photo is "wrong", and tries a
// different one. That is what happened to `damage_photo` before it was raised, and the same value
// was sitting in four more purposes. These pin the shape so it cannot drift back.

const MB = 1024 * 1024;

const EVIDENCE_PURPOSES = ["damage_photo", "vsr_attachment", "vsr_damage_photo", "transfer_attachment"] as const;

describe("evidence-photo purposes", () => {
  // Every one of these is captured on a phone, by an engineer in a van or a manager on the warehouse
  // floor, and a modern phone JPEG is routinely 4–15 MB. The browser downscales before uploading, so
  // a typical capture arrives far under this — the ceiling exists for the files compression cannot
  // help: a format the canvas will not decode, or a device too constrained to re-encode.
  it.each(EVIDENCE_PURPOSES)("%s accepts a full-size phone photo", (purpose) => {
    expect(UPLOAD_PURPOSES[purpose].maxBytes).toBe(10 * MB);
  });

  // Images only. These skip the magic-byte read that documents get, because Cloudinary's own decode
  // is the content check — it stores them as `image` and rejects anything it cannot decode. A
  // purpose that quietly gained a document type here would lose that guarantee.
  it.each(EVIDENCE_PURPOSES)("%s accepts images and nothing else", (purpose) => {
    for (const type of UPLOAD_PURPOSES[purpose].mediaTypes) {
      expect(type, `${purpose} allows ${type}`).toMatch(/^image\//);
    }
  });
});

describe("document purposes", () => {
  // Documents are the customer's own paperwork and are NOT downscaled — a canvas round trip would
  // destroy a PDF — so their ceilings have to hold the real file.
  it.each([
    ["job_attachment", 10],
    ["prf_attachment", 10],
    ["po_attachment", 10],
    ["grn_attachment", 5],
  ] as const)("%s caps at %i MB", (purpose, mb) => {
    expect(UPLOAD_PURPOSES[purpose].maxBytes).toBe(mb * MB);
  });
});

describe("every purpose", () => {
  it("declares a positive size cap", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.maxBytes, name).toBeGreaterThan(0);
    }
  });

  // A purpose with no accepted types would sign an upload of anything at all.
  it("declares at least one accepted media type", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.mediaTypes.length, name).toBeGreaterThan(0);
    }
  });

  // The permission list is what stops one module's picker minting a signature for another's folder.
  it("declares at least one permission", () => {
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      expect(cfg.permissions.length, name).toBeGreaterThan(0);
    }
  });
});

// ── Spreadsheets are a SURFACE decision, not a global one ──────────────────────────────────────
//
// The client asked for CSV/XLS/XLSX in document uploads. The easy way to deliver that is to widen
// the one shared `DOCUMENT_TYPES` list, which silently hands spreadsheets to every purpose that
// happens to reference it — including the goods receipt, which was never part of the ask. These pin
// the split so a later edit cannot collapse it back into one list without a test going red.

const SPREADSHEETS = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

const SPREADSHEET_CAPABLE = ["prf_attachment", "po_attachment", "job_attachment"] as const;

describe("spreadsheet policy", () => {
  it.each(SPREADSHEET_CAPABLE)("%s accepts CSV, XLS and XLSX", (purpose) => {
    for (const type of SPREADSHEETS) {
      expect(UPLOAD_PURPOSES[purpose].mediaTypes, `${purpose} should accept ${type}`).toContain(type);
    }
  });

  // The originals are ADDED to, never replaced. A supplier quote is still overwhelmingly a PDF.
  it.each(SPREADSHEET_CAPABLE)("%s still accepts the original four document types", (purpose) => {
    for (const type of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/png",
      "image/jpeg",
    ]) {
      expect(UPLOAD_PURPOSES[purpose].mediaTypes, `${purpose} should still accept ${type}`).toContain(type);
    }
  });

  // A goods receipt carries what came off the van — a delivery note, a packing slip, a photo of a
  // damaged pallet. Not a workbook. This is the assertion that makes the two lists a decision.
  it("grn_attachment accepts no spreadsheet type", () => {
    for (const type of SPREADSHEETS) {
      expect(UPLOAD_PURPOSES.grn_attachment.mediaTypes, `GRN should not accept ${type}`).not.toContain(type);
    }
  });

  // Photos are a different category entirely and must not drift into document policy.
  it.each(EVIDENCE_PURPOSES)("%s accepts no spreadsheet type", (purpose) => {
    for (const type of SPREADSHEETS) {
      expect(UPLOAD_PURPOSES[purpose].mediaTypes, `${purpose} should not accept ${type}`).not.toContain(type);
    }
  });
});

describe("content signatures", () => {
  // `assertContentMatches` FAILS CLOSED: a raw type with no entry here is refused outright. So every
  // non-image type any purpose accepts must be checkable, or that purpose is advertising a type it
  // will always reject at finalize — after the user has waited for the whole upload.
  it("covers every non-image media type any purpose accepts", () => {
    const covered = new Set(CONTENT_SIGNATURES.map((s) => s.mediaType));
    for (const [name, cfg] of Object.entries(UPLOAD_PURPOSES)) {
      for (const type of cfg.mediaTypes) {
        if (resourceTypeFor(type) === "image") continue;
        expect(covered, `${name} accepts ${type} with no content signature`).toContain(type);
      }
    }
  });

  // The inverse: an entry describes either leading bytes or a text check, never both and never
  // neither. A malformed entry would make `assertContentMatches` take a branch with nothing to test.
  it("gives every signature exactly one kind of check", () => {
    for (const sig of CONTENT_SIGNATURES) {
      const kinds = [sig.bytes ? "bytes" : null, sig.text ? "text" : null].filter(Boolean);
      expect(kinds, `${sig.mediaType} declares ${kinds.length} checks`).toHaveLength(1);
    }
  });

  it("checks CSV by exclusion, because no CSV signature exists", () => {
    const csv = CONTENT_SIGNATURES.find((s) => s.mediaType === "text/csv");
    expect(csv?.text).toBe(true);
  });

  // The list a CSV probe is swept against. An executable header missing from it is the case this
  // whole check exists for.
  it("refuses the common executable and archive headers", () => {
    const heads = BINARY_HEADERS.map((h) => h.bytes.join(","));
    expect(heads).toContain([0x4d, 0x5a].join(",")); // MZ — Windows .exe
    expect(heads).toContain([0x7f, 0x45, 0x4c, 0x46].join(",")); // ELF
    expect(heads).toContain([0x50, 0x4b, 0x03, 0x04].join(",")); // ZIP
  });
});

// ── Which headers may reject a CSV on their own ────────────────────────────────────────────────
//
// `BINARY_HEADERS` is the catalogue; `CSV_HEADER_GUARDS` is the subset that is EVIDENCE. The
// difference is the "MZ" bug: two printable letters matched a real parts CSV opening `MZ1200,...`
// and refused it as a Windows executable. A prefix only means something if a CSV could not begin
// with it.
describe("isTextByte", () => {
  it("accepts what a CSV actually contains", () => {
    for (const b of [0x09, 0x0a, 0x0d, 0x20, 0x2c, 0x41, 0x7e]) expect(isTextByte(b), `0x${b.toString(16)}`).toBe(true);
  });

  // UTF-8 continuation bytes and Latin-1 accents. Refusing these would refuse "Müller".
  it("accepts every byte from 0x80 up", () => {
    for (const b of [0x80, 0xc3, 0xbc, 0xef, 0xbb, 0xbf, 0xff]) expect(isTextByte(b), `0x${b.toString(16)}`).toBe(true);
  });

  it("refuses the C0 controls a data file never carries, and DEL", () => {
    for (const b of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) expect(isTextByte(b), `0x${b.toString(16)}`).toBe(false);
  });
});

describe("CSV_HEADER_GUARDS", () => {
  const has = (bytes: number[]) => CSV_HEADER_GUARDS.some((h) => h.bytes.join(",") === bytes.join(","));

  // THE regression, stated as the rule rather than as one exception.
  it("drops MZ — two printable bytes a real CSV can open with", () => {
    expect(has([0x4d, 0x5a])).toBe(false);
    // Still catalogued: nothing was deleted from the security model, only demoted from standalone
    // evidence to a format the text sweep already refuses.
    expect(BINARY_HEADERS.some((h) => h.bytes.join(",") === [0x4d, 0x5a].join(","))).toBe(true);
  });

  it("keeps every header that carries a byte no text file has", () => {
    expect(has([0x7f, 0x45, 0x4c, 0x46])).toBe(true); // ELF — DEL
    expect(has([0x50, 0x4b, 0x03, 0x04])).toBe(true); // ZIP — 0x03
    expect(has([0xd0, 0xcf, 0x11, 0xe0])).toBe(true); // OLE2 — 0x11
    expect(has([0x1f, 0x8b])).toBe(true); // gzip — 0x1f, and only two bytes
  });

  // All-printable but four bytes long: no parts list opens with these.
  it("keeps the four-byte printable tokens", () => {
    expect(has([0x25, 0x50, 0x44, 0x46])).toBe(true); // %PDF
    expect(has([0x47, 0x49, 0x46, 0x38])).toBe(true); // GIF8
    expect(has([0x52, 0x61, 0x72, 0x21])).toBe(true); // Rar!
  });

  // The rule, not the list — so a header added later is judged rather than assumed.
  it("admits a header only when it is non-printable or long enough to be unmistakable", () => {
    for (const h of BINARY_HEADERS) {
      const printable = h.bytes.every(isPrintableAscii);
      const admitted = has(h.bytes);
      expect(admitted, h.label).toBe(!printable || h.bytes.length >= MIN_PRINTABLE_HEADER_BYTES);
    }
  });

  it("drops exactly one entry from the catalogue", () => {
    expect(CSV_HEADER_GUARDS).toHaveLength(BINARY_HEADERS.length - 1);
  });
});
