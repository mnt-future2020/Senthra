import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ prisma: { hireCustodyExit: { findMany: vi.fn() } } }));

import { prisma } from "../../lib/prisma.js";
import type { NewCustodyExit } from "./hireCustodyExit.repository.js";
import {
  CUSTODY_HELD_DAMAGED,
  CUSTODY_LOST,
  SETTLE_SETTLED,
  SETTLE_UNSETTLED,
  CUSTODY_RETURNED_TO_SUPPLIER,
  CUSTODY_WITHDRAWN,
  SETTLE_DISMISSED,
  createExitTx,
  damageCapFiguresByLines,
  recomputeCountersTx,
  reconcileDamageCustodyTx,
  withdrawDamageExitTx,
} from "./hireCustodyExit.repository.js";

const LINE = "e".repeat(24);
const RECEIPT = "r".repeat(24);

/** Matches a Prisma `where` against a plain row, including the `{ in: [...] }` form these use. */
const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) =>
    v !== null && typeof v === "object" && Array.isArray((v as { in?: unknown[] }).in)
      ? (v as { in: unknown[] }).in.includes(row[k])
      : row[k] === v,
  );

/** A tiny in-memory stand-in for the two collections these functions touch. */
function makeTx(rows: Record<string, unknown>[], hire: Record<string, unknown> = {}) {
  const line: Record<string, unknown> = { ...hire };
  return {
    line,
    rows,
    tx: {
      hireCustodyExit: {
        findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
          let out = rows.filter((r) => matches(r, where));
          if (orderBy) {
            // `declaredAt` then `id`, the same tie-break the reconciliation depends on for a stable
            // partition — a split shares its parent's date exactly.
            out = [...out].sort(
              (a, b) =>
                (a.declaredAt as Date).getTime() - (b.declaredAt as Date).getTime() ||
                String(a.id).localeCompare(String(b.id)),
            );
          }
          return out;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const hit = rows.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        },
        count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `x${rows.length}`, ...data };
          rows.push(row);
          return row;
        },
      },
      purchaseOrderRentalLine: {
        findUnique: async () => line,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(line, data);
          return line;
        },
      },
    } as never,
  };
}

const damageRow = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  purchaseOrderRentalLineId: LINE,
  purchaseOrderId: "9".repeat(24),
  poCode: "PO-0042",
  warehouseId: "b".repeat(24),
  kind: "damage",
  qty: 1,
  custodyState: CUSTODY_HELD_DAMAGED,
  settlementState: SETTLE_UNSETTLED,
  reason: "Screen cracked on site",
  notes: null,
  photoUrl: "https://x/1.jpg",
  jobId: null,
  jobNumber: "JOB-2026-0117",
  engineerId: null,
  engineerName: "Dave",
  movementLineId: null,
  declaredBy: "wm@x.co",
  declaredAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});


// ── WHEN the damage was declared, as opposed to when the row was written ────────────────────────
//
// These two dates were the same value for every caller, because the row could not be given one: the
// column simply took `now()`. A migration that wrote a year of history in one afternoon therefore
// dated every record it created that afternoon, and the hire line's `fieldDamageReportedAt` — which
// this repository recomputes FROM these rows — inherited the same wrong day.
describe("createExitTx", () => {
  // Typed, so the properties the tests add to it are checked against what a caller may actually pass.
  const newExit = (): NewCustodyExit => ({
    purchaseOrderRentalLineId: LINE,
    purchaseOrderId: "9".repeat(24),
    poCode: "PO-0042",
    warehouseId: "b".repeat(24),
    kind: "damage" as const,
    qty: 1,
    itemName: "Fibre tester",
    custodyState: CUSTODY_HELD_DAMAGED,
    reason: "Screen cracked on site",
    declaredBy: "wm@x.co",
    sourceType: "goods_management_return",
    sourceId: "m".repeat(24),
  });

  it("records the declaration date the caller knows", async () => {
    const { tx, rows } = makeTx([]);
    const found = new Date("2026-08-23T20:28:50.123Z");
    await createExitTx(tx, { ...newExit(), declaredAt: found });
    expect(rows[0]!.declaredAt).toEqual(found);
  });

  it("dates the hire line from that same day, not from the moment of the write", async () => {
    // The counter recompute reads these rows, so a supplied date has to reach it — otherwise the row
    // says one day and the line it belongs to says another.
    const { tx, line } = makeTx([]);
    await createExitTx(tx, { ...newExit(), declaredAt: new Date("2026-08-23T20:28:50.123Z") });
    expect(line.fieldDamageReportedAt).toEqual(new Date("2026-08-23T20:28:50.123Z"));
  });

  it("leaves the date to the database when the caller has none to give", async () => {
    // A scan IS the declaration, so `now()` is the truth for it and the column's default says so.
    const { tx, rows } = makeTx([]);
    await createExitTx(tx, newExit());
    expect(rows[0]).not.toHaveProperty("declaredAt");
  });
});

