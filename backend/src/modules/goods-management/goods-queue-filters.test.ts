import { describe, expect, it } from "vitest";

import { buildWhere } from "#modules/job/job.repository.js";
import { calendarDayWindow, instantDayWindow } from "../../utils/filter-date.js";

// The goods queue's new filters all narrow the JOB, so they are pushed into the candidate query
// rather than applied over the candidate set in memory. That matters twice: the per-job enrichment
// that follows (goods status, movements, balances) then runs over the narrowed set, and `total`
// counts exactly the rows the pager walks.
//
// findActiveForGoodsManagement builds its own where; these tests pin the same semantics through the
// shared job builder, which is the pure surface available to a unit test.

describe("goods queue — engineer / customer / site narrow the job", () => {
  it("applies all three at once, alongside the due window", () => {
    const where = buildWhere({
      assignedEngineerId: "eeeeeeeeeeeeeeeeeeee1111",
      customerId: "cccccccccccccccccccc2222",
      siteId: "ssssssssssssssssssss3333",
      dueWindow: calendarDayWindow("2026-08-01", "2026-08-31"),
    });
    expect(where.assignedEngineerId).toBe("eeeeeeeeeeeeeeeeeeee1111");
    expect(where.customerId).toBe("cccccccccccccccccccc2222");
    expect(where.siteId).toBe("ssssssssssssssssssss3333");
    expect(where.completionDate).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lt: new Date("2026-09-01T00:00:00.000Z"),
    });
  });
});

// The activity window is the one the Closed view is read along, and it moved from a UTC day to the
// company's. These assert the boundary the retrofit produces — half-open, so consecutive months
// tile exactly instead of overlapping on the midnight between them.
describe("goods queue — the closed-activity window is a COMPANY day", () => {
  it("starts an hour before UTC midnight during BST", () => {
    const w = instantDayWindow("2026-07-01", "2026-07-31", "Europe/London");
    expect(w.gte).toEqual(new Date("2026-06-30T23:00:00.000Z"));
    expect(w.lt).toEqual(new Date("2026-07-31T23:00:00.000Z"));
  });

  it("is UTC midnight during GMT", () => {
    const w = instantDayWindow("2026-01-01", "2026-01-31", "Europe/London");
    expect(w.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(w.lt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });

  it("tiles two consecutive months with no gap and no overlap", () => {
    const july = instantDayWindow("2026-07-01", "2026-07-31", "Europe/London");
    const august = instantDayWindow("2026-08-01", "2026-08-31", "Europe/London");
    expect(july.lt).toEqual(august.gte);
  });

  it("puts a late-evening movement in the month it happened, not the next one", () => {
    const july = instantDayWindow("2026-07-01", "2026-07-31", "Europe/London");
    // 23:30 UK on the 31st is 22:30Z — inside July.
    expect(new Date("2026-07-31T22:30:00.000Z") < july.lt!).toBe(true);
    // 00:30 UK on 1 August is 23:30Z on the 31st — NOT July. This is the row the old UTC window
    // swept in, and the one whose absence from August nobody would have noticed.
    expect(new Date("2026-07-31T23:30:00.000Z") < july.lt!).toBe(false);
  });
});
