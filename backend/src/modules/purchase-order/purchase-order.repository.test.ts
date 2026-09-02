import { beforeEach, describe, expect, it } from "vitest";

// Mock lib/prisma so importing the repository never constructs a real Prisma client —
// buildWhere is a pure where-clause builder with no I/O. `purchaseOrder` carries the two calls
// `updateStatusIf` makes, so the guarded transition can be exercised against a fake row.
import { vi } from "vitest";
vi.mock("../../lib/prisma.js", () => ({
  prisma: { purchaseOrder: { updateMany: vi.fn(), findFirst: vi.fn() } },
}));

import { prisma } from "../../lib/prisma.js";
import { awaitingClosePoWhere, buildWhere, LIVE_GRN, RECEIVABLE_PO_STATUSES, updateStatusIf, withRelations } from "./purchase-order.repository.js";

describe("buildWhere — PO list status filtering", () => {
  it("maps a single status to an equality filter (backward compatible)", () => {
    expect(buildWhere({ status: "sent" }).status).toBe("sent");
  });

  it("maps multiple statuses to an `in` filter", () => {
    expect(buildWhere({ statuses: ["sent", "partially_received"] }).status).toEqual({
      in: ["sent", "partially_received"],
    });
  });

  it("prefers `statuses` over a single `status` when both are given", () => {
    expect(buildWhere({ status: "draft", statuses: ["sent", "partially_received"] }).status).toEqual({
      in: ["sent", "partially_received"],
    });
  });

  it("ignores an empty `statuses` array and falls back to `status`", () => {
    expect(buildWhere({ status: "sent", statuses: [] }).status).toBe("sent");
  });

  it("always excludes soft-deleted rows", () => {
    expect(buildWhere({}).deletedAt).toBeNull();
    expect(buildWhere({}).status).toBeUndefined();
  });
});

