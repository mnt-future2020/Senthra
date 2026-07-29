import { describe, expect, it } from "vitest";

import { buildAuditWhere } from "./audit.repository.js";

// The warehouse scope is a SECURITY boundary, not a convenience filter: a warehouse-scoped
// actor (a warehouse manager) may read audit entries ONLY for the warehouses they're assigned
// to. That means the scope must (a) constrain to targetType "warehouse", (b) restrict targetId
// to the assigned set, and (c) never let a client-supplied targetType/targetId widen the view.
//
// (c) is an INTERSECTION, not a blanket override: a client targetId narrows within the scope and
// can never escape it. A blanket override satisfies "can't widen past the scope" but breaks the
// other half — a request for one warehouse quietly answered with all of them. These tests pin both
// directions.

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
    // Matches NOTHING rather than falling back to the whole scope: the requested target isn't in
    // the set, so intersecting it leaves nothing. Strictly narrower than the scope either way.
    expect(where.targetId).toEqual({ in: [] });
  });

  // A scoped actor asking for ONE of their own warehouses must get exactly that warehouse. The scope
  // used to REPLACE the requested targetId, so a per-warehouse screen (the Warehouse detail page's
  // Activity tab) silently received every warehouse the actor was assigned to — indistinguishable
  // from the right answer, because the entries were all warehouse entries.
  it("INTERSECTS a targetId inside the scope instead of widening it back to the whole set", () => {
    const where = buildAuditWhere({ targetType: "warehouse", targetId: "w2", scopeWarehouseIds: ["w1", "w2", "w3"] });
    expect(where.targetType).toBe("warehouse");
    expect(where.targetId).toEqual({ in: ["w2"] });
  });

  it("narrows a targetId OUTSIDE the scope to nothing (never to the scope)", () => {
    const where = buildAuditWhere({ targetType: "warehouse", targetId: "w9", scopeWarehouseIds: ["w1", "w2"] });
    expect(where.targetId).toEqual({ in: [] });
  });

  it("still returns the whole scope when no targetId is asked for", () => {
    const where = buildAuditWhere({ targetType: "warehouse", scopeWarehouseIds: ["w1", "w2"] });
    expect(where.targetId).toEqual({ in: ["w1", "w2"] });
  });

  it("an unrestricted actor's targetId is honoured verbatim", () => {
    const where = buildAuditWhere({ targetType: "warehouse", targetId: "w2" });
    expect(where.targetId).toBe("w2");
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
