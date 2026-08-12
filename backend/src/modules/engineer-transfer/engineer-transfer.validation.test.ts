import { describe, expect, it } from "vitest";

import { acknowledgeSchema, createTransferSchema, uploadAttachmentSchema } from "./engineer-transfer.validation.js";

const OID = (c: string) => c.repeat(24);

const FROM = OID("a");
const TO = OID("b");
const IRM = OID("c");
const CSE = OID("d");

const companyLine = { ownership: "company" as const, irmItemId: IRM, quantity: 2 };
const customerLine = { ownership: "customer" as const, customerStockEntryId: CSE, quantity: 1 };

const base = {
  fromEngineerId: FROM,
  toEngineerId: TO,
  lines: [companyLine],
  reason: "Need extra cable for Leeds job",
};

describe("createTransferSchema — line ownership refinement", () => {
  it("accepts a valid company line (irmItemId set)", () => {
    expect(createTransferSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a valid customer line (customerStockEntryId set)", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [customerLine] });
    expect(r.success).toBe(true);
  });

  it("accepts mixed company + customer lines", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [companyLine, customerLine] });
    expect(r.success).toBe(true);
  });

  it("rejects company line without irmItemId", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ownership: "company", quantity: 1 }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.some((i) => i.message.includes("irmItemId"));
      expect(msg).toBe(true);
    }
  });

  it("rejects customer line without customerStockEntryId", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ownership: "customer", quantity: 1 }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.some((i) => i.message.includes("customerStockEntryId"));
      expect(msg).toBe(true);
    }
  });

  it("rejects zero quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: 0 }] });
    expect(r.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: -1 }] });
    expect(r.success).toBe(false);
  });

  it("rejects fractional quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: 1.5 }] });
    expect(r.success).toBe(false);
  });

  it("rejects empty lines array", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [] });
    expect(r.success).toBe(false);
  });

  it("rejects missing reason", () => {
    const r = createTransferSchema.safeParse({ ...base, reason: "" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid fromEngineerId (not ObjectId)", () => {
    const r = createTransferSchema.safeParse({ ...base, fromEngineerId: "nope" });
    expect(r.success).toBe(false);
  });

  it("toEngineerId is optional (self-service flow)", () => {
    const { toEngineerId: _, ...noTo } = base;
    const r = createTransferSchema.safeParse(noTo);
    expect(r.success).toBe(true);
  });
});
// ── Upload contracts ────────────────────────────────────────────────────────────────────────────
//
// Fixtures carry REAL leading bytes rather than a placeholder payload under a chosen label. These
// schemas judge the declared media type only, so a label alone would satisfy them — which is exactly
// the weakness being closed, and a fixture that leans on it documents the wrong contract.
const bytesOf = (signature: number[], pad = 40) =>
  Buffer.concat([Buffer.from(signature), Buffer.alloc(pad, 0x41)]).toString("base64");
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = bytesOf([0xff, 0xd8, 0xff, 0xe0]);
const GIF = bytesOf([...Buffer.from("GIF89a")]);
const PDF = bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d]);
const EXE = bytesOf([0x4d, 0x5a, 0x90, 0x00]); // a Windows executable
const uri = (mediaType: string, payload: string) => `data:${mediaType};base64,${payload}`;
const MAX_CHARS = 3 * 1024 * 1024;

// The recipient DRAWS this on a canvas — `canvas.toDataURL("image/png")` in EngineerTransfers.tsx is
// the only producer, and there is no upload alternative. It previously accepted any `data:image/…`
// with NO size ceiling at all: the only limit was the global body parser's ~3.7 MB.
describe("acknowledgeSchema — the signature is evidence", () => {
  const parse = (signature: string) => acknowledgeSchema.safeParse({ signature });

  it("accepts the PNG the signature pad actually produces", () => {
    expect(parse(uri("image/png", PNG)).success).toBe(true);
  });

  // The app's established signature contract (user.validation's signatureImage) allows both, so a
  // future upload option needs no second rule.
  it("accepts JPEG, matching the app's other signature field", () => {
    expect(parse(uri("image/jpeg", JPG)).success).toBe(true);
    expect(parse(uri("image/jpg", JPG)).success).toBe(true);
  });

  // A signature records that a named person took delivery. An SVG renders differently in different
  // viewers — the one property such a record must not have — and can carry script onto a public URL.
  it("rejects SVG", () => {
    expect(parse(uri("image/svg+xml", PNG)).success).toBe(false);
  });

  it.each(["image/gif", "image/webp", "image/x-icon", "image/avif", "image/tiff"])(
    "rejects %s — no longer any image/* subtype",
    (mediaType) => {
      expect(parse(uri(mediaType, GIF)).success).toBe(false);
    },
  );

  it.each([
    ["a PDF", uri("application/pdf", PDF)],
    ["an executable", uri("application/octet-stream", EXE)],
    ["a plain URL", "https://cdn.example.com/sig.png"],
    ["free text", "signature"],
    ["an empty string", ""],
    ["a percent-encoded data URI", "data:image/png,notbase64"],
  ])("rejects %s", (_label, signature) => {
    expect(parse(signature).success).toBe(false);
  });

  it("accepts a signature just inside the size ceiling", () => {
    const payload = "A".repeat(MAX_CHARS - uri("image/png", "").length);
    expect(parse(uri("image/png", payload)).success).toBe(true);
  });

  // The ceiling this field never had.
  it("rejects a signature past the size ceiling", () => {
    const payload = "A".repeat(MAX_CHARS);
    expect(parse(uri("image/png", payload)).success).toBe(false);
  });

  it("reports against the signature field", () => {
    const res = parse(uri("image/svg+xml", PNG));
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues.some((i) => i.path.includes("signature"))).toBe(true);
  });
});

// `application/octet-stream` is what a browser emits when it knows nothing about a file, so accepting
// it meant this endpoint accepted any payload at all under that label. TransferComposer refuses a file
// whose `file.type` is not `image/*` before uploading, so nothing legitimate produced it.
describe("engineer-transfer uploadAttachmentSchema", () => {
  const parse = (image: string) => uploadAttachmentSchema.safeParse({ image });

  it("rejects application/octet-stream", () => {
    expect(parse(uri("application/octet-stream", PNG)).success).toBe(false);
  });

  it("rejects an executable declared as octet-stream", () => {
    expect(parse(uri("application/octet-stream", EXE)).success).toBe(false);
  });

  it.each([
    ["PNG", "image/png", PNG],
    ["JPEG", "image/jpeg", JPG],
    ["GIF", "image/gif", GIF],
    ["WEBP", "image/webp", GIF],
    ["SVG", "image/svg+xml", GIF],
    ["PDF", "application/pdf", PDF],
  ])("still accepts %s", (_l, mediaType, payload) => {
    expect(parse(uri(mediaType, payload)).success).toBe(true);
  });

  it("keeps the ~2 MB ceiling", () => {
    expect(parse(uri("image/png", "A".repeat(MAX_CHARS))).success).toBe(false);
  });

  // Anchored to `;base64,`. A percent-encoded data URI is a different encoding, not a smaller one:
  // it used to pass this regex and fail later inside Cloudinary, surfacing an error from the wrong
  // layer with a message about nothing the caller did.
  it.each([
    ["a percent-encoded data URI", "data:image/png,hello-world"],
    ["a data URI with no encoding declared", "data:image/png,"],
    ["a charset instead of base64", "data:image/png;charset=utf-8,abc"],
  ])("rejects %s", (_l, v) => {
    expect(parse(v).success).toBe(false);
  });
});