describe("buildWhere — the `overdue` derived pseudo-status", () => {
  const DAY_START = new Date("2026-08-07T00:00:00.000Z");

  it("narrows to the receivable window, not every sent PO", () => {
    // The whole point of the pseudo-status: the "Deliveries overdue" badge must open exactly its own
    // rows. `?status=sent` would also list POs that are early or have no ETA at all.
    expect(buildWhere({ status: "overdue", overdueBefore: DAY_START }).status).toEqual({
      in: ["sent", "supplier_accepted", "partially_received"],
    });
  });

  it("treats the CONFIRMED date as authoritative and falls back to expected only when it is unset", () => {
    const where = buildWhere({ status: "overdue", overdueBefore: DAY_START });
    // `confirmed ?? expected < dayStart` — the same rule expectedDeliveries applies in memory. The
    // fallback branch must still require confirmedDeliveryDate to be UNSET, or a PO the supplier
    // re-confirmed for NEXT week would count as overdue on its stale original date.
    expect(where.AND).toEqual([
      {
        OR: [
          { confirmedDeliveryDate: { lt: DAY_START } },
          {
            OR: [{ confirmedDeliveryDate: null }, { confirmedDeliveryDate: { isSet: false } }],
            expectedDeliveryDate: { lt: DAY_START },
          },
        ],
      },
    ]);
  });

  // THE regression this pair exists for. `confirmedDeliveryDate: null` on its own matches only rows
  // where the field is EXPLICITLY null — and nothing writes it on create; recordSupplierAcceptance is
  // the only path that ever sets it. So on every PO still awaiting acknowledgement the field is
  // ABSENT, and in Mongo absent is not null.
  //
  // The badge reads `confirmed ?? expected` in memory, where undefined falls through. This clause did
  // not, so a `sent` PO with a past expected date was counted as overdue and then hidden from the
  // list that count opens: "Deliveries overdue 8" opened six rows, every one Supplier Accepted, with
  // the un-acknowledged ones — the ones most worth chasing — missing.
  //
  // Same shape as the fix already applied to the portal-invite count's `lastLoginAt`. This is the
  // second time this trap has shipped; the assertion is here so there isn't a third.
  it("matches a PO whose confirmed date was never written, not just one explicitly null", () => {
    const fallback = (buildWhere({ status: "overdue", overdueBefore: DAY_START }).AND as Array<{
      OR: Array<Record<string, unknown>>;
    }>)[0].OR[1] as { OR: Array<Record<string, unknown>> };
    expect(fallback.OR).toEqual([{ confirmedDeliveryDate: null }, { confirmedDeliveryDate: { isSet: false } }]);
  });

  // Absent-vs-null is only half of it: the fallback must STILL be gated on the expected date, or the
  // filter would return every un-acknowledged PO regardless of when it is due.
  it("still requires a past expected date on the fallback arm", () => {
    const fallback = (buildWhere({ status: "overdue", overdueBefore: DAY_START }).AND as Array<{
      OR: Array<Record<string, unknown>>;
    }>)[0].OR[1];
    expect(fallback).toMatchObject({ expectedDeliveryDate: { lt: DAY_START } });
  });

  it("composes with warehouse scoping instead of overwriting it", () => {
    // Both conditions live in AND; a scoped actor must never be widened to another warehouse's
    // overdue deliveries just because they picked this filter.
    const where = buildWhere({ status: "overdue", overdueBefore: DAY_START, warehouseIds: ["w1"] });
    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({ warehouseId: { in: ["w1"] } });
  });

  it("keeps the date condition out of the search OR", () => {
    // Search writes `where.OR`. If the date rule lived there too it would be clobbered, silently
    // turning "overdue matching X" into "every receivable PO matching X".
    const where = buildWhere({ status: "overdue", overdueBefore: DAY_START, search: "PO-1" });
    expect(where.OR).toEqual([
      { code: { contains: "PO-1", mode: "insensitive" } },
      { supplierName: { contains: "PO-1", mode: "insensitive" } },
      { referenceNumber: { contains: "PO-1", mode: "insensitive" } },
    ]);
    expect(where.AND).toHaveLength(1);
  });

  it("THROWS without a day boundary rather than quietly returning nothing", () => {
    // A missing boundary is a wiring bug. Defaulting would report "no overdue deliveries", which is
    // invisible and wrong — exactly the failure this badge exists to prevent.
    expect(() => buildWhere({ status: "overdue" })).toThrow(/overdueBefore is required/);
  });

  it("leaves every other status untouched", () => {
    expect(buildWhere({ status: "sent" }).AND).toBeUndefined();
    expect(buildWhere({ statuses: ["sent"] }).AND).toBeUndefined();
  });
});

// These two exist so an attention badge opens EXACTLY the rows it counted. Each queue spans more
// than one real status, so before they existed the badge summed the queue while its href pointed at
// a single stored status — "7 POs to approve" opened a list of 4.
describe("buildWhere — the `awaiting_approval` derived pseudo-status", () => {
  it("covers PRF-born drafts as well as explicitly submitted rows", () => {
    // A fast-path PO is created straight into `draft` and is ALREADY awaiting sign-off. Filtering on
    // `pending_approval` alone hid every one of them.
    expect(buildWhere({ status: "awaiting_approval" }).AND).toEqual([
      {
        OR: [{ status: "draft", purchaseRequestId: { not: null } }, { status: "pending_approval" }],
      },
    ]);
  });

  it("does not match a hand-made draft that was never raised from a PRF", () => {
    // `purchaseRequestId: not null` is what separates "generated, awaiting approval" from "someone is
    // still typing it". Without it every unfinished draft would land in the approval queue.
    const [clause] = buildWhere({ status: "awaiting_approval" }).AND as [{ OR: unknown[] }];
    expect(clause.OR[0]).toEqual({ status: "draft", purchaseRequestId: { not: null } });
  });

  it("composes with warehouse scoping and keeps the queue out of the search OR", () => {
    const where = buildWhere({ status: "awaiting_approval", warehouseIds: ["w1"], search: "PO-1" });
    expect(where.AND).toHaveLength(2);
    expect(where.AND).toContainEqual({ warehouseId: { in: ["w1"] } });
    // Search owns `where.OR`; the queue must not be clobbered by it.
    expect(where.OR).toHaveLength(3);
  });
});

