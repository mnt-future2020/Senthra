import { describe, expect, it } from "vitest";

import {
  createIrmCategorySchema,
  updateIrmCategorySchema,
} from "./irm-category.validation.js";

describe("createIrmCategorySchema", () => {
  it("accepts a valid category and trims the name", () => {
    const r = createIrmCategorySchema.safeParse({ name: "  Fibre  ", status: "active" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Fibre");
  });

  it("requires a name", () => {
    expect(createIrmCategorySchema.safeParse({ description: "x" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(createIrmCategorySchema.safeParse({ name: "Cable", status: "archived" }).success).toBe(false);
  });
});

describe("updateIrmCategorySchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateIrmCategorySchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects an empty-string name when provided", () => {
    expect(updateIrmCategorySchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
