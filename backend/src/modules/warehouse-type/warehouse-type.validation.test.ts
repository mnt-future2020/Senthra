import { describe, expect, it } from "vitest";

import {
  createWarehouseTypeSchema,
  updateWarehouseTypeSchema,
} from "./warehouse-type.validation.js";

describe("createWarehouseTypeSchema", () => {
  it("accepts a valid type and trims the name", () => {
    const r = createWarehouseTypeSchema.safeParse({
      name: "  Engineer Van  ",
      description: " Mobile stock ",
      status: "active",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Engineer Van");
      expect(r.data.description).toBe("Mobile stock");
    }
  });

  it("requires a name", () => {
    expect(createWarehouseTypeSchema.safeParse({ description: "x" }).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(createWarehouseTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(createWarehouseTypeSchema.safeParse({ name: "Van", status: "archived" }).success).toBe(
      false,
    );
  });

  it("rejects a name longer than 60 chars", () => {
    expect(createWarehouseTypeSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
  });
});

describe("updateWarehouseTypeSchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateWarehouseTypeSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    expect(updateWarehouseTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
