import { describe, expect, it } from "vitest";

import { createGoodsReceiptSchema, grnCancelSchema, updateGoodsReceiptSchema } from "./goods-in.validation.js";

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



