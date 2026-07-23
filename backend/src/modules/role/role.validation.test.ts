import { describe, expect, it } from "vitest";

import { ALL_PERMISSIONS, PERMISSION_KEYS } from "./permissions.js";
import { createRoleSchema, updateRoleSchema } from "./role.validation.js";

// The permissions array used to carry a hardcoded `.max(50)`. The catalogue outgrew it, so
// saving any role with more than 50 permissions failed with a bare "Too big: expected array
// to have <=50 items" — including the built-in Warehouse Manager, which the seeder writes
// straight through the repository and therefore never hit the schema. These tests pin the
// bound to the catalogue itself so it cannot silently go stale again.

const EVERY_KEY = [...PERMISSION_KEYS];

describe("role permissions field", () => {
  it("accepts the entire permission catalogue", () => {
    expect(EVERY_KEY.length).toBeGreaterThan(50); // the case the old cap rejected
    expect(createRoleSchema.safeParse({ name: "Everything", permissions: EVERY_KEY }).success).toBe(true);
    expect(updateRoleSchema.safeParse({ permissions: EVERY_KEY }).success).toBe(true);
  });

  it("accepts the catalogue plus the '*' wildcard", () => {
    const result = updateRoleSchema.safeParse({ permissions: [ALL_PERMISSIONS, ...EVERY_KEY] });
    expect(result.success).toBe(true);
  });

  it("accepts an empty list and an omitted field", () => {
    expect(updateRoleSchema.safeParse({ permissions: [] }).success).toBe(true);
    expect(updateRoleSchema.safeParse({}).success).toBe(true);
  });

  // Still bounded — the field must not become an unbounded sink for arbitrary payloads.
  it("rejects a list larger than the catalogue can justify", () => {
    const oversized = Array.from({ length: EVERY_KEY.length * 2 + 10 }, (_, i) => `bogus.key${i}`);
    expect(updateRoleSchema.safeParse({ permissions: oversized }).success).toBe(false);
  });

  it("rejects an absurdly long key instead of passing it to the service", () => {
    const result = updateRoleSchema.safeParse({ permissions: ["x".repeat(5000)] });
    expect(result.success).toBe(false);
  });

  it("accepts the longest real key in the catalogue", () => {
    const longest = EVERY_KEY.reduce((a, b) => (b.length > a.length ? b : a));
    expect(updateRoleSchema.safeParse({ permissions: [longest] }).success).toBe(true);
  });
});
