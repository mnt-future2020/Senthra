import { beforeEach, describe, expect, it, vi } from "vitest";

// countAttention's four `where` clauses. Written after both of its portal-invite clauses shipped
// broken at once, in the two ways this shape fails — one loud, one silent:
//
//   `deletedAt: null` on customerUser — the field does not exist on that model (it lives on the
//   parent Customer), so every call threw PrismaClientValidationError at runtime. TypeScript did
//   NOT catch it, which is the whole reason these assertions are worth writing.
//
//   `lastLoginAt: null` alone — matches only rows where the field is explicitly null, and nothing
//   ever writes it, so a never-signed-in user has it ABSENT. Verified against the real database:
//   the naive clause returned 0 where the isSet variant returned 2.
//
// The second is the dangerous one. A crash gets reported; a badge stuck at zero reads as "no work
// outstanding" and nobody looks again.
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    customerStockRequest: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
    customerStockWarehouseAssignment: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
    customerStockEntry: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
    customerUser: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
  },
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { prisma } from "../../lib/prisma.js";
import { countAttention, countAttentionByCustomer, countIntakeByWarehouse } from "./customer.repository.js";

const inviteCount = prisma.customerUser.count as ReturnType<typeof vi.fn>;
const assignmentCount = prisma.customerStockWarehouseAssignment.count as ReturnType<typeof vi.fn>;
const entryCount = prisma.customerStockEntry.count as ReturnType<typeof vi.fn>;
const requestCount = prisma.customerStockRequest.count as ReturnType<typeof vi.fn>;

const inviteWhere = () => inviteCount.mock.calls.at(-1)?.[0].where;

beforeEach(() => vi.clearAllMocks());

describe("countAttention — portal invites pending", () => {
  it("matches a never-signed-in user whether lastLoginAt is null or absent", async () => {
    await countAttention();
    expect(inviteWhere().OR).toEqual([{ lastLoginAt: null }, { lastLoginAt: { isSet: false } }]);
  });

  // The bare form is the bug: it is what made the count sit at 0 with invites genuinely outstanding.
  it("never narrows to lastLoginAt: null on its own", async () => {
    await countAttention();
    expect(inviteWhere().lastLoginAt).toBeUndefined();
  });

  // CustomerUser has no deletedAt — asking for one is what threw. The soft-delete is on the parent,
  // so a deleted company must stop generating "chase this invite" work through the relation.
  it("scopes the soft-delete through the customer relation, not the user", async () => {
    await countAttention();
    expect(inviteWhere()).not.toHaveProperty("deletedAt");
    expect(inviteWhere().customer).toEqual({ deletedAt: null });
  });

  // Both halves of "invited but never used it". Without mustResetPassword a pre-existing contact row
  // — one that was never invited and has no password — would be counted as an outstanding invite.
  it("counts only active users who still owe a first sign-in", async () => {
    await countAttention();
    expect(inviteWhere().status).toBe("active");
    expect(inviteWhere().mustResetPassword).toBe(true);
  });
});

