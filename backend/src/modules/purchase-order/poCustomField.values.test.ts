import { describe, expect, it } from "vitest";

import {
  mergeCustomFieldValues,
  printableCustomFields,
  readStoredCustomFields,
  type PoCustomFieldDefinitionFacts,
  type StoredPoCustomField,
} from "./poCustomField.values.js";

const F1 = "1".repeat(24);
const F2 = "2".repeat(24);
const F3 = "3".repeat(24);

const def = (id: string, over: Partial<PoCustomFieldDefinitionFacts> = {}): PoCustomFieldDefinitionFacts => ({
  id,
  label: `Field ${id[0]}`,
  active: true,
  printOnPdf: true,
  sortOrder: Number(id[0]),
  ...over,
});
const stored = (fieldId: string, value: string, over: Partial<StoredPoCustomField> = {}): StoredPoCustomField => ({
  fieldId,
  label: `Old ${fieldId[0]}`,
  value,
  printOnPdf: true,
  ...over,
});

describe("readStoredCustomFields — a Json column, read defensively", () => {
  it.each([null, undefined, "garbage", 42, {}, { fieldId: F1, value: "x" }])("reads %j as no values", (raw) => {
    expect(readStoredCustomFields(raw)).toEqual([]);
  });

  it("drops every malformed entry and keeps the well-formed one", () => {
    const raw = [
      null,
      "text",
      [1],
      { fieldId: 5, value: "a" },
      { fieldId: F1, value: 7 },
      { fieldId: F1, value: "   " },
      { fieldId: F2, label: "Cost centre", value: " CC-1 ", printOnPdf: true },
      { fieldId: F2, label: "Duplicate", value: "again", printOnPdf: true },
    ];
    expect(readStoredCustomFields(raw)).toEqual([{ fieldId: F2, label: "Cost centre", value: "CC-1", printOnPdf: true }]);
  });

  it("names an unlabelled value rather than losing it, and never prints one whose flag is missing", () => {
    expect(readStoredCustomFields([{ fieldId: F1, value: "v" }])).toEqual([
      { fieldId: F1, label: "Additional information", value: "v", printOnPdf: false },
    ]);
  });
});

describe("mergeCustomFieldValues", () => {
  it("snapshots each definition's label and print flag with its value, in field order", () => {
    const out = mergeCustomFieldValues([], { [F2]: " b ", [F1]: "a" }, [def(F1), def(F2, { printOnPdf: false })]);
    expect(out).toEqual([
      { fieldId: F1, label: "Field 1", value: "a", printOnPdf: true },
      { fieldId: F2, label: "Field 2", value: "b", printOnPdf: false },
    ]);
  });

  it("clears a field that is sent blank", () => {
    expect(mergeCustomFieldValues([stored(F1, "old")], { [F1]: "   " }, [def(F1)])).toEqual([]);
  });

  it("leaves a value the body does not name exactly as stored", () => {
    const out = mergeCustomFieldValues([stored(F1, "keep")], { [F2]: "new" }, [def(F1), def(F2)]);
    expect(out.map((v) => [v.fieldId, v.value])).toEqual([
      [F1, "keep"],
      [F2, "new"],
    ]);
  });

  it("refuses an id with no definition", () => {
    expect(() => mergeCustomFieldValues([], { [F3]: "x" }, [def(F1)])).toThrow(/no longer exists/);
  });

  it("refuses a NEW value for an inactive field", () => {
    expect(() => mergeCustomFieldValues([], { [F1]: "x" }, [def(F1, { active: false })])).toThrow(/no longer in use/);
    expect(() =>
      mergeCustomFieldValues([stored(F1, "old")], { [F1]: "changed" }, [def(F1, { active: false })]),
    ).toThrow(/no longer in use/);
  });

  it("keeps an inactive field's value when it is sent back unchanged, and lets it be cleared", () => {
    const inactive = [def(F1, { active: false })];
    expect(mergeCustomFieldValues([stored(F1, "old")], { [F1]: "old" }, inactive).map((v) => v.value)).toEqual(["old"]);
    expect(mergeCustomFieldValues([stored(F1, "old")], { [F1]: "" }, inactive)).toEqual([]);
  });

  it("refreshes a renamed field's label and print flag on the next draft save", () => {
    const out = mergeCustomFieldValues(
      [stored(F1, "v", { label: "Cost center", printOnPdf: true })],
      { [F2]: "" },
      [def(F1, { label: "Cost centre", printOnPdf: false }), def(F2)],
    );
    expect(out).toEqual([{ fieldId: F1, label: "Cost centre", value: "v", printOnPdf: false }]);
  });

  it("keeps a value whose definition has disappeared, after the rest", () => {
    const out = mergeCustomFieldValues([stored(F3, "orphan")], { [F1]: "a" }, [def(F1)]);
    expect(out.map((v) => [v.fieldId, v.label])).toEqual([
      [F1, "Field 1"],
      [F3, "Old 3"],
    ]);
  });
});

describe("printableCustomFields", () => {
  it("returns only the values set to print, as label/value", () => {
    expect(
      printableCustomFields([stored(F1, "shown", { label: "Cost centre" }), stored(F2, "hidden", { printOnPdf: false })]),
    ).toEqual([{ label: "Cost centre", value: "shown" }]);
  });

  it("returns nothing for an order raised before custom fields existed", () => {
    expect(printableCustomFields(undefined)).toEqual([]);
    expect(printableCustomFields(null)).toEqual([]);
  });
});
