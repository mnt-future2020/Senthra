import { describe, expect, it } from "vitest";

import {
  catalogueItemSchema,
  createCustomerSchema,
  customerUserSchema,
  projectSchema,
  siteSchema,
} from "./customer.validation.js";

// These cover the customer module's INPUT contract — the zod schemas are the
// production-grade boundary (every admin write goes through them). Pure, no DB.

describe("projectSchema", () => {
  it("accepts a full project and coerces dates/status", () => {
    const r = projectSchema.safeParse({
      name: "BT Core Migration",
      type: "Migration",
      startDate: "2026-01-01",
      endDate: "",
      status: "planned",
      description: "Phase 1",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("planned");
      expect(r.data.endDate).toBeUndefined(); // "" → undefined
    }
  });
  it("requires a name", () => {
    expect(projectSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects an unknown status", () => {
    expect(projectSchema.safeParse({ name: "P", status: "bogus" }).success).toBe(false);
  });
  it("rejects an unparseable date", () => {
    expect(projectSchema.safeParse({ name: "P", startDate: "not-a-date" }).success).toBe(false);
  });
  it("treats a blank status as unset", () => {
    const r = projectSchema.safeParse({ name: "P", status: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBeUndefined();
  });
});

describe("catalogueItemSchema", () => {
  const base = { name: "SFP-LX", sku: "NTTP06", categoryId: "0123456789abcdef01234567" };

  it("accepts a full item and coerces thresholdQty to a number", () => {
    const r = catalogueItemSchema.safeParse({
      ...base,
      description: "single-mode",
      uom: "Each",
      serialized: true,
      barcodeRequired: true,
      highValue: true,
      thresholdQty: "10",
      status: "active",
      attributes: { Fibre: "Singlemode" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.thresholdQty).toBe(10);
      expect(r.data.serialized).toBe(true);
      expect(r.data.uom).toBe("Each");
    }
  });

  it("requires name, sku and categoryId", () => {
    expect(catalogueItemSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...base, sku: "" }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ name: "x", sku: "y" }).success).toBe(false);
  });

  it("requires categoryId to be a 24-hex id, not free text", () => {
    expect(catalogueItemSchema.safeParse({ ...base, categoryId: "Optical" }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...base, categoryId: "  " }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...base, categoryId: "0123456789abcdef01234567" }).success).toBe(true);
  });

  it("allows the spec's own 'High Value Item' wording (no broad money-word guard)", () => {
    expect(catalogueItemSchema.safeParse({ ...base, name: "High Value Optical Module" }).success).toBe(
      true,
    );
  });

  it("rejects a currency symbol in any visible field (price-free catalogue)", () => {
    expect(catalogueItemSchema.safeParse({ ...base, name: "Cable £5" }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...base, sku: "$KU" }).success).toBe(false);
    expect(
      catalogueItemSchema.safeParse({ ...base, attributes: { Cost: "€5" } }).success,
    ).toBe(false);
  });

  it("rejects an unknown unit of measure", () => {
    expect(catalogueItemSchema.safeParse({ ...base, uom: "Furlong" }).success).toBe(false);
  });

  it("rejects a non-integer / negative threshold", () => {
    expect(catalogueItemSchema.safeParse({ ...base, thresholdQty: "10.5" }).success).toBe(false);
    expect(catalogueItemSchema.safeParse({ ...base, thresholdQty: "-1" }).success).toBe(false);
  });

  it("caps custom fields at 30", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(catalogueItemSchema.safeParse({ ...base, attributes }).success).toBe(false);
  });

  it("never carries a price field through (catalogue is price-free)", () => {
    const r = catalogueItemSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect("unitPricePence" in r.data).toBe(false);
      expect("price" in r.data).toBe(false);
    }
  });
});

describe("siteSchema", () => {
  it("accepts a full site", () => {
    const r = siteSchema.safeParse({
      name: "Leeds Basinghall",
      addressLine: "1 Basinghall St",
      postcode: "LS1 5AA",
      contactPerson: "Sam",
      contactNumber: "07700 900111",
      status: "active",
    });
    expect(r.success).toBe(true);
  });
  it("requires a name", () => {
    expect(siteSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects an invalid UK postcode", () => {
    expect(siteSchema.safeParse({ name: "S", postcode: "12345" }).success).toBe(false);
  });
  it("strips any client-supplied coordinates (geocoded server-side from the postcode)", () => {
    const r = siteSchema.safeParse({ name: "S", latitude: "53.8", longitude: "-1.5" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("latitude" in r.data).toBe(false);
      expect("longitude" in r.data).toBe(false);
    }
  });
});

describe("customerUserSchema", () => {
  it("accepts a valid user", () => {
    expect(
      customerUserSchema.safeParse({
        fullName: "Jane Doe",
        email: "jane@customer.com",
        phone: "07700 900000",
        designation: "Project Manager",
        status: "active",
      }).success,
    ).toBe(true);
  });
  it("requires a full name and email", () => {
    expect(customerUserSchema.safeParse({ fullName: "", email: "a@b.com" }).success).toBe(false);
    expect(customerUserSchema.safeParse({ fullName: "A", email: "" }).success).toBe(false);
  });
  it("rejects an invalid email", () => {
    expect(customerUserSchema.safeParse({ fullName: "A", email: "not-an-email" }).success).toBe(
      false,
    );
  });
  it("rejects an invalid phone", () => {
    expect(
      customerUserSchema.safeParse({ fullName: "A", email: "a@b.com", phone: "12" }).success,
    ).toBe(false);
  });
});

describe("createCustomerSchema", () => {
  it("requires name + email and accepts the profile fields", () => {
    const r = createCustomerSchema.safeParse({
      name: "BT",
      email: "pm@bt.com",
      legalName: "British Telecommunications plc",
      country: "United Kingdom",
      postcode: "EC1A 1BB",
    });
    expect(r.success).toBe(true);
  });
  it("rejects a missing name or email", () => {
    expect(createCustomerSchema.safeParse({ name: "", email: "a@b.com" }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ name: "BT", email: "" }).success).toBe(false);
  });
  it("rejects an invalid postcode", () => {
    expect(createCustomerSchema.safeParse({ name: "BT", email: "a@b.com", postcode: "ZZ" }).success).toBe(
      false,
    );
  });
});
