import { describe, expect, it } from "vitest";

import type { PermissionGroup } from "@/types/role";
import {
  applyImplied,
  baseKeyOf,
  grantWithPrerequisites,
  grantableGroups,
  revokeWithDependents,
  stripUngrantable,
} from "./permissionImplications";

// Minimal catalogue mirroring the shape the role editor loads: a customer-child group
// (stock_requests) with a non-view action, plus the parent customers group.
const GROUPS: PermissionGroup[] = [
  {
    key: "stock_requests",
    label: "Customer Stock Submissions",
    description: "",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "stock_requests.view", action: "View", description: "" },
      { key: "stock_requests.complete", action: "Complete", description: "" },
    ],
  },
  {
    key: "customer_projects",
    label: "Customer Projects",
    description: "",
    category: "Customers",
    parent: "customers",
    permissions: [
      { key: "customer_projects.view", action: "View", description: "" },
      { key: "customer_projects.edit", action: "Edit", description: "" },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    description: "",
    category: "Customers",
    permissions: [
      { key: "customers.view", action: "View", description: "" },
      { key: "customers.edit", action: "Edit", description: "" },
    ],
  },
];

// The Engineer Portal shape: no action labelled "View" (its base is "Dashboard"), plus a
// mid-level dependency — every per-job action needs the job LIST, which needs the portal.
// Mirrors the real catalog entry in backend permissions.ts.
const ENGINEER: PermissionGroup = {
  key: "engineer",
  label: "Engineer Portal",
  description: "",
  category: "Engineer Portal",
  baseKey: "engineer.dashboard.view",
  permissions: [
    { key: "engineer.dashboard.view", action: "Dashboard", description: "" },
    { key: "engineer.jobs.view", action: "Jobs", description: "" },
    {
      key: "engineer.jobs.accept",
      action: "Accept job",
      description: "",
      requires: ["engineer.jobs.view"],
    },
    {
      key: "engineer.jobs.start",
      action: "Start job",
      description: "",
      requires: ["engineer.jobs.view"],
    },
    { key: "engineer.settings.edit", action: "Settings", description: "" },
  ],
};

const WITH_ENGINEER = [...GROUPS, ENGINEER];

describe("baseKeyOf", () => {
  it("uses the action labelled 'View' when no baseKey is declared", () => {
    expect(baseKeyOf(GROUPS[2])).toBe("customers.view");
  });

  it("prefers an explicit baseKey (group whose entry point isn't called 'View')", () => {
    expect(baseKeyOf(ENGINEER)).toBe("engineer.dashboard.view");
  });

  it("returns undefined for a group with neither", () => {
    const orphan: PermissionGroup = {
      key: "x",
      label: "",
      description: "",
      category: "System",
      permissions: [{ key: "x.do", action: "Do", description: "" }],
    };
    expect(baseKeyOf(orphan)).toBeUndefined();
  });
});

describe("applyImplied — dependency closure for a non-'View' base (the Engineer Portal bug)", () => {
  it("a per-job action pulls in the job list AND the portal base, transitively", () => {
    const result = applyImplied(["engineer.jobs.accept"], WITH_ENGINEER);
    expect(result).toContain("engineer.jobs.view");
    expect(result).toContain("engineer.dashboard.view");
  });

  it("a non-job portal action pulls in the portal base", () => {
    expect(applyImplied(["engineer.settings.edit"], WITH_ENGINEER)).toContain(
      "engineer.dashboard.view",
    );
  });

  it("repairs the exact set that was saved on the helpdesk role", () => {
    const result = applyImplied(
      ["engineer.jobs.accept", "engineer.jobs.start", "engineer.settings.edit"],
      WITH_ENGINEER,
    );
    expect(result).toContain("engineer.dashboard.view");
    expect(result).toContain("engineer.jobs.view");
  });

  it("leaves a base-only grant unchanged", () => {
    expect(applyImplied(["engineer.dashboard.view"], WITH_ENGINEER)).toEqual([
      "engineer.dashboard.view",
    ]);
  });

  it("is idempotent", () => {
    const once = applyImplied(["engineer.jobs.accept"], WITH_ENGINEER);
    expect([...applyImplied(once, WITH_ENGINEER)].sort()).toEqual([...once].sort());
  });

  it("does not drag engineer keys into an unrelated grant", () => {
    const result = applyImplied(["customers.edit"], WITH_ENGINEER);
    expect(result.some((k) => k.startsWith("engineer."))).toBe(false);
  });
});

