import { describe, expect, it } from "vitest";

import type { PoCustomFieldDefinition } from "@/types/purchase-order";
import { accentColorError, fieldLabelError, moveField, poDocBrandingView, toColorInputValue } from "./poSettings";

const def = (id: string, label: string, over: Partial<PoCustomFieldDefinition> = {}): PoCustomFieldDefinition => ({
  id,
  label,
  type: "text",
  active: true,
  printOnPdf: true,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("poDocBrandingView — what the PO PDF prints with", () => {
  const app = { logoUrl: "https://cdn/app.png", brandColor: "#7b6ef0" };

  it("falls back to the app logo and colour when nothing PO-specific is set", () => {
    expect(poDocBrandingView({ ...app, poDocLogoUrl: "", poDocAccentColor: "" })).toEqual({
      logoUrl: "https://cdn/app.png",
      logoIsFallback: true,
      color: "#7b6ef0",
      colorIsFallback: true,
    });
  });

  it("uses the PO-specific values when they are set", () => {
    expect(poDocBrandingView({ ...app, poDocLogoUrl: "https://cdn/po.png", poDocAccentColor: "#1f3a8a" })).toEqual({
      logoUrl: "https://cdn/po.png",
      logoIsFallback: false,
      color: "#1f3a8a",
      colorIsFallback: false,
    });
  });

  it("reports no logo at all when neither is set", () => {
    expect(poDocBrandingView({ logoUrl: "", brandColor: "#7b6ef0", poDocLogoUrl: "", poDocAccentColor: "" }).logoUrl).toBe("");
  });

  // The app colour may carry alpha, which the PDF engine cannot draw — the screen must name the colour
  // the PDF will really print, exactly as the server normalises it.
  it.each([["#11223344", "#112233"], ["#abcd", "#aabbcc"]])("falls back to %s as %s — what the PDF prints", (brandColor, expected) => {
    expect(poDocBrandingView({ ...app, brandColor, poDocLogoUrl: "", poDocAccentColor: "" }).color).toBe(expected);
  });
});

describe("accentColorError", () => {
  it.each(["", "  ", "#abc", "#1F3A8A"])("accepts %j", (v) => expect(accentColorError(v)).toBeNull());
  it.each(["#abcd", "#11223344", "red", "1f3a8a"])("refuses %j", (v) => expect(accentColorError(v)).toMatch(/hex colour/));
});

describe("toColorInputValue", () => {
  it("hands the native colour picker a #rrggbb value", () => {
    expect(toColorInputValue("#ABC")).toBe("#aabbcc");
    expect(toColorInputValue("#1F3A8A")).toBe("#1f3a8a");
    expect(toColorInputValue("#11223344")).toBe("#112233");
    expect(toColorInputValue("nonsense", "#7b6ef0")).toBe("#7b6ef0");
  });
});

describe("fieldLabelError", () => {
  const fields = [def("a", "Cost centre"), def("b", "Legacy ref", { active: false })];

  it("accepts a new, unique name", () => expect(fieldLabelError("Site contact", fields)).toBeNull());
  it("refuses a blank or over-long name", () => {
    expect(fieldLabelError("   ", fields)).toMatch(/Enter a field name/);
    expect(fieldLabelError("x".repeat(61), fields)).toMatch(/60 characters/);
  });
  it("refuses a duplicate, ignoring case — and points at reactivation for an inactive one", () => {
    expect(fieldLabelError("COST CENTRE", fields)).toMatch(/already exists\./);
    expect(fieldLabelError("legacy ref", fields)).toMatch(/reactivate it instead/);
  });
  it("lets a field keep its own name when renaming", () => expect(fieldLabelError("Cost centre", fields, "a")).toBeNull());
});

describe("moveField", () => {
  const list = [def("a", "A"), def("b", "B"), def("c", "C")];

  it("swaps a field with its neighbour", () => {
    expect(moveField(list, "b", -1).map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(moveField(list, "b", 1).map((f) => f.id)).toEqual(["a", "c", "b"]);
  });

  it("returns the same list when the field cannot move", () => {
    expect(moveField(list, "a", -1)).toBe(list);
    expect(moveField(list, "c", 1)).toBe(list);
    expect(moveField(list, "zz", 1)).toBe(list);
  });
});
