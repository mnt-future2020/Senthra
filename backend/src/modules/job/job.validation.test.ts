import { describe, expect, it } from "vitest";

import { createJobSchema, updateJobSchema } from "./job.validation.js";

const A = "a".repeat(24), B = "b".repeat(24), C = "c".repeat(24), D = "d".repeat(24), E = "e".repeat(24), WH = "f".repeat(24), WH2 = "1".repeat(24);

// Carries a destination (addressLine1) because create now requires a site OR an address — see the
// destination suite below. Without it these kit-line cases would fail for a reason that has nothing
// to do with kit lines, and the "rejects duplicates" ones would pass for the wrong reason.
function base(kitLines: unknown[]) {
  return { name: "Job", customerId: A, projectId: B, assignedEngineerId: C, addressLine1: "1 Test Street", kitLines };
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

// A job dispatches an engineer somewhere, so create demands a destination: a saved site OR a typed
// address. Deliberately either/or rather than "an address is required" — a customer site's own
// address fields are optional, so a site can be saved with just a name, and requiring an address
// would reject someone who correctly picked such a site.
describe("createJobSchema destination (site or address)", () => {
  const withDest = (extra: Record<string, unknown>) => ({
    name: "Job",
    customerId: A,
    projectId: B,
    assignedEngineerId: C,
    kitLines: [misc("Cable ties")],
    ...extra,
  });

  it("accepts a saved site with no typed address", () => {
    // The site may itself hold no address — that gap belongs on the site record, not on the job.
    expect(createJobSchema.safeParse(withDest({ siteId: E })).success).toBe(true);
  });

  it("accepts a typed address with no saved site", () => {
    expect(createJobSchema.safeParse(withDest({ addressLine1: "1 Basinghall Street" })).success).toBe(true);
  });

  it("accepts both together", () => {
    expect(createJobSchema.safeParse(withDest({ siteId: E, addressLine1: "1 Basinghall Street" })).success).toBe(true);
  });

  it("REJECTS neither — the job would name nowhere to go", () => {
    const r = createJobSchema.safeParse(withDest({}));
    expect(r.success).toBe(false);
    if (!r.success) {
      // Reported against the site field so the form can surface it at the top of the location step.
      expect(r.error.issues.some((i) => i.path.includes("siteId"))).toBe(true);
    }
  });

  it("REJECTS a whitespace-only address as a destination", () => {
    expect(createJobSchema.safeParse(withDest({ addressLine1: "   " })).success).toBe(false);
  });

  it("does not accept a postcode or city ALONE as the destination", () => {
    // Neither names a place an engineer can be sent to on its own.
    expect(createJobSchema.safeParse(withDest({ postcode: "LS1 4DY" })).success).toBe(false);
    expect(createJobSchema.safeParse(withDest({ city: "Leeds" })).success).toBe(false);
  });
});

// The rule applies on UPDATE too, but it cannot be expressed as a schema refinement — an update is
// a PATCH, so a payload that mentions neither field says nothing about the destination and is
// perfectly valid on its own. It's the MERGED result (existing row + patch) that must have one, and
// only job.service.updateJob can see the existing row. Pinned so nobody "completes" the pair by
// adding a superRefine here, which would reject every partial patch in the app.
// A blank box has to be able to say "I cleared this". A plain text field gets that for free
// (z.string() keeps the ""), but an id or a date can't — their validator rejects "" — so they were
// wrapped in emptyToUndef, which turned "cleared" into "not mentioned". The result was a site, a
// supplier or a completion date you could set but never remove: the save succeeded and silently
// kept the old value. They now normalise "" to null, which the service already knew how to store.
describe("ids and dates the user can un-pick normalise '' to null (= clear it)", () => {
  it.each([["siteId"], ["supplierId"], ["completionDate"]])("%s: '' becomes null", (field) => {
    const r = updateJobSchema.safeParse({ [field]: "" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>)[field]).toBeNull();
  });

  it("accepts an explicit null too (a caller that means 'clear' outright)", () => {
    const r = updateJobSchema.safeParse({ siteId: null, supplierId: null, completionDate: null });
    expect(r.success).toBe(true);
  });

  it("still rejects a malformed id or date — 'clearable' is not 'unvalidated'", () => {
    expect(updateJobSchema.safeParse({ siteId: "not-an-id" }).success).toBe(false);
    expect(updateJobSchema.safeParse({ completionDate: "not-a-date" }).success).toBe(false);
  });

  it("leaves a MISSING key as undefined — that still means 'leave this field alone'", () => {
    const r = updateJobSchema.safeParse({ name: "Renamed" });
    expect(r.success).toBe(true);
    expect((r.data as Record<string, unknown>).siteId).toBeUndefined();
  });

  // Kit-line ids keep the old behaviour on purpose: a line is replaced wholesale, never patched,
  // so null there would only widen what the service has to defend against for no gain.
  it("does NOT make kit-line source ids nullable", () => {
    const withNullIrmId = base([{ lineType: "irm", itemName: "CAT6", irmItemId: null, warehouseId: WH, qty: 5 }]);
    expect(createJobSchema.safeParse(withNullIrmId).success).toBe(false);
  });
});

describe("updateJobSchema deliberately carries NO destination rule (it lives in the service)", () => {
  it("accepts a patch that mentions neither a site nor an address", () => {
    expect(updateJobSchema.safeParse({ notes: "reschedule agreed with the customer" }).success).toBe(true);
  });

  it("accepts a patch that explicitly blanks the address — the service decides if that's allowed", () => {
    expect(updateJobSchema.safeParse({ addressLine1: "" }).success).toBe(true);
  });
});
