import { describe, expect, it } from "vitest";

import { isAdminNavItemVisible } from "./nav";

// A permissive `can` for the tests: the principal holds exactly the listed perms.
const holding = (...perms: string[]) => (p: string) => perms.includes(p);
const holdsNothing = () => false;

describe("isAdminNavItemVisible", () => {
  it("always shows a permless item (e.g. the Dashboard landing)", () => {
    expect(isAdminNavItemVisible({ perms: [] }, holdsNothing, false)).toBe(true);
    expect(isAdminNavItemVisible({ perms: [] }, holdsNothing, true)).toBe(true);
  });

  it("shows a gated item when the principal holds ANY of its perms", () => {
    expect(isAdminNavItemVisible({ perms: ["users.view", "roles.view"] }, holding("roles.view"), false)).toBe(true);
  });

  it("hides a gated item when the principal holds none of its perms", () => {
    expect(isAdminNavItemVisible({ perms: ["users.view"] }, holdsNothing, false)).toBe(false);
  });

  // The Audit Log page: a warehouse-scoped role gets audit.view (for the warehouse detail's
  // Audit trail tab), but the GLOBAL Audit Log page is not their surface — hide the nav item.
  it("hides a hideForWarehouseScoped item from a warehouse-scoped user even if they hold the perm", () => {
    const auditLog = { perms: ["audit.view"], hideForWarehouseScoped: true };
    expect(isAdminNavItemVisible(auditLog, holding("audit.view"), true)).toBe(false);
  });

  it("still shows that same item to a NON-warehouse-scoped user who holds the perm", () => {
    const auditLog = { perms: ["audit.view"], hideForWarehouseScoped: true };
    expect(isAdminNavItemVisible(auditLog, holding("audit.view"), false)).toBe(true);
  });

  it("hides a hideForWarehouseScoped item from a warehouse-scoped user who lacks the perm too", () => {
    const auditLog = { perms: ["audit.view"], hideForWarehouseScoped: true };
    expect(isAdminNavItemVisible(auditLog, holdsNothing, true)).toBe(false);
  });
});