describe("role capabilities (Engineer Portal is offered only to a field role)", () => {
  // Same tag the backend catalog carries; the editor receives it with the catalog.
  const GATED: PermissionGroup = { ...ENGINEER, capability: "field_ops" };
  const CATALOG = [...GROUPS, GATED];
  const FIELD = { field_ops: true };
  const NOT_FIELD = { field_ops: false };

  it("offers the gated group to a field role", () => {
    expect(grantableGroups(CATALOG, FIELD).map((g) => g.key)).toContain("engineer");
  });

  it("hides the gated group from a non-field role", () => {
    expect(grantableGroups(CATALOG, NOT_FIELD).map((g) => g.key)).not.toContain("engineer");
  });

  it("never hides an untagged group", () => {
    expect(grantableGroups(CATALOG, NOT_FIELD).map((g) => g.key)).toEqual([
      "stock_requests",
      "customer_projects",
      "customers",
    ]);
  });

  it("strips gated keys for a non-field role, keeping the rest", () => {
    const result = stripUngrantable(
      ["customers.view", "engineer.dashboard.view", "engineer.jobs.accept"],
      CATALOG,
      NOT_FIELD,
    );
    expect(result).toEqual(["customers.view"]);
  });

  it("keeps gated keys for a field role", () => {
    const perms = ["customers.view", "engineer.dashboard.view"];
    expect(stripUngrantable(perms, CATALOG, FIELD)).toEqual(perms);
  });

  it("only ever removes — the result is a subset of the input", () => {
    const input = ["customers.view", "engineer.transfer"];
    for (const caps of [FIELD, NOT_FIELD]) {
      for (const key of stripUngrantable(input, CATALOG, caps)) expect(input).toContain(key);
    }
  });

  it("is a no-op when the catalog has no gated group", () => {
    const perms = ["customers.view", "customers.edit"];
    expect(stripUngrantable(perms, GROUPS, NOT_FIELD)).toBe(perms);
  });

  it("leaves a set containing the '*' wildcard completely alone", () => {
    // Mirrors the backend short-circuit. Without it a MIXED set diverged: the client would add
    // prerequisites the server wouldn't, and strip a gated key the server would keep — a privilege
    // reduction the server never makes.
    const wildcard = ["*", "engineer.jobs.accept", "customers.edit"];
    expect(applyImplied(wildcard, CATALOG)).toEqual(wildcard);
    expect(stripUngrantable(wildcard, CATALOG, NOT_FIELD)).toEqual(wildcard);
  });

  it("toggling the capability off and back on is LOSSLESS", () => {
    // The role editor derives what-would-be-saved from the selection instead of deleting from it,
    // so flipping "Field role" off and on again must return the identical set. The earlier version
    // deleted the keys and tried to remember them in a ref — it lost them.
    const selection = applyImplied(["engineer.jobs.accept"], CATALOG);
    expect(stripUngrantable(selection, CATALOG, NOT_FIELD)).toEqual([]);
    expect(stripUngrantable(selection, CATALOG, FIELD)).toEqual(selection);
  });

  it("matches the backend order of operations: close first, then strip", () => {
    // Ticking Accept job on a role that then loses the capability must leave NOTHING behind —
    // not the prerequisites the closure pulled in either.
    const closed = applyImplied(["engineer.jobs.accept"], CATALOG);
    expect(closed.length).toBeGreaterThan(1);
    expect(stripUngrantable(closed, CATALOG, NOT_FIELD)).toEqual([]);
  });
});

