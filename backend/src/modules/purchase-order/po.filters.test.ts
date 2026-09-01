import { describe, expect, it } from "vitest";

import { buildWhere } from "./purchase-order.repository.js";
import { buildWhere as buildPrfWhere } from "#modules/purchase-request/purchase-request.repository.js";
import { calendarDayWindow, instantDayWindow } from "../../utils/filter-date.js";

// Date windows on the procurement lists. The interesting case is the PO one: `overdue` already
// constrains expectedDeliveryDate through its own AND'd OR, so an expected-date window written
// straight onto the where would sit beside — or silently replace — it.

const DAY_START = new Date("2026-08-31T00:00:00.000Z");
const andClauses = (w: { AND?: unknown }) => (Array.isArray(w.AND) ? w.AND : w.AND ? [w.AND] : []);

describe("purchase orders — order date (an instant)", () => {
  it("uses the COMPANY day, not the UTC one", () => {
    const where = buildWhere({ orderedWindow: instantDayWindow("2026-08-31", "2026-08-31", "Europe/London") });
    expect(andClauses(where)).toContainEqual({
      orderDate: { gte: new Date("2026-08-30T23:00:00.000Z"), lt: new Date("2026-08-31T23:00:00.000Z") },
    });
  });

  it("adds nothing when no date was given", () => {
    expect(andClauses(buildWhere({ orderedWindow: instantDayWindow(undefined, undefined, "Europe/London") }))).toHaveLength(0);
  });
});

describe("purchase orders — expected delivery (a calendar day)", () => {
  it("covers the whole of the last day", () => {
    const where = buildWhere({ expectedWindow: calendarDayWindow("2026-08-01", "2026-08-31") });
    expect(andClauses(where)).toContainEqual({
      expectedDeliveryDate: { gte: new Date("2026-08-01T00:00:00.000Z"), lt: new Date("2026-09-01T00:00:00.000Z") },
    });
  });

  it("COMPOSES with the derived overdue status instead of replacing its clause", () => {
    const where = buildWhere({
      status: "overdue",
      overdueBefore: DAY_START,
      expectedWindow: calendarDayWindow("2026-08-01", "2026-08-31"),
    });
    const clauses = andClauses(where);
    // Overdue's own predicate survives…
    expect(clauses.some((c) => JSON.stringify(c).includes("confirmedDeliveryDate"))).toBe(true);
    // …and the window is a SEPARATE AND'd clause, so both must hold.
    expect(clauses).toContainEqual({
      expectedDeliveryDate: { gte: new Date("2026-08-01T00:00:00.000Z"), lt: new Date("2026-09-01T00:00:00.000Z") },
    });
  });

  it("composes with a warehouse SCOPE — a filter narrows within it, never around it", () => {
    const where = buildWhere({
      warehouseId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      warehouseIds: ["bbbbbbbbbbbbbbbbbbbbbbbb"],
      expectedWindow: calendarDayWindow("2026-08-01", undefined),
    });
    // The scope clause is still there alongside the explicit pick, so a warehouse outside the
    // actor's set matches nothing rather than being served.
    expect(andClauses(where)).toContainEqual({ warehouseId: { in: ["bbbbbbbbbbbbbbbbbbbbbbbb"] } });
    expect(where.warehouseId).toBe("aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("keeps supplier, warehouse and priority alongside the windows", () => {
    const where = buildWhere({
      supplierId: "cccccccccccccccccccccccc",
      warehouseId: "dddddddddddddddddddddddd",
      priority: "urgent",
      orderedWindow: instantDayWindow("2026-08-01", undefined, "UTC"),
      expectedWindow: calendarDayWindow(undefined, "2026-08-31"),
    });
    expect(where.supplierId).toBe("cccccccccccccccccccccccc");
    expect(where.warehouseId).toBe("dddddddddddddddddddddddd");
    expect(where.priority).toBe("urgent");
    expect(andClauses(where)).toHaveLength(2);
  });
});

describe("purchase requests — required-by and quote-valid-until (both calendar days)", () => {
  it("covers the whole of each window's last day", () => {
    const where = buildPrfWhere({
      requiredByWindow: calendarDayWindow("2026-08-01", "2026-08-31"),
      quoteValidWindow: calendarDayWindow(undefined, "2026-09-30"),
    });
    expect(where.requiredByDate).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(where.quoteValidUntil).toEqual({ lt: new Date("2026-10-01T00:00:00.000Z") });
  });

  it("composes with supplier, warehouse and the rework pseudo-status", () => {
    const where = buildPrfWhere({
      status: "rework",
      supplierId: "cccccccccccccccccccccccc",
      warehouseId: "dddddddddddddddddddddddd",
      requiredByWindow: calendarDayWindow("2026-08-01", undefined),
    });
    expect(where.supplierId).toBe("cccccccccccccccccccccccc");
    expect(where.warehouseId).toBe("dddddddddddddddddddddddd");
    expect(where.requiredByDate).toEqual({ gte: new Date("2026-08-01T00:00:00.000Z") });
    // The derived status keeps its own AND'd clause.
    expect(andClauses(where).length).toBeGreaterThan(0);
  });

  it("omits both keys when neither window is set", () => {
    const where = buildPrfWhere({ supplierId: "cccccccccccccccccccccccc" });
    expect(where.requiredByDate).toBeUndefined();
    expect(where.quoteValidUntil).toBeUndefined();
  });
});
