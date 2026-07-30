import { describe, expect, it } from "vitest";
import { postMovementSchema, reportDamageSchema, scanLookupSchema } from "./goods-management.validation.js";

const OID = "a".repeat(24);

describe("scanLookupSchema", () => {
  it("accepts a valid issue lookup", () => {
    const r = scanLookupSchema.safeParse({ jobId: OID, warehouseId: OID, direction: "issue", code: "IRM-0004" });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown direction", () => {
    const r = scanLookupSchema.safeParse({ jobId: OID, direction: "consume", code: "X" });
    expect(r.success).toBe(false);
  });
});

describe("postMovementSchema", () => {
  it("requires damagePhotoUrl + damageReason when a return line is damaged", () => {
    const r = postMovementSchema.safeParse({
      direction: "return",
      lines: [{ source: "irm", irmItemId: OID, qty: 1, condition: "damaged" }],
    });
    expect(r.success).toBe(false);
  });
  it("accepts a good return line without a photo", () => {
    const r = postMovementSchema.safeParse({
      direction: "return",
      warehouseId: OID,
      lines: [{ source: "irm", irmItemId: OID, qty: 1, condition: "good" }],
    });
    expect(r.success).toBe(true);
  });
});

describe("reportDamageSchema", () => {
  const base = {
    warehouseId: OID,
    quantity: 1,
    reason: "Crushed by forklift",
    damagePhotoUrl: "https://cdn/x.jpg",
  };

  it("accepts a company report that sends the unused customer socket as NULL", () => {
    // A damaged balance is keyed with exactly ONE owner socket set, so the client explicitly sends
    // the other as null. This failed with "expected string, received null" until emptyToUndef was
    // taught that null means absent — the first real submission from the UI hit it.
    const r = reportDamageSchema.safeParse({ ...base, ownerType: "company", irmItemId: OID, customerStockEntryId: null });
    expect(r.success).toBe(true);
  });

  it("accepts a customer report that sends the unused IRM socket as NULL", () => {
    const r = reportDamageSchema.safeParse({ ...base, ownerType: "customer", irmItemId: null, customerStockEntryId: OID });
    expect(r.success).toBe(true);
  });

  it("requires an irmItemId for company-owned stock", () => {
    const r = reportDamageSchema.safeParse({ ...base, ownerType: "company", irmItemId: null, customerStockEntryId: null });
    expect(r.success).toBe(false);
  });

  it("requires a customerStockEntryId for customer-owned stock", () => {
    const r = reportDamageSchema.safeParse({ ...base, ownerType: "customer", irmItemId: null, customerStockEntryId: null });
    expect(r.success).toBe(false);
  });

  it("requires a reason AND a photo — the evidence the damaged pool exists to hold", () => {
    expect(reportDamageSchema.safeParse({ ...base, reason: "", ownerType: "company", irmItemId: OID }).success).toBe(false);
    expect(reportDamageSchema.safeParse({ ...base, damagePhotoUrl: "", ownerType: "company", irmItemId: OID }).success).toBe(false);
  });

  it("rejects a zero or negative quantity", () => {
    expect(reportDamageSchema.safeParse({ ...base, quantity: 0, ownerType: "company", irmItemId: OID }).success).toBe(false);
    expect(reportDamageSchema.safeParse({ ...base, quantity: -3, ownerType: "company", irmItemId: OID }).success).toBe(false);
  });
});
