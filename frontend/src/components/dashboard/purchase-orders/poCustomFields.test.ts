import { describe, expect, it } from "vitest";

import type { PoCustomFieldDefinition, PurchaseOrder } from "@/types/purchase-order";
import {
  activeCustomFieldDefinitions,
  customFieldsPayload,
  initialCustomFieldValues,
  retainedCustomFieldValues,
  visibleCustomFieldValues,
} from "./poCustomFields";

const def = (id: string, over: Partial<PoCustomFieldDefinition> = {}): PoCustomFieldDefinition => ({
  id,
  label: `Field ${id}`,
  type: "text",
  active: true,
  printOnPdf: true,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...over,
});
const order = (customFields: PurchaseOrder["customFields"]) => ({ customFields }) as PurchaseOrder;
const value = (fieldId: string, v: string, label = `Field ${fieldId}`) => ({ fieldId, label, value: v, printOnPdf: true });

describe("activeCustomFieldDefinitions", () => {
  it("offers only the active fields, in their configured order", () => {
    const out = activeCustomFieldDefinitions([def("b", { sortOrder: 2 }), def("x", { active: false, sortOrder: 0 }), def("a", { sortOrder: 1 })]);
    expect(out.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("initialCustomFieldValues", () => {
  it("turns an order's stored values into form state", () => {
    expect(initialCustomFieldValues(order([value("a", "CC-42")]))).toEqual({ a: "CC-42" });
  });

  it("is empty for a new order, and for one saved before custom fields existed", () => {
    expect(initialCustomFieldValues(null)).toEqual({});
    expect(initialCustomFieldValues(order(undefined))).toEqual({});
  });
});

describe("customFieldsPayload", () => {
  it("sends every ACTIVE field's text, trimmed — blank included, which clears it", () => {
    expect(customFieldsPayload([def("a"), def("b")], { a: " CC-42 ", c: "never sent" })).toEqual({ a: "CC-42", b: "" });
  });
});

describe("retainedCustomFieldValues", () => {
  it("lists stored values whose field is no longer active — they are shown read-only and never sent", () => {
    const defs = [def("a"), def("b", { active: false })];
    expect(retainedCustomFieldValues(order([value("a", "x"), value("b", "kept"), value("gone", "orphan")]), defs)).toEqual([
      value("b", "kept"),
      value("gone", "orphan"),
    ]);
  });
});

describe("visibleCustomFieldValues", () => {
  it("shows every non-empty stored value, with the label it was saved under", () => {
    expect(visibleCustomFieldValues(order([value("a", "CC-42", "Cost centre"), value("b", "  ")]))).toEqual([
      value("a", "CC-42", "Cost centre"),
    ]);
  });

  it("shows nothing for an order without custom fields", () => {
    expect(visibleCustomFieldValues(order(undefined))).toEqual([]);
    expect(visibleCustomFieldValues(order([]))).toEqual([]);
  });
});
