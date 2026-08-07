import { describe, expect, it, vi } from "vitest";

// The repository instantiates a Prisma client at import; stub it and capture the `where` each read
// builds, which is the whole point of these tests — the status window IS the behaviour.
const { findMany, count, findFirst, kitLineCount, summaryFindMany } = vi.hoisted(() => ({
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  findFirst: vi.fn().mockResolvedValue(null),
  kitLineCount: vi.fn().mockResolvedValue(0),
  // Its own mock rather than a shared `findMany`: every other test here reads `findMany.mock.calls
  // .at(-1)`, and folding the summary read into it would silently make each of those assert against
  // the wrong query.
  summaryFindMany: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    job: { findMany, count, findFirst },
    jobKitLine: { count: kitLineCount },
    jobStockSummary: { findMany: summaryFindMany },
  },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import {
  countByCustomerPortal,
  countLiveKitLinesByWarehouse,
  countOpenByCustomer,
  findActiveByEngineerWithKitLines,
  findActiveForGoodsManagement,
  findByIdForCustomer,
  findGoodsActiveJobIds,
  findManyByCustomerPortal,
  PORTAL_JOB_STATUSES,
} from "./job.repository.js";

// A chase list exists to surface stock nobody is looking at any more, so the one status that must NOT
// silently drop out of it is the one where everybody stops looking: cancelled. `cancelJob` is reachable
// from `accepted` and `in_progress` (see ALLOWED_TRANSITIONS in job.service.ts), it has no guard on
// outstanding stock and it does not touch goodsStatus — so a job can be cancelled while an engineer is
// still physically holding its kit. Excluding cancelled here makes that stock invisible to both the
// Overdue tab and the Inventory Hub's overdue count: a silent false negative, which is precisely the
// failure mode listOverdueWithin's own comment says this read must never have ("jobs are EXCLUDED by
// proof of reconciliation, never included by proof of openness").
describe("findGoodsActiveJobIds — the overdue read's starting set", () => {
  it("includes cancelled jobs, whose stock can still be out with an engineer", async () => {
    await findGoodsActiveJobIds();
    const statuses = findMany.mock.calls.at(-1)?.[0].where.status.in;
    expect(statuses).toContain("cancelled");
  });

  it("still covers every status stock can be issued against", async () => {
    await findGoodsActiveJobIds();
    const statuses = findMany.mock.calls.at(-1)?.[0].where.status.in;
    expect(statuses).toEqual(expect.arrayContaining(["accepted", "in_progress", "completed"]));
  });

  // Stock is only issued from `accepted` onward, so a job that never got there cannot be holding any.
  // Keeping them out is what stops the read degrading into "every job ever".
  it("excludes statuses no stock can have been issued against", async () => {
    await findGoodsActiveJobIds();
    const statuses: string[] = findMany.mock.calls.at(-1)?.[0].where.status.in;
    expect(statuses).not.toContain("draft");
    expect(statuses).not.toContain("assigned");
    expect(statuses).not.toContain("rejected");
  });

  it("excludes soft-deleted jobs", async () => {
    await findGoodsActiveJobIds();
    expect(findMany.mock.calls.at(-1)?.[0].where.deletedAt).toBeNull();
  });
});

// Putting the job on the chase list was only half the job: cancelling has to leave the stock a way
// HOME as well. These two reads are that path — one lets the warehouse find the job to scan the kit
// back in, the other keeps the units counted as committed while they are still in the van. Both used
// to stop at `completed`, so the moment a job was cancelled its kit both vanished from the Queue and
// silently became free van stock other jobs could be offered.
describe("findActiveForGoodsManagement — the warehouse must still be able to take the kit back", () => {
  it("includes cancelled jobs", async () => {
    await findActiveForGoodsManagement("wh1");
    expect(findMany.mock.calls.at(-1)?.[0].where.status.in).toContain("cancelled");
  });

  // Issuing is blocked on a cancelled job by postIssue; the queue row exists to RETURN, and listQueue
  // drops the cancelled jobs that never had anything issued.
  it("still excludes statuses stock cannot be issued against", async () => {
    await findActiveForGoodsManagement("wh1");
    const statuses: string[] = findMany.mock.calls.at(-1)?.[0].where.status.in;
    expect(statuses).not.toContain("draft");
    expect(statuses).not.toContain("assigned");
    expect(statuses).not.toContain("rejected");
  });
});

// Both of these answer one question — "is this job still in flight?" — for a delete guard, and both
// must answer it the same way the CUSTOMER's own dashboard does. `rejected` means our engineer
// declined and the office has to reassign: the work is still on, which is why job.service's
// ACTIVE_STATUSES folds `rejected` into the "scheduled" stage and counts it as active. Treating it as
// closed here made the guard looser than the number the customer is looking at: their dashboard read
// "1 active job" while an admin could delete the company outright.
describe("delete guards — a rejected job is work still in flight", () => {
  it("countOpenByCustomer counts a job waiting to be reassigned", async () => {
    await countOpenByCustomer("cust1");
    const notIn: string[] = count.mock.calls.at(-1)?.[0].where.status.notIn;
    expect(notIn).not.toContain("rejected");
    expect(notIn).toEqual(expect.arrayContaining(["completed", "cancelled"]));
  });

  // The kit lines of a rejected job still name their pickup warehouse, and the engineer who picks the
  // job up next has to be sent somewhere.
  it("countLiveKitLinesByWarehouse still holds the warehouse of a rejected job", async () => {
    await countLiveKitLinesByWarehouse("wh1");
    const notIn: string[] = kitLineCount.mock.calls.at(-1)?.[0].where.OR[0].job.status.notIn;
    expect(notIn).not.toContain("rejected");
    expect(notIn).toEqual(expect.arrayContaining(["completed", "cancelled"]));
  });
});

// Closing a job moves no units. `cancelJob` has no guard on outstanding stock, and a completed job
// can sit in `awaiting_return` — either way the engineer walks away still holding the kit, and the
// scan-back-in runs through goods management against the pickup warehouse. A guard keyed only on job
// status calls both of those finished and lets the warehouse be deleted out from under the return:
// the same stranded-stock failure findGoodsActiveJobIds and findActiveByEngineerWithKitLines above
// keep `cancelled` in their windows to prevent, reopened at the delete guard instead.
describe("countLiveKitLinesByWarehouse — a closed job whose stock never came back", () => {
  it("also counts kit lines on jobs whose stock is still unsettled", async () => {
    summaryFindMany.mockResolvedValueOnce([{ jobId: "job-cancelled-with-stock-out" }]);
    await countLiveKitLinesByWarehouse("wh1");
    const or = kitLineCount.mock.calls.at(-1)?.[0].where.OR;
    expect(or[1].jobId.in).toContain("job-cancelled-with-stock-out");
  });

  it("asks only for the goods states that mean stock is still out", async () => {
    await countLiveKitLinesByWarehouse("wh1");
    const statuses: string[] = summaryFindMany.mock.calls.at(-1)?.[0].where.goodsStatus.in;
    expect(statuses).toEqual(expect.arrayContaining(["issued", "partially_issued", "awaiting_return"]));
    // The two settled ends. Counting `reconciled` would make any warehouse that ever served a job
    // undeletable — the guard nobody could satisfy that the status window exists to avoid.
    expect(statuses).not.toContain("reconciled");
    expect(statuses).not.toContain("not_issued");
  });

  // Both branches, not just the live one: a job deleted after its stock settled is gone from every
  // read, and counting its kit lines would block the warehouse on a record nobody can act on.
  it("ignores soft-deleted jobs on both branches", async () => {
    summaryFindMany.mockResolvedValueOnce([{ jobId: "job-1" }]);
    await countLiveKitLinesByWarehouse("wh1");
    const or = kitLineCount.mock.calls.at(-1)?.[0].where.OR;
    expect(or[0].job.deletedAt).toBeNull();
    expect(or[1].job.deletedAt).toBeNull();
  });

  it("stays scoped to the one warehouse", async () => {
    await countLiveKitLinesByWarehouse("wh1");
    expect(kitLineCount.mock.calls.at(-1)?.[0].where.warehouseId).toBe("wh1");
  });
});

describe("findActiveByEngineerWithKitLines — cancelled stock is still committed", () => {
  // jobCommittedByEngineer reads this. Dropping cancelled released every unit the engineer was holding
  // for that job: the field-stock return flow stopped subtracting it, and kit-request availability
  // started offering it to other jobs as "on another van" — the same units, promised twice.
  it("includes cancelled jobs", async () => {
    await findActiveByEngineerWithKitLines("eng1");
    expect(findMany.mock.calls.at(-1)?.[0].where.status.in).toContain("cancelled");
  });

  it("stays scoped to the one engineer, and to live records", async () => {
    await findActiveByEngineerWithKitLines("eng1");
    const where = findMany.mock.calls.at(-1)?.[0].where;
    expect(where.assignedEngineerId).toBe("eng1");
    expect(where.deletedAt).toBeNull();
  });
});

// The customer portal is the only surface in this module reachable by someone outside the company,
// so its `where` is a security boundary and not merely a filter. These assert the two things that
// must hold on EVERY read it makes: one customer, and never a draft.
describe("customer-portal reads — the scope is the boundary", () => {
  const CUST = "f".repeat(24);
  const lastWhere = (m: typeof findMany | typeof count) => m.mock.calls.at(-1)?.[0].where;

  it("pins the list to one customer and to live records", async () => {
    await findManyByCustomerPortal(CUST);
    const where = lastWhere(findMany);
    expect(where.customerId).toBe(CUST);
    expect(where.deletedAt).toBeNull();
  });

  it("pins the count the same way — a total that counted more than the list would be its own leak", async () => {
    await countByCustomerPortal(CUST);
    expect(lastWhere(count).customerId).toBe(CUST);
    expect(lastWhere(count).deletedAt).toBeNull();
  });

  // Both reads go through one where-builder precisely so this can't be true of one and not the other.
  it("never returns a draft job, filtered or not", async () => {
    await findManyByCustomerPortal(CUST);
    expect(lastWhere(findMany).status.in).not.toContain("draft");

    await findManyByCustomerPortal(CUST, { statuses: ["assigned"] });
    expect(lastWhere(findMany).status.in).not.toContain("draft");

    await countByCustomerPortal(CUST, { statuses: ["completed"] });
    expect(lastWhere(count).status.in).not.toContain("draft");
  });

  // The status filter is a NARROWING, never a widening: a caller that asks for something outside the
  // visible set gets the visible set, not that something. Without this the portal's whole
  // hidden-status guarantee would rest on every caller remembering to sanitise first.
  it("drops statuses outside the visible set instead of honouring them", async () => {
    await findManyByCustomerPortal(CUST, { statuses: ["draft", "completed"] });
    expect(lastWhere(findMany).status.in).toEqual(["completed"]);
  });

  it("falls back to every visible status when the filter leaves nothing legal", async () => {
    await findManyByCustomerPortal(CUST, { statuses: ["draft"] });
    expect(lastWhere(findMany).status.in).toEqual([...PORTAL_JOB_STATUSES]);
  });

  it("narrows to the requested statuses when they are legal", async () => {
    await findManyByCustomerPortal(CUST, { statuses: ["assigned", "accepted"] });
    expect(lastWhere(findMany).status.in).toEqual(["assigned", "accepted"]);
  });

  // A search must not become a second way out of the customer scope. `where.OR` sits ALONGSIDE
  // customerId (Prisma ANDs top-level keys), so this checks the scope survives a search being added.
  it("keeps the customer scope when a search is applied", async () => {
    await findManyByCustomerPortal(CUST, { search: "fibre" });
    const where = lastWhere(findMany);
    expect(where.customerId).toBe(CUST);
    expect(where.OR.length).toBeGreaterThan(0);
  });

  // A regex metacharacter in the search term reaches Mongo as a raw $regex unless escaped — "(" then
  // throws P2010 and 500s the customer's own list. See utils/search.escapeRegex.
  it("escapes regex metacharacters in the search term", async () => {
    await findManyByCustomerPortal(CUST, { search: "unit (a)" });
    const nameClause = lastWhere(findMany).OR.find((c: Record<string, { contains: string }>) => c.name);
    expect(nameClause.name.contains).toBe("unit \\(a\\)");
  });

  // The portal must never hand back the whole record — see portalJobSelect for what is held out and
  // why. An `include` here would ship notes, attachments and the engineer's email to the customer.
  it("projects with a select, never an include", async () => {
    await findManyByCustomerPortal(CUST);
    const args = findMany.mock.calls.at(-1)?.[0];
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select)).not.toContain("notes");
    expect(Object.keys(args.select)).not.toContain("attachments");
    expect(Object.keys(args.select)).not.toContain("cancelReason");
    expect(Object.keys(args.select)).not.toContain("assignedEngineerEmail");
  });

  it("sorts by due date ascending — the customer's next job first — with a stable tiebreak", async () => {
    await findManyByCustomerPortal(CUST, {}, 0, 20, "due");
    expect(findMany.mock.calls.at(-1)?.[0].orderBy).toEqual([{ completionDate: "asc" }, { jobNumber: "desc" }]);
  });

  // The single-job read is the easiest one to get wrong later: `findUnique({ id })` looks like a
  // harmless simplification and would hand ANY customer ANY job, while every test above still
  // passed — they only cover the list. So the scope is asserted here on its own.
  it("scopes the single-job read to the customer, live records and visible statuses", async () => {
    await findByIdForCustomer("j1", CUST);
    const where = lastWhere(findFirst);
    expect(where.id).toBe("j1");
    expect(where.customerId).toBe(CUST);
    expect(where.deletedAt).toBeNull();
    expect(where.status.in).not.toContain("draft");
  });

  // An empty id must not reach Prisma as `{ id: "" }` — a where with no id is a where that matches
  // the customer's FIRST job, which is a real job returned for a URL that names none.
  it("returns null for an empty id without querying at all", async () => {
    findFirst.mockClear();
    await expect(findByIdForCustomer("", CUST)).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  // The detail projection is far wider than the list's, so it is the one that has to be checked
  // field by field. These four are the whole difference between it and the office's payload.
  it("keeps supplier, staff contacts, internal notes and the reject reason out of the detail select", async () => {
    await findByIdForCustomer("j1", CUST);
    const select = findFirst.mock.calls.at(-1)?.[0].select;
    for (const f of ["supplierName", "installerType", "assignedEngineerEmail", "createdBy", "updatedBy", "acceptedBy", "rejectedBy", "notes", "rejectReason"]) {
      expect(select).not.toHaveProperty(f);
    }
    // Kit lines carry the same rule: the office's Notes column is staff-to-staff free text.
    expect(select.kitLines.select).not.toHaveProperty("notes");
  });
});
