import { describe, expect, it } from "vitest";

import { testStorageSchema, updateSettingsSchema } from "./settings.validation.js";

// ── The two storage URLs ──────────────────────────────────────────────────────────────────────
//
// Both reach the network, and they fail in very different ways.
//
// The ENDPOINT is where the SDK signs its requests — a bad one fails loudly, at the next call.
//
// The CDN origin is the dangerous one. It is baked into every delivery URL the app then writes onto
// attachment, avatar and signature rows, and none of the S3 calls in the connection test ever touch
// it. So a typo used to pass the test GREEN and then become a permanent part of every record
// written afterwards — a data migration to undo, not a settings correction.
//
// The probe now fetches the object back through that origin (see spaces.probe.test.ts). This is the
// cheaper half of the same defence: reject the obviously-wrong value before it is ever stored.

const accepts = (schema: typeof updateSettingsSchema, field: string, value: string) =>
  schema.safeParse({ [field]: value }).success;

describe("the Spaces endpoint and CDN URL", () => {
  it.each([
    ["https://ams3.digitaloceanspaces.com", true],
    ["http://localhost:9000", true],
    ["https://files.example.com/prefix", true],
    // Cleared — both fields are optional, and "" is how the UI removes a value.
    ["", true],
    ["ams3.digitaloceanspaces.com", false],
    ["not a url at all", false],
    ["  ", false],
  ])("endpoint %j → accepted: %s", (value, expected) => {
    expect(accepts(updateSettingsSchema, "spacesEndpoint", value)).toBe(expected);
  });

  it.each([
    ["https://cdn.example.com", true],
    ["", true],
    ["cdn.example.com", false],
    ["://broken", false],
  ])("CDN %j → accepted: %s", (value, expected) => {
    expect(accepts(updateSettingsSchema, "spacesCdnUrl", value)).toBe(expected);
  });

  // `z.string().url()` alone accepts these, and the server FETCHES the CDN origin during the probe.
  it.each(["ftp://files.example.com", "javascript:alert(1)", "file:///etc/passwd"])(
    "refuses the non-http scheme %j",
    (value) => {
      expect(accepts(updateSettingsSchema, "spacesCdnUrl", value)).toBe(false);
      expect(accepts(updateSettingsSchema, "spacesEndpoint", value)).toBe(false);
    },
  );

  it("refuses an absurdly long URL", () => {
    expect(accepts(updateSettingsSchema, "spacesCdnUrl", `https://e.com/${"a".repeat(3000)}`)).toBe(false);
  });

  // The test payload carries the same fields, and is the FIRST place a typo would otherwise be
  // rewarded with a green tick.
  it("applies the same rule to the connection-test payload", () => {
    expect(testStorageSchema.safeParse({ provider: "spaces", spacesCdnUrl: "cdn.example.com" }).success).toBe(false);
    expect(testStorageSchema.safeParse({ provider: "spaces", spacesCdnUrl: "https://cdn.example.com" }).success).toBe(
      true,
    );
  });

  it("says which field is wrong, in words an administrator can act on", () => {
    const result = updateSettingsSchema.safeParse({ spacesCdnUrl: "cdn.example.com" });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toMatch(/valid CDN URL/i);
  });
});