describe("grantWithPrerequisites (ticking a chip on)", () => {
  it("adds the key plus its transitive prerequisites", () => {
    const result = grantWithPrerequisites([], WITH_ENGINEER, ["engineer.jobs.accept"]);
    expect([...result].sort()).toEqual([
      "engineer.dashboard.view",
      "engineer.jobs.accept",
      "engineer.jobs.view",
    ]);
  });

  it("preserves permissions already granted elsewhere", () => {
    const result = grantWithPrerequisites(["users.view"], WITH_ENGINEER, ["engineer.jobs.accept"]);
    expect(result).toContain("users.view");
  });
});

describe("revokeWithDependents (ticking a chip off)", () => {
  const FULL = applyImplied(
    ["engineer.jobs.accept", "engineer.jobs.start", "engineer.settings.edit"],
    WITH_ENGINEER,
  );

  it("un-ticking the base access clears the whole module", () => {
    const result = revokeWithDependents(FULL, WITH_ENGINEER, ["engineer.dashboard.view"]);
    expect(result.filter((k) => k.startsWith("engineer."))).toEqual([]);
  });

  it("un-ticking a mid-level prerequisite clears only what needed it", () => {
    // Dropping the job list must take accept + start, but leave the portal and settings alone.
    const result = revokeWithDependents(FULL, WITH_ENGINEER, ["engineer.jobs.view"]);
    expect(result).not.toContain("engineer.jobs.accept");
    expect(result).not.toContain("engineer.jobs.start");
    expect(result).toContain("engineer.dashboard.view");
    expect(result).toContain("engineer.settings.edit");
  });

  it("un-ticking a leaf removes only that leaf", () => {
    const result = revokeWithDependents(FULL, WITH_ENGINEER, ["engineer.jobs.accept"]);
    expect(result).not.toContain("engineer.jobs.accept");
    expect(result).toContain("engineer.jobs.start");
    expect(result).toContain("engineer.jobs.view");
  });

  it("never leaves an orphan the closure would silently re-add", () => {
    // The round-trip property: revoking then re-closing must not resurrect the revoked key.
    const revoked = revokeWithDependents(FULL, WITH_ENGINEER, ["engineer.jobs.view"]);
    expect(applyImplied(revoked, WITH_ENGINEER)).not.toContain("engineer.jobs.view");
  });

  it("leaves other modules untouched", () => {
    const result = revokeWithDependents([...FULL, "users.view"], WITH_ENGINEER, [
      "engineer.dashboard.view",
    ]);
    expect(result).toContain("users.view");
  });
});

describe("applyImplied (role-editor matrix, mirrors backend applyImpliedPermissions)", () => {
  it("adds the intra-group view for a non-view action", () => {
    expect(applyImplied(["stock_requests.complete"], GROUPS, false)).toContain("stock_requests.view");
  });

  it("adds customers.view for a customer-child grant on a NON-scoped role", () => {
    expect(applyImplied(["stock_requests.complete"], GROUPS, false)).toContain("customers.view");
  });

  it("does NOT add customers.view for a warehouse-scoped role holding ONLY stock_requests.*", () => {
    const result = applyImplied(["stock_requests.complete"], GROUPS, true);
    expect(result).not.toContain("customers.view");
    // ...but the intra-group view still applies.
    expect(result).toContain("stock_requests.view");
  });

  it("STILL adds customers.view for a customer-PAGE group on a warehouse-scoped role", () => {
    // customer_projects is not a warehouse-side group, so it stays coupled to customers.view even
    // for a scoped role — otherwise it'd be a dead permission (unreachable without the customer page).
    expect(applyImplied(["customer_projects.view"], GROUPS, true)).toContain("customers.view");
  });

  it("adds customers.view when a scoped role mixes stock_requests with a customer-page group", () => {
    const result = applyImplied(["stock_requests.complete", "customer_projects.view"], GROUPS, true);
    expect(result).toContain("customers.view");
  });

  it("PRESERVES an explicitly-ticked customers.view even for a warehouse-scoped role", () => {
    const result = applyImplied(["stock_requests.complete", "customers.view"], GROUPS, true);
    expect(result).toContain("customers.view");
  });

  it("defaults to non-scoped behaviour when the flag is omitted", () => {
    expect(applyImplied(["stock_requests.complete"], GROUPS)).toContain("customers.view");
  });
});
