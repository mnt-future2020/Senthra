import { describe, expect, it, vi } from "vitest";

// The repository instantiates a Prisma client at import; stub it and capture the `where` each read
// builds, which is the whole point of these tests — the status window IS the behaviour.
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn().mockResolvedValue([]) }));
vi.mock("../../lib/prisma.js", () => ({
  prisma: { job: { findMany } },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { findGoodsActiveJobIds } from "./job.repository.js";

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
