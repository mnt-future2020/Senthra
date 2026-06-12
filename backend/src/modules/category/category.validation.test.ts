import { describe, expect, it } from "vitest";

import { createCategorySchema, updateCategorySchema } from "./category.validation.js";

describe("createCategorySchema", () => {
  it("accepts a valid category and trims the name", () => {
    const r = createCategorySchema.safeParse({ name: "  Optical  ", description: " fibre optics ", status: "active" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Optical");
      expect(r.data.description).toBe("fibre optics");
      expect(r.data.status).toBe("active");
    }
  });

  it("requires a name", () => {
    const r = createCategorySchema.safeParse({ description: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects a blank name", () => {
    const r = createCategorySchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const r = createCategorySchema.safeParse({ name: "Optical", status: "archived" });
    expect(r.success).toBe(false);
  });

  it("rejects a name longer than 60 chars", () => {
    const r = createCategorySchema.safeParse({ name: "x".repeat(61) });
    expect(r.success).toBe(false);
  });
});

describe("updateCategorySchema", () => {
  it("accepts a partial update (status only)", () => {
    const r = updateCategorySchema.safeParse({ status: "inactive" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    const r = updateCategorySchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
  });
});