describe("buildWhere — the `awaiting_send` derived pseudo-status", () => {
  it("covers both approved (no PM yet) and pm_review (assigned, awaiting the send)", () => {
    expect(buildWhere({ status: "awaiting_send" }).AND).toEqual([
      { OR: [{ status: "approved" }, { status: "pm_review" }] },
    ]);
  });

  it("scopes ONLY the pm_review half to one PM", () => {
    // An approved PO has no pmUserId. Applying the PM filter to both halves would drop every
    // approved row and leave the list showing fewer than the badge counted — the original bug.
    expect(buildWhere({ status: "awaiting_send", pmScopeUserId: "u1" }).AND).toEqual([
      { OR: [{ status: "approved" }, { status: "pm_review", pmUserId: "u1" }] },
    ]);
  });

  it("ignores pmScopeUserId for every other status", () => {
    // A plain pm_review filter is what `pmUserId` is for; the scope hint must not leak elsewhere.
    expect(buildWhere({ status: "sent", pmScopeUserId: "u1" }).AND).toBeUndefined();
    expect(buildWhere({ status: "sent", pmScopeUserId: "u1" }).status).toBe("sent");
  });
});

// The badge counts `status IN RECEIVABLE_PO_STATUSES`; the chip used to open `?status=sent`, which is
// one of those three. So "Deliveries to receive · 14" opened a list of 7 — and that list was already
// the "Awaiting supplier acceptance · 7" chip's, sitting right beside it.
describe("buildWhere — the `receivable` derived pseudo-status", () => {
  it("spans every status a warehouse can still book stock in against", () => {
    expect(buildWhere({ status: "receivable" }).status).toEqual({
      in: ["sent", "supplier_accepted", "partially_received"],
    });
  });

  // The count and the list must be one predicate, not two that happen to agree today.
  it("opens exactly the rows countAttention measures", () => {
    expect(buildWhere({ status: "receivable" }).status).toEqual({ in: [...RECEIVABLE_PO_STATUSES] });
  });

  // `sent` alone stays its own filter — it is the supplier-acceptance queue, a different question.
  it("is not the same filter as ?status=sent", () => {
    expect(buildWhere({ status: "sent" }).status).not.toEqual(buildWhere({ status: "receivable" }).status);
  });

  // Unlike `overdue`, it needs no date boundary — it is a pure status set.
  it("needs no overdueBefore", () => {
    expect(() => buildWhere({ status: "receivable" })).not.toThrow();
    expect(buildWhere({ status: "receivable" }).AND).toBeUndefined();
  });

  it("still composes with warehouse scoping", () => {
    const where = buildWhere({ status: "receivable", warehouseIds: ["w1"] });
    expect(where.status).toEqual({ in: [...RECEIVABLE_PO_STATUSES] });
    expect(where.AND).toEqual([{ warehouseId: { in: ["w1"] } }]);
  });
});


// The chain strip renders every one of these as a clickable node, and a draft goods receipt can be
// deleted — so an unfiltered list put a button on the order that landed on "Goods receipt not
// found." Exactly what a deleted purchase order did to the request that generated it.
describe("the chained goods receipts are LIVE only", () => {
  it("filters deleted receipts out of the include", () => {
    expect(withRelations.goodsReceipts.where).toEqual(LIVE_GRN);
  });

  // Mongo: `{ deletedAt: null }` alone misses a row whose create omitted the field.
  it("accepts both the null and the missing shape", () => {
    expect(LIVE_GRN.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }]);
  });
});

