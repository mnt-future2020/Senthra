import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  CUSTOMER_COMPAT_BACKFILL,
  LEGACY_PERMISSION_EXPANSION,
  PERMISSION_CATEGORIES,
  PERMISSION_GROUPS,
  PERMISSION_CAPABILITY,
  PERMISSION_KEYS,
  PERMISSION_PREREQUISITES,
  WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS,
  applyImpliedPermissions,
  baseKeyOf,
  closePrerequisites,
  splitByCapability,
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

describe("permission dependencies — catalog integrity", () => {
  // THE INVARIANT THAT WAS MISSING. Every multi-action group must declare a base-access key,
  // either implicitly (an action labelled "View") or explicitly (`baseKey`). Without one the
  // group opts out of the implied closure entirely and roles can be saved holding an action with
  // nothing to reach it from — exactly what happened to the Engineer Portal group.
  it("every multi-action group resolves a base-access key", () => {
    for (const group of PERMISSION_GROUPS) {
      if (group.permissions.length < 2) continue; // single-action group has nothing to depend on
      expect(baseKeyOf(group), `group "${group.key}" has no base-access key`).toBeTruthy();
    }
  });

  it("every resolved base key belongs to its own group", () => {
    for (const group of PERMISSION_GROUPS) {
      const base = baseKeyOf(group);
      if (!base) continue;
      expect(
        group.permissions.map((p) => p.key),
        `base key "${base}" is not a permission of group "${group.key}"`,
      ).toContain(base);
    }
  });

  it("every declared `requires` names a real catalog key", () => {
    for (const group of PERMISSION_GROUPS) {
      for (const permission of group.permissions) {
        for (const required of permission.requires ?? []) {
          expect(PERMISSION_KEYS, `dangling requires on ${permission.key}`).toContain(required);
        }
      }
    }
  });

  it("no permission depends on itself", () => {
    for (const [key, deps] of PERMISSION_PREREQUISITES) expect(deps).not.toContain(key);
  });

  it("the dependency graph is acyclic (closure terminates for every key)", () => {
    for (const key of PERMISSION_KEYS) {
      const closed = closePrerequisites([key]);
      // A cycle would mean a key reachable from its own prerequisites.
      for (const dep of PERMISSION_PREREQUISITES.get(key) ?? []) {
        expect(closePrerequisites([dep]), `cycle through ${key}`).not.toContain(key);
      }
      expect(closed).toContain(key);
    }
  });

  it("closePrerequisites is idempotent", () => {
    const once = closePrerequisites(["engineer.jobs.accept", "users.delete"]);
    expect([...closePrerequisites(once)].sort()).toEqual([...once].sort());
  });
});

describe("applyImpliedPermissions — Engineer Portal (base is 'Dashboard', not 'View')", () => {
  // The regression this whole model exists for: the group has no action named "View", so the old
  // `action === "View"` lookup skipped it and every engineer grant stayed orphaned.
  it("a per-job action pulls in the job list AND the portal base", () => {
    const result = applyImpliedPermissions(["engineer.jobs.accept"]);
    expect(result).toContain("engineer.jobs.view"); // explicit `requires`
    expect(result).toContain("engineer.dashboard.view"); // transitively, via the group base
  });

  it("a non-job portal action pulls in the portal base", () => {
    expect(applyImpliedPermissions(["engineer.van_stock.request"])).toContain(
      "engineer.dashboard.view",
    );
    expect(applyImpliedPermissions(["engineer.transfer"])).toContain("engineer.dashboard.view");
    expect(applyImpliedPermissions(["engineer.inventory.view"])).toContain(
      "engineer.dashboard.view",
    );
  });

  it("reproduces the reported bad save as a coherent set", () => {
    // Saved on the "helpdesk" role via the editor: Accept job + Start job + Settings, with no
    // Dashboard and no Jobs — the role could reach nothing. The closure now repairs it on write.
    const result = applyImpliedPermissions([
      "engineer.jobs.accept",
      "engineer.jobs.start",
      "engineer.settings.edit",
    ]);
    expect(result).toContain("engineer.dashboard.view");
    expect(result).toContain("engineer.jobs.view");
  });

  it("leaves a base-only grant unchanged", () => {
    expect(applyImpliedPermissions(["engineer.dashboard.view"])).toEqual([
      "engineer.dashboard.view",
    ]);
  });

  it("does not leak engineer keys into an unrelated grant", () => {
    const result = applyImpliedPermissions(["users.create"]);
    expect(result.some((k) => k.startsWith("engineer."))).toBe(false);
  });

  it("keeps the admin-side Engineer Stock Transfers group independent of the portal", () => {
    // engineer_stock is a different group (Inventory category) with its own "View" — granting it
    // must NOT drag in the engineer portal.
    const result = applyImpliedPermissions(["engineer_stock.transfer"]);
    expect(result).toContain("engineer_stock.view");
    expect(result).not.toContain("engineer.dashboard.view");
  });
});

