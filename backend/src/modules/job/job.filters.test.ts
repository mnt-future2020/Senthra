import { describe, expect, it } from "vitest";

import { buildCustomerWhere, buildEngineerWhere, buildWhere } from "./job.repository.js";
import { calendarDayWindow, instantDayWindow } from "../../utils/filter-date.js";

// Filter composition on the Jobs list. Pure where-builders, no Prisma I/O — the same contract the
// purchase-order repository's own buildWhere tests run under.
//
// What these protect:
//   • a due-date window covers the WHOLE of its last day (the "To excludes its own day" bug),
//   • "overdue" and an explicit due range COMPOSE instead of overwriting each other,
//   • every dimension ANDs, so Engineer + Site + Status + Date means all four,
//   • the portal's tenant bound survives a site filter.

const DAY_START = new Date("2026-08-31T00:00:00.000Z");
const OBJ = "aaaaaaaaaaaaaaaaaaaaaaaa";

describe("due-date window", () => {
  it("covers the whole of the last day", () => {
    const where = buildWhere({ dueWindow: calendarDayWindow("2026-08-01", "2026-08-31") });
    expect(where.completionDate).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("makes a single day a range of exactly that day", () => {
    const where = buildWhere({ dueWindow: calendarDayWindow("2026-08-31", "2026-08-31") });
    expect(where.completionDate).toEqual({
      gte: new Date("2026-08-31T00:00:00.000Z"),
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("supports an open lower or upper bound", () => {
    expect(buildWhere({ dueWindow: calendarDayWindow("2026-08-31", undefined) }).completionDate).toEqual({
      gte: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(buildWhere({ dueWindow: calendarDayWindow(undefined, "2026-08-31") }).completionDate).toEqual({
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("omits the key entirely when no date was given", () => {
    expect(buildWhere({ dueWindow: calendarDayWindow(undefined, undefined) }).completionDate).toBeUndefined();
    expect(buildWhere({}).completionDate).toBeUndefined();
  });
});

describe("overdue composes with an explicit due range", () => {
  it("keeps BOTH bounds — overdue narrows the upper edge, the range sets the lower", () => {
    const where = buildWhere({
      status: "overdue",
      overdueBefore: DAY_START,
      dueWindow: calendarDayWindow("2026-08-01", "2026-12-31"),
    });
    // The range's own `lt` (1 Jan) is LATER than today, so today wins — an overdue job cannot be
    // due in the future, whatever range was asked for.
    expect(where.completionDate).toEqual({ gte: new Date("2026-08-01T00:00:00.000Z"), lt: DAY_START });
    expect(where.status).toEqual({ in: expect.arrayContaining(["assigned"]) });
  });

  it("keeps the RANGE's upper bound when it is the tighter of the two", () => {
    const where = buildWhere({
      status: "overdue",
      overdueBefore: DAY_START,
      dueWindow: calendarDayWindow(undefined, "2026-08-05"),
    });
    expect(where.completionDate).toEqual({ lt: new Date("2026-08-06T00:00:00.000Z") });
  });

  it("still throws when overdue is asked for with no day boundary — a quiet default would lie", () => {
    expect(() => buildWhere({ status: "overdue" })).toThrow(/overdueBefore/);
  });

  it("does NOT apply the overdue bound to a plain status", () => {
    const where = buildWhere({ status: "completed", overdueBefore: DAY_START });
    expect(where.completionDate).toBeUndefined();
    expect(where.status).toBe("completed");
  });
});

describe("dimensions compose with AND", () => {
  it("Engineer + Site + Status + Date all apply at once", () => {
    const where = buildWhere({
      status: "in_progress",
      assignedEngineerId: OBJ,
      siteId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      customerId: "cccccccccccccccccccccccc",
      projectId: "dddddddddddddddddddddddd",
      priority: "urgent",
      dueWindow: calendarDayWindow("2026-08-01", "2026-08-31"),
    });
    expect(where.status).toBe("in_progress");
    expect(where.assignedEngineerId).toBe(OBJ);
    expect(where.siteId).toBe("bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(where.customerId).toBe("cccccccccccccccccccccccc");
    expect(where.projectId).toBe("dddddddddddddddddddddddd");
    expect(where.priority).toBe("urgent");
    expect(where.completionDate).toBeDefined();
    // Soft-deleted jobs stay out no matter what was filtered.
    expect(where.deletedAt).toBeNull();
  });

  it("search sits in its own OR and never replaces a dimension", () => {
    const where = buildWhere({ search: "JOB-2026", assignedEngineerId: OBJ });
    expect(where.assignedEngineerId).toBe(OBJ);
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it("escapes a search term so a regex metacharacter cannot change the query", () => {
    const where = buildWhere({ search: "PO-00(6" });
    const arm = (where.OR as { jobNumber?: { contains?: string } }[])[0];
    expect(arm?.jobNumber?.contains).toBe("PO-00\\(6");
  });

  it("created-at uses the COMPANY day, not the UTC one", () => {
    // 31 Aug is BST, so the company's day starts an hour before UTC midnight.
    const where = buildWhere({ createdWindow: instantDayWindow("2026-08-31", "2026-08-31", "Europe/London") });
    expect(where.createdAt).toEqual({
      gte: new Date("2026-08-30T23:00:00.000Z"),
      lt: new Date("2026-08-31T23:00:00.000Z"),
    });
  });
});

describe("engineer portal list", () => {
  it("stays pinned to the engineer whatever else is filtered", () => {
    const where = buildEngineerWhere(OBJ, {
      dueWindow: calendarDayWindow("2026-08-01", "2026-08-31"),
      siteId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      search: "fibre",
    });
    expect(where.assignedEngineerId).toBe(OBJ);
    expect(where.completionDate).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("merges overdue with a due range here too", () => {
    const where = buildEngineerWhere(OBJ, {
      status: "overdue",
      overdueBefore: DAY_START,
      dueWindow: calendarDayWindow("2026-08-01", undefined),
    });
    expect(where.completionDate).toEqual({ gte: new Date("2026-08-01T00:00:00.000Z"), lt: DAY_START });
  });
});

describe("customer portal list — the tenant bound is not negotiable", () => {
  const CUST = "eeeeeeeeeeeeeeeeeeeeeeee";

  it("keeps customerId pinned when a site is filtered", () => {
    const where = buildCustomerWhere(CUST, { siteId: "ffffffffffffffffffffffff" });
    expect(where.customerId).toBe(CUST);
    expect(where.siteId).toBe("ffffffffffffffffffffffff");
  });

  it("keeps the visible-status allow-list when a date window is applied", () => {
    const where = buildCustomerWhere(CUST, { dueWindow: calendarDayWindow("2026-08-01", "2026-08-31") });
    expect(where.customerId).toBe(CUST);
    // A customer must never be shown a draft, however the list is narrowed.
    expect((where.status as { in: string[] }).in).not.toContain("draft");
    expect(where.completionDate).toBeDefined();
  });

  it("a borrowed site id from another company simply matches nothing — it cannot widen the scope", () => {
    const where = buildCustomerWhere(CUST, { siteId: "999999999999999999999999" });
    // Both bounds are present, so the query is customerId AND siteId: someone else's site yields
    // zero rows rather than reaching across the tenant boundary.
    expect(where.customerId).toBe(CUST);
    expect(where.siteId).toBe("999999999999999999999999");
  });
});
