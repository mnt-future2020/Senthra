import { describe, expect, it } from "vitest";
import { postMovementSchema, scanLookupSchema } from "./goods-management.validation.js";

const OID = "a".repeat(24);

describe("scanLookupSchema", () => {
  it("accepts a valid issue lookup", () => {
    const r = scanLookupSchema.safeParse({ jobId: OID, direction: "issue", code: "IRM-0004" });
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
      lines: [{ source: "irm", irmItemId: OID, qty: 1, condition: "good" }],
    });
    expect(r.success).toBe(true);
  });
});
