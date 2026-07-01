import { describe, expect, it } from "vitest";

import { createTransferSchema } from "./engineer-transfer.validation.js";

const OID = (c: string) => c.repeat(24);

const FROM = OID("a");
const TO = OID("b");
const IRM = OID("c");
const CSE = OID("d");

const companyLine = { ownership: "company" as const, irmItemId: IRM, quantity: 2 };
const customerLine = { ownership: "customer" as const, customerStockEntryId: CSE, quantity: 1 };

const base = {
  fromEngineerId: FROM,
  toEngineerId: TO,
  lines: [companyLine],
  reason: "Need extra cable for Leeds job",
};

describe("createTransferSchema — line ownership refinement", () => {
  it("accepts a valid company line (irmItemId set)", () => {
    expect(createTransferSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a valid customer line (customerStockEntryId set)", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [customerLine] });
    expect(r.success).toBe(true);
  });

  it("accepts mixed company + customer lines", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [companyLine, customerLine] });
    expect(r.success).toBe(true);
  });

  it("rejects company line without irmItemId", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ownership: "company", quantity: 1 }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.some((i) => i.message.includes("irmItemId"));
      expect(msg).toBe(true);
    }
  });

  it("rejects customer line without customerStockEntryId", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ownership: "customer", quantity: 1 }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.some((i) => i.message.includes("customerStockEntryId"));
      expect(msg).toBe(true);
    }
  });

  it("rejects zero quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: 0 }] });
    expect(r.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: -1 }] });
    expect(r.success).toBe(false);
  });

  it("rejects fractional quantity", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [{ ...companyLine, quantity: 1.5 }] });
    expect(r.success).toBe(false);
  });

  it("rejects empty lines array", () => {
    const r = createTransferSchema.safeParse({ ...base, lines: [] });
    expect(r.success).toBe(false);
  });

  it("rejects missing reason", () => {
    const r = createTransferSchema.safeParse({ ...base, reason: "" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid fromEngineerId (not ObjectId)", () => {
    const r = createTransferSchema.safeParse({ ...base, fromEngineerId: "nope" });
    expect(r.success).toBe(false);
  });

  it("toEngineerId is optional (self-service flow)", () => {
    const { toEngineerId: _, ...noTo } = base;
    const r = createTransferSchema.safeParse(noTo);
    expect(r.success).toBe(true);
  });
});
