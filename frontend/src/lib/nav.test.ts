import { describe, expect, it } from "vitest";

import { isAdminNavItemVisible, sidebarSurfaceLabel } from "./nav";
import type { AdminPrincipal, CustomerPrincipal, UserPrincipal } from "@/types/auth";

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

describe("sidebarSurfaceLabel", () => {
  const admin: AdminPrincipal = { type: "admin", id: "a1", email: "admin@x.test", name: "Owner" };
  const staff = (roleName: string | null): UserPrincipal => ({
    type: "user",
    id: "u1",
    email: "u@x.test",
    firstName: "Gokul",
    lastName: "Test",
    profileImageUrl: null,
    signatureUrl: null,
    status: "active",
    mustResetPassword: false,
    role: roleName === null ? null : { id: "r1", key: "role", name: roleName },
    permissions: [],
  });
  const customer: CustomerPrincipal = {
    type: "customer",
    id: "c1",
    customerId: "cu1",
    email: "pm@client.test",
    name: "Client Ltd",
    userName: "Client PM",
    customerCode: "CUS-0001",
    logoUrl: null,
    mustResetPassword: false,
    permissions: [],
  };

  // The client's report: Finance Director and Project Manager logins both read "Admin Suite".
  it("shows a staff user's own role instead of claiming the admin suite", () => {
    expect(sidebarSurfaceLabel(staff("Finance Director"), false)).toBe("Finance Director");
    expect(sidebarSurfaceLabel(staff("Project Manager"), false)).toBe("Project Manager");
  });

  it("keeps 'Admin Suite' for the super-admin account, which it is true of", () => {
    expect(sidebarSurfaceLabel(admin, false)).toBe("Admin Suite");
  });

  it("keeps the portal labels for customers and engineer-only staff", () => {
    expect(sidebarSurfaceLabel(customer, false)).toBe("Customer Portal");
    expect(sidebarSurfaceLabel(staff("Field Engineer"), true)).toBe("Engineer Portal");
  });

  it("never falls back to 'Admin Suite' for a staff user without a usable role name", () => {
    expect(sidebarSurfaceLabel(staff(null), false)).toBe("Staff Portal");
    expect(sidebarSurfaceLabel(staff("   "), false)).toBe("Staff Portal");
  });

  it("renders nothing before the session is known", () => {
    expect(sidebarSurfaceLabel(null, false)).toBe("");
  });
});
