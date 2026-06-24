import { describe, expect, it } from "vitest";

import {
  assertWarehouseAccess,
  getAccessibleWarehouseIds,
  isWarehouseScopedUser,
  warehouseScopeFilter,
} from "./warehouse-access.js";

const WH_A = "a".repeat(24);
const WH_B = "b".repeat(24);
const WH_C = "c".repeat(24);

describe("getAccessibleWarehouseIds", () => {
  it("returns null (unrestricted) for no actor", () => {
    expect(getAccessibleWarehouseIds(undefined)).toBeNull();
  });

  it("returns null (unrestricted) when assignedWarehouseIds is null/absent", () => {
    expect(getAccessibleWarehouseIds({})).toBeNull();
    expect(getAccessibleWarehouseIds({ assignedWarehouseIds: null })).toBeNull();
  });

  it("returns the assigned set for a restricted actor", () => {
    expect(getAccessibleWarehouseIds({ assignedWarehouseIds: [WH_A, WH_B] })).toEqual([WH_A, WH_B]);
  });

  it("returns an empty array verbatim (restricted-to-nothing)", () => {
    expect(getAccessibleWarehouseIds({ assignedWarehouseIds: [] })).toEqual([]);
  });
});

describe("warehouseScopeFilter", () => {
  it("returns undefined (no filter) for an unrestricted actor", () => {
    expect(warehouseScopeFilter(undefined)).toBeUndefined();
    expect(warehouseScopeFilter({ assignedWarehouseIds: null })).toBeUndefined();
  });

  it("returns the id list for a restricted actor", () => {
    expect(warehouseScopeFilter({ assignedWarehouseIds: [WH_A] })).toEqual([WH_A]);
  });

  it("returns [] for a restricted-to-nothing actor (matches nothing)", () => {
    expect(warehouseScopeFilter({ assignedWarehouseIds: [] })).toEqual([]);
  });
});

describe("isWarehouseScopedUser", () => {
  it("is true for a staff user with an assigned set (incl. an empty set)", () => {
    expect(isWarehouseScopedUser({ type: "user", assignedWarehouseIds: [WH_A] })).toBe(true);
    expect(isWarehouseScopedUser({ type: "user", assignedWarehouseIds: [] })).toBe(true);
  });

  it("is false for a non-scoped user (assignedWarehouseIds null)", () => {
    expect(isWarehouseScopedUser({ type: "user", assignedWarehouseIds: null })).toBe(false);
    expect(isWarehouseScopedUser({ type: "user" })).toBe(false);
  });

  it("is false for admin / customer / system / null actors", () => {
    expect(isWarehouseScopedUser({ type: "admin", assignedWarehouseIds: null })).toBe(false);
    expect(isWarehouseScopedUser({ type: "customer", assignedWarehouseIds: null })).toBe(false);
    expect(isWarehouseScopedUser({ type: "system" })).toBe(false);
    expect(isWarehouseScopedUser(undefined)).toBe(false);
  });
});

describe("assertWarehouseAccess", () => {
  it("is a no-op for an unrestricted actor (any warehouse)", () => {
    expect(() => assertWarehouseAccess(undefined, WH_A)).not.toThrow();
    expect(() => assertWarehouseAccess({ assignedWarehouseIds: null }, WH_A)).not.toThrow();
  });

  it("allows an assigned warehouse", () => {
    expect(() => assertWarehouseAccess({ assignedWarehouseIds: [WH_A, WH_B] }, WH_A)).not.toThrow();
  });

  it("throws 403 for an unassigned warehouse", () => {
    expect(() => assertWarehouseAccess({ assignedWarehouseIds: [WH_A, WH_B] }, WH_C)).toThrow(
      /access to this warehouse/i,
    );
  });

  it("throws for a restricted-to-nothing actor", () => {
    expect(() => assertWarehouseAccess({ assignedWarehouseIds: [] }, WH_A)).toThrow();
  });
});
