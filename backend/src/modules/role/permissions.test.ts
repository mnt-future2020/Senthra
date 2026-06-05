import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  LEGACY_PERMISSION_EXPANSION,
  PERMISSION_KEYS,
  applyImpliedPermissions,
  escalationViolations,
  roleGrants,
  sanitizePermissions,
} from "./permissions.js";

describe("roleGrants", () => {
  it("grants an exact permission the set holds", () => {
    expect(roleGrants(["users.view"], "users.view")).toBe(true);
  });
  it("denies a permission the set doesn't hold", () => {
    expect(roleGrants(["users.view"], "users.delete")).toBe(false);
  });
  it("'*' grants every permission", () => {
    expect(roleGrants([ALL_PERMISSIONS], "anything.at.all")).toBe(true);
  });
});

describe("sanitizePermissions", () => {
  it("keeps valid keys and dedupes", () => {
    const { valid, unknown } = sanitizePermissions(["users.view", "users.view", "settings.manage"]);
    expect(valid).toEqual(["users.view", "settings.manage"]);
    expect(unknown).toEqual([]);
  });
  it("accepts the '*' wildcard", () => {
    expect(sanitizePermissions(["*"]).valid).toEqual(["*"]);
  });
  it("flags unknown keys instead of silently dropping them", () => {
    const { valid, unknown } = sanitizePermissions(["users.view", "bogus.key"]);
    expect(valid).toEqual(["users.view"]);
    expect(unknown).toEqual(["bogus.key"]);
  });
});

describe("escalationViolations (no-escalation guard)", () => {
  it("a '*' actor (super-admin) can grant anything", () => {
    expect(escalationViolations(["users.delete", "settings.manage"], ["*"])).toEqual([]);
  });
  it("a delegate can grant a subset of what it holds", () => {
    expect(escalationViolations(["users.view"], ["users.view", "users.edit"])).toEqual([]);
  });
  it("a delegate can't grant a permission it lacks", () => {
    expect(escalationViolations(["users.delete"], ["users.view"])).toEqual(["users.delete"]);
  });
  it("a delegate can never grant the '*' wildcard", () => {
    expect(escalationViolations(["*"], ["users.view", "users.edit"])).toEqual(["*"]);
  });
});

describe("applyImpliedPermissions (manage implies view)", () => {
  it("adds the module's view when any action is granted", () => {
    expect(applyImpliedPermissions(["users.create"]).sort()).toEqual(["users.create", "users.view"]);
  });
  it("pairs settings.manage with settings.view", () => {
    expect(applyImpliedPermissions(["settings.manage"]).sort()).toEqual([
      "settings.manage",
      "settings.view",
    ]);
  });
  it("leaves a view-only grant unchanged", () => {
    expect(applyImpliedPermissions(["users.view"])).toEqual(["users.view"]);
  });
  it("never produces an edit-without-view set", () => {
    const result = applyImpliedPermissions(["users.edit", "users.delete"]);
    expect(result).toContain("users.view");
  });
  it("leaves '*' untouched", () => {
    expect(applyImpliedPermissions(["*"])).toEqual(["*"]);
  });
});

describe("LEGACY_PERMISSION_EXPANSION (migration map)", () => {
  it("expands users.manage to all per-action user keys", () => {
    expect(LEGACY_PERMISSION_EXPANSION["users.manage"]).toEqual([
      "users.view",
      "users.create",
      "users.edit",
      "users.delete",
    ]);
  });
  it("every expanded key is a real catalog key", () => {
    for (const keys of Object.values(LEGACY_PERMISSION_EXPANSION)) {
      for (const key of keys) expect(PERMISSION_KEYS).toContain(key);
    }
  });
});
