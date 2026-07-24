import { describe, expect, it } from "vitest";

import type { PermissionGroup } from "@/types/role";
import { applyImplied } from "./permissionImplications";

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
