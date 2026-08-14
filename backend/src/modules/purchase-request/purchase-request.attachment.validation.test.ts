import { describe, expect, it } from "vitest";

import { prfAttachmentSchema } from "./purchase-request.validation.js";

// The PRF attachment body. This surface matters more than the other two: converting a PRF copies its
// attachments' identity onto the PO, so one stored file ends up displayed on two records — and
// removing either one now deletes the file from Cloudinary. Whatever gets in here under a trusted
// label is what a supplier order later shows as its quotation.
//
// Both descriptive fields used to be taken on trust: `fileType: "pdf", fileSizeBytes: 40960` would
// carry any payload at any size, because the schema compared the declarations to each other and never
// to `data`.

const sig = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], // %PDF-1.4
  docx: [0x50, 0x4b, 0x03, 0x04], // ZIP container
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff, 0xe0],
  exe: [0x4d, 0x5a, 0x90, 0x00],
  svg: [...Buffer.from("<svg xmlns=")],
} as const;

const dataUri = (mediaType: string, signature: readonly number[], bytes: number) => {
  const head = Buffer.from(signature as number[]);
  const buf = Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x41)]);
  return `data:${mediaType};base64,${buf.toString("base64")}`;
};

const TEN_MB = 10 * 1024 * 1024;
const base = { fileName: "quote.pdf", fileType: "pdf", fileSizeBytes: 2048, data: dataUri("application/pdf", sig.pdf, 2048) };

describe("prfAttachmentSchema — the honest case", () => {
  it("accepts a PDF that is a PDF, at the size it says", () => {
    expect(prfAttachmentSchema.safeParse(base).success).toBe(true);
  });

  it.each(["docx", "png", "jpg"] as const)("accepts a %s", (type) => {
    const res = prfAttachmentSchema.safeParse({ ...base, fileName: `q.${type}`, fileType: type, data: dataUri("application/octet-stream", sig[type], 2048) });
    expect(res.success).toBe(true);
  });

  it("accepts a file at exactly the 10 MB ceiling", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileSizeBytes: TEN_MB, data: dataUri("application/pdf", sig.pdf, TEN_MB) }).success).toBe(true);
  });

  it("keeps the label optional", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, label: "Supplier quote" }).success).toBe(true);
  });
});

describe("prfAttachmentSchema — the size is measured, not taken on trust", () => {
  // The declaration used to be the only thing checked, so this passed.
  it("rejects a small declared size on a large payload", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileSizeBytes: 40 * 1024 }).success).toBe(false);
  });

  it("rejects a large declared size on a small payload", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileSizeBytes: 1 }).success).toBe(false);
  });

  it("rejects an oversize payload however small the declaration", () => {
    const over = { ...base, fileSizeBytes: 2048, data: dataUri("application/pdf", sig.pdf, TEN_MB + 1024) };
    expect(prfAttachmentSchema.safeParse(over).success).toBe(false);
  });

  // Reported against the field the user can act on, not buried under `data`.
  it("names fileSizeBytes when the two disagree", () => {
    const res = prfAttachmentSchema.safeParse({ ...base, fileSizeBytes: 999 });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues.some((i) => i.path.includes("fileSizeBytes"))).toBe(true);
  });
});

describe("prfAttachmentSchema — the type is read from the file", () => {
  it("rejects an executable calling itself a PDF", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, data: dataUri("application/pdf", sig.exe, 2048) }).success).toBe(false);
  });

  // An SVG is the one that would matter most: it is a document format that can carry script, and
  // these files come back as links staff, engineers and customers all click.
  it("rejects an SVG calling itself a PNG", () => {
    const res = prfAttachmentSchema.safeParse({ ...base, fileName: "logo.png", fileType: "png", data: dataUri("image/png", sig.svg, 2048) });
    expect(res.success).toBe(false);
  });

  it("rejects a real file wearing the wrong one of the four labels", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileType: "png" }).success).toBe(false); // a PDF declared png
    expect(prfAttachmentSchema.safeParse({ ...base, fileType: "docx" }).success).toBe(false);
  });

  it("ignores the media type in the URI, honest or not", () => {
    // Wrong label in front of a real PDF: still a PDF.
    expect(prfAttachmentSchema.safeParse({ ...base, data: dataUri("image/png", sig.pdf, 2048) }).success).toBe(true);
    // Right label in front of an executable: still not a PDF.
    expect(prfAttachmentSchema.safeParse({ ...base, data: dataUri("application/pdf", sig.exe, 2048) }).success).toBe(false);
  });

  it("names fileType when the payload contradicts it", () => {
    const res = prfAttachmentSchema.safeParse({ ...base, data: dataUri("application/pdf", sig.exe, 2048) });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues.some((i) => i.path.includes("fileType"))).toBe(true);
  });
});

describe("prfAttachmentSchema — malformed bodies", () => {
  it.each([
    ["a plain URL", "https://example.com/quote.pdf"],
    ["an empty string", ""],
    ["a data URI with no payload", "data:application/pdf;base64,"],
    ["a percent-encoded data URI", "data:text/plain,hello"],
  ])("rejects %s", (_label, data) => {
    expect(prfAttachmentSchema.safeParse({ ...base, data }).success).toBe(false);
  });

  it("still rejects a type outside the four", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileType: "exe" }).success).toBe(false);
  });

  it("still requires a file name", () => {
    expect(prfAttachmentSchema.safeParse({ ...base, fileName: "" }).success).toBe(false);
  });
});
