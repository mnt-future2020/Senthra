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

  // critical ≤ reorder ≤ maximum. The old pair compared max against `minimumStock`, which the
  // reorder engine never read — the rule guarded a number that changed nothing.
  it("rejects a maximum below the reorder level", () => {
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 10, maximumStock: 5 })).success).toBe(false);
  });

  it("accepts a maximum at or above the reorder level", () => {
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 5, maximumStock: 10 })).success).toBe(true);
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 10, maximumStock: 10 })).success).toBe(true);
  });

  it("rejects a critical level above the reorder level", () => {
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 10, criticalLevel: 20 })).success).toBe(false);
  });

  it("accepts a critical level at or below the reorder level", () => {
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 10, criticalLevel: 3 })).success).toBe(true);
    expect(createIrmItemSchema.safeParse(valid({ reorderLevel: 10, criticalLevel: 10 })).success).toBe(true);
  });

  // Each rule needs BOTH numbers — one alone can't contradict anything.
  it("stays quiet when only one of the three is given", () => {
    expect(createIrmItemSchema.safeParse(valid({ maximumStock: 5 })).success).toBe(true);
    expect(createIrmItemSchema.safeParse(valid({ criticalLevel: 900 })).success).toBe(true);
  });

  // The chain closes on EVERY adjacent pair. Both rules above hinge on the reorder level, so with it
  // blank nothing compared critical against maximum — critical 200 with a maximum of 50 passed,
  // which is an ordering the comment claimed but the code only half-enforced.
  it("still catches critical above maximum when NO reorder level is given", () => {
    expect(createIrmItemSchema.safeParse(valid({ criticalLevel: 200, maximumStock: 50 })).success).toBe(false);
  });

  it("accepts critical at or below maximum with no reorder level", () => {
    expect(createIrmItemSchema.safeParse(valid({ criticalLevel: 50, maximumStock: 50 })).success).toBe(true);
    expect(createIrmItemSchema.safeParse(valid({ criticalLevel: 10, maximumStock: 50 })).success).toBe(true);
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

  it("rejects clearing the SKU — an item that has one can never go back to having none", () => {
    expect(updateIrmItemSchema.safeParse({ sku: "" }).success).toBe(false);
    expect(updateIrmItemSchema.safeParse({ sku: "   " }).success).toBe(false);
  });

  it("still allows omitting the SKU entirely (no change)", () => {
    expect(updateIrmItemSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});