describe("role capabilities — the Engineer Portal is field-roles-only", () => {
  const FIELD = { field_ops: true };
  const NOT_FIELD = { field_ops: false };

  it("tags every Engineer Portal key with the field_ops capability", () => {
    const engineer = PERMISSION_GROUPS.find((g) => g.key === "engineer")!;
    for (const permission of engineer.permissions) {
      expect(PERMISSION_CAPABILITY.get(permission.key)).toBe("field_ops");
    }
  });

  it("leaves the admin-side Engineer Stock Transfers group ungated", () => {
    // engineer_stock is office oversight of transfers — a warehouse/ops role holds it, so it must
    // NOT require the field capability.
    expect(PERMISSION_CAPABILITY.get("engineer_stock.view")).toBeUndefined();
    expect(PERMISSION_CAPABILITY.get("engineer_stock.transfer")).toBeUndefined();
  });

  it("every capability-tagged key belongs to a real catalog key", () => {
    for (const key of PERMISSION_CAPABILITY.keys()) expect(PERMISSION_KEYS).toContain(key);
  });

  it("keeps Engineer Portal keys for a field role", () => {
    const { kept, removed } = splitByCapability(
      ["engineer.dashboard.view", "engineer.jobs.view", "users.view"],
      FIELD,
    );
    expect(removed).toEqual([]);
    expect(kept).toContain("engineer.dashboard.view");
  });

  it("strips Engineer Portal keys from a NON-field role, keeping everything else", () => {
    // The reported case: helpdesk holding engineer keys it can never use.
    const { kept, removed } = splitByCapability(
      ["users.view", "engineer.dashboard.view", "engineer.jobs.accept", "audit.view"],
      NOT_FIELD,
    );
    expect(kept).toEqual(["users.view", "audit.view"]);
    expect(removed).toEqual(["engineer.dashboard.view", "engineer.jobs.accept"]);
  });

  it("never ADDS a permission — output is always a subset of the input", () => {
    // The safety property the seed repair depends on: stripping can only reduce privilege.
    const input = ["users.view", "engineer.transfer", "customers.view"];
    for (const caps of [FIELD, NOT_FIELD]) {
      const { kept } = splitByCapability(input, caps);
      for (const key of kept) expect(input).toContain(key);
    }
  });

  it("leaves the '*' super-admin wildcard untouched", () => {
    const { kept, removed } = splitByCapability(["*"], NOT_FIELD);
    expect(kept).toEqual(["*"]);
    expect(removed).toEqual([]);
  });

  it("is idempotent", () => {
    const once = splitByCapability(["users.view", "engineer.jobs.accept"], NOT_FIELD).kept;
    expect(splitByCapability(once, NOT_FIELD).kept).toEqual(once);
  });

  it("does not touch a role with no capability-gated keys at all", () => {
    const input = ["users.view", "users.create", "settings.manage"];
    expect(splitByCapability(input, NOT_FIELD)).toEqual({ kept: input, removed: [] });
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

describe("applyImpliedPermissions — warehouse-scoped roles: only stock_requests skips customers.view", () => {
  it("does NOT auto-add customers.view for a warehouse-scoped role holding ONLY stock_requests.*", () => {
    // stock_requests is the warehouse receive flow — it works without the global customer
    // directory, so a warehouse manager holding only it is not forced customers.view. The crux.
    const result = applyImpliedPermissions(["stock_requests.complete"], true);
    expect(result).not.toContain("customers.view");
  });

  it("still applies the intra-group view implication for a warehouse-scoped role", () => {
    // Only the customer CROSS-group implication is affected; "manage implies its own view" stays.
    expect(applyImpliedPermissions(["stock_requests.complete"], true)).toContain("stock_requests.view");
  });

  it("PRESERVES an explicitly-granted customers.view for a warehouse-scoped role", () => {
    // The skip only removes the SILENT add — a deliberate grant must survive.
    const result = applyImpliedPermissions(["stock_requests.complete", "customers.view"], true);
    expect(result).toContain("customers.view");
  });

  it("still auto-adds customers.view for a NON-warehouse-scoped role (unchanged default)", () => {
    expect(applyImpliedPermissions(["stock_requests.complete"], false)).toContain("customers.view");
  });

  it("defaults to non-scoped when the flag is omitted (existing callers unaffected)", () => {
    expect(applyImpliedPermissions(["stock_requests.complete"])).toContain("customers.view");
  });

  // The refinement: a customer-PAGE child group (projects/sites/portal/customer_stock) is NOT
  // exempt even for a scoped role, because it is unusable without customers.view — forcing the
  // view keeps the grant coherent instead of leaving a dead permission.
  it("STILL adds customers.view for a customer-page group on a warehouse-scoped role", () => {
    expect(applyImpliedPermissions(["customer_projects.view"], true)).toContain("customers.view");
    expect(applyImpliedPermissions(["customer_sites.view"], true)).toContain("customers.view");
    expect(applyImpliedPermissions(["customer_portal.view"], true)).toContain("customers.view");
    expect(applyImpliedPermissions(["customer_stock.edit"], true)).toContain("customers.view");
  });

  it("adds customers.view when a scoped role mixes stock_requests with a customer-page group", () => {
    // stock_requests alone would be exempt, but the non-exempt customer_projects pulls the view in.
    const result = applyImpliedPermissions(["stock_requests.complete", "customer_projects.view"], true);
    expect(result).toContain("customers.view");
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

describe("WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS (warehouse-side consignment intake)", () => {
  it("is exactly the two warehouse-side receive keys", () => {
    // The full warehouse-side flow — see the Incoming stock → Customer pool and the Inventory
    // → Customer pool, receive an assignment, then fill the entry, read the category master and
    // print its barcode — needs only these two. Pin them so the set can't silently grow.
    expect([...WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS].sort()).toEqual([
      "stock_requests.complete",
      "stock_requests.view",
    ]);
  });

  it("names only real catalogue keys", () => {
    for (const key of WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it("excludes the office review-queue keys (approve/reject stay a reviewer's job)", () => {
    expect(WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS).not.toContain("stock_requests.approve");
    expect(WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS).not.toContain("stock_requests.reject");
  });

  it("excludes the broad customer_stock.* keys (entry routes accept stock_requests.* instead)", () => {
    for (const key of WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS) {
      expect(key.startsWith("customer_stock.")).toBe(false);
    }
  });

  it("admits the category master read guard (so the receive form's picker fills)", () => {
    // Mirror of CATEGORY_LIST_READERS in category.routes.ts: the receive form's category picker
    // must load for anyone holding these keys, or the required Category field is unpickable.
    expect(WAREHOUSE_CUSTOMER_STOCK_PERMISSIONS).toContain("stock_requests.complete");
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
