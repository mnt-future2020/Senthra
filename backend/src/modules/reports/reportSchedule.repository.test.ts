import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Deleting a schedule must take its run history with it ─────────────────────────────────────
//
// `ReportRun.schedule` is a REQUIRED relation with no `onDelete` — as is every relation in this
// schema. Prisma emulates referential integrity on MongoDB, and a required relation defaults to
// RESTRICT, so deleting a parent that has children is refused with P2014. The delete button therefore
// worked only on a schedule that had never run: the exact opposite of the ones anybody wants to
// remove, and the confirm dialog promised the run history went with it.
//
// The fix is the same explicit-children pattern the purchase-order repository already uses. These
// tests pin the ORDER (children first) and the atomicity, because getting either wrong reintroduces
// the failure in a form that only shows up on a schedule with history.

const tx = vi.hoisted(() => ({
  reportRun: { deleteMany: vi.fn() },
  reportSchedule: { delete: vi.fn() },
}));
const { withTransaction, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    withTransaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      calls.push("transaction:open");
      return fn(undefined);
    }),
  };
});

vi.mock("../../lib/prisma.js", () => ({
  prisma: { reportRun: tx.reportRun, reportSchedule: tx.reportSchedule },
  withTransaction: (fn: (t: unknown) => Promise<unknown>) =>
    withTransaction(() => fn({ reportRun: tx.reportRun, reportSchedule: tx.reportSchedule })),
}));

import { deleteSchedule } from "./reportSchedule.repository.js";

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  tx.reportRun.deleteMany.mockImplementation(async () => {
    calls.push("runs:deleted");
    return { count: 2 };
  });
  tx.reportSchedule.delete.mockImplementation(async () => {
    calls.push("schedule:deleted");
    return { id: "sch1" };
  });
});

describe("deleteSchedule", () => {
  it("removes the schedule's runs as well as the schedule", async () => {
    await deleteSchedule("sch1");
    expect(tx.reportRun.deleteMany).toHaveBeenCalledWith({ where: { scheduleId: "sch1" } });
    expect(tx.reportSchedule.delete).toHaveBeenCalledWith({ where: { id: "sch1" } });
  });

  // Children FIRST. The other order is the P2014 this exists to prevent.
  it("deletes the runs before the schedule", async () => {
    await deleteSchedule("sch1");
    expect(calls).toEqual(["transaction:open", "runs:deleted", "schedule:deleted"]);
  });

  // Both or neither: a half-done delete leaves orphan runs pointing at a schedule that is gone, and
  // nothing in the app would ever look at them again to notice.
  it("does both inside one transaction", async () => {
    await deleteSchedule("sch1");
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns the deleted schedule", async () => {
    await expect(deleteSchedule("sch1")).resolves.toMatchObject({ id: "sch1" });
  });
});
