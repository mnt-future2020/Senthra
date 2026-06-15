import { describe, expect, it } from "vitest";

import { createIrmTypeSchema, updateIrmTypeSchema } from "./irm-type.validation.js";

describe("createIrmTypeSchema", () => {
  it("accepts a valid type and trims the name", () => {
    const r = createIrmTypeSchema.safeParse({ name: "  Consumable  ", description: " x ", status: "active" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Consumable");
      expect(r.data.description).toBe("x");
    }
  });

  it("requires a name", () => {
    expect(createIrmTypeSchema.safeParse({ description: "x" }).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(createIrmTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(createIrmTypeSchema.safeParse({ name: "Asset", status: "archived" }).success).toBe(false);
  });
});

describe("updateIrmTypeSchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateIrmTypeSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    expect(updateIrmTypeSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
