import { beforeEach, describe, expect, it, vi } from "vitest";

// The warehouse-side receiving counts. Prisma is stubbed to the two calls these make, so the test is
// about WHICH rows are selected and how they are attributed to a warehouse — the two things that
// decide whether a badge matches the pane it opens.
const { rentalLine } = vi.hoisted(() => ({
  rentalLine: { count: vi.fn(), findMany: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: { purchaseOrderRentalLine: rentalLine } }));

import {
  countAwaitingHireDeliveries,
  countAwaitingHireDeliveriesByWarehouse,
  listOnHire,
  ON_HIRE_STATUSES,
  onHireFilter,
} from "./purchase-order.repository.js";
import { awaitingDeliveryWhere, overdueDeliveryWhere, returnedWhere } from "./rentalHire.predicate.js";

beforeEach(() => {
  rentalLine.count.mockReset().mockResolvedValue(0);
  rentalLine.findMany.mockReset().mockResolvedValue([]);
});

const whereOf = (mock: typeof rentalLine.count) =>
  mock.mock.calls[0][0].where as {
    hireStatus?: unknown;
    fullyReceived?: boolean;
    hireStartDate?: unknown;
    purchaseOrder: { is: { warehouseId?: unknown } };
  };

describe("countAwaitingHireDeliveries", () => {
  // The pane lists EVERY hire still awaiting delivery at this warehouse. The only rental badge that
  // existed counted `overdueDeliveryWhere` — awaiting AND already started — so a hire arriving next
  // week sat in the pane with a Receive button and no badge anywhere counted it. You were told only
  // once you were already late.
  it("counts every hire still awaiting delivery, not only the ones already due", async () => {
    await countAwaitingHireDeliveries(["wh1"]);
    const where = whereOf(rentalLine.count);
    expect(where.fullyReceived, "the queue is about units still to come, not about a status").toBe(false);
    expect(where.hireStatus).toEqual({ not: "returned" });
    expect(where.hireStartDate, "a start-date bound would hide hires that have not come due yet").toBeUndefined();
  });

  it("narrows to the actor's warehouses", async () => {
    await countAwaitingHireDeliveries(["wh1", "wh2"]);
    expect(whereOf(rentalLine.count).purchaseOrder.is.warehouseId).toEqual({ in: ["wh1", "wh2"] });
  });

  it("counts every warehouse for an unscoped actor", async () => {
    await countAwaitingHireDeliveries(undefined);
    expect(whereOf(rentalLine.count).purchaseOrder.is.warehouseId).toBeUndefined();
  });

  it("returns the count prisma gives it", async () => {
    rentalLine.count.mockResolvedValue(4);
    expect(await countAwaitingHireDeliveries(["wh1"])).toBe(4);
  });
});

describe("countAwaitingHireDeliveriesByWarehouse", () => {
  const line = (warehouseId: string) => ({ purchaseOrder: { warehouseId } });

  // The warehouse lives on the ORDER, not the line, so this cannot be a groupBy — it is tallied in
  // memory. Small by nature: only hires nobody has received yet.
  it("tallies the awaiting hires per receiving warehouse", async () => {
    rentalLine.findMany.mockResolvedValue([line("wh1"), line("wh2"), line("wh1"), line("wh1")]);
    expect(await countAwaitingHireDeliveriesByWarehouse()).toEqual({ wh1: 3, wh2: 1 });
  });

  it("selects the same rows as the flat count", async () => {
    await countAwaitingHireDeliveriesByWarehouse(["wh1"]);
    const where = whereOf(rentalLine.findMany);
    expect(where.fullyReceived, "the queue is about units still to come, not about a status").toBe(false);
    expect(where.hireStatus).toEqual({ not: "returned" });
    expect(where.hireStartDate).toBeUndefined();
    expect(where.purchaseOrder.is.warehouseId).toEqual({ in: ["wh1"] });
  });

  // A line whose order lost its warehouse would otherwise tally under the key "undefined" and show
  // up as a phantom row on the Warehouses list.
  it("ignores a line whose order names no warehouse", async () => {
    rentalLine.findMany.mockResolvedValue([line("wh1"), { purchaseOrder: null }, { purchaseOrder: { warehouseId: null } }]);
    expect(await countAwaitingHireDeliveriesByWarehouse()).toEqual({ wh1: 1 });
  });

  it("is an empty map when nothing is awaiting", async () => {
    expect(await countAwaitingHireDeliveriesByWarehouse()).toEqual({});
  });
});

// A badge must open exactly the rows it counted. "Hires not yet received" counts
// `overdueDeliveryWhere` (nothing arrived, hire already started) but its link opened `?status=
// awaiting`, which the list resolves to the far broader receiving queue — badge 1, list 2. The
// registry forbids exactly this ("two different queues cannot share one destination"), and no
// OnHireStatus matched the narrower set, so the list gained one.
describe("onHireFilter — every badge has a filter that opens its own rows", () => {
  const TODAY = new Date("2026-09-28T00:00:00.000Z");

  it("resolves `late` to the same predicate the chase badge counts", () => {
    expect(onHireFilter("late", TODAY)).toEqual(overdueDeliveryWhere(TODAY));
  });

  // The receiving queue stays its own, broader filter — it is what the warehouse pane lists.
  it("keeps `awaiting` on the full receiving queue", () => {
    expect(onHireFilter("awaiting", TODAY)).toEqual(awaitingDeliveryWhere());
  });

  it("does not confuse the two", () => {
    expect(onHireFilter("late", TODAY)).not.toEqual(onHireFilter("awaiting", TODAY));
  });
});

// The list endpoint coerces `?status=` against a hand-written whitelist. A value in OnHireStatus but
// missing from that list is silently downgraded to "all" — the badge link would open EVERY live hire
// under a count of 3. Deriving the whitelist from one exported list makes the drift impossible.
describe("ON_HIRE_STATUSES — the vocabulary the endpoint accepts", () => {
  it("accepts every status the filter knows how to resolve", () => {
    // `returned` is the finished-hire register — the one entry that selects rows OUTSIDE the live
    // set. It belongs in this vocabulary for the same reason as the rest: a status the filter can
    // resolve but the endpoint's whitelist has never heard of is silently downgraded to "all".
    expect([...ON_HIRE_STATUSES].sort()).toEqual(["all", "awaiting", "expiring", "late", "overdue", "returned"]);
  });

  it("resolves each one to a predicate rather than falling through to the whole list", () => {
    const TODAY = new Date("2026-09-28T00:00:00.000Z");
    const all = JSON.stringify(onHireFilter("all", TODAY));
    for (const status of ON_HIRE_STATUSES) {
      if (status === "all") continue;
      expect(JSON.stringify(onHireFilter(status, TODAY)), `"${status}" silently means "all"`).not.toBe(all);
    }
  });
});

// ── The finished-hire register ────────────────────────────────────────────────────────────────
//
// The one entry in this vocabulary that selects rows OUTSIDE the live set. Before it existed a hire
// that went back left every rental screen at once — the warehouse pane, the on-hire list and its own
// catalogue page are all live-only — and the only surviving trace was the movement panel on an order
// you had to already know the number of. "What did we spend on hire in July" could not be asked.
describe("`returned` — hires that are finished", () => {
  const TODAY = new Date("2026-09-28T00:00:00.000Z");

  it("selects finished hires, and only on orders that still stand", () => {
    const where = onHireFilter("returned", TODAY) as { hireStatus?: unknown; purchaseOrder?: { is: { status?: unknown } } };
    expect(where).toEqual(returnedWhere());
    expect(where.hireStatus).toBe("returned");
    // A hire on a cancelled order is not hire spend.
    expect(where.purchaseOrder?.is.status).toEqual({ not: "cancelled" });
  });

  // Asked on the STATUS, not on `fullyReturned`: a line whose delivered units all went back but whose
  // remaining units never arrived is `fullyReturned` and still `on_hire` — still owed, still on the
  // receiving queue, and not a completed hire.
  it("does not claim a part-delivered hire is finished just because what arrived went back", () => {
    const where = onHireFilter("returned", TODAY) as { fullyReturned?: unknown };
    expect(where.fullyReturned).toBeUndefined();
  });

  // A live list is a WORKLIST — soonest deadline first, because the top of it is what is owed next. A
  // finished hire owes nothing, so its register reads as history instead. Descending on the same key,
  // so `@@index([hireStatus, hireEndDate])` still serves it.
  it("reads most recently ended first, where the live list reads most urgent first", async () => {
    await listOnHire({ status: "returned", todayStart: TODAY, page: 1, pageSize: 20 });
    expect(rentalLine.findMany.mock.calls[0][0].orderBy).toEqual({ hireEndDate: "desc" });
    rentalLine.findMany.mockClear();
    await listOnHire({ status: "all", todayStart: TODAY, page: 1, pageSize: 20 });
    expect(rentalLine.findMany.mock.calls[0][0].orderBy).toEqual({ hireEndDate: "asc" });
  });
});