describe("recomputeCountersTx", () => {
  it("counts every damage unit still on the shelf once, settled or not", async () => {
    const { tx, line } = makeTx([
      damageRow({ id: "a1", qty: 1, settlementState: SETTLE_SETTLED }),
      damageRow({ id: "a2", qty: 2 }),
      damageRow({ id: "a3", qty: 5, custodyState: "withdrawn" }),
      { ...damageRow({ id: "a4", qty: 3 }), kind: "loss", custodyState: CUSTODY_LOST },
      { ...damageRow({ id: "a5", qty: 4 }), kind: "loss", custodyState: "recovered" },
    ]);
    const out = await recomputeCountersTx(tx, LINE);
    // A settled charge does not repair the unit; a withdrawn report never happened; a recovered loss
    // is back on the shelf.
    expect(out).toEqual({ fieldDamageQty: 3, lostQuantity: 3 });
    expect(line.fieldDamageQty).toBe(3);
    expect(line.lostQuantity).toBe(3);
  });

  it("dates the hire from the EARLIEST open report, not from the moment of recompute", async () => {
    const { tx, line } = makeTx([
      damageRow({ id: "a1", declaredAt: new Date("2026-08-01T00:00:00Z") }),
      damageRow({ id: "a2", declaredAt: new Date("2026-09-01T00:00:00Z") }),
    ]);
    await recomputeCountersTx(tx, LINE);
    expect(line.fieldDamageReportedAt).toEqual(new Date("2026-08-01T00:00:00Z"));
  });

  it("clears the date once nothing is open", async () => {
    const { tx, line } = makeTx([damageRow({ custodyState: "withdrawn" })]);
    await recomputeCountersTx(tx, LINE);
    expect(line.fieldDamageReportedAt).toBeNull();
    expect(line.fieldDamageQty).toBe(0);
  });
});

/**
 * DAMAGED KIT GOES BACK WITH EVERYTHING ELSE — a hire stays the provider's, so a broken unit travels
 * home on the collection note and the argument about it happens afterwards.
 *
 * Nothing recorded that. `returned_to_supplier` was declared, displayed and never written, so a record
 * kept saying "Damaged, still here" after the driver had taken it, and the order line kept printing
 * "N damaged here" against a returned hire.
 *
 * No note can be asked WHICH damaged units went back: a collection note's own damage column is capped
 * against units never reported, so it can only ever describe damage found at the door. The shelf is
 * the evidence — it cannot hold more damaged units than it holds units at all.
 */
