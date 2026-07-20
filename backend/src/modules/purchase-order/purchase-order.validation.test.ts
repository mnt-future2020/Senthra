import { describe, expect, it } from "vitest";

import {
  createPurchaseOrderSchema,
  poAttachmentSchema,
  poCancelSchema,
  poRejectSchema,
  poSupplierAcceptSchema,
  updatePurchaseOrderSchema,
} from "./purchase-order.validation.js";

const SUP_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const IRM_ID = "c".repeat(24);
const IRM_ID_2 = "d".repeat(24);

const valid = (over: Record<string, unknown> = {}) => ({
  supplierId: SUP_ID,
  warehouseId: WH_ID,
  orderDate: "2026-06-01",
  expectedDeliveryDate: "2026-06-10",
  items: [{ irmItemId: IRM_ID, quantity: 5, unitPricePence: 1000 }],
  ...over,
});

describe("createPurchaseOrderSchema — required fields", () => {
  it("accepts a valid order", () => {
    expect(createPurchaseOrderSchema.safeParse(valid()).success).toBe(true);
  });

  it.each(["supplierId", "warehouseId", "orderDate", "expectedDeliveryDate", "items"])(
    "rejects a missing %s",
    (field) => {
      const payload = valid();
      delete (payload as Record<string, unknown>)[field];
      expect(createPurchaseOrderSchema.safeParse(payload).success).toBe(false);
    },
  );
});

describe("createPurchaseOrderSchema — lines", () => {
  it("rejects an empty items array", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [] })).success).toBe(false);
  });

  it("rejects a duplicate item", () => {
    expect(
      createPurchaseOrderSchema.safeParse(
        valid({ items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: 100 }, { irmItemId: IRM_ID, quantity: 2, unitPricePence: 200 }] }),
      ).success,
    ).toBe(false);
  });

  it("accepts two distinct items", () => {
    expect(
      createPurchaseOrderSchema.safeParse(
        valid({ items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: 100 }, { irmItemId: IRM_ID_2, quantity: 2, unitPricePence: 200 }] }),
      ).success,
    ).toBe(true);
  });

  it("rejects a quantity below 1", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [{ irmItemId: IRM_ID, quantity: 0, unitPricePence: 100 }] })).success).toBe(false);
  });

  it("rejects a negative unit price", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: -1 }] })).success).toBe(false);
  });

  it("rejects a VAT rate above 100", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [{ irmItemId: IRM_ID, quantity: 1, unitPricePence: 100, vatRate: 120 }] })).success).toBe(false);
  });
});

describe("createPurchaseOrderSchema — dates", () => {
  it("rejects an expected delivery date before the order date", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ expectedDeliveryDate: "2026-05-01" })).success).toBe(false);
  });

  it("accepts an expected delivery date equal to the order date", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ expectedDeliveryDate: "2026-06-01" })).success).toBe(true);
  });
});

describe("updatePurchaseOrderSchema", () => {
  it("accepts a partial update (priority only)", () => {
    expect(updatePurchaseOrderSchema.safeParse({ priority: "high" }).success).toBe(true);
  });

  it("rejects an unknown priority", () => {
    expect(updatePurchaseOrderSchema.safeParse({ priority: "blocker" }).success).toBe(false);
  });

  it("rejects an empty items array when provided", () => {
    expect(updatePurchaseOrderSchema.safeParse({ items: [] }).success).toBe(false);
  });

  // An EDIT must be able to CLEAR jobId / deliveryTerms via an explicit null (not omission).
  it("accepts null to clear jobId / deliveryTerms / paymentTerms", () => {
    expect(updatePurchaseOrderSchema.safeParse({ jobId: null, deliveryTerms: null, paymentTerms: null }).success).toBe(true);
  });

  it("accepts a valid Incoterm code and rejects an unknown one", () => {
    expect(updatePurchaseOrderSchema.safeParse({ deliveryTerms: "DDP" }).success).toBe(true);
    expect(updatePurchaseOrderSchema.safeParse({ deliveryTerms: "XYZ" }).success).toBe(false);
  });

  // paymentTerms max was raised to 100 to match the supplier's customPaymentTerms cap.
  it("accepts a 100-char payment term but rejects 101", () => {
    expect(updatePurchaseOrderSchema.safeParse({ paymentTerms: "x".repeat(100) }).success).toBe(true);
    expect(updatePurchaseOrderSchema.safeParse({ paymentTerms: "x".repeat(101) }).success).toBe(false);
  });
});

describe("poSupplierAcceptSchema — confirmed delivery can't precede acceptance", () => {
  it("accepts a confirmed date on/after the accepted date", () => {
    expect(poSupplierAcceptSchema.safeParse({ acceptedDate: "2026-07-20", confirmedDeliveryDate: "2026-07-25" }).success).toBe(true);
    expect(poSupplierAcceptSchema.safeParse({ acceptedDate: "2026-07-20", confirmedDeliveryDate: "2026-07-20" }).success).toBe(true);
  });

  it("rejects a confirmed date before the accepted date", () => {
    expect(poSupplierAcceptSchema.safeParse({ acceptedDate: "2026-07-20", confirmedDeliveryDate: "2026-07-10" }).success).toBe(false);
  });

  // Accepting an order means committing to a delivery date — it's what the warehouse plans
  // against, and it stays revisable afterwards via the delivery-date endpoint.
  it("REQUIRES the confirmed delivery date", () => {
    expect(poSupplierAcceptSchema.safeParse({ acceptedDate: "2026-07-20" }).success).toBe(false);
    expect(poSupplierAcceptSchema.safeParse({}).success).toBe(false);
    expect(poSupplierAcceptSchema.safeParse({ confirmedDeliveryDate: "" }).success).toBe(false);
  });

  it("allows a SAME-DAY confirmed delivery when acceptedDate is omitted (date-only compare, not now)", () => {
    // Regression: comparing the date-only confirmed date (UTC midnight) against Date.now()
    // (mid-day) wrongly rejected 'accept today, deliver today'. Both sides are normalised to the day.
    const today = new Date().toISOString().slice(0, 10);
    expect(poSupplierAcceptSchema.safeParse({ confirmedDeliveryDate: today }).success).toBe(true);
  });
});

describe("workflow + attachment bodies", () => {
  it("reject requires a reason", () => {
    expect(poRejectSchema.safeParse({}).success).toBe(false);
    expect(poRejectSchema.safeParse({ reason: "Wrong supplier" }).success).toBe(true);
  });

  it("cancel requires a reason (explicit cancellation matrix)", () => {
    expect(poCancelSchema.safeParse({}).success).toBe(false);
    expect(poCancelSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(poCancelSchema.safeParse({ reason: "No longer needed" }).success).toBe(true);
  });

  it("attachment rejects an unsupported file type", () => {
    expect(
      poAttachmentSchema.safeParse({ fileName: "x.exe", fileType: "exe", fileSizeBytes: 100, data: "data:..." }).success,
    ).toBe(false);
  });

  it("attachment rejects a file over 10 MB", () => {
    expect(
      poAttachmentSchema.safeParse({ fileName: "x.pdf", fileType: "pdf", fileSizeBytes: 11 * 1024 * 1024, data: "data:application/pdf;base64,AAA" }).success,
    ).toBe(false);
  });

  it("attachment accepts a valid PDF", () => {
    expect(
      poAttachmentSchema.safeParse({ label: "Quote", fileName: "quote.pdf", fileType: "pdf", fileSizeBytes: 2048, data: "data:application/pdf;base64,AAA" }).success,
    ).toBe(true);
  });
});
