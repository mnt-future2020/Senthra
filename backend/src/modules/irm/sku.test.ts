import { describe, expect, it } from "vitest";

import { buildSkuCandidate, categoryPrefix, normalizeSku, SKU_MAX, SKU_RE, withSuffix } from "./sku.js";

describe("normalizeSku", () => {
  it("uppercases and joins words with single dashes", () => {
    expect(normalizeSku("cat6 u/utp cable 305m")).toBe("CAT6-U-UTP-CABLE-305M");
  });

  it("collapses runs of separators instead of emitting empty segments", () => {
    expect(normalizeSku("FBR  //  SM12")).toBe("FBR-SM12");
  });

  it("repairs the stray inner space real data already carries", () => {
    // 'FBR-SM12- G652D' exists in production and is what motivated the format rule.
    expect(normalizeSku("FBR-SM12- G652D")).toBe("FBR-SM12-G652D");
  });

  it("strips leading and trailing separators", () => {
    expect(normalizeSku("  -cat6-  ")).toBe("CAT6");
  });

  it("returns empty when nothing usable survives", () => {
    expect(normalizeSku("###")).toBe("");
    expect(normalizeSku("   ")).toBe("");
    expect(normalizeSku(null)).toBe("");
    expect(normalizeSku(undefined)).toBe("");
  });

  it("never exceeds the column ceiling and never ends on a dash after truncation", () => {
    // Engineered so the cut lands exactly on a separator — the naive slice would leave "…-".
    const raw = `${"A".repeat(SKU_MAX - 1)} B`;
    const out = normalizeSku(raw);
    expect(out.length).toBeLessThanOrEqual(SKU_MAX);
    expect(out.endsWith("-")).toBe(false);
  });

  it("always produces the canonical shape", () => {
    for (const raw of ["cat6 box", "a//b__c", "  x  ", "Ünïcode 12", "9"]) {
      const out = normalizeSku(raw);
      if (out) expect(out).toMatch(SKU_RE);
    }
  });
});

describe("categoryPrefix", () => {
  it("takes the first three alphanumerics, uppercased", () => {
    expect(categoryPrefix("Cable")).toBe("CAB");
    expect(categoryPrefix("Fibre")).toBe("FIB");
    expect(categoryPrefix("Connectors")).toBe("CON");
    expect(categoryPrefix("Network Hardware")).toBe("NET");
  });

  it("skips separators rather than counting them", () => {
    expect(categoryPrefix("T-E-S-T")).toBe("TES");
  });

  it("falls back to IRM when there is nothing to take", () => {
    expect(categoryPrefix("")).toBe("IRM");
    expect(categoryPrefix("---")).toBe("IRM");
    expect(categoryPrefix(null)).toBe("IRM");
  });

  it("pads nothing — a short category keeps its short code", () => {
    expect(categoryPrefix("PU")).toBe("PU");
  });
});

describe("buildSkuCandidate", () => {
  it("builds category code + name slug", () => {
    expect(buildSkuCandidate("Cat6 U/UTP Cable 305m Box", "Cable")).toBe("CAB-CAT6-U-UTP-CABLE-305M");
    expect(buildSkuCandidate("LC/UPC Fibre Connector", "Connectors")).toBe("CON-LC-UPC-FIBRE-CONNECTOR");
  });

  it("cuts on a word boundary, never mid-word", () => {
    // The slug reaches 19 chars at PATCH; adding PANEL would make 25 against a 24 budget, so PANEL
    // and everything after it is dropped WHOLE rather than cut mid-word.
    const sku = buildSkuCandidate("24-Port Fibre Patch Panel — 1U Rack Mount", "Fibre");
    expect(sku).toBe("FIB-24-PORT-FIBRE-PATCH");
    expect(sku).not.toContain("PANEL");
    expect(sku.endsWith("-")).toBe(false);
  });

  it("hard-truncates a single word longer than the slug budget", () => {
    // Without the fallback the word-boundary loop keeps nothing and the SKU degrades to a bare
    // category code — which every item in that category would then share.
    const sku = buildSkuCandidate("ffffifgikgoikgokgkggikfkffgikgokgkggikfkff", "test irm");
    expect(sku.startsWith("TES-")).toBe(true);
    expect(sku.length).toBeGreaterThan("TES-".length);
    expect(sku).toMatch(SKU_RE);
  });

  it("falls back to IRM when the item has no category", () => {
    expect(buildSkuCandidate("Cat6 Box", null)).toBe("IRM-CAT6-BOX");
  });

  it("leaves room for a uniqueness suffix inside the column ceiling", () => {
    const sku = buildSkuCandidate("A".repeat(200), "Consumables");
    expect(withSuffix(sku, 99).length).toBeLessThanOrEqual(SKU_MAX);
  });

  it("always produces the canonical shape", () => {
    for (const name of ["Cat6 U/UTP", "###", "9", "a", "  spaced  out  "]) {
      expect(buildSkuCandidate(name, "Cable")).toMatch(SKU_RE);
    }
  });
});

describe("withSuffix", () => {
  it("leaves the first attempt untouched", () => {
    expect(withSuffix("CAB-CAT6", 1)).toBe("CAB-CAT6");
    expect(withSuffix("CAB-CAT6", 0)).toBe("CAB-CAT6");
  });

  it("numbers later attempts from 2", () => {
    expect(withSuffix("CAB-CAT6", 2)).toBe("CAB-CAT6-2");
    expect(withSuffix("CAB-CAT6", 10)).toBe("CAB-CAT6-10");
  });
});