describe("reconcileDamageCustodyTx", () => {
  const shelf = (over: Record<string, unknown> = {}) => ({
    receivedQuantity: 3,
    returnedQuantity: 0,
    lostQuantity: 0,
    issuedQuantity: 0,
    ...over,
  });

  it("leaves everything held while the shelf can still hold it", async () => {
    const { tx, rows, line } = makeTx([damageRow({ id: "a1", qty: 2 })], shelf());
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows[0].custodyState).toBe(CUSTODY_HELD_DAMAGED);
    expect(line.fieldDamageQty).toBe(2);
  });

  // THE CASE THIS EXISTS FOR. Everything went back, so nothing broken is still here — whatever the
  // record said a moment ago.
  it("sends every record back once the shelf is empty", async () => {
    const { tx, rows, line } = makeTx([damageRow({ id: "a1", qty: 2 })], shelf({ returnedQuantity: 3 }));
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows[0].custodyState).toBe(CUSTODY_RETURNED_TO_SUPPLIER);
    // The counter follows, which is the number the order line and the availability check both read.
    expect(line.fieldDamageQty).toBe(0);
  });

  // Oldest first, matching settleOpenAgainstNoteTx. Which physical unit went back is unknowable and
  // every ordering is a guess; what matters is that it is the SAME guess twice.
  it("sends the oldest back first when only some of them can have gone", async () => {
    const rows = [
      damageRow({ id: "a1", qty: 1, declaredAt: new Date("2026-09-01T00:00:00Z") }),
      damageRow({ id: "a2", qty: 1, declaredAt: new Date("2026-09-10T00:00:00Z") }),
    ];
    const { tx } = makeTx(rows, shelf({ returnedQuantity: 2 })); // shelf 1, damaged 2
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows.find((r) => r.id === "a1")!.custodyState).toBe(CUSTODY_RETURNED_TO_SUPPLIER);
    expect(rows.find((r) => r.id === "a2")!.custodyState).toBe(CUSTODY_HELD_DAMAGED);
  });

  it("splits a record when only part of it can have gone", async () => {
    const rows = [damageRow({ id: "a1", qty: 3 })];
    const { tx, line } = makeTx(rows, shelf({ receivedQuantity: 4, returnedQuantity: 3 })); // shelf 1
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "a1", qty: 1, custodyState: CUSTODY_HELD_DAMAGED });
    expect(rows[1]).toMatchObject({ qty: 2, custodyState: CUSTODY_RETURNED_TO_SUPPLIER });
    expect(line.fieldDamageQty).toBe(1);
  });

  // The money follows the units it was agreed for. A slice off a settled record is still settled —
  // the charge was for those units, and going back does not refund it.
  it("carries the settlement onto the slice it cuts off", async () => {
    const rows = [damageRow({ id: "a1", qty: 3, settlementState: SETTLE_SETTLED, settledByReceiptId: RECEIPT })];
    const { tx } = makeTx(rows, shelf({ receivedQuantity: 4, returnedQuantity: 3 }));
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows[1]).toMatchObject({ settlementState: SETTLE_SETTLED, settledByReceiptId: RECEIPT });
  });

  // A parent can be split MORE THAN ONCE. Keyed on `sourceId` alone the second slice collides with the
  // first, and the unique index would abort a collection that had already committed its quantities.
  it("survives a second partial return against the same record", async () => {
    const rows = [damageRow({ id: "a1", qty: 3 })];
    const { tx } = makeTx(rows, shelf({ receivedQuantity: 5, returnedQuantity: 3 })); // shelf 2
    await reconcileDamageCustodyTx(tx, LINE);
    const { tx: tx2, line } = makeTx(rows, shelf({ receivedQuantity: 5, returnedQuantity: 4 })); // shelf 1
    await reconcileDamageCustodyTx(tx2, LINE);
    const keys = rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return String(row.sourceType) + "|" + String(row.sourceId);
    });
    expect(new Set(keys).size).toBe(keys.length);
    expect(line.fieldDamageQty).toBe(1);
  });

  // Idempotent because it PARTITIONS rather than decrements: a decrementing version would have to know
  // what it had already done, and would take the same units away twice on a retry.
  it("changes nothing on a second run against the same shelf", async () => {
    const rows = [damageRow({ id: "a1", qty: 3 })];
    const { tx } = makeTx(rows, shelf({ receivedQuantity: 4, returnedQuantity: 3 }));
    await reconcileDamageCustodyTx(tx, LINE);
    const after = JSON.stringify(rows);
    const { tx: tx2 } = makeTx(rows, shelf({ receivedQuantity: 4, returnedQuantity: 3 }));
    await reconcileDamageCustodyTx(tx2, LINE);
    expect(JSON.stringify(rows)).toBe(after);
  });

  // REVERSIBLE, and that falls out of the same partition. Undo a collection and the shelf grows back,
  // so the records come home on their own — no separate un-do path to keep in step.
  it("brings records back when a reversed collection restores the shelf", async () => {
    const rows = [damageRow({ id: "a1", qty: 2, custodyState: CUSTODY_RETURNED_TO_SUPPLIER })];
    const { tx, line } = makeTx(rows, shelf());
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows[0].custodyState).toBe(CUSTODY_HELD_DAMAGED);
    expect(line.fieldDamageQty).toBe(2);
  });

  // A lost unit was never on the shelf — `declareHireLost` drains an engineer's holding, lowering
  // `issuedQuantity` and `lostQuantity` together — so it must not push damage off it.
  it("ignores a loss, which does not come off the shelf", async () => {
    const rows = [damageRow({ id: "a1", qty: 2 })];
    const { tx } = makeTx(rows, shelf({ receivedQuantity: 4, issuedQuantity: 1 }));
    await reconcileDamageCustodyTx(tx, LINE);
    expect(rows[0].custodyState).toBe(CUSTODY_HELD_DAMAGED);
  });
});

