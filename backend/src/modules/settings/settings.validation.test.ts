import { describe, expect, it } from "vitest";

import { updateSettingsSchema } from "./settings.validation.js";

// The settings update is a partial patch — every field optional. These cover the additive
// Company Profile + Regional fields (the rest of the schema is pre-existing and unchanged).

describe("updateSettingsSchema — company profile + regional", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full, valid company profile + regional block", () => {
    const r = updateSettingsSchema.safeParse({
      companyLegalName: "Electra Networks Limited",
      companyRegNumber: "01234567",
      vatNumber: "GB123456789",
      companyAddressLine1: "Unit 4 Enterprise Centre",
      companyAddressLine2: "Easthampstead Road",
      companyCity: "Bracknell",
      companyCounty: "Berkshire",
      companyPostcode: "RG12 1NF",
      companyCountry: "United Kingdom",
      companyPhone: "+44 1344 000000",
      companyEmail: "purchasing@electra.example",
      websiteUrl: "https://electra.example",
      timezone: "Europe/London",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "24h",
    });
    expect(r.success).toBe(true);
  });

  it("accepts empty strings (clears a field back to its default on the server)", () => {
    const r = updateSettingsSchema.safeParse({
      companyLegalName: "",
      companyCountry: "",
      companyEmail: "",
      websiteUrl: "",
      dateFormat: "",
      timeFormat: "",
      timezone: "",
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["DD/MM/YYYY"],
    ["MM/DD/YYYY"],
    ["YYYY-MM-DD"],
  ])("accepts date format %s", (fmt) => {
    expect(updateSettingsSchema.safeParse({ dateFormat: fmt }).success).toBe(true);
  });

  it.each([["24h"], ["12h"]])("accepts time format %s", (fmt) => {
    expect(updateSettingsSchema.safeParse({ timeFormat: fmt }).success).toBe(true);
  });

  it.each([
    ["invalid company email", { companyEmail: "not-an-email" }],
    ["invalid website url", { websiteUrl: "notaurl" }],
    ["invalid date format", { dateFormat: "DD-MM-YY" }],
    ["invalid time format", { timeFormat: "48h" }],
    ["company legal name too long", { companyLegalName: "x".repeat(201) }],
    ["vat number too long", { vatNumber: "x".repeat(41) }],
    ["postcode too long", { companyPostcode: "x".repeat(17) }],
  ])("rejects: %s", (_label, payload) => {
    expect(updateSettingsSchema.safeParse(payload).success).toBe(false);
  });
});

describe("updateSettingsSchema — stock code prefix", () => {
  it.each([["CSE"], ["AB"], ["abcde"]])("accepts %s", (v) => {
    expect(updateSettingsSchema.safeParse({ stockCodePrefix: v }).success).toBe(true);
  });

  it("accepts an empty string (clears back to the default)", () => {
    expect(updateSettingsSchema.safeParse({ stockCodePrefix: "" }).success).toBe(true);
  });

  it.each([
    ["one letter", "A"],
    ["six letters", "ABCDEF"],
    ["contains a digit", "CS1"],
    ["contains a dash", "C-E"],
  ])("rejects %s", (_label, v) => {
    expect(updateSettingsSchema.safeParse({ stockCodePrefix: v }).success).toBe(false);
  });
});
