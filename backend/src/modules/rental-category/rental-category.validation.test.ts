import { describe, expect, it } from "vitest";

import {
  createRentalCategorySchema,
  updateRentalCategorySchema,
} from "./rental-category.validation.js";

describe("createRentalCategorySchema", () => {
  it("accepts a name and trims it", () => {
    expect(createRentalCategorySchema.parse({ name: "  Test Equipment  " }).name).toBe("Test Equipment");
  });

  it("refuses a blank name", () => {
    expect(createRentalCategorySchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createRentalCategorySchema.safeParse({}).success).toBe(false);
  });

  it("refuses a name beyond the column's limit", () => {
    expect(createRentalCategorySchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
  });

  it("refuses a status outside the allowed pair", () => {
    expect(createRentalCategorySchema.safeParse({ name: "X", status: "archived" }).success).toBe(false);
    expect(createRentalCategorySchema.safeParse({ name: "X", status: "inactive" }).success).toBe(true);
  });
});

describe("updateRentalCategorySchema", () => {
  it("allows a patch that changes nothing", () => {
    expect(updateRentalCategorySchema.safeParse({}).success).toBe(true);
  });

  // A PATCH may omit the name, but sending an empty one is a mistake, not "clear it" — the column
  // is required and nameLower carries a unique index.
  it("refuses an explicitly blank name", () => {
    expect(updateRentalCategorySchema.safeParse({ name: "  " }).success).toBe(false);
  });
});
