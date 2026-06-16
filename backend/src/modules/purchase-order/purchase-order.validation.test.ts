import { describe, expect, it } from "vitest";

import {
  createPurchaseOrderSchema,
  poAttachmentSchema,
  poCancelSchema,
  poRejectSchema,
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
});

describe("workflow + attachment bodies", () => {
  it("reject requires a reason", () => {
    expect(poRejectSchema.safeParse({}).success).toBe(false);
    expect(poRejectSchema.safeParse({ reason: "Wrong supplier" }).success).toBe(true);
  });

  it("cancel reason is optional", () => {
    expect(poCancelSchema.safeParse({}).success).toBe(true);
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
