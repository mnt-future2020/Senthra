import { beforeEach, describe, expect, it, vi } from "vitest";

// A count and the list it opens computed by two predicates is a bug this codebase has already been
// bitten by — the attention registry carries comments about it for `?status=rework` and
// `?status=awaiting_send`. This asserts the rental badges cannot repeat it: the badge count, the
// on-hire list and the sweep all filter on the SAME object.
//
// Prisma is mocked at the client so the `where` each call builds is captured verbatim.
// `vi.hoisted` because vi.mock is hoisted above every other statement — a plain const here would
// still be in its temporal dead zone when the factory runs.
// Typed to ACCEPT the query object, not just return a value — an argless `vi.fn` gives
// `mock.calls[0]` an empty-tuple type and the `where` this whole file inspects becomes unreachable.
const { count, findMany } = vi.hoisted(() => ({
  count: vi.fn(async (_args: { where: unknown }) => 0),
  findMany: vi.fn(async (_args: { where: unknown }) => [] as unknown[]),
}));

vi.mock("../../lib/prisma.js", () => ({
  prisma: { purchaseOrderRentalLine: { count, findMany } },
  withTransaction: vi.fn(),
  isWriteConflict: vi.fn(() => false),
}));

import * as poRepo from "./purchase-order.repository.js";
import { expiringSoonWhere, overdueWhere } from "./rentalHire.predicate.js";

const TODAY = new Date("2026-09-28T00:00:00Z");

beforeEach(() => vi.clearAllMocks());

// A SEARCH must narrow the window, never widen it — the whole reason it is written as an AND arm
// rather than a top-level OR. An OR there would sit beside the deadline predicate instead of inside
// it, and one typed word would put every matching hire on screen under a badge that counted three.
describe("a search narrows the badge's window rather than escaping it", () => {
  it("keeps the deadline predicate alongside the text", async () => {
    await poRepo.listOnHire({ status: "overdue", todayStart: TODAY, page: 1, pageSize: 20, search: "Fibre" });
    const where = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where.where).toMatchObject(overdueWhere(TODAY) as Record<string, unknown>);
    expect(where.where.AND).toBeDefined();
  });

  // Prisma injects `contains` into a Mongo $regex UNESCAPED, so a bare "(" is a P2010 -> 500 rather
  // than no results. Every search repository in this codebase escapes first.
  it("escapes the term before it reaches the regex", async () => {
    await poRepo.listOnHire({ status: "all", todayStart: TODAY, page: 1, pageSize: 20, search: "PO-00(6" });
    const where = findMany.mock.calls[0]![0] as { where: { AND: [{ OR: unknown[] }] } };
    expect(JSON.stringify(where.where.AND[0].OR)).toContain("PO-00\\\\(6");
  });
});

describe("the badge count and the list it opens share one predicate", () => {
  it("expiring: the count and the list filter identically", async () => {
    await poRepo.countExpiringHires(TODAY);
    await poRepo.listOnHire({ status: "expiring", todayStart: TODAY, page: 1, pageSize: 20 });

    const counted = count.mock.calls[0]![0] as { where: unknown };
    const listed = findMany.mock.calls[0]![0] as { where: unknown };
    expect(listed.where).toEqual(counted.where);
    expect(counted.where).toEqual(expiringSoonWhere(TODAY));
  });

  it("overdue: the count and the list filter identically", async () => {
    await poRepo.countOverdueHires(TODAY);
    await poRepo.listOnHire({ status: "overdue", todayStart: TODAY, page: 1, pageSize: 20 });

    const counted = count.mock.calls[0]![0] as { where: unknown };
    const listed = findMany.mock.calls[0]![0] as { where: unknown };
    expect(listed.where).toEqual(counted.where);
    expect(counted.where).toEqual(overdueWhere(TODAY));
  });

  // The list's own total must match its rows, so both halves of one page use the same filter.
  it("the list's rows and its total count the same set", async () => {
    await poRepo.listOnHire({ status: "expiring", todayStart: TODAY, page: 1, pageSize: 20 });
    const rowsWhere = (findMany.mock.calls[0]![0] as { where: unknown }).where;
    const totalWhere = (count.mock.calls[0]![0] as { where: unknown }).where;
    expect(totalWhere).toEqual(rowsWhere);
  });

  // The sweep must never email about a hire the badge does not show, so it starts from the same
  // predicate and only narrows further (not-yet-sent, not-currently-leased).
  it("the sweep starts from the expiring predicate", async () => {
    await poRepo.findDueForReminder(TODAY, 100, 5);
    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject(expiringSoonWhere(TODAY) as Record<string, unknown>);
  });
});

// One catalogue item's live hires — the card on its own page, and where a scanned label lands.
describe("narrowing to one rental item", () => {
  it("adds the item to the shared predicate rather than replacing it", async () => {
    await poRepo.listOnHire({ status: "overdue", todayStart: TODAY, page: 1, pageSize: 20, rentalItemId: "a".repeat(24) });
    const listed = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    // Everything the badge asks for is still asked for — the card cannot show a hire the badge would
    // not count, only fewer of them.
    expect(listed.where).toMatchObject({ ...overdueWhere(TODAY), rentalItemId: "a".repeat(24) });
  });

  it("leaves the predicate untouched when no item is named", async () => {
    await poRepo.listOnHire({ status: "overdue", todayStart: TODAY, page: 1, pageSize: 20 });
    const listed = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(listed.where).toEqual(overdueWhere(TODAY));
  });
});
