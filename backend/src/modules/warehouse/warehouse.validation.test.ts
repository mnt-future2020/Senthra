import { describe, expect, it } from "vitest";

import { createWarehouseSchema, updateWarehouseSchema } from "./warehouse.validation.js";

const TYPE_ID = "a".repeat(24);

// A minimal VALID create payload — name, type, and the required address fields.
const valid = () => ({
  name: "Leeds Depot",
  typeId: TYPE_ID,
  addressLine1: "1 Test Way",
  city: "Leeds",
  postcode: "LS1 4DY",
  country: "United Kingdom",
});

describe("createWarehouseSchema — required fields", () => {
  it("accepts a valid warehouse with all required fields", () => {
    const r = createWarehouseSchema.safeParse(valid());
    expect(r.success).toBe(true);
  });

  it("accepts a full warehouse (+ optional fields)", () => {
    const r = createWarehouseSchema.safeParse({
      ...valid(),
      isDefault: true,
      addressLine2: "Unit 4",
      county: "West Yorkshire",
      contactPerson: "Pat",
      contactEmail: "pat@example.com",
      contactPhone: "07123456789",
      operatingHours: "Mon–Fri 08:00–18:00",
      timezone: "Europe/London",
      notes: "Back gate access only",
      status: "active",
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["name", { name: undefined }],
    ["typeId", { typeId: undefined }],
    ["addressLine1", { addressLine1: undefined }],
    ["city", { city: undefined }],
    ["postcode", { postcode: undefined }],
    ["country", { country: undefined }],
  ])("requires %s", (_label, patch) => {
    expect(createWarehouseSchema.safeParse({ ...valid(), ...patch }).success).toBe(false);
  });

  it("rejects blank required text (name / addressLine1 / city)", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), name: "   " }).success).toBe(false);
    expect(createWarehouseSchema.safeParse({ ...valid(), addressLine1: "   " }).success).toBe(false);
    expect(createWarehouseSchema.safeParse({ ...valid(), city: "   " }).success).toBe(false);
  });

  it("rejects addressLine1 longer than 150 chars", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), addressLine1: "x".repeat(151) }).success).toBe(
      false,
    );
  });

  it("rejects a typeId that isn't a 24-hex ObjectId", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), typeId: "spaceship" }).success).toBe(false);
  });

  it("rejects a malformed UK postcode", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), postcode: "NOPE" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), status: "archived" }).success).toBe(false);
  });

  it("accepts United Kingdom but rejects Ireland and other countries (UK-only)", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), country: "United Kingdom" }).success).toBe(true);
    expect(createWarehouseSchema.safeParse({ ...valid(), country: "Ireland" }).success).toBe(false);
    expect(createWarehouseSchema.safeParse({ ...valid(), country: "France" }).success).toBe(false);
  });

  it("rejects an unknown timezone", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), timezone: "Mars/Olympus" }).success).toBe(false);
  });

  it("rejects a malformed contact email", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), contactEmail: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("accepts a blank contact email (clears)", () => {
    expect(createWarehouseSchema.safeParse({ ...valid(), contactEmail: "" }).success).toBe(true);
  });

  // Managers come from the Users & Roles assignment, never from the warehouse payload — a smuggled
  // manager id must be stripped, not stored.
  it("strips a manager id from the payload", () => {
    const r = createWarehouseSchema.safeParse({ ...valid(), managerUserId: "b".repeat(24) });
    expect(r.success).toBe(true);
    if (r.success) expect("managerUserId" in r.data).toBe(false);
  });
});

describe("updateWarehouseSchema — partial, but required fields can't be blanked", () => {
  it("accepts a partial update (status only)", () => {
    expect(updateWarehouseSchema.safeParse({ status: "inactive" }).success).toBe(true);
  });

  it("accepts changing the type (typeId)", () => {
    expect(updateWarehouseSchema.safeParse({ typeId: TYPE_ID }).success).toBe(true);
  });

  it("rejects blanking a required field (addressLine1 / city / postcode)", () => {
    expect(updateWarehouseSchema.safeParse({ addressLine1: "" }).success).toBe(false);
    expect(updateWarehouseSchema.safeParse({ city: "" }).success).toBe(false);
    expect(updateWarehouseSchema.safeParse({ postcode: "" }).success).toBe(false);
  });

  it("rejects an empty-string name when provided", () => {
    expect(updateWarehouseSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
