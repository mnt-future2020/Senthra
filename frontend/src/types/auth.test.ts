import { describe, expect, it } from "vitest";

import {
  canAccessDashboard,
  firstDashboardPath,
  homeFor,
  principalCan,
  type AdminPrincipal,
  type UserPrincipal,
} from "./auth";

const admin: AdminPrincipal = { type: "admin", id: "a", email: "a@x.com", name: "Admin" };

const makeUser = (permissions: string[]): UserPrincipal => ({
  type: "user",
  id: "u",
  email: "u@x.com",
  firstName: "U",
  lastName: "Ser",
  profileImageUrl: null,
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
