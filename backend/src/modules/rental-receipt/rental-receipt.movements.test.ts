import { beforeEach, describe, expect, it, vi } from "vitest";

// The two reads a period report is built on, at the layer that writes the query.
//
//   movementDatesByHireLine  — when each hire physically started and ended
//   findMany / count         — the register's filter set
//
// Prisma is stubbed to exactly those calls: what is under test is WHICH rows the query selects, and
// that is decided entirely by the `where` this file hands over.

const { receiptLine, receipt } = vi.hoisted(() => ({
  receiptLine: { findMany: vi.fn() },
  receipt: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("../../lib/prisma.js", () => ({
  prisma: { rentalReceiptLine: receiptLine, rentalReceipt: receipt },
  withTransaction: vi.fn(),
}));

import { count, findMany, movementDatesByHireLine } from "./rental-receipt.repository.js";

const H1 = "a".repeat(24);
const H2 = "b".repeat(24);

const moved = (lineId: string, direction: string, date: string) => ({
  purchaseOrderRentalLineId: lineId,
  rentalReceipt: { direction, deliveryDate: new Date(date) },
});

beforeEach(() => {
  receiptLine.findMany.mockReset().mockResolvedValue([]);
  receipt.findMany.mockReset().mockResolvedValue([]);
  receipt.count.mockReset().mockResolvedValue(0);
});

describe("the hire's physical window", () => {
  // A hire arrives in parts and goes back in parts. The window is the OUTER pair: the clock starts on
  // the first unit through the door and stops on the last one collected. Taking either from a single
  // note would price a 6-week hire as a 2-week one.
  it("runs from the first delivery to the last collection", async () => {
    receiptLine.findMany.mockResolvedValue([
      moved(H1, "in", "2026-06-02T00:00:00.000Z"),
      moved(H1, "in", "2026-06-09T00:00:00.000Z"),
      moved(H1, "out", "2026-07-14T00:00:00.000Z"),
      moved(H1, "out", "2026-07-20T00:00:00.000Z"),
    ]);
    const m = await movementDatesByHireLine([H1]);
    expect(m.get(H1)).toEqual({
      deliveredOn: new Date("2026-06-02T00:00:00.000Z"),
      collectedOn: new Date("2026-07-20T00:00:00.000Z"),
    });
  });

  // A hire still out has a start and no end. Absent, not a date and not a zero — see HireMovementDates.
  it("leaves the far end absent while the kit is still out", async () => {
    receiptLine.findMany.mockResolvedValue([moved(H1, "in", "2026-06-02T00:00:00.000Z")]);
    expect(await movementDatesByHireLine([H1])).toEqual(new Map([[H1, { deliveredOn: new Date("2026-06-02T00:00:00.000Z") }]]));
  });

  it("keeps each hire line's window to itself", async () => {
    receiptLine.findMany.mockResolvedValue([
      moved(H1, "in", "2026-06-02T00:00:00.000Z"),
      moved(H2, "in", "2026-06-30T00:00:00.000Z"),
    ]);
    const m = await movementDatesByHireLine([H1, H2]);
    expect(m.get(H2)?.deliveredOn).toEqual(new Date("2026-06-30T00:00:00.000Z"));
  });

  // Rows written before `direction` existed have no direction stored at all, and they are deliveries.
  // The classification is done in the REDUCTION rather than by the query, precisely so an absent
  // value stays readable: in MongoDB a missing field matches `$ne` but not `$in`, so a query-side
  // filter would have to be written one exact way to avoid dropping every legacy delivery.
  it("treats a note with no direction as the delivery it is", async () => {
    receiptLine.findMany.mockResolvedValue([
      { purchaseOrderRentalLineId: H1, damageChargePence: null, rentalReceipt: { direction: null, deliveryDate: new Date("2026-05-01T00:00:00.000Z") } },
    ]);
    expect((await movementDatesByHireLine([H1])).get(H1)?.deliveredOn).toEqual(new Date("2026-05-01T00:00:00.000Z"));
  });

  // A damage report moves nothing, so it must never start or end the hire's clock — but it is the
  // leg that usually carries the money, so it cannot simply be filtered out of the query either.
  it("takes the charge from a damage report without letting it move the dates", async () => {
    receiptLine.findMany.mockResolvedValue([
      { ...moved(H1, "in", "2026-06-02T00:00:00.000Z"), damageChargePence: null },
      { ...moved(H1, "damage", "2026-06-20T00:00:00.000Z"), damageChargePence: 45_000 },
    ]);
    const m = await movementDatesByHireLine([H1]);
    expect(m.get(H1)?.deliveredOn).toEqual(new Date("2026-06-02T00:00:00.000Z"));
    expect(m.get(H1)?.collectedOn).toBeUndefined();
    expect(m.get(H1)?.damageChargePence).toBe(45_000);
  });

  // Several reports on one hire add up; a hire with nothing quoted has NO figure, which is a
  // different answer from zero and is what stops it being treated as settled.
  it("adds up every charge on the hire, and reports none as absent", async () => {
    receiptLine.findMany.mockResolvedValue([
      { ...moved(H1, "damage", "2026-06-20T00:00:00.000Z"), damageChargePence: 45_000 },
      { ...moved(H1, "out", "2026-07-14T00:00:00.000Z"), damageChargePence: 12_500 },
      { ...moved(H2, "out", "2026-07-14T00:00:00.000Z"), damageChargePence: null },
    ]);
    const m = await movementDatesByHireLine([H1, H2]);
    expect(m.get(H1)?.damageChargePence).toBe(57_500);
    expect(m.get(H2)?.damageChargePence).toBeUndefined();
  });

  // Damage that came WITH the kit is the supplier's own fault. The service refuses to set a charge on
  // an arrival at all; the sum refuses to read one, so a row written any other way cannot bill us.
  it("never bills us for damage that arrived with the kit", async () => {
    receiptLine.findMany.mockResolvedValue([
      { ...moved(H1, "in", "2026-06-02T00:00:00.000Z"), damageChargePence: 99_000 },
    ]);
    expect((await movementDatesByHireLine([H1])).get(H1)?.damageChargePence).toBeUndefined();
  });

  // A damage report moves nothing, and a REVERSED note moved nothing either. Both must stay out of a
  // window that a supplier invoice is checked against.
  it("reads only live deliveries and returns", async () => {
    await movementDatesByHireLine([H1]);
    const where = receiptLine.findMany.mock.calls[0][0].where;
    expect(where.rentalReceipt.is.OR).toEqual([{ reversedAt: null }, { reversedAt: { isSet: false } }]);
  });

  // `{ in: [] }` is a valid filter that matches nothing, but the round trip is still a round trip —
  // and this runs on every page of the on-hire list.
  it("does not go to the database for an empty page", async () => {
    expect(await movementDatesByHireLine([])).toEqual(new Map());
    expect(receiptLine.findMany).not.toHaveBeenCalled();
  });
});

describe("the register's filter", () => {
  const whereOf = () => receipt.findMany.mock.calls[0][0].where;
  /** The search arms, wherever they are ANDed on. */
  const searchArms = () =>
    ((whereOf().AND ?? []) as { OR?: unknown[] }[]).flatMap((a) => a.OR ?? []) as Record<string, unknown>[];
  const liveArm = () => ((whereOf().AND ?? []) as { OR?: unknown[] }[]).find((a) => JSON.stringify(a).includes("reversedAt"));

  it("bounds the period on the date the equipment moved", async () => {
    await findMany({ dateFrom: new Date("2026-07-01T00:00:00.000Z"), dateTo: new Date("2026-07-31T23:59:59.999Z") });
    expect(whereOf().deliveryDate).toEqual({
      gte: new Date("2026-07-01T00:00:00.000Z"),
      lte: new Date("2026-07-31T23:59:59.999Z"),
    });
  });

  // Sorted on when it HAPPENED, not on when it was typed: a note entered late belongs where it
  // happened, or a period read off this list is missing rows that are in the export.
  it("reads newest movement first", async () => {
    await findMany({});
    expect(receipt.findMany.mock.calls[0][0].orderBy[0]).toEqual({ deliveryDate: "desc" });
  });

  // A chosen warehouse narrows the caller's permitted set. It must never replace it — that would let
  // a warehouse-scoped user read another site's movements by typing its id into the query string.
  it("keeps the actor's scope when a warehouse is also chosen", async () => {
    await findMany({ warehouseId: H1, warehouseIds: [H2] });
    expect(whereOf().warehouseId).toEqual({ equals: H1, in: [H2] });
  });

  it("excludes reversed notes only when asked", async () => {
    await findMany({ includeReversed: false });
    expect(liveArm()).toEqual({ OR: [{ reversedAt: null }, { reversedAt: { isSet: false } }] });
    receipt.findMany.mockClear();
    await findMany({});
    expect(whereOf().AND).toBeUndefined();
  });

  // THE ONE THAT WAS MISSING, and the bug it would have caught shipped because of it: both clauses
  // wanted a top-level `OR`, the search was assigned second, and it silently erased the live filter.
  // Typing into the box put reversed notes back into a list — and an export — that still showed its
  // "Hide reversed" filter as on. Each was covered alone; neither test used the two together.
  it("keeps hiding reversed notes while a search is typed", async () => {
    await findMany({ includeReversed: false, search: "HRN" });
    expect(liveArm(), "the live filter was clobbered by the search").toBeDefined();
    expect(searchArms().length).toBeGreaterThan(0);
  });

  // Prisma injects `contains` into a Mongo $regex UNESCAPED, so an unescaped "(" from a search box is
  // a P2010 → 500 rather than no results. Every search repository in this codebase escapes first.
  it("escapes a search term before it reaches the regex", async () => {
    await findMany({ search: "PO-00(6" });
    expect(JSON.stringify(searchArms())).toContain("PO-00\\\\(6");
  });

  // THE ONE IDENTIFIER HERE THAT NAMES A PHYSICAL UNIT. Everything else describes a movement; the
  // supplier's tag describes the tester. Without it, "when did FT-9 arrive and in what condition" —
  // the question a damage dispute is actually argued on — could only be answered by downloading the
  // lines CSV and searching the file.
  it("finds a note by the supplier's asset tag", async () => {
    await findMany({ search: "FT-9" });
    const arms = searchArms() as { lines?: { some: { assetTags: { hasSome: string[] } } } }[];
    const tagArm = arms.find((a) => a.lines);
    expect(tagArm?.lines?.some.assetTags.hasSome).toContain("FT-9");
  });

  // Tags are typed as they are printed, and Mongo's `has` is case-SENSITIVE — "ft-9" would otherwise
  // find nothing at all on a sheet reading "FT-9".
  it("matches a tag whatever case it is typed in", async () => {
    await findMany({ search: "ft-9" });
    const arms = searchArms() as { lines?: { some: { assetTags: { hasSome: string[] } } } }[];
    const variants = arms.find((a) => a.lines)?.lines?.some.assetTags.hasSome ?? [];
    expect(variants).toEqual(expect.arrayContaining(["ft-9", "FT-9"]));
  });

  // Whole values, compared by Mongo rather than injected into a pattern — so unlike the `contains`
  // arms beside it, a bracket in a tag is a bracket and must NOT arrive escaped.
  it("does not regex-escape the tag it compares", async () => {
    await findMany({ search: "FT(9)" });
    const arms = searchArms() as { lines?: { some: { assetTags: { hasSome: string[] } } } }[];
    expect(arms.find((a) => a.lines)?.lines?.some.assetTags.hasSome).toContain("FT(9)");
  });

  it("counts exactly what it lists", async () => {
    await count({ direction: "out", supplierId: "s1" });
    expect(receipt.count.mock.calls[0][0].where).toMatchObject({ direction: "out", supplierId: "s1" });
  });
});
