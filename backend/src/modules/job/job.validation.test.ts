import { describe, expect, it } from "vitest";

import { createJobSchema } from "./job.validation.js";

const A = "a".repeat(24), B = "b".repeat(24), C = "c".repeat(24), D = "d".repeat(24), E = "e".repeat(24), WH = "f".repeat(24), WH2 = "1".repeat(24);

function base(kitLines: unknown[]) {
  return { name: "Job", customerId: A, projectId: B, assignedEngineerId: C, kitLines };
}
const irm = (irmItemId: string, qty = 5, warehouseId: string = WH) => ({ lineType: "irm", itemName: "CAT6", irmItemId, warehouseId, qty });
const cse = (customerStockEntryId: string, qty = 1) => ({ lineType: "customer_stock", itemName: "SFP", customerStockEntryId, qty });
const misc = (itemName: string, qty = 1) => ({ lineType: "misc", itemName, qty });

describe("createJobSchema kit-line dedupe", () => {
  it("rejects the same IRM item twice for the same warehouse", () => {
    expect(createJobSchema.safeParse(base([irm(D), irm(D)])).success).toBe(false);
  });
  it("allows the same IRM item at two different warehouses (split pickup)", () => {
    expect(createJobSchema.safeParse(base([irm(D, 5, WH), irm(D, 5, WH2)])).success).toBe(true);
  });
  it("rejects the same customer-stock entry on two kit lines", () => {
    expect(createJobSchema.safeParse(base([cse(D), cse(D)])).success).toBe(false);
  });
  it("allows two misc lines with the same name (no source id)", () => {
    expect(createJobSchema.safeParse(base([misc("wires"), misc("wires")])).success).toBe(true);
  });
  it("allows distinct IRM items", () => {
    expect(createJobSchema.safeParse(base([irm(D), irm(E)])).success).toBe(true);
  });
});
