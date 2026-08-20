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

// Fixtures carry REAL leading bytes. They used to be `base64,AAAA` with a declared size of 2 KB —
// which the schema accepted, because it read the declaration and never the payload. That is the
// assumption these tests were quietly encoding, so the fixtures had to change with the rule.
const fileOf = (signature: number[], bytes: number) => {
  const head = Buffer.from(signature);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 0x41)]);
};
const PDF_SIG = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
const EXE_SIG = [0x4d, 0x5a, 0x90, 0x00]; // a Windows executable
const dataUri = (mediaType: string, signature: number[], bytes: number) =>
  `data:${mediaType};base64,${fileOf(signature, bytes).toString("base64")}`;
const pdf = (bytes: number) => dataUri("application/pdf", PDF_SIG, bytes);

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

  // An empty items array is now legitimate HERE: an order converted from a hire-only request has
  // no IRM lines at all, and refusing it made such an order impossible to edit. The rule did not
  // disappear — it moved to the service, which can see the rental lines and refuses only when the
  // order would be left with no line of either kind (see updatePurchaseOrder).
  it("accepts an empty items array — the 'must keep a line' rule lives in the service", () => {
    expect(updatePurchaseOrderSchema.safeParse({ items: [] }).success).toBe(true);
  });

  // The manual CREATE still requires one: there is no way to enter a rental line by hand, so an
  // order created with no items would have nothing on it at all.
  it("still rejects an empty items array on create", () => {
    expect(
      createPurchaseOrderSchema.safeParse({
        supplierId: "a".repeat(24),
        warehouseId: "b".repeat(24),
        orderDate: "2026-09-01",
        expectedDeliveryDate: "2026-09-10",
        items: [],
      }).success,
    ).toBe(false);
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

  // The confirmed date is CONDITIONALLY required, and the condition is the order's STATUS — which a
  // body schema cannot see. The rule lives in recordSupplierAcceptance; the schema only has to stop
  // refusing the late-acknowledgement case, where the goods are already in and there is no delivery
  // left to plan for.
  it("accepts an acknowledgement with no confirmed delivery date", () => {
    expect(poSupplierAcceptSchema.safeParse({ acceptedDate: "2026-07-20" }).success).toBe(true);
    expect(poSupplierAcceptSchema.safeParse({}).success).toBe(true);
    expect(poSupplierAcceptSchema.safeParse({ confirmedDeliveryDate: "" }).success).toBe(true);
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
      poAttachmentSchema.safeParse({ fileName: "x.pdf", fileType: "pdf", fileSizeBytes: 11 * 1024 * 1024, data: pdf(11 * 1024 * 1024) }).success,
    ).toBe(false);
  });

  it("attachment accepts a valid PDF", () => {
    expect(
      poAttachmentSchema.safeParse({ label: "Quote", fileName: "quote.pdf", fileType: "pdf", fileSizeBytes: 2048, data: pdf(2048) }).success,
    ).toBe(true);
  });

  // A PO attachment can be REMOVED, and removal now deletes the Cloudinary file — so what gets
  // stored under a trusted label matters more here than anywhere.
  it("attachment rejects a declared size or type the payload contradicts", () => {
    const base = { label: "Quote", fileName: "quote.pdf", fileType: "pdf", fileSizeBytes: 2048, data: pdf(2048) };
    expect(poAttachmentSchema.safeParse({ ...base, fileSizeBytes: 40 * 1024 }).success).toBe(false);
    expect(poAttachmentSchema.safeParse({ ...base, data: dataUri("application/pdf", EXE_SIG, 2048) }).success).toBe(false);
  });
});
