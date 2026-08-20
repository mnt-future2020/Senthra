import { describe, expect, it } from "vitest";

import { createRentalItemSchema, updateRentalItemSchema } from "./rental-item.validation.js";

const OID = "6a1d7f5bfa7d25704f02b963";
const valid = { name: "Fibre Tester", rentalCategoryId: OID, baseUnit: "Each" };

describe("createRentalItemSchema — the master's shape", () => {
  it("accepts the required set and trims the name", () => {
    expect(createRentalItemSchema.parse({ ...valid, name: " Fibre Tester " }).name).toBe("Fibre Tester");
  });

  it("requires a name, a category and a unit", () => {
    expect(createRentalItemSchema.safeParse({ ...valid, name: "  " }).success).toBe(false);
    expect(createRentalItemSchema.safeParse({ name: "X", baseUnit: "Each" }).success).toBe(false);
    // A hire is always quantified in something, so the unit is not optional.
    expect(createRentalItemSchema.safeParse({ name: "X", rentalCategoryId: OID }).success).toBe(false);
    expect(createRentalItemSchema.safeParse({ ...valid, baseUnit: "   " }).success).toBe(false);
  });

  // The unit comes from the app-wide vocabulary (utils/uom.ts), not free text — the same closed
  // list IRM items and customer stock entries use. Per-unit coverage lives in utils/__tests__/uom.
  it("refuses a unit outside the shared vocabulary", () => {
    expect(createRentalItemSchema.safeParse({ ...valid, baseUnit: "each" }).success).toBe(false);
    expect(createRentalItemSchema.safeParse({ ...valid, baseUnit: "Sets" }).success).toBe(false);
  });

  it("refuses a category that is not an object id", () => {
    expect(createRentalItemSchema.safeParse({ ...valid, rentalCategoryId: "nope" }).success).toBe(false);
  });

  it("refuses a status outside the allowed pair", () => {
    expect(createRentalItemSchema.safeParse({ ...valid, status: "archived" }).success).toBe(false);
    expect(createRentalItemSchema.safeParse({ ...valid, status: "inactive" }).success).toBe(true);
  });

  // The code is server-allocated from the atomic Counter. Accepting one would let a caller collide
  // with a live item, and `code` is uniquely indexed, so the create would simply fail.
  it("ignores a client-supplied code", () => {
    const r = createRentalItemSchema.parse({ ...valid, code: "RNT-9999" }) as Record<string, unknown>;
    expect(r.code).toBeUndefined();
  });

  // THE business rule this master exists under: it says WHAT can be hired, never what a hire costs.
  // Price, VAT and currency are negotiated per period and per supplier, so they belong to the PRF
  // rental line. A rate here would be a second, staler answer that drifts on the first quote.
  it("silently drops every pricing field a caller might send", () => {
    const r = createRentalItemSchema.parse({
      ...valid,
      standardHireRatePence: 15000,
      hireRatePeriod: "week",
      currency: "GBP",
      vatRatePercent: 20,
    }) as Record<string, unknown>;
    for (const field of ["standardHireRatePence", "hireRatePeriod", "currency", "vatRatePercent"]) {
      expect(r[field], `${field} must not survive into the rental master`).toBeUndefined();
    }
  });
});

describe("updateRentalItemSchema", () => {
  it("allows a patch that changes nothing", () => {
    expect(updateRentalItemSchema.safeParse({}).success).toBe(true);
  });

  // A PATCH may omit the unit, but sending an empty one is a mistake rather than "clear it" — the
  // column is required.
  it("refuses an explicitly blank unit", () => {
    expect(updateRentalItemSchema.safeParse({ baseUnit: "  " }).success).toBe(false);
  });

  it("drops pricing on update too", () => {
    const r = updateRentalItemSchema.parse({ standardHireRatePence: 1, vatRatePercent: 5 }) as Record<string, unknown>;
    expect(r.standardHireRatePence).toBeUndefined();
    expect(r.vatRatePercent).toBeUndefined();
  });
});
