import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  CUSTOMER_COMPAT_BACKFILL,
  LEGACY_PERMISSION_EXPANSION,
  PERMISSION_CATEGORIES,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  applyImpliedPermissions,
  customerCompatAdditions,
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

describe("customer RBAC split — catalog", () => {
  const childGroups = [
    "customer_projects",
    "customer_stock",
    "customer_sites",
    "customer_portal",
    "stock_requests",
  ];
  it("exposes the five new customer sub-entity groups", () => {
    for (const key of childGroups) {
      expect(PERMISSION_GROUPS.some((g) => g.key === key)).toBe(true);
    }
  });
  it("every new group has a 'View' action (so implied-view works)", () => {
    for (const key of childGroups) {
      const group = PERMISSION_GROUPS.find((g) => g.key === key)!;
      expect(group.permissions.some((p) => p.action === "View")).toBe(true);
    }
  });
  it("keeps the original coarse customers.* keys", () => {
    for (const key of ["customers.view", "customers.create", "customers.edit", "customers.delete"]) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });
  it("includes the forward-looking stock_requests.complete key", () => {
    expect(PERMISSION_KEYS).toContain("stock_requests.complete");
  });
});

describe("catalog category metadata (role-editor matrix)", () => {
  it("every group declares a non-empty category", () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.category, `group ${group.key} missing category`).toBeTruthy();
    }
  });
  it("every group's category is a known ordered category", () => {
    for (const group of PERMISSION_GROUPS) {
      expect(PERMISSION_CATEGORIES, `unknown category for ${group.key}`).toContain(group.category);
    }
  });
  it("the five customer sub-entities nest under the customers group", () => {
    const children = [
      "customer_projects",
      "customer_stock",
      "customer_sites",
      "customer_portal",
      "stock_requests",
    ];
    for (const key of children) {
      const group = PERMISSION_GROUPS.find((g) => g.key === key)!;
      expect(group.parent).toBe("customers");
    }
  });
  it("every parent reference points to a real group key", () => {
    const keys = new Set(PERMISSION_GROUPS.map((g) => g.key));
    for (const group of PERMISSION_GROUPS) {
      if (group.parent) expect(keys, `dangling parent on ${group.key}`).toContain(group.parent);
    }
  });
});

describe("applyImpliedPermissions — customer cross-group implication", () => {
  it("a child sub-entity grant implies customers.view", () => {
    expect(applyImpliedPermissions(["customer_projects.view"])).toContain("customers.view");
  });
  it("managing the portal login implies its own view AND customers.view", () => {
    const result = applyImpliedPermissions(["customer_portal.manage"]);
    expect(result).toContain("customer_portal.view");
    expect(result).toContain("customers.view");
  });
  it("a stock-request action implies its view and customers.view", () => {
    const result = applyImpliedPermissions(["stock_requests.approve"]);
    expect(result).toContain("stock_requests.view");
    expect(result).toContain("customers.view");
  });
  it("does not add customers.view for an unrelated grant", () => {
    expect(applyImpliedPermissions(["warehouse.view"])).not.toContain("customers.view");
  });
});

describe("customerCompatAdditions (additive backward-compat)", () => {
  it("backfills child views for a customers.view holder", () => {
    const additions = customerCompatAdditions(["customers.view"]);
    expect(additions).toEqual(expect.arrayContaining(CUSTOMER_COMPAT_BACKFILL["customers.view"]));
  });
  it("backfills child write keys for a customers.edit holder", () => {
    const additions = customerCompatAdditions(["customers.view", "customers.edit"]);
    expect(additions).toContain("customer_projects.delete");
    expect(additions).toContain("customer_portal.reset_password");
    expect(additions).toContain("stock_requests.approve");
  });
  it("is idempotent — returns nothing once the child keys are present", () => {
    const full = [
      "customers.view",
      "customers.edit",
      ...CUSTOMER_COMPAT_BACKFILL["customers.edit"],
    ];
    expect(customerCompatAdditions(full)).toEqual([]);
  });
  it("leaves a '*' role untouched (it already grants everything)", () => {
    expect(customerCompatAdditions(["*"])).toEqual([]);
  });
  it("adds nothing for a role without any customers.* grant", () => {
    expect(customerCompatAdditions(["warehouse.view"])).toEqual([]);
  });
  it("every backfilled key is a real catalog key", () => {
    for (const keys of Object.values(CUSTOMER_COMPAT_BACKFILL)) {
      for (const key of keys) expect(PERMISSION_KEYS).toContain(key);
    }
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