// ── "Received — ready to close" ─────────────────────────────────────────────────────────────────
//
// `fully_received` alone answered the wrong question on a rental order. It means every ordered unit
// ARRIVED, which stays true forever once it happens — but a hire is a round trip, and closePurchaseOrder
// refuses an order whose kit is still out. So the badge counted orders it was impossible to act on,
// and the first rule of the attention registry is that a count means work a human still owes.
describe("buildWhere — the `awaiting_close` derived pseudo-status", () => {
  it("asks for orders that have arrived AND have nothing still on hire", () => {
    const where = buildWhere({ status: "awaiting_close" });
    expect(where).toMatchObject(awaitingClosePoWhere());
    expect(where.status).toBe("fully_received");
  });

  // Both terminal states, via the predicate the close guard itself uses — a hire that went back and
  // one closed short are equally finished, and the two must not drift into disagreeing.
  it("counts a hire as finished only when it is returned or cancelled", () => {
    const where = awaitingClosePoWhere();
    expect(where.rentalItems).toEqual({ none: { hireStatus: { notIn: ["returned", "cancelled"] } } });
  });

  // A goods-only order has no rental lines at all, so `none` is vacuously true and it still counts —
  // which is the behaviour that must not change for every non-rental order in the system.
  it("leaves a goods-only order exactly where it was", () => {
    expect(buildWhere({ status: "awaiting_close" }).status).toBe("fully_received");
  });

  it("composes with a search rather than being clobbered by it", () => {
    const where = buildWhere({ status: "awaiting_close", search: "PO-1" });
    expect(where.rentalItems).toBeDefined();
    expect(where.OR).toHaveLength(3);
  });
});

// ── updateStatusIf — the guarded header transition ────────────────────────────────────────────
//
// The defence `updateRentalLineIf` gives a hire line, applied to the order header. What matters is
// that the expected status travels INTO the write: a check made before the write is not a guard,
// because a second request can pass the identical check on the identical status and Mongo raises
// nothing when the two writes never overlap in time.
describe("updateStatusIf — the expected status is part of the write, not a prior check", () => {
  const mockUpdateMany = prisma.purchaseOrder.updateMany as ReturnType<typeof vi.fn>;
  const mockFindFirst = prisma.purchaseOrder.findFirst as ReturnType<typeof vi.fn>;
  const PO_ID = "f".repeat(24);

  beforeEach(() => vi.clearAllMocks());

  it("carries the expected status in the WHERE clause", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindFirst.mockResolvedValue({ id: PO_ID, status: "sent" });
    await updateStatusIf(PO_ID, "approved", { status: "sent" });
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: PO_ID, status: "approved" },
      data: { status: "sent" },
    });
  });

  it("returns the fresh row when the guard held", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindFirst.mockResolvedValue({ id: PO_ID, status: "sent" });
    await expect(updateStatusIf(PO_ID, "approved", { status: "sent" })).resolves.toMatchObject({ status: "sent" });
  });

  // The loser of a race: the row moved on, so the filter matched nothing. `null` — never a throw,
  // and never a silent success — is what lets the service answer with a 409 that names the new status
  // rather than a 500 the client would retry straight back into.
  it("returns null when the row had already moved, and does not re-read it", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await expect(updateStatusIf(PO_ID, "approved", { status: "sent" })).resolves.toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  // Two requests, one row, real ordering: the second must find the status already moved. This is the
  // regression — before the guard, both `where: { id }` writes landed and both callers proceeded to
  // email the supplier and archive a document of record.
  it("lets exactly one of two concurrent transitions through", async () => {
    let status = "approved";
    mockUpdateMany.mockImplementation(async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
      if (status !== where.status) return { count: 0 };
      status = data.status;
      return { count: 1 };
    });
    mockFindFirst.mockImplementation(async () => ({ id: PO_ID, status }));

    const results = await Promise.all([
      updateStatusIf(PO_ID, "approved", { status: "sent" }),
      updateStatusIf(PO_ID, "approved", { status: "sent" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(status).toBe("sent");
  });
});
