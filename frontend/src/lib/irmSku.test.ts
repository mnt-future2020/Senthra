import { describe, expect, it } from "vitest";

import { buildSkuCandidate, categoryPrefix, findSkuPrefixMismatch, normalizeSku, SKU_MAX } from "./irmSku";

// These mirror backend/src/modules/irm/sku.test.ts case-for-case. The two copies drifting is the
// one real risk of mirroring the helper, so the assertions are kept identical on purpose — if a
// rule changes on the server, this file fails and points at the other one.
describe("normalizeSku", () => {
  it("uppercases and joins words with single dashes", () => {
    expect(normalizeSku("cat6 u/utp cable 305m")).toBe("CAT6-U-UTP-CABLE-305M");
  });

  it("collapses runs of separators", () => {
    expect(normalizeSku("FBR  //  SM12")).toBe("FBR-SM12");
  });

  it("repairs the stray inner space real data already carries", () => {
    expect(normalizeSku("FBR-SM12- G652D")).toBe("FBR-SM12-G652D");
  });

  it("strips leading and trailing separators", () => {
    expect(normalizeSku("  -cat6-  ")).toBe("CAT6");
  });

  it("returns empty when nothing usable survives", () => {
    expect(normalizeSku("###")).toBe("");
    expect(normalizeSku("")).toBe("");
    expect(normalizeSku(null)).toBe("");
  });

  it("never exceeds the ceiling and never ends on a dash after truncation", () => {
    const out = normalizeSku(`${"A".repeat(SKU_MAX - 1)} B`);
    expect(out.length).toBeLessThanOrEqual(SKU_MAX);
    expect(out.endsWith("-")).toBe(false);
  });
});

describe("categoryPrefix", () => {
  it("takes the first three alphanumerics, uppercased", () => {
    expect(categoryPrefix("Cable")).toBe("CAB");
    expect(categoryPrefix("Fibre")).toBe("FIB");
    expect(categoryPrefix("Connectors")).toBe("CON");
    expect(categoryPrefix("Network Hardware")).toBe("NET");
  });

  it("falls back to IRM when there is nothing to take", () => {
    expect(categoryPrefix("---")).toBe("IRM");
    expect(categoryPrefix(null)).toBe("IRM");
  });
});

describe("buildSkuCandidate", () => {
  it("builds category code + name slug", () => {
    expect(buildSkuCandidate("Cat6 U/UTP Cable 305m Box", "Cable")).toBe("CAB-CAT6-U-UTP-CABLE-305M");
    expect(buildSkuCandidate("LC/UPC Fibre Connector", "Connectors")).toBe("CON-LC-UPC-FIBRE-CONNECTOR");
  });

  it("cuts on a word boundary, never mid-word", () => {
    const sku = buildSkuCandidate("24-Port Fibre Patch Panel — 1U Rack Mount", "Fibre");
    expect(sku).toBe("FIB-24-PORT-FIBRE-PATCH");
    expect(sku).not.toContain("PANEL");
  });

  it("hard-truncates a single word longer than the slug budget", () => {
    const sku = buildSkuCandidate("ffffifgikgoikgokgkggikfkffgikgokgkggikfkff", "test irm");
    expect(sku.startsWith("TES-")).toBe(true);
    expect(sku.length).toBeGreaterThan("TES-".length);
  });

  it("falls back to IRM when the item has no category", () => {
    expect(buildSkuCandidate("Cat6 Box", null)).toBe("IRM-CAT6-BOX");
  });

  it("returns empty-safe output for an empty name", () => {
    expect(buildSkuCandidate("", "Cable")).toBe("CAB");
  });
});

describe("findSkuPrefixMismatch", () => {
  const CATEGORIES = [
    { id: "c1", name: "Cable" },
    { id: "c2", name: "Accessories" },
    { id: "c3", name: "Fibre" },
  ];

  it("reports a SKU carrying another category's code", () => {
    expect(findSkuPrefixMismatch("ACC-CAT6-305M", "Cable", CATEGORIES, "c1")).toEqual({
      head: "ACC",
      owner: "Accessories",
    });
  });

  it("stays quiet when the SKU already matches the category", () => {
    expect(findSkuPrefixMismatch("CAB-CAT6-305M", "Cable", CATEGORIES, "c1")).toBeNull();
  });

  it("leaves hand-written SKUs alone — their lead segment belongs to no category", () => {
    expect(findSkuPrefixMismatch("CAT6-305-BOX", "Cable", CATEGORIES, "c1")).toBeNull();
    expect(findSkuPrefixMismatch("LC-UPC-SM", "Cable", CATEGORIES, "c1")).toBeNull();
    // The no-category fallback prefix isn't a category either, so it is not nagged about.
    expect(findSkuPrefixMismatch("IRM-CAT6-305-NEW", "Cable", CATEGORIES, "c1")).toBeNull();
  });

  it("matches case-insensitively — the field is normalized on the way in", () => {
    expect(findSkuPrefixMismatch("acc-cat6", "Cable", CATEGORIES, "c1")?.owner).toBe("Accessories");
  });

  it("never reports the CURRENT category against itself", () => {
    // Two categories can share a three-letter code; the current one must always win.
    const sharing = [{ id: "c1", name: "Connectors" }, { id: "c2", name: "Consumables" }];
    expect(findSkuPrefixMismatch("CON-LC-UPC", "Connectors", sharing, "c1")).toBeNull();
  });

  it("returns null for an empty SKU", () => {
    expect(findSkuPrefixMismatch("", "Cable", CATEGORIES, "c1")).toBeNull();
    expect(findSkuPrefixMismatch("###", "Cable", CATEGORIES, "c1")).toBeNull();
  });
});
