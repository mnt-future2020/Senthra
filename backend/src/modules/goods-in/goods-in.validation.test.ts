import { describe, expect, it } from "vitest";

import { createGoodsReceiptSchema, grnAttachmentSchema, GRN_ATTACHMENT_MAX_BYTES, grnCancelSchema, updateGoodsReceiptSchema } from "./goods-in.validation.js";

const PO = "a".repeat(24);
const POI = "b".repeat(24);
const base = {
  purchaseOrderId: PO,
  receivedDate: "2026-06-15",
  items: [{ purchaseOrderItemId: POI, receivedQuantity: 5, acceptedQuantity: 5 }],
};

describe("createGoodsReceiptSchema", () => {
  it("accepts a minimal valid receipt", () => {
    expect(createGoodsReceiptSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ["missing purchase order", { ...base, purchaseOrderId: "" }],
    ["non-id purchase order", { ...base, purchaseOrderId: "nope" }],
    ["missing received date", { ...base, receivedDate: "" }],
    ["no items", { ...base, items: [] }],
    ["no line receiving >= 1", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 0, acceptedQuantity: 0 }] }],
    ["negative received", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: -1, acceptedQuantity: 0 }] }],
    ["accepted exceeds received", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: 5 }] }],
    ["negative accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: -1 }] }],
    // Required, NOT optional-defaulting-to-0 — a missing field must never silently read as
    // "everything was damaged" and keep good stock out of inventory. z.coerce.number() would
    // turn EVERY value below into a number (null/[]/false → 0, true → 1), so each is pinned
    // separately: coercion, not the required check, is what makes this dangerous.
    ["missing accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3 }] }],
    ["blank accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: "" }] }],
    ["whitespace accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: "   " }] }],
    ["null accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: null }] }],
    ["array accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: [] }] }],
    ["boolean accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: true }] }],
    ["non-numeric accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: "abc" }] }],
    ["fractional accepted", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, acceptedQuantity: 2.5 }] }],
    ["duplicate PO line", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 1, acceptedQuantity: 1 }, { purchaseOrderItemId: POI, receivedQuantity: 2, acceptedQuantity: 2 }] }],
    ["invalid quality status", { ...base, qualityStatus: "weird" }],
    ["batch quantity < 1", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 2, acceptedQuantity: 2, batches: [{ batchNumber: "B1", quantity: 0 }] }] }],
  ])("rejects: %s", (_label, payload) => {
    expect(createGoodsReceiptSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts serials + batches arrays (counts are checked in the service)", () => {
    const ok = createGoodsReceiptSchema.safeParse({
      ...base,
      items: [{ purchaseOrderItemId: POI, receivedQuantity: 2, acceptedQuantity: 2, serials: ["SN1", "SN2"], batches: [{ batchNumber: "B1", expiryDate: "2027-01-01", quantity: 2 }] }],
    });
    expect(ok.success).toBe(true);
  });

  it("still accepts a numeric STRING accepted qty (form fields arrive as strings)", () => {
    const parsed = createGoodsReceiptSchema.safeParse({ ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: "5", acceptedQuantity: "0" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items[0].acceptedQuantity).toBe(0);
  });

  it("accepts a partial acceptance (accepted < received) and zero accepted", () => {
    for (const acceptedQuantity of [0, 3]) {
      const parsed = createGoodsReceiptSchema.safeParse({ ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 5, acceptedQuantity }] });
      expect(parsed.success).toBe(true);
    }
  });

  it("never accepts a client-supplied damaged quantity (it's derived in the service)", () => {
    const parsed = createGoodsReceiptSchema.safeParse({ ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 5, acceptedQuantity: 4, damagedQuantity: 99 }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("damagedQuantity" in parsed.data.items[0]).toBe(false);
  });

  it("never accepts system-owned fields (they're simply ignored)", () => {
    const parsed = createGoodsReceiptSchema.safeParse({ ...base, code: "GRN-9999", status: "completed" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("code" in parsed.data).toBe(false);
      expect("status" in parsed.data).toBe(false);
    }
  });
});

describe("updateGoodsReceiptSchema", () => {
  it("is all-optional (an empty patch is valid)", () => {
    expect(updateGoodsReceiptSchema.safeParse({}).success).toBe(true);
  });
  it("still validates items when provided", () => {
    expect(updateGoodsReceiptSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("grnCancelSchema", () => {
  it("reason is optional", () => {
    expect(grnCancelSchema.safeParse({}).success).toBe(true);
    expect(grnCancelSchema.safeParse({ reason: "Wrong delivery" }).success).toBe(true);
  });
});


// Fixtures carry REAL leading bytes. They used to be `base64,AAAA` with a declared size of 2 KB —
// which the schema accepted, because it read the declaration and never the payload. That is the
// assumption these tests were quietly encoding, so the fixtures had to change with the rule.
const fileOf = (signature: number[], bytes: number) => {
  const head = Buffer.from(signature);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x41)]);
};
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXE_SIG = [0x4d, 0x5a, 0x90, 0x00]; // a Windows executable
const dataUri = (mediaType: string, signature: number[], bytes: number) =>
  `data:${mediaType};base64,${fileOf(signature, bytes).toString("base64")}`;
const pdf = (bytes: number) => dataUri("application/pdf", PDF_SIG, bytes);

describe("grnAttachmentSchema", () => {
  const att = { fileName: "delivery-note.pdf", fileType: "pdf", fileSizeBytes: 2048, data: pdf(2048) };
  it("accepts a valid PDF data URI", () => {
    expect(grnAttachmentSchema.safeParse(att).success).toBe(true);
  });
  it("rejects an unsupported type", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, fileType: "exe" }).success).toBe(false);
  });
  it("accepts a file at exactly the 5 MB limit", () => {
    const at5mb = { ...att, fileSizeBytes: GRN_ATTACHMENT_MAX_BYTES, data: pdf(GRN_ATTACHMENT_MAX_BYTES) };
    expect(grnAttachmentSchema.safeParse(at5mb).success).toBe(true);
  });
  it("rejects a file just over the 5 MB limit", () => {
    const over = { ...att, fileSizeBytes: GRN_ATTACHMENT_MAX_BYTES + 1, data: pdf(GRN_ATTACHMENT_MAX_BYTES + 1) };
    expect(grnAttachmentSchema.safeParse(over).success).toBe(false);
  });
  it("rejects a non data: URI", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, data: "http://x/y.pdf" }).success).toBe(false);
  });

  // The GRN's 20 MB per-receipt ceiling is summed from STORED sizes, so a declaration nobody checks
  // is a cap that silently does not hold — five "40 KB" files could carry 50 MB.
  it("rejects a size that disagrees with the payload, under the limit or not", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, fileSizeBytes: 40 * 1024 }).success).toBe(false);
    expect(grnAttachmentSchema.safeParse({ ...att, fileSizeBytes: 1 }).success).toBe(false);
  });

  it("rejects a payload that is not the type it claims", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, data: dataUri("application/pdf", EXE_SIG, 2048) }).success).toBe(false);
    expect(grnAttachmentSchema.safeParse({ ...att, data: dataUri("application/pdf", PNG_SIG, 2048) }).success).toBe(false);
  });

  it("accepts a PNG declared as png", () => {
    const png = { ...att, fileName: "photo.png", fileType: "png", data: dataUri("image/png", PNG_SIG, 2048) };
    expect(grnAttachmentSchema.safeParse(png).success).toBe(true);
  });
});
