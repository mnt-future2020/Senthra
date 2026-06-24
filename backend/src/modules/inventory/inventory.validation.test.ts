import { describe, expect, it } from "vitest";

import { addStockSchema, createTransferSchema } from "./inventory.validation.js";

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

describe("addStockSchema", () => {
  const WH = "d".repeat(24);
  const addBase = { irmItemId: IRM, warehouseId: WH, quantity: 10, movementDate: "2026-06-15", reason: "opening_balance" };

  it("accepts a minimal valid add", () => {
    expect(addStockSchema.safeParse(addBase).success).toBe(true);
  });

  it("coerces a numeric-string quantity to an integer", () => {
    const r = addStockSchema.safeParse({ ...addBase, quantity: "10" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.quantity).toBe(10);
  });

  it.each([["opening_balance"], ["legacy_stock"], ["found"], ["other"]])("accepts reason %s", (reason) => {
    expect(addStockSchema.safeParse({ ...addBase, reason }).success).toBe(true);
  });

  it("accepts an optional reference + notes", () => {
    expect(addStockSchema.safeParse({ ...addBase, referenceNumber: "STK-1", notes: "from the old shelf" }).success).toBe(true);
  });

  it("accepts today as the movement date", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(addStockSchema.safeParse({ ...addBase, movementDate: today }).success).toBe(true);
  });

  it("rejects a future movement date", () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const r = addStockSchema.safeParse({ ...addBase, movementDate: future });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /future/i.test(i.message))).toBe(true);
  });

  it.each([
    ["missing item", { ...addBase, irmItemId: "" }],
    ["non-id item", { ...addBase, irmItemId: "nope" }],
    ["missing warehouse", { ...addBase, warehouseId: "" }],
    ["non-id warehouse", { ...addBase, warehouseId: "nope" }],
    ["zero quantity", { ...addBase, quantity: 0 }],
    ["negative quantity", { ...addBase, quantity: -5 }],
    ["fractional quantity", { ...addBase, quantity: 2.5 }],
    ["quantity over the cap", { ...addBase, quantity: 10_000_001 }],
    ["missing reason", { ...addBase, reason: undefined }],
    ["invalid reason", { ...addBase, reason: "correction" }],
    ["missing movement date", { ...addBase, movementDate: "" }],
    ["invalid movement date", { ...addBase, movementDate: "not-a-date" }],
    ["reference too long", { ...addBase, referenceNumber: "x".repeat(61) }],
  ])("rejects: %s", (_label, payload) => {
    expect(addStockSchema.safeParse(payload).success).toBe(false);
  });
});
