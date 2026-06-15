import { describe, expect, it } from "vitest";

import {
  createSupplierTypeSchema,
  updateSupplierTypeSchema,
} from "./supplier-type.validation.js";

describe("createSupplierTypeSchema", () => {
  it("accepts a valid type and trims the name", () => {
    const r = createSupplierTypeSchema.safeParse({
      name: "  Distributor  ",
      description: " Bulk reseller ",
      status: "active",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Distributor");
      expect(r.data.description).toBe("Bulk reseller");
    }
  });

  it("requires a name", () => {
    expect(createSupplierTypeSchema.safeParse({ description: "x" }).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(createSupplierTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(createSupplierTypeSchema.safeParse({ name: "Vendor", status: "archived" }).success).toBe(
      false,
    );
  });

  it("rejects a name longer than 60 chars", () => {
    expect(createSupplierTypeSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
  });
});

describe("updateSupplierTypeSchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateSupplierTypeSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    expect(updateSupplierTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