describe("countAttention — warehouse scoping", () => {
  // Floor work is scoped to the actor's warehouses; the pending-review queue is not, because no
  // warehouse has been assigned to those requests yet. Getting that backwards would either hide
  // another manager's queue or show every manager the whole company's.
  it("scopes the warehouse-floor counts and leaves the review queue company-wide", async () => {
    await countAttention(["wh1", "wh2"]);
    expect(assignmentCount.mock.calls.at(-1)?.[0].where.warehouseId).toEqual({ in: ["wh1", "wh2"] });
    expect(entryCount.mock.calls.at(-1)?.[0].where.warehouseId).toEqual({ in: ["wh1", "wh2"] });
    expect(requestCount.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
  });

  // An unscoped caller (a company-wide role) must see every warehouse, not none.
  it("applies no warehouse filter when the caller has no scope", async () => {
    await countAttention();
    expect(assignmentCount.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
    expect(entryCount.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
  });
});

// The same four counts, split per entity — the per-row numbers on the Warehouses and Customers lists.
// These two queues have no cross-entity screen at all (a submission is reviewed on the customer's own
// page), so the row IS the navigation: if a split disagrees with the flat count, the badge says there
// is work and no row admits to holding it.
const assignmentGroup = prisma.customerStockWarehouseAssignment.groupBy as ReturnType<typeof vi.fn>;
const entryGroup = prisma.customerStockEntry.groupBy as ReturnType<typeof vi.fn>;
const requestGroup = prisma.customerStockRequest.groupBy as ReturnType<typeof vi.fn>;
const inviteGroup = prisma.customerUser.groupBy as ReturnType<typeof vi.fn>;

describe("countIntakeByWarehouse", () => {
  it("keys each queue by warehouse and drops the grouping wrapper", async () => {
    assignmentGroup.mockResolvedValue([
      { warehouseId: "wh1", _count: { _all: 3 } },
      { warehouseId: "wh2", _count: { _all: 1 } },
    ]);
    entryGroup.mockResolvedValue([{ warehouseId: "wh2", _count: { _all: 5 } }]);
    expect(await countIntakeByWarehouse()).toEqual({
      assignmentsOpen: { wh1: 3, wh2: 1 },
      stockEntryDrafts: { wh2: 5 },
    });
  });

  it("uses the same predicates as the flat count, so a row can't disagree with the badge", async () => {
    await countIntakeByWarehouse(["wh1"]);
    await countAttention(["wh1"]);
    expect(assignmentGroup.mock.calls.at(-1)?.[0].where).toEqual(assignmentCount.mock.calls.at(-1)?.[0].where);
    expect(entryGroup.mock.calls.at(-1)?.[0].where).toEqual(entryCount.mock.calls.at(-1)?.[0].where);
  });

  it("applies no warehouse filter for an unscoped caller", async () => {
    await countIntakeByWarehouse();
    expect(assignmentGroup.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
  });

  // A warehouse with nothing outstanding produces no group. The column shows a dash there, so the
  // absence has to survive as absence rather than being invented as a zero.
  it("returns empty maps when nothing is outstanding", async () => {
    assignmentGroup.mockResolvedValue([]);
    entryGroup.mockResolvedValue([]);
    expect(await countIntakeByWarehouse()).toEqual({ assignmentsOpen: {}, stockEntryDrafts: {} });
  });
});

describe("countAttentionByCustomer", () => {
  it("keys every queue by customer", async () => {
    // groupBy calls resolve in declaration order: pending, approved, invites.
    requestGroup
      .mockResolvedValueOnce([{ customerId: "c1", _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ customerId: "c3", _count: { _all: 1 } }]);
    inviteGroup.mockResolvedValue([{ customerId: "c2", _count: { _all: 1 } }]);
    expect(await countAttentionByCustomer()).toEqual({
      stockRequestsPending: { c1: 2 },
      stockRequestsAwaitingAssignment: { c3: 1 },
      portalInvitesPending: { c2: 1 },
    });
  });

  // `approved` means reviewed but NOT yet routed to warehouses — the "Assign warehouses" button.
  // It was counted by nothing: the pending count stops before it, and the assignment count can only
  // see assignments that already exist, which is what this step creates. So approving a request took
  // it out of every badge while the work was still outstanding.
  it("counts approved-but-unassigned separately from pending", async () => {
    await countAttentionByCustomer();
    const wheres = requestGroup.mock.calls.map((c) => c[0].where);
    expect(wheres).toEqual([{ status: "pending" }, { status: "approved" }]);
  });

  // The trap that made the FLAT invite count sit at zero for good: nothing writes lastLoginAt on
  // create, so a never-signed-in user has it absent, and absent is not null. The split is a second
  // copy of that predicate and would fail the same silent way on its own.
  it("carries the lastLoginAt null-or-absent guard into the split", async () => {
    await countAttentionByCustomer();
    expect(inviteGroup.mock.calls.at(-1)?.[0].where.OR).toEqual([
      { lastLoginAt: null },
      { lastLoginAt: { isSet: false } },
    ]);
  });

  it("matches the flat count's predicates exactly", async () => {
    await countAttentionByCustomer();
    await countAttention();
    expect(inviteGroup.mock.calls.at(-1)?.[0].where).toEqual(inviteCount.mock.calls.at(-1)?.[0].where);
    expect(requestGroup.mock.calls.at(-1)?.[0].where).toEqual(requestCount.mock.calls.at(-1)?.[0].where);
  });

  // Neither queue is warehouse-bound — a submission has not been assigned to a warehouse yet, and a
  // portal invite never is. Scoping either would hide work from the person who has to do it.
  it("takes no warehouse scope at all", async () => {
    await countAttentionByCustomer();
    expect(requestGroup.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
    expect(inviteGroup.mock.calls.at(-1)?.[0].where).not.toHaveProperty("warehouseId");
  });
});
