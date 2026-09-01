import { describe, expect, it } from "vitest";

import { irmItemFormSeeds } from "./irmItemFormSeeds";

describe("irmItemFormSeeds", () => {
  it("carries the name the caller already collected, trimmed", () => {
    expect(irmItemFormSeeds("create", "  CAT36  ").name).toBe("CAT36");
  });

  it("links the calling document's supplier as the primary row", () => {
    expect(irmItemFormSeeds("create", "CAT36", "s1").supplierRows).toEqual([
      { supplierId: "s1", isPrimary: true, priority: "1", supplierSku: "", leadTimeDays: "" },
    ]);
  });

  it("adds no supplier row when the caller has not chosen one", () => {
    expect(irmItemFormSeeds("create", "CAT36").supplierRows).toEqual([]);
    expect(irmItemFormSeeds("create", "CAT36", "").supplierRows).toEqual([]);
  });

  it("opens empty when nothing was seeded", () => {
    expect(irmItemFormSeeds("create")).toEqual({ name: "", supplierRows: [] });
  });

  // An edit form describes a row that already exists. Honouring a caller's seed there would
  // silently rewrite that item's name and supplier link the instant the form opened.
  it("ignores every seed on edit", () => {
    expect(irmItemFormSeeds("edit", "CAT36", "s1")).toEqual({ name: "", supplierRows: [] });
  });

  // The form reads this for BOTH its initial state and its dirty baseline. If the two could differ,
  // a freshly-opened seeded form would report unsaved changes before anything was typed.
  it("is stable, so the initial state and the dirty baseline always agree", () => {
    expect(irmItemFormSeeds("create", " CAT36 ", "s1")).toEqual(irmItemFormSeeds("create", " CAT36 ", "s1"));
  });
});
