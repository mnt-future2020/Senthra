import { describe, expect, it } from "vitest";

import { createGoodsReceiptSchema, grnAttachmentSchema, GRN_ATTACHMENT_MAX_BYTES, grnCancelSchema, updateGoodsReceiptSchema } from "./goods-in.validation.js";

const PO = "a".repeat(24);
const POI = "b".repeat(24);
const base = {
  purchaseOrderId: PO,
  receivedDate: "2026-06-15",
  items: [{ purchaseOrderItemId: POI, receivedQuantity: 5 }],
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
    ["no line receiving >= 1", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 0 }] }],
    ["negative received", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: -1 }] }],
    ["damaged exceeds received", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 3, damagedQuantity: 5 }] }],
    ["duplicate PO line", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 1 }, { purchaseOrderItemId: POI, receivedQuantity: 2 }] }],
    ["invalid quality status", { ...base, qualityStatus: "weird" }],
    ["batch quantity < 1", { ...base, items: [{ purchaseOrderItemId: POI, receivedQuantity: 2, batches: [{ batchNumber: "B1", quantity: 0 }] }] }],
  ])("rejects: %s", (_label, payload) => {
    expect(createGoodsReceiptSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts serials + batches arrays (counts are checked in the service)", () => {
    const ok = createGoodsReceiptSchema.safeParse({
      ...base,
      items: [{ purchaseOrderItemId: POI, receivedQuantity: 2, serials: ["SN1", "SN2"], batches: [{ batchNumber: "B1", expiryDate: "2027-01-01", quantity: 2 }] }],
    });
    expect(ok.success).toBe(true);
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

describe("grnAttachmentSchema", () => {
  const att = { fileName: "delivery-note.pdf", fileType: "pdf", fileSizeBytes: 2048, data: "data:application/pdf;base64,AAAA" };
  it("accepts a valid PDF data URI", () => {
    expect(grnAttachmentSchema.safeParse(att).success).toBe(true);
  });
  it("rejects an unsupported type", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, fileType: "exe" }).success).toBe(false);
  });
  it("accepts a file at exactly the 5 MB limit", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, fileSizeBytes: GRN_ATTACHMENT_MAX_BYTES }).success).toBe(true);
  });
  it("rejects a file just over the 5 MB limit", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, fileSizeBytes: GRN_ATTACHMENT_MAX_BYTES + 1 }).success).toBe(false);
  });
  it("rejects a non data: URI", () => {
    expect(grnAttachmentSchema.safeParse({ ...att, data: "http://x/y.pdf" }).success).toBe(false);
  });
});
