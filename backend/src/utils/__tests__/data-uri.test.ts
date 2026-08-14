import { describe, expect, it } from "vitest";

import { attachmentTypeMatches, dataUriBytes, dataUriMediaType, detectAttachmentType } from "../data-uri.js";

// Builders that produce a data URI from REAL leading bytes, so these tests exercise the same path a
// browser upload takes rather than a hand-written string that happens to satisfy the regex.
const uri = (mediaType: string, bytes: number[] | Buffer, tail = 0) => {
  const head = Buffer.from(bytes as number[]);
  const buf = tail > 0 ? Buffer.concat([head, Buffer.alloc(tail, 0x41)]) : head;
  return `data:${mediaType};base64,${buf.toString("base64")}`;
};

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
const DOCX = [0x50, 0x4b, 0x03, 0x04];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const EXE = [0x4d, 0x5a, 0x90, 0x00]; // "MZ" — a Windows executable
const SVG = [...Buffer.from("<svg xmlns=")];

describe("dataUriBytes", () => {
  // The reason this exists: a caller declares a size and the server believed it. Base64 of N bytes
  // decodes to exactly N, so the payload settles it and the declaration cannot inflate or deflate.
  it("measures the decoded length exactly, at every padding length", () => {
    for (const n of [1, 2, 3, 4, 5, 100, 1023, 1024, 4096]) {
      const data = `data:application/pdf;base64,${Buffer.alloc(n, 0x41).toString("base64")}`;
      expect(dataUriBytes(data), `${n} bytes`).toBe(n);
    }
  });

  it("is not fooled by a large declared size on a tiny payload", () => {
    expect(dataUriBytes(uri("application/pdf", PDF))).toBe(PDF.length);
  });

  it("tolerates whitespace inside the payload", () => {
    const b64 = Buffer.alloc(30, 0x41).toString("base64");
    expect(dataUriBytes(`data:application/pdf;base64,${b64.slice(0, 8)}\n${b64.slice(8)}`)).toBe(30);
  });

  // Never throws — it runs inside zod refinements on untrusted input, where an exception would
  // surface as a 500 instead of a validation message. 0 then fails the min(1) every caller applies.
  it.each(["", "not a data uri", "data:application/pdf", "data:application/pdf,plain-text", "https://x/a.pdf"])(
    "returns 0 for %o rather than throwing",
    (input) => {
      expect(dataUriBytes(input)).toBe(0);
    },
  );
});

describe("detectAttachmentType", () => {
  it.each([
    ["pdf", PDF],
    ["docx", DOCX],
    ["png", PNG],
    ["jpg", JPG],
  ] as const)("identifies %s from its leading bytes", (expected, bytes) => {
    expect(detectAttachmentType(uri("application/octet-stream", bytes))).toBe(expected);
  });

  // The whole point: the stated media type is ignored. A payload labelled `application/pdf` that is
  // really an executable comes back as unrecognised, not as a PDF.
  it("ignores the stated media type entirely", () => {
    expect(detectAttachmentType(uri("application/pdf", EXE))).toBeNull();
    expect(detectAttachmentType(uri("application/pdf", PNG))).toBe("png");
    expect(detectAttachmentType(uri("image/png", PDF))).toBe("pdf");
  });

  it.each([
    ["an executable", EXE],
    ["an SVG", SVG],
    ["plain text", [...Buffer.from("hello world, no signature here")]],
  ])("refuses to name %s", (_label, bytes) => {
    expect(detectAttachmentType(uri("application/pdf", bytes))).toBeNull();
  });

  // Some writers prepend bytes before "%PDF-" and every real reader scans for it, so a strict
  // offset-0 check would reject invoices that open fine everywhere else.
  it("finds a PDF header that is not at offset 0", () => {
    const shifted = Buffer.concat([Buffer.alloc(40, 0x20), Buffer.from(PDF)]);
    expect(detectAttachmentType(uri("application/pdf", shifted))).toBe("pdf");
  });

  it("stops looking for the PDF header past the search window", () => {
    const buried = Buffer.concat([Buffer.alloc(4096, 0x20), Buffer.from(PDF)]);
    expect(detectAttachmentType(uri("application/pdf", buried))).toBeNull();
  });

  // ZIP, PNG and JPEG are strict at offset 0 — one with junk in front is genuinely broken, and
  // accepting it would reopen the hole the PDF search deliberately allows.
  it.each([
    ["docx", DOCX],
    ["png", PNG],
    ["jpg", JPG],
  ] as const)("does NOT search for the %s signature past offset 0", (_type, bytes) => {
    const shifted = Buffer.concat([Buffer.alloc(8, 0x20), Buffer.from(bytes as number[])]);
    expect(detectAttachmentType(uri("application/octet-stream", shifted))).toBeNull();
  });

  it("handles a payload shorter than a signature without throwing", () => {
    expect(detectAttachmentType("data:application/pdf;base64,QQ==")).toBeNull();
    expect(detectAttachmentType("data:application/pdf;base64,")).toBeNull();
  });

  it("reads a large file from its head alone", () => {
    expect(detectAttachmentType(uri("application/pdf", PDF, 200_000))).toBe("pdf");
  });
});

describe("attachmentTypeMatches", () => {
  it("passes when the declaration is honest", () => {
    expect(attachmentTypeMatches(uri("application/pdf", PDF), "pdf")).toBe(true);
    expect(attachmentTypeMatches(uri("image/png", PNG), "png")).toBe(true);
  });

  // The case that motivated all of this: "it's a pdf, trust me".
  it("fails when the declaration is a lie", () => {
    expect(attachmentTypeMatches(uri("application/pdf", EXE), "pdf")).toBe(false);
    expect(attachmentTypeMatches(uri("application/pdf", PNG), "pdf")).toBe(false);
    expect(attachmentTypeMatches(uri("application/pdf", SVG), "pdf")).toBe(false);
  });

  it("treats jpeg and jpg as one format, in either spelling", () => {
    expect(attachmentTypeMatches(uri("image/jpeg", JPG), "jpg")).toBe(true);
    expect(attachmentTypeMatches(uri("image/jpeg", JPG), "jpeg")).toBe(true);
    expect(attachmentTypeMatches(uri("image/jpeg", JPG), "JPEG")).toBe(true);
  });

  it("fails an unrecognised payload rather than letting it through", () => {
    expect(attachmentTypeMatches(uri("application/pdf", [0x00, 0x01]), "pdf")).toBe(false);
    expect(attachmentTypeMatches("garbage", "pdf")).toBe(false);
  });
});

describe("dataUriMediaType", () => {
  it("reports the stated type, lowercased", () => {
    expect(dataUriMediaType("data:APPLICATION/PDF;base64,QQ==")).toBe("application/pdf");
  });

  it("returns null for a non-base64 data URI", () => {
    expect(dataUriMediaType("data:text/plain,hello")).toBeNull();
  });
});
