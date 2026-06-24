import { describe, expect, it } from "vitest";

import { updateMyProfileSchema } from "./user.validation.js";

// The whole security story of self-service profile edit is "the schema is the whitelist": zod strips
// every key that isn't explicitly allowed, so a client can never self-set a privilege/identity field.
describe("updateMyProfileSchema — strict self-edit whitelist", () => {
  it("keeps ONLY phone/profileImage/address and strips email/role/status/employeeId/permissions/dob", () => {
    const parsed = updateMyProfileSchema.parse({
      phone: "+447911123456",
      addressLine1: "1 Trade Road",
      addressLine2: "Unit 2",
      city: "Leeds",
      postcode: "LS1 1AB",
      // None of these may ever survive a self-edit:
      email: "evil@example.com",
      role: "super_admin",
      roleId: "abc123",
      status: "active",
      employeeId: "SNT-9999",
      permissions: ["*"],
      dob: "1990-01-01",
      dateOfBirth: "1990-01-01",
      signatureUrl: "https://x",
      profileImageUrl: "https://x",
    } as Record<string, unknown>);

    expect(Object.keys(parsed).sort()).toEqual(["addressLine1", "addressLine2", "city", "phone", "postcode"]);
    for (const k of ["email", "role", "roleId", "status", "employeeId", "permissions", "dob", "dateOfBirth", "signatureUrl", "profileImageUrl"]) {
      expect(k in parsed).toBe(false);
    }
  });

  it("accepts an empty patch + a data-URI avatar; rejects a non-data-URI avatar", () => {
    expect(updateMyProfileSchema.safeParse({}).success).toBe(true);
    expect(updateMyProfileSchema.safeParse({ profileImage: "data:image/png;base64,AAAA" }).success).toBe(true);
    expect(updateMyProfileSchema.safeParse({ profileImage: "https://not-a-data-uri" }).success).toBe(false);
  });
});
