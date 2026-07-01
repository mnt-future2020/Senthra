import { describe, expect, it } from "vitest";

import { canAccessDashboard, firstDashboardPath, homeFor, principalCan } from "./auth";
import type { AdminPrincipal, UserPrincipal } from "@/types/auth";

const admin: AdminPrincipal = { type: "admin", id: "a", email: "a@x.com", name: "Admin" };

const makeUser = (permissions: string[]): UserPrincipal => ({
  type: "user",
  id: "u",
  email: "u@x.com",
  firstName: "U",
  lastName: "Ser",
  profileImageUrl: null,
  signatureUrl: null,
  status: "active",
  mustResetPassword: false,
  role: null,
  permissions,
});

describe("principalCan", () => {
  it("the super-admin account holds everything", () => {
    expect(principalCan(admin, "anything.at.all")).toBe(true);
  });
  it("a user with the permission passes", () => {
    expect(principalCan(makeUser(["users.view"]), "users.view")).toBe(true);
  });
  it("a user without it is denied", () => {
    expect(principalCan(makeUser(["users.view"]), "settings.manage")).toBe(false);
  });
  it("a user holding '*' passes anything", () => {
    expect(principalCan(makeUser(["*"]), "settings.manage")).toBe(true);
  });
  it("a null principal is denied", () => {
    expect(principalCan(null, "users.view")).toBe(false);
  });
});

describe("firstDashboardPath", () => {
  it("the admin lands on the first section (Settings)", () => {
    expect(firstDashboardPath(admin)).toBe("/dashboard/settings");
  });
  it("a users-only user lands on Users & Roles", () => {
    expect(firstDashboardPath(makeUser(["users.view"]))).toBe("/dashboard/users");
  });
  it("a settings-only user lands on Settings", () => {
    expect(firstDashboardPath(makeUser(["settings.view"]))).toBe("/dashboard/settings");
  });
  it("a categories-only user lands on Settings (Categories is a Settings section)", () => {
    expect(firstDashboardPath(makeUser(["categories.view"]))).toBe("/dashboard/settings");
  });
  it("a jobs-only user lands on Jobs (e.g. the Project Manager role)", () => {
    expect(firstDashboardPath(makeUser(["jobs.view"]))).toBe("/dashboard/jobs");
  });
  it("an engineer-only user lands on the engineer portal", () => {
    expect(firstDashboardPath(makeUser(["engineer.dashboard.view"]))).toBe("/dashboard/engineer");
  });
  it("an audit-only user lands on the Audit log", () => {
    expect(firstDashboardPath(makeUser(["audit.view"]))).toBe("/dashboard/audit");
  });
  it("lands on the higher-priority section when a user holds several", () => {
    // Engineer is intentionally ranked below real modules; audit below the engineer portal.
    expect(firstDashboardPath(makeUser(["engineer.dashboard.view", "jobs.view"]))).toBe(
      "/dashboard/jobs",
    );
    expect(firstDashboardPath(makeUser(["audit.view", "engineer.dashboard.view"]))).toBe(
      "/dashboard/engineer",
    );
  });
  it("a no-permission user has no section", () => {
    expect(firstDashboardPath(makeUser([]))).toBeNull();
  });
});

describe("canAccessDashboard", () => {
  it("is true when at least one section is reachable", () => {
    expect(canAccessDashboard(makeUser(["roles.view"]))).toBe(true);
  });
  it("is false with no permissions", () => {
    expect(canAccessDashboard(makeUser([]))).toBe(false);
  });
});

describe("homeFor", () => {
  it("sends everyone into the unified shell", () => {
    expect(homeFor(admin)).toBe("/dashboard");
    expect(homeFor(makeUser([]))).toBe("/dashboard");
  });
});
