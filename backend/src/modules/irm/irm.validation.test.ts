import { describe, expect, it } from "vitest";

import { createIrmItemSchema, updateIrmItemSchema } from "./irm.validation.js";

const TYPE_ID = "a".repeat(24);
const CAT_ID = "b".repeat(24);
const SUP_ID = "c".repeat(24);
const SUP_ID_2 = "d".repeat(24);

const valid = (over: Record<string, unknown> = {}) => ({
  name: "CAT6 Cable",
  typeId: TYPE_ID,
  irmCategoryId: CAT_ID,
  baseUnit: "Each",
  suppliers: [{ supplierId: SUP_ID, isPrimary: true }],
  ...over,
});

describe("createIrmItemSchema — required fields", () => {
  it("accepts a valid item", () => {
    expect(createIrmItemSchema.safeParse(valid()).success).toBe(true);
  });

  it.each(["name", "typeId", "irmCategoryId", "baseUnit"])("rejects a missing %s", (field) => {
    const payload = valid();
    delete (payload as Record<string, unknown>)[field];
    expect(createIrmItemSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects an invalid base unit", () => {
    expect(createIrmItemSchema.safeParse(valid({ baseUnit: "Furlong" })).success).toBe(false);
  });
});

describe("createIrmItemSchema — suppliers (optional, at most one primary)", () => {
  it("accepts a missing suppliers key", () => {
    const payload = valid();
    delete (payload as Record<string, unknown>).suppliers;
    expect(createIrmItemSchema.safeParse(payload).success).toBe(true);
  });

  it("accepts an empty suppliers array", () => {
    expect(createIrmItemSchema.safeParse(valid({ suppliers: [] })).success).toBe(true);
  });

  it("accepts a supplier with no primary flag", () => {
    expect(createIrmItemSchema.safeParse(valid({ suppliers: [{ supplierId: SUP_ID }] })).success).toBe(true);
  });

  it("rejects two primaries", () => {
    expect(
      createIrmItemSchema.safeParse(
        valid({ suppliers: [{ supplierId: SUP_ID, isPrimary: true }, { supplierId: SUP_ID_2, isPrimary: true }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects a duplicate supplier", () => {
    expect(
      createIrmItemSchema.safeParse(
        valid({ suppliers: [{ supplierId: SUP_ID, isPrimary: true }, { supplierId: SUP_ID }] }),
      ).success,
    ).toBe(false);
  });

  it("accepts a primary + an alternative", () => {
    expect(
      createIrmItemSchema.safeParse(
        valid({ suppliers: [{ supplierId: SUP_ID, isPrimary: true }, { supplierId: SUP_ID_2, priority: 1 }] }),
      ).success,
    ).toBe(true);
  });
});

describe("createIrmItemSchema — numbers", () => {
  it("rejects a negative cost", () => {
    expect(createIrmItemSchema.safeParse(valid({ standardCost: -5 })).success).toBe(false);
  });

  it("coerces a numeric-string cost (pounds)", () => {
    const r = createIrmItemSchema.safeParse(valid({ standardCost: "12.34" }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.standardCost).toBeCloseTo(12.34);
  });

  it("rejects VAT above 100", () => {
    expect(createIrmItemSchema.safeParse(valid({ vatRatePercent: 120 })).success).toBe(false);
  });

  it("rejects maximumStock below minimumStock", () => {
    expect(createIrmItemSchema.safeParse(valid({ minimumStock: 10, maximumStock: 5 })).success).toBe(false);
  });

  it("accepts maximumStock >= minimumStock", () => {
    expect(createIrmItemSchema.safeParse(valid({ minimumStock: 5, maximumStock: 10 })).success).toBe(true);
  });
});

describe("updateIrmItemSchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateIrmItemSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects blanking the name", () => {
    expect(updateIrmItemSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("accepts an empty suppliers array (clears every link)", () => {
    expect(updateIrmItemSchema.safeParse({ suppliers: [] }).success).toBe(true);
  });

  it("accepts clearing the owner via empty string", () => {
    const r = updateIrmItemSchema.safeParse({ ownerUserId: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ownerUserId).toBeNull();
  });
});
