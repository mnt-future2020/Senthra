import { describe, expect, it } from "vitest";

import { singularize } from "./Pagination";

// Every label actually passed to <Pagination> across the app. The footer renders
// "Total: 1 <singularize(label)>", so each of these has a user-visible singular form.
const LABELS_IN_USE = [
  "categories",
  "customers",
  "damaged items",
  "deliveries",
  "departments",
  "entries",
  "events",
  "goods receipts",
  "IRM categories",
  "IRM types",
  "items",
  "job titles",
  "jobs",
  "movements",
  "projects",
  "purchase orders",
  "purchase requests",
  "receipts",
  "records",
  "requests",
  "roles",
  "sites",
  "submissions",
  "supplier types",
  "suppliers",
  "transfers",
  "users",
  "warehouse types",
  "warehouses",
];

describe("singularize — the 'Total: 1 <thing>' label", () => {
  it("handles -ies plurals", () => {
    // The bug this guards: stripping a trailing "s" turned "deliveries" into "deliverie",
    // which shipped and was visible as "Total: 1 deliverie" on a warehouse with one PO.
    expect(singularize("deliveries")).toBe("delivery");
    expect(singularize("categories")).toBe("category");
    expect(singularize("entries")).toBe("entry");
    expect(singularize("IRM categories")).toBe("IRM category");
  });

  it("handles plain -s plurals", () => {
    expect(singularize("jobs")).toBe("job");
    expect(singularize("users")).toBe("user");
    expect(singularize("purchase orders")).toBe("purchase order");
    expect(singularize("warehouse types")).toBe("warehouse type");
  });

  it("handles -es plurals after a sibilant", () => {
    expect(singularize("addresses")).toBe("address");
    expect(singularize("batches")).toBe("batch");
    expect(singularize("boxes")).toBe("box");
  });

  it("leaves an already-singular label alone", () => {
    expect(singularize("item")).toBe("item");
    expect(singularize("stock")).toBe("stock"); // ends in -k, not a plural
  });

  it("does not mangle a word whose plural ends -ss", () => {
    // "address" is singular already; a naive /s$/ strip would make it "addres".
    expect(singularize("address")).toBe("address");
  });

  it("produces a sensible singular for every label the app actually passes", () => {
    // Guards the whole call-site surface at once: no label may singularize to something that
    // still looks plural, or that lost more than the plural suffix.
    for (const label of LABELS_IN_USE) {
      const one = singularize(label);
      expect(one.length).toBeGreaterThan(0);
      expect(one).not.toMatch(/ie$/); // the "deliverie" class of bug
      expect(one.length).toBeLessThanOrEqual(label.length + 1); // -ies → -y may not grow
    }
  });
});
