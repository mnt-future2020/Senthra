import { describe, expect, it } from "vitest";

import { canAssignRole } from "./roleAssignable";

// `holds` stands in for useAuth's `can`: true for "*" holders on every key, otherwise membership.
const actor = (permissions: string[]) => (p: string) =>
  permissions.includes("*") || permissions.includes(p);

const SUPER_ADMIN = ["*"];
const SYSTEM_ADMIN = ["users.view", "users.create", "users.edit", "roles.view"];

describe("canAssignRole", () => {
  it("lets a full-access actor assign a full-access role", () => {
    // The super-admin creating a backup super-admin — the case that must keep working.
    expect(canAssignRole(["*"], actor(SUPER_ADMIN))).toBe(true);
  });

  it("lets a full-access actor assign any ordinary role", () => {
    expect(canAssignRole(SYSTEM_ADMIN, actor(SUPER_ADMIN))).toBe(true);
    expect(canAssignRole([], actor(SUPER_ADMIN))).toBe(true);
  });

  it("stops a delegate from minting another super-user", () => {
    expect(canAssignRole(["*"], actor(SYSTEM_ADMIN))).toBe(false);
  });

  it("stops a delegate granting a permission it does not hold", () => {
    // System Admin has no jobs.create, so it can't hand out a role that grants it.
    expect(canAssignRole(["users.view", "jobs.create"], actor(SYSTEM_ADMIN))).toBe(false);
  });

  it("lets a delegate assign a role that is a subset of what it holds", () => {
    expect(canAssignRole(["users.view", "roles.view"], actor(SYSTEM_ADMIN))).toBe(true);
  });

  it("treats an exact match as assignable", () => {
    expect(canAssignRole(SYSTEM_ADMIN, actor(SYSTEM_ADMIN))).toBe(true);
  });

  it("lets anyone assign a role that grants nothing", () => {
    // Project Coordinator ships with an empty permission list.
    expect(canAssignRole([], actor(SYSTEM_ADMIN))).toBe(true);
    expect(canAssignRole([], actor([]))).toBe(true);
  });

  it("gives a permissionless actor nothing but the empty role", () => {
    expect(canAssignRole(["users.view"], actor([]))).toBe(false);
    expect(canAssignRole(["*"], actor([]))).toBe(false);
  });
});
