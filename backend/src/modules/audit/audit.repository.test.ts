import { describe, expect, it } from "vitest";

import { buildAuditWhere } from "./audit.repository.js";

// The warehouse scope is a SECURITY boundary, not a convenience filter: a warehouse-scoped
// actor (a warehouse manager) may read audit entries ONLY for the warehouses they're assigned
// to. That means the scope must (a) constrain to targetType "warehouse", (b) restrict targetId
// to the assigned set, and (c) OVERRIDE any client-supplied targetType/targetId so a crafted
// query string can't widen the view. These tests pin all three.

describe("buildAuditWhere — warehouse scope", () => {
  it("with no scope leaves client target filters untouched", () => {
    const where = buildAuditWhere({ targetType: "user", targetId: "u1" });
    expect(where.targetType).toBe("user");
    expect(where.targetId).toBe("u1");
  });

  it("with a scope forces targetType=warehouse and restricts targetId to the set", () => {
    const where = buildAuditWhere({ scopeWarehouseIds: ["w1", "w2"] });
    expect(where.targetType).toBe("warehouse");
    expect(where.targetId).toEqual({ in: ["w1", "w2"] });
  });

  it("OVERRIDES a client-supplied targetType/targetId (no widening past the scope)", () => {
    const where = buildAuditWhere({
      targetType: "user", // a scoped user trying to read user audit
      targetId: "someone-elses-id",
      scopeWarehouseIds: ["w1"],
    });
    expect(where.targetType).toBe("warehouse");
    expect(where.targetId).toEqual({ in: ["w1"] });
  });

  it("an empty scope matches nothing (a user with zero assigned warehouses sees no audit)", () => {
    const where = buildAuditWhere({ scopeWarehouseIds: [] });
    expect(where.targetType).toBe("warehouse");
    expect(where.targetId).toEqual({ in: [] });
  });

  it("keeps a search term while still enforcing the scope", () => {
    const where = buildAuditWhere({ search: "acme", scopeWarehouseIds: ["w1"] });
    expect(where.OR).toBeTruthy(); // search still applies
    expect(where.targetType).toBe("warehouse"); // ...but only within the scope
    expect(where.targetId).toEqual({ in: ["w1"] });
  });
});
