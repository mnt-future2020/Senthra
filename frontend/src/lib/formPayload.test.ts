import { describe, expect, it } from "vitest";

import { optionalFor } from "./formPayload";

describe("optionalFor", () => {
  const onCreate = optionalFor(false);
  const onEdit = optionalFor(true);

  it("sends the trimmed value when the box has content (both modes)", () => {
    expect(onCreate("  Leeds  ")).toBe("Leeds");
    expect(onEdit("  Leeds  ")).toBe("Leeds");
  });

  it("OMITS a blank on create — there is nothing to clear, and create schemas reject ''", () => {
    expect(onCreate("")).toBeUndefined();
    expect(onCreate("   ")).toBeUndefined();
  });

  it("sends '' for a blank on edit — the only way to say 'the user cleared this'", () => {
    expect(onEdit("")).toBe("");
    expect(onEdit("   ")).toBe("");
  });

  // The whole point of the helper: `undefined` disappears from the request body entirely, so it can
  // never carry an instruction. This is what silently kept old values in the database for months.
  it("survives JSON serialisation on edit, and is dropped on create", () => {
    expect(JSON.parse(JSON.stringify({ city: onEdit("") }))).toEqual({ city: "" });
    expect(JSON.parse(JSON.stringify({ city: onCreate("") }))).toEqual({});
  });
});
