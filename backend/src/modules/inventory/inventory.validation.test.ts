import { describe, expect, it } from "vitest";

import { createTransferSchema } from "./inventory.validation.js";

const IRM = "a".repeat(24);
const FROM = "b".repeat(24);
const TO = "c".repeat(24);
const base = { irmItemId: IRM, fromWarehouseId: FROM, toWarehouseId: TO, quantity: 5, movementDate: "2026-06-15" };

describe("createTransferSchema", () => {
  it("accepts a minimal valid transfer", () => {
    expect(createTransferSchema.safeParse(base).success).toBe(true);
  });

  it("coerces a numeric-string quantity to an integer", () => {
    const r = createTransferSchema.safeParse({ ...base, quantity: "5" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.quantity).toBe(5);
  });

  it("accepts optional reference / description / internal notes", () => {
    expect(
      createTransferSchema.safeParse({ ...base, referenceNumber: "REF-1", description: "Rebalancing", internalNotes: "ok" }).success,
    ).toBe(true);
  });

  it.each([
    ["missing item", { ...base, irmItemId: "" }],
    ["non-id item", { ...base, irmItemId: "nope" }],
    ["missing source", { ...base, fromWarehouseId: "" }],
    ["non-id source", { ...base, fromWarehouseId: "nope" }],
    ["missing destination", { ...base, toWarehouseId: "" }],
    ["source === destination", { ...base, toWarehouseId: FROM }],
    ["missing movement date", { ...base, movementDate: "" }],
    ["invalid movement date", { ...base, movementDate: "not-a-date" }],
    ["zero quantity", { ...base, quantity: 0 }],
    ["negative quantity", { ...base, quantity: -1 }],
    ["fractional quantity", { ...base, quantity: 1.5 }],
    ["quantity over the cap", { ...base, quantity: 10_000_001 }],
    ["reference too long", { ...base, referenceNumber: "x".repeat(61) }],
  ])("rejects: %s", (_label, payload) => {
    expect(createTransferSchema.safeParse(payload).success).toBe(false);
  });

  it("flags the self-transfer error on the destination field", () => {
    const r = createTransferSchema.safeParse({ ...base, toWarehouseId: FROM });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("toWarehouseId"))).toBe(true);
  });
});
