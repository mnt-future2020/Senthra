import { describe, expect, it } from "vitest";

import {
  createPoCustomFieldSchema,
  customFieldValuesField,
  reorderPoCustomFieldsSchema,
  updatePoCustomFieldSchema,
} from "./poCustomField.validation.js";

const F1 = "1".repeat(24);
const F2 = "2".repeat(24);

describe("createPoCustomFieldSchema", () => {
  it("trims the name and leaves the print flag optional", () => {
    expect(createPoCustomFieldSchema.parse({ label: "  Cost centre  " })).toEqual({ label: "Cost centre" });
    expect(createPoCustomFieldSchema.parse({ label: "Site contact", printOnPdf: false })).toEqual({
      label: "Site contact",
      printOnPdf: false,
    });
  });

  it.each([{}, { label: "" }, { label: "   " }, { label: "x".repeat(61) }, { label: 7 }])("refuses %j", (body) => {
    expect(createPoCustomFieldSchema.safeParse(body).success).toBe(false);
  });

  it("offers no 'required' setting — an unknown key is stripped, never stored", () => {
    expect(createPoCustomFieldSchema.parse({ label: "A", required: true })).toEqual({ label: "A" });
  });
});

describe("updatePoCustomFieldSchema", () => {
  it("accepts any one of rename / active / print", () => {
    expect(updatePoCustomFieldSchema.safeParse({ label: "B" }).success).toBe(true);
    expect(updatePoCustomFieldSchema.safeParse({ active: false }).success).toBe(true);
    expect(updatePoCustomFieldSchema.safeParse({ printOnPdf: true }).success).toBe(true);
  });

  it("refuses an empty body", () => {
    expect(updatePoCustomFieldSchema.safeParse({}).success).toBe(false);
  });
});

describe("reorderPoCustomFieldsSchema", () => {
  it("accepts a list of field ids", () => {
    expect(reorderPoCustomFieldsSchema.safeParse({ ids: [F2, F1] }).success).toBe(true);
  });

  it.each([{ ids: [] }, { ids: [F1, F1] }, { ids: ["nope"] }, {}])("refuses %j", (body) => {
    expect(reorderPoCustomFieldsSchema.safeParse(body).success).toBe(false);
  });
});

describe("customFieldValuesField — the values on a PO body", () => {
  it("accepts text keyed by field id, blank included (blank clears)", () => {
    expect(customFieldValuesField.safeParse({ [F1]: "CC-42", [F2]: "" }).success).toBe(true);
  });

  it("refuses a key that is not a field id", () => {
    expect(customFieldValuesField.safeParse({ costCentre: "CC-42" }).success).toBe(false);
  });

  it.each([7, true, null, ["a"], { a: 1 }])("refuses a non-text value (%j)", (value) => {
    expect(customFieldValuesField.safeParse({ [F1]: value }).success).toBe(false);
  });

  it("refuses a value over 500 characters", () => {
    expect(customFieldValuesField.safeParse({ [F1]: "x".repeat(500) }).success).toBe(true);
    expect(customFieldValuesField.safeParse({ [F1]: "x".repeat(501) }).success).toBe(false);
  });

  it("refuses a flood of keys", () => {
    const body = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [i.toString(16).padStart(24, "0"), "x"]));
    expect(customFieldValuesField.safeParse(body).success).toBe(false);
  });
});
