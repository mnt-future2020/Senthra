import { describe, expect, it } from "vitest";

import type { Principal } from "@/types/auth";
import { canPickCustomers, canSearchSites, isWarehouseScoped } from "./pickerAccess";

// The client mirror of the backend picker guards (backend permissions.ts — CUSTOMER_OPTION_READERS,
// JOB_SITE_SEARCH_READERS, CUSTOMER_OPTION_UNSCOPED_READERS). The backend's permission-alignment test
// pins the real seeded bundles against the server rule; these pin that the UI hides exactly what the
// server would refuse — no more (an empty filter) and no less (a toast).

const can = (perms: string[]) => (p: string) => perms.includes("*") || perms.includes(p);

// The keys each seeded role holds that bear on these pickers.
const FINANCE_DIRECTOR = can(["jobs.view", "suppliers.view", "warehouse.view", "reports.finance.view", "purchase_orders.view"]);
const PROJECT_MANAGER = can(["jobs.view", "jobs.create", "jobs.edit", "customers.view", "inventory.view"]);
const WAREHOUSE_MANAGER = can(["warehouse.view", "inventory.view", "inventory.history", "goods_management.view", "stock_requests.view"]);

describe("canPickCustomers — the customer and project pickers", () => {
  it("#1 #23 opens them to the Finance Director through jobs.view", () => {
    expect(canPickCustomers(FINANCE_DIRECTOR, false)).toBe(true);
  });

  it("opens them to the Project Manager", () => {
    expect(canPickCustomers(PROJECT_MANAGER, false)).toBe(true);
  });

  it("#19-#21 keeps them CLOSED to the warehouse-scoped Warehouse Manager", () => {
    expect(canPickCustomers(WAREHOUSE_MANAGER, true)).toBe(false);
  });

  it("#24 opens them to a job planner holding only the job keys", () => {
    expect(canPickCustomers(can(["jobs.create"]), false)).toBe(true);
    expect(canPickCustomers(can(["jobs.edit"]), true)).toBe(true); // jobs are not warehouse-scoped
  });

  it("#28 opens them to an unscoped report user…", () => {
    expect(canPickCustomers(can(["reports.view"]), false)).toBe(true);
  });

  it("#28 …but NOT to a warehouse-scoped one: their reports are scoped, the list is company-wide", () => {
    expect(canPickCustomers(can(["reports.view"]), true)).toBe(false);
  });

  it("honours an explicit customers.view on a scoped role — a deliberate grant", () => {
    expect(canPickCustomers(can(["customers.view"]), true)).toBe(true);
  });

  it("is always true for the super-admin", () => {
    expect(canPickCustomers(can(["*"]), false)).toBe(true);
  });
});

describe("canSearchSites — the site type-ahead filter", () => {
  it("opens it to jobs.view", () => {
    expect(canSearchSites(FINANCE_DIRECTOR, false)).toBe(true);
  });
  it("#19 keeps it closed to the Warehouse Manager", () => {
    expect(canSearchSites(WAREHOUSE_MANAGER, true)).toBe(false);
  });
  it("#28 opens it to an unscoped report user, not a scoped one", () => {
    expect(canSearchSites(can(["reports.view"]), false)).toBe(true);
    expect(canSearchSites(can(["reports.view"]), true)).toBe(false);
  });
  it("is NOT opened by the job form's create key — that form searches its own customer's sites", () => {
    expect(canSearchSites(can(["jobs.create"]), false)).toBe(false);
  });
});

describe("isWarehouseScoped", () => {
  const user = (isWarehouseScoped?: boolean): Principal => ({
    type: "user", id: "u", email: "u@x", firstName: "U", lastName: "X", profileImageUrl: null, signatureUrl: null,
    status: "active", mustResetPassword: false, role: null, permissions: [], isWarehouseScoped,
  });

  it("reads the role's flag", () => {
    expect(isWarehouseScoped(user(true))).toBe(true);
    expect(isWarehouseScoped(user(false))).toBe(false);
  });
  it("treats a principal cached before the flag existed as unscoped", () => {
    expect(isWarehouseScoped(user(undefined))).toBe(false);
  });
  it("is false for the super-admin, a customer and no one", () => {
    expect(isWarehouseScoped({ type: "admin", id: "a", email: "a@x", name: null })).toBe(false);
    expect(isWarehouseScoped(null)).toBe(false);
  });
});
