import { describe, expect, it } from "vitest";

import { createSupplierSchema, updateSupplierSchema } from "./supplier.validation.js";

const TYPE_ID = "d".repeat(24);

// A fully-valid create payload; override individual fields per test.
const valid = (over: Record<string, unknown> = {}) => ({
  name: "Corning Ltd",
  typeId: TYPE_ID,
  addressLine1: "1 Fibre Way",
  city: "Leeds",
  postcode: "LS1 1AB",
  country: "United Kingdom",
  ...over,
});

describe("createSupplierSchema — required fields", () => {
  it("accepts a valid supplier and trims the name", () => {
    const r = createSupplierSchema.safeParse(valid({ name: "  Corning Ltd  " }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Corning Ltd");
  });

  it.each(["name", "typeId", "addressLine1", "city", "postcode", "country"])(
    "rejects a missing %s",
    (field) => {
      const payload = valid();
      delete (payload as Record<string, unknown>)[field];
      expect(createSupplierSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("rejects an address line 1 longer than 150 chars", () => {
    expect(createSupplierSchema.safeParse(valid({ addressLine1: "x".repeat(151) })).success).toBe(
      false,
    );
  });

  it("rejects a non-UK postcode format", () => {
    expect(createSupplierSchema.safeParse(valid({ postcode: "99999" })).success).toBe(false);
  });
});

describe("createSupplierSchema — country allow-list (UK only)", () => {
  it("accepts United Kingdom", () => {
    expect(createSupplierSchema.safeParse(valid({ country: "United Kingdom" })).success).toBe(true);
  });

  it.each(["Ireland", "France", "USA"])("rejects %s", (country) => {
    expect(createSupplierSchema.safeParse(valid({ country })).success).toBe(false);
  });
});

describe("createSupplierSchema — optional field validation", () => {
  it("rejects an invalid contact email", () => {
    expect(createSupplierSchema.safeParse(valid({ contactEmail: "not-an-email" })).success).toBe(
      false,
    );
  });

  it("rejects an invalid website", () => {
    expect(createSupplierSchema.safeParse(valid({ website: "http://" })).success).toBe(false);
  });

  it("accepts a bare-domain website", () => {
    expect(createSupplierSchema.safeParse(valid({ website: "corning.com" })).success).toBe(true);
  });

  it("rejects a lead time above 365", () => {
    expect(createSupplierSchema.safeParse(valid({ leadTimeDays: 400 })).success).toBe(false);
  });

  it("rejects a negative lead time", () => {
    expect(createSupplierSchema.safeParse(valid({ leadTimeDays: -1 })).success).toBe(false);
  });

  it("coerces a numeric-string lead time", () => {
    const r = createSupplierSchema.safeParse(valid({ leadTimeDays: "30" }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.leadTimeDays).toBe(30);
  });

  it("rejects an unknown currency", () => {
    expect(createSupplierSchema.safeParse(valid({ currency: "USD" })).success).toBe(false);
  });

  it("rejects an unknown payment term", () => {
    expect(createSupplierSchema.safeParse(valid({ paymentTerms: "120 Days" })).success).toBe(false);
  });
});

describe("createSupplierSchema — custom payment terms", () => {
  it("requires the custom text when paymentTerms is Custom", () => {
    expect(createSupplierSchema.safeParse(valid({ paymentTerms: "Custom" })).success).toBe(false);
  });

  it("accepts Custom with the custom text", () => {
    expect(
      createSupplierSchema.safeParse(valid({ paymentTerms: "Custom", customPaymentTerms: "Net 10 EOM" }))
        .success,
    ).toBe(true);
  });

  it("accepts Prepaid (no custom text needed)", () => {
    expect(createSupplierSchema.safeParse(valid({ paymentTerms: "Prepaid" })).success).toBe(true);
  });
});

describe("updateSupplierSchema", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateSupplierSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("rejects blanking a required field (city)", () => {
    expect(updateSupplierSchema.safeParse({ city: "   " }).success).toBe(false);
  });

  it("clears payment terms when sent an empty string (— None — on edit)", () => {
    const r = updateSupplierSchema.safeParse({ paymentTerms: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.paymentTerms).toBeNull();
  });
});