/**
 * A WRONG REPORT IS USUALLY FOUND WHEN THE PROVIDER DISPUTES THEIR INVOICE — weeks after they
 * collected. Refusing the withdrawal then would leave a claim we know to be wrong with no way to
 * retract it, on the one order where somebody is arguing about it.
 */
describe("withdrawDamageExitTx", () => {
  it("takes back a report on kit that is still here", async () => {
    const { tx } = makeTx([damageRow({ id: "a1" })]);
    expect(await withdrawDamageExitTx(tx, "a1")).toBe(true);
  });

  it("takes back a report on kit the provider already collected", async () => {
    const { tx } = makeTx([damageRow({ id: "a1", custodyState: CUSTODY_RETURNED_TO_SUPPLIER })]);
    expect(await withdrawDamageExitTx(tx, "a1")).toBe(true);
  });

  // Nothing left to take back. Reported rather than silently succeeding — a withdrawal that did
  // nothing looks exactly like one that worked.
  it("refuses a report already withdrawn", async () => {
    const { tx } = makeTx([damageRow({ id: "a1", custodyState: "withdrawn" })]);
    expect(await withdrawDamageExitTx(tx, "a1")).toBe(false);
  });
});

// ── ONE PHYSICAL UNIT, ONE QUARANTINE — now decided by arithmetic, not by allocation ───────────
//
// A warehouse damage note used to ALLOCATE its quantity against damage already reported on the hire
// line — oldest first — settling what it covered and opening a row only for the surplus. That is what
// kept one physical unit from being quarantined twice, and it is also why a genuinely new fault could
// not be told from an older one: a hire line is a count with no unit identity, so the allocator always
// assumed the same fault and absorbed the new report into the old event.
//
// The allocator is gone. `damageCapFiguresByLines` carries the same protection as a CAP, and these
// tests are the same invariants asked of the mechanism that now enforces them:
//
//   • quarantinedNotTallied — every unit a report is holding off the shelf that the hire's
//                             provider-facing `damagedQuantity` does not yet count. Subtracted from
//                             what a note may report, which is what makes over-quarantining
//                             impossible however the endpoint is called.
//
// A DISMISSED report is the case that used to be missed: "nothing is owed" closes the claim and does
// not un-break the tester, so the unit stays `held_damaged`, out of `hireIssuable` and counted here.
describe("damageCapFiguresByLines", () => {
  const capRow = (over: Record<string, unknown> = {}) => ({
    purchaseOrderRentalLineId: LINE,
    qty: 1,
    kind: "damage",
    custodyState: CUSTODY_HELD_DAMAGED,
    settlementState: SETTLE_UNSETTLED,
    ...over,
  });

  /** Serves the repository's own `where`, so a row only counts if the real filter would select it. */
  const withRows = (rows: Record<string, unknown>[]) =>
    vi.mocked(prisma.hireCustodyExit.findMany).mockImplementation((async (args: {
      where: Record<string, unknown>;
    }) => rows.filter((r) => matches(r, args.where))) as never);

  it("counts an open report", async () => {
    withRows([capRow()]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toEqual({ quarantinedNotTallied: 1 });
  });

  it("counts a DISMISSED report as holding its unit", async () => {
    // THE CASE THE OLD CAP MISSED. Dropping the claim does not un-break the tester, so a note that
    // ignored this row could mint a second quarantine for a unit already off the shelf —
    // `fieldDamageQty: 2` on a hire that received one.
    withRows([capRow({ settlementState: SETTLE_DISMISSED })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toEqual({ quarantinedNotTallied: 1 });
  });

  it("ignores a WITHDRAWN report — those units were never damaged", async () => {
    withRows([capRow({ custodyState: CUSTODY_WITHDRAWN, settlementState: SETTLE_DISMISSED })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toBeUndefined();
  });

  it("ignores kit already gone back to the provider", async () => {
    // It is not on the shelf, so it is not holding a unit out of the pool here.
    withRows([capRow({ custodyState: CUSTODY_RETURNED_TO_SUPPLIER })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toBeUndefined();
  });

  it("ignores a report already settled — the hire's tally already counts it", async () => {
    // Counting it here would subtract the same unit twice, once through the tally and once through
    // this figure, and refuse damage on kit that is genuinely still fit.
    withRows([capRow({ settlementState: SETTLE_SETTLED })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toBeUndefined();
  });

  it("never lets a LOSS reach a damage cap", async () => {
    // The financial half of a loss is deliberately deferred. Deferring it must not mean a lost unit
    // quietly becomes a damage claim because damage is the path that happens to exist.
    withRows([capRow({ kind: "loss", custodyState: CUSTODY_LOST })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toBeUndefined();
  });

  it("adds up several reports on one line, open and dismissed together", async () => {
    withRows([capRow({ qty: 2 }), capRow({ qty: 3, settlementState: SETTLE_DISMISSED })]);
    expect((await damageCapFiguresByLines([LINE])).get(LINE)).toEqual({ quarantinedNotTallied: 5 });
  });

  it("keeps each hire line's figures to itself", async () => {
    const OTHER = "f".repeat(24);
    withRows([capRow(), capRow({ purchaseOrderRentalLineId: OTHER, qty: 4 })]);
    const out = await damageCapFiguresByLines([LINE, OTHER]);
    expect(out.get(LINE)!.quarantinedNotTallied).toBe(1);
    expect(out.get(OTHER)!.quarantinedNotTallied).toBe(4);
  });

  it("reads ONCE for the whole set, and not at all for an empty one", async () => {
    withRows([capRow()]);
    vi.mocked(prisma.hireCustodyExit.findMany).mockClear();
    await damageCapFiguresByLines([LINE, "f".repeat(24), "a".repeat(24)]);
    expect(vi.mocked(prisma.hireCustodyExit.findMany)).toHaveBeenCalledTimes(1);
    vi.mocked(prisma.hireCustodyExit.findMany).mockClear();
    expect(await damageCapFiguresByLines([])).toEqual(new Map());
    expect(vi.mocked(prisma.hireCustodyExit.findMany)).not.toHaveBeenCalled();
  });
});
