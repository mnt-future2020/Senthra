import { describe, expect, it } from "vitest";

import { createGoodsOutSchema } from "./goods-out.validation.js";

const WH = "a".repeat(24);
const ENG = "b".repeat(24);
const IRM = "c".repeat(24);
const base = {
  warehouseId: WH,
  engineerId: ENG,
  dispatchDate: "2026-06-16",
  dispatchReason: "installation",
  items: [{ irmItemId: IRM, quantity: 5 }],
};

describe("createGoodsOutSchema", () => {
  it("accepts a minimal valid dispatch", () => {
    expect(createGoodsOutSchema.safeParse(base).success).toBe(true);
  });

  it("coerces a numeric-string quantity to an integer", () => {
    const r = createGoodsOutSchema.safeParse({ ...base, items: [{ irmItemId: IRM, quantity: "5" }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.items[0].quantity).toBe(5);
  });

  it("accepts optional expected return date, authoriser, and future sockets", () => {
    expect(
      createGoodsOutSchema.safeParse({
        ...base,
        expectedReturnDate: "2026-07-01",
        authorizedById: "d".repeat(24),
        authorizedByName: "PM Ravi",
        jobId: "e".repeat(24),
        projectId: "f".repeat(24),
        customerStockRequestId: "0".repeat(24),
        referenceNumber: "DSP-1",
        description: "For the Leeds job",
        internalNotes: "ok",
      }).success,
    ).toBe(true);
  });

  it("treats an empty-string expected return date / authoriser as omitted", () => {
    const r = createGoodsOutSchema.safeParse({ ...base, expectedReturnDate: "", authorizedById: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.expectedReturnDate).toBeUndefined();
      expect(r.data.authorizedById).toBeUndefined();
    }
  });

  it.each([
    ["missing warehouse", { ...base, warehouseId: "" }],
    ["non-id warehouse", { ...base, warehouseId: "nope" }],
    ["missing engineer", { ...base, engineerId: "" }],
    ["missing dispatch date", { ...base, dispatchDate: "" }],
    ["invalid dispatch date", { ...base, dispatchDate: "not-a-date" }],
    ["missing dispatch reason", { ...base, dispatchReason: undefined }],
    ["invalid dispatch reason", { ...base, dispatchReason: "weird" }],
    ["no items", { ...base, items: [] }],
    ["zero quantity", { ...base, items: [{ irmItemId: IRM, quantity: 0 }] }],
    ["negative quantity", { ...base, items: [{ irmItemId: IRM, quantity: -1 }] }],
    ["fractional quantity", { ...base, items: [{ irmItemId: IRM, quantity: 1.5 }] }],
    ["quantity over the cap", { ...base, items: [{ irmItemId: IRM, quantity: 10_000_001 }] }],
    ["duplicate item line", { ...base, items: [{ irmItemId: IRM, quantity: 1 }, { irmItemId: IRM, quantity: 2 }] }],
    ["reference too long", { ...base, referenceNumber: "x".repeat(61) }],
  ])("rejects: %s", (_label, payload) => {
    expect(createGoodsOutSchema.safeParse(payload).success).toBe(false);
  });
});
