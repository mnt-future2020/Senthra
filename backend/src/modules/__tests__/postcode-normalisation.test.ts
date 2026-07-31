import { describe, expect, it } from "vitest";

import { createCustomerSchema, updateCustomerSchema, siteSchema } from "#modules/customer/customer.validation.js";
import { createWarehouseSchema, updateWarehouseSchema } from "#modules/warehouse/warehouse.validation.js";
import { createSupplierSchema, updateSupplierSchema } from "#modules/supplier/supplier.validation.js";
import { createUserSchema, updateUserSchema, updateMyProfileSchema } from "#modules/user/user.validation.js";
import { createJobSchema, updateJobSchema } from "#modules/job/job.validation.js";
import { updateSettingsSchema } from "#modules/settings/settings.validation.js";

// Every write path that stores a postcode must hand the service the CANONICAL form, so the
// same physical postcode can never be stored as both "ls14dy" and "LS1 4DY". Normalising in
// each zod schema (rather than in the input box) is what makes this true for the master-data
// forms, the customer site CSV import and any direct API call alike.
//
// Each case parses a minimal valid payload with a lowercase, unspaced postcode and asserts
// the parsed output is "LS1 4DY".
const TYPED = "ls14dy";
const CANONICAL = "LS1 4DY";
const OID = (c: string) => c.repeat(24);

// Minimal valid payloads for the two schemas with several unrelated required fields, so a
// failure here can only be about the postcode.
const userBase = {
  firstName: "Pat",
  lastName: "Kaur",
  email: "pat@example.com",
  roleId: OID("a"),
  phone: "07123456789",
  jobTitle: "Engineer",
  department: "Field Ops",
  dateOfJoining: "2026-01-01",
};
const jobBase = {
  name: "Job 1",
  customerId: OID("a"),
  projectId: OID("b"),
  assignedEngineerId: OID("c"),
  // A job needs at least one kit line; a `misc` line is the one shape needing no source id.
  kitLines: [{ lineType: "misc", itemName: "Misc part", qty: 1 }],
  // …and a DESTINATION on create (a saved site or a typed address) — see createJobSchema. Without
  // it this fixture fails for a reason that has nothing to do with postcode normalisation.
  addressLine1: "1 Test Street",
};

const cases: [string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, object][] = [
  ["createCustomerSchema", createCustomerSchema, { name: "Acme", email: "a@b.com", postcode: TYPED }],
  ["updateCustomerSchema", updateCustomerSchema, { postcode: TYPED }],
  ["siteSchema (also the CSV import path)", siteSchema, { name: "Site A", postcode: TYPED }],
  [
    "createWarehouseSchema",
    createWarehouseSchema,
    { name: "Leeds Depot", typeId: OID("a"), addressLine1: "1 Way", city: "Leeds", postcode: TYPED, country: "United Kingdom" },
  ],
  ["updateWarehouseSchema", updateWarehouseSchema, { postcode: TYPED }],
  [
    "createSupplierSchema",
    createSupplierSchema,
    { name: "Acme Ltd", typeId: OID("a"), addressLine1: "1 Way", city: "Leeds", postcode: TYPED, country: "United Kingdom" },
  ],
  ["updateSupplierSchema", updateSupplierSchema, { postcode: TYPED }],
  ["createUserSchema", createUserSchema, { ...userBase, postcode: TYPED }],
  ["updateUserSchema", updateUserSchema, { postcode: TYPED }],
  ["updateMyProfileSchema", updateMyProfileSchema, { postcode: TYPED }],
  ["createJobSchema", createJobSchema, { ...jobBase, postcode: TYPED }],
  ["updateJobSchema", updateJobSchema, { postcode: TYPED }],
];

describe("postcode normalisation across every schema that accepts one", () => {
  it.each(cases)("%s normalises a lowercase unspaced postcode", (_label, schema, payload) => {
    const r = schema.safeParse(payload);
    expect(r.success).toBe(true);
    expect((r.data as { postcode?: string }).postcode).toBe(CANONICAL);
  });

  it("updateSettingsSchema normalises the company postcode", () => {
    const r = updateSettingsSchema.safeParse({ companyPostcode: TYPED });
    expect(r.success).toBe(true);
    expect(r.data?.companyPostcode).toBe(CANONICAL);
  });
});

describe("postcode validation is enforced on the fields that were previously unchecked", () => {
  it.each([
    ["createUserSchema", createUserSchema, { ...userBase, postcode: "nope" }],
    ["updateMyProfileSchema", updateMyProfileSchema, { postcode: "nope" }],
    ["createJobSchema", createJobSchema, { ...jobBase, postcode: "nope" }],
  ])("%s rejects a malformed postcode", (_label, schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("updateSettingsSchema rejects a malformed company postcode", () => {
    expect(updateSettingsSchema.safeParse({ companyPostcode: "nope" }).success).toBe(false);
  });
});

// The create forms send `postcode: postcode.trim() || undefined`, so a blank arrives as a MISSING
// key, not an empty string — and validate.middleware surfaces issues[0].message to the client.
describe("a required postcode names itself when the key is missing", () => {
  it.each([
    ["createWarehouseSchema", createWarehouseSchema, { name: "D", typeId: OID("a"), addressLine1: "1 Way", city: "Leeds", country: "United Kingdom" }],
    ["createSupplierSchema", createSupplierSchema, { name: "S", typeId: OID("a"), addressLine1: "1 Way", city: "Leeds", country: "United Kingdom" }],
  ])("%s", (_label, schema, payload) => {
    const r = schema.safeParse(payload) as { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
    expect(r.success).toBe(false);
    const postcodeIssue = r.error?.issues.find((i) => i.path[0] === "postcode");
    expect(postcodeIssue?.message).toBe("Postcode is required.");
  });
});

describe("an optional postcode stays clearable", () => {
  it.each([
    ["updateCustomerSchema", updateCustomerSchema],
    ["updateMyProfileSchema", updateMyProfileSchema],
    ["updateJobSchema", updateJobSchema],
  ])("%s accepts an empty string as 'cleared'", (_label, schema) => {
    const r = schema.safeParse({ postcode: "" });
    expect(r.success).toBe(true);
    expect((r.data as { postcode?: string }).postcode).toBe("");
  });

  it("updateSettingsSchema accepts an empty company postcode", () => {
    expect(updateSettingsSchema.safeParse({ companyPostcode: "" }).success).toBe(true);
  });
});
