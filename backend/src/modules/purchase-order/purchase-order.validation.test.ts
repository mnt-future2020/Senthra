import { describe, expect, it } from "vitest";

import {
  createPurchaseOrderSchema,
  createPurchaseOrdersSplitSchema,
  poCancelSchema,
  poMarkSentSchema,
  poRejectSchema,
  poSupplierAcceptSchema,
  PO_ISSUE_CHANNELS,
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

  // The four `poAttachmentSchema` cases that stood here went with the schema. They guarded a base64
  // JSON body that no longer exists: the file now goes browser → Cloudinary under a signature, and the
  // same three rules — declared type is one we accept, declared size is under 10 MB, and the BYTES are
  // what the label claims — are enforced by `upload.catalog.ts` and covered by `upload.service.test.ts`
  // (see "rejects a PDF label on ZIP bytes"). Restating them here would test nothing that runs.
});

// ── Rental lines on an order — the same line a purchase request carries ────────────────────────
describe("rental lines on a purchase order", () => {
  const RNT_ID = "6a1d7f5bfa7d25704f02b963";
  const hire = { rentalItemId: RNT_ID, quantity: 1, hireStartDate: "2026-09-01", hireEndDate: "2026-10-01", unitPricePence: 15000 };

  it("create: accepts a hire beside the items, and a hire-only order", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ rentalItems: [hire] })).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [], rentalItems: [hire] })).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse(valid({ items: undefined, rentalItems: [hire] })).success).toBe(true);
  });

  it("create: still refuses an order with no line of either kind", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [], rentalItems: [] })).success).toBe(false);
    expect(createPurchaseOrderSchema.safeParse(valid({ items: [] })).success).toBe(false);
  });

  it("create: a hire is validated by the request's rules — an inverted period is refused", () => {
    expect(createPurchaseOrderSchema.safeParse(valid({ rentalItems: [{ ...hire, hireEndDate: "2026-08-01" }] })).success).toBe(false);
  });

  const splitValid = (over: Record<string, unknown> = {}) => ({
    supplierId: SUP_ID,
    orderDate: "2026-06-01",
    expectedDeliveryDate: "2026-06-10",
    items: [{ irmItemId: IRM_ID, quantity: 5, unitPricePence: 1000, warehouseId: WH_ID }],
    ...over,
  });

  it("split create: a hire names the warehouse it is delivered to", () => {
    expect(createPurchaseOrdersSplitSchema.safeParse(splitValid({ rentalItems: [{ ...hire, warehouseId: WH_ID }] })).success).toBe(true);
    expect(createPurchaseOrdersSplitSchema.safeParse(splitValid({ rentalItems: [hire] })).success).toBe(false);
  });

  it("split create: a hire-only request is legitimate, an empty one is not", () => {
    expect(createPurchaseOrdersSplitSchema.safeParse(splitValid({ items: [], rentalItems: [{ ...hire, warehouseId: WH_ID }] })).success).toBe(true);
    expect(createPurchaseOrdersSplitSchema.safeParse(splitValid({ items: [], rentalItems: [] })).success).toBe(false);
  });

  it("update: accepts the replacement hires, and a header-only patch still omits them", () => {
    const withHires = updatePurchaseOrderSchema.safeParse({ rentalItems: [hire] });
    expect(withHires.success).toBe(true);
    const headerOnly = updatePurchaseOrderSchema.safeParse({ projectRef: "PROJ-1" });
    expect(headerOnly.success).toBe(true);
    expect(headerOnly.success && headerOnly.data.rentalItems).toBeUndefined();
  });

  it("update: what the server computes never comes from the client", () => {
    const res = updatePurchaseOrderSchema.parse({ rentalItems: [{ ...hire, lineTotalPence: 1, notifyOnDate: "2026-09-28", hireStatus: "returned" }] });
    const line = res.rentalItems![0] as Record<string, unknown>;
    expect(line).not.toHaveProperty("lineTotalPence");
    expect(line).not.toHaveProperty("notifyOnDate");
    expect(line).not.toHaveProperty("hireStatus");
  });
});

// ── poMarkSentSchema ("Mark as sent") ─────────────────────────────────────────────────────────
//
// Both fields are optional and both are AUDIT METADATA ONLY — nothing on the order stores them, and
// nothing downstream branches on them. The schema's job is therefore narrow: accept an empty body,
// reject anything that isn't one of the five known channels, and cap the note.
describe("poMarkSentSchema", () => {
  it("accepts an empty body — the order being issued is the whole business fact", () => {
    const res = poMarkSentSchema.safeParse({});
    expect(res.success).toBe(true);
    expect(res.success && res.data.channel).toBeUndefined();
    expect(res.success && res.data.note).toBeUndefined();
  });

  it.each(PO_ISSUE_CHANNELS)("accepts the '%s' channel", (channel) => {
    expect(poMarkSentSchema.safeParse({ channel }).success).toBe(true);
  });

  it("rejects a channel outside the known set — no arbitrary values reach the ledger", () => {
    expect(poMarkSentSchema.safeParse({ channel: "carrier-pigeon" }).success).toBe(false);
    expect(poMarkSentSchema.safeParse({ channel: "EMAIL" }).success).toBe(false);
    expect(poMarkSentSchema.safeParse({ channel: 1 }).success).toBe(false);
  });

  // A cleared picker posts "", which must read as "not given" rather than as an invalid channel —
  // the same preprocessing every other optional enum in this file uses.
  it("treats an empty channel string as absent", () => {
    const res = poMarkSentSchema.safeParse({ channel: "" });
    expect(res.success).toBe(true);
    expect(res.success && res.data.channel).toBeUndefined();
  });

  it("trims the note", () => {
    const res = poMarkSentSchema.parse({ note: "  Sent via WhatsApp to Dave  " });
    expect(res.note).toBe("Sent via WhatsApp to Dave");
  });

  it("caps the note at 500 characters", () => {
    expect(poMarkSentSchema.safeParse({ note: "x".repeat(500) }).success).toBe(true);
    expect(poMarkSentSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
  });

  it("accepts a blank note (the service treats it as absent)", () => {
    expect(poMarkSentSchema.safeParse({ note: "   " }).success).toBe(true);
  });
});
