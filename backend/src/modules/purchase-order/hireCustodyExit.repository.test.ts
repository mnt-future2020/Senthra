import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({ prisma: {} }));

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
  recomputeCountersTx,
  reconcileDamageCustodyTx,
  settleOpenDamageAgainstNoteTx,
  withdrawDamageExitTx,
} from "./hireCustodyExit.repository.js";

const LINE = "e".repeat(24);
const RECEIPT = "r".repeat(24);
const AT = new Date("2026-09-20T00:00:00Z");

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

// ── The double-count a damage note would otherwise create ──────────────────────────────────────
//
// An engineer brings a tester back broken; the return scan opens an exit and the unit leaves the
// issuable pool. The office then raises the provider's damage note for that SAME tester. A note that
// opened its own row would quarantine one physical unit twice, and no screen would explain why the
// hire had lost two units of availability for one fault.
describe("settleOpenDamageAgainstNoteTx", () => {
  it("covers an open report instead of leaving it for a second row", async () => {
    const { tx, rows } = makeTx([damageRow()]);
    const covered = await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);
    expect(covered).toBe(1);
    expect(rows).toHaveLength(1); // no new row — the note consumed the report
    expect(rows[0]!.settlementState).toBe(SETTLE_SETTLED);
    expect(rows[0]!.settledByReceiptId).toBe(RECEIPT);
    // Custody untouched: an agreed charge does not repair a tester, so it stays out of the pool.
    expect(rows[0]!.custodyState).toBe(CUSTODY_HELD_DAMAGED);
  });

  it("reports nothing covered when there is no open report to consume", async () => {
    const { tx } = makeTx([]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 2, RECEIPT, AT)).toBe(0);
  });

  it("takes the OLDEST report first", async () => {
    const older = damageRow({ id: "a1", declaredAt: new Date("2026-08-01T00:00:00Z") });
    const newer = damageRow({ id: "a2", declaredAt: new Date("2026-09-01T00:00:00Z") });
    const { tx, rows } = makeTx([newer, older]);
    await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);
    expect(rows.find((r) => r.id === "a1")!.settlementState).toBe(SETTLE_SETTLED);
    expect(rows.find((r) => r.id === "a2")!.settlementState).toBe(SETTLE_UNSETTLED);
  });

  it("splits a report bigger than the note rather than settling it whole", async () => {
    // Two reported, one accepted. The quarantine must still total two units, not three.
    const { tx, rows } = makeTx([damageRow({ qty: 2 })]);
    const covered = await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);
    expect(covered).toBe(1);
    expect(rows).toHaveLength(2);
    const settled = rows.find((r) => r.settlementState === SETTLE_SETTLED)!;
    const stillOpen = rows.find((r) => r.settlementState === SETTLE_UNSETTLED)!;
    expect(settled.qty).toBe(1);
    expect(stillOpen.qty).toBe(1);
    // The split keeps the original's evidence, so the photograph does not go missing with the split.
    expect(settled.photoUrl).toBe("https://x/1.jpg");
    expect(settled.declaredAt).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("never covers more than the note reports", async () => {
    const { tx, rows } = makeTx([damageRow({ qty: 1 }), damageRow({ id: "a2", qty: 1 })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT)).toBe(1);
    expect(rows.filter((r) => r.settlementState === SETTLE_SETTLED)).toHaveLength(1);
  });
});

// ── A loss is not a damage, and a damage note must not be able to settle one ────────────────────
//
// The financial half of a loss is deliberately deferred — what a provider charges for a replacement is
// agreed on their own document, and that flow is not built yet. Deferring it must NOT mean a lost unit
// quietly becomes a damage claim because damage is the settlement path that happens to exist.
describe("loss exits are invisible to a damage note", () => {
  it("never settles a loss row against a damage note, however many units the note reports", async () => {
    const loss = { ...damageRow({ id: "L1", qty: 3 }), kind: "loss", custodyState: CUSTODY_LOST };
    const { tx, rows } = makeTx([loss]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 3, RECEIPT, AT)).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settlementState).toBe(SETTLE_UNSETTLED);
    expect(rows[0]!.settledByReceiptId).toBeUndefined();
    expect(rows[0]!.custodyState).toBe(CUSTODY_LOST);
  });

  it("settles the damage beside a loss and leaves the loss exactly where it was", async () => {
    const loss = { ...damageRow({ id: "L1", qty: 1 }), kind: "loss", custodyState: CUSTODY_LOST };
    const { tx, rows } = makeTx([loss, damageRow({ id: "D1", qty: 1 })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 2, RECEIPT, AT)).toBe(1);
    expect(rows.find((r) => r.id === "L1")!.settlementState).toBe(SETTLE_UNSETTLED);
    expect(rows.find((r) => r.id === "D1")!.settlementState).toBe(SETTLE_SETTLED);
  });
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

// ── ONE PHYSICAL UNIT, ONE QUARANTINE — even after the charge is dropped ───────────────────────
//
// `settleOpenAgainstNoteTx` does two jobs with one pass, and they do not share a filter:
//
//   • FINANCIAL — move a live claim onto the note. `unsettled` rows only.
//   • PHYSICAL  — stop one broken unit being quarantined twice. EVERY row holding a unit off the
//     shelf, whatever the office decided about the money.
//
// A DISMISSED report is where the two answers part company: "nothing is owed" closes the claim and
// does not un-break the tester, so the unit stays `held_damaged` and stays out of `hireIssuable`.
// Filtering it out of BOTH jobs is what let a later warehouse note mint a second custody row for a
// unit already quarantined — `fieldDamageQty: 2` on a hire that received one.
describe("a dismissed report still holds its physical unit", () => {
  const dismissed = (over: Record<string, unknown> = {}) =>
    damageRow({ id: "d1", settlementState: SETTLE_DISMISSED, ...over });

  it("absorbs a later note instead of letting it open a SECOND quarantine row", async () => {
    // 1 received, 1 reported off a job, dismissed as fair wear. The office later changes its mind and
    // raises the provider's damage note for that same tester.
    const { tx, rows } = makeTx([dismissed({ qty: 1 })]);

    const covered = await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);

    // Covered, so the caller opens nothing further — the unit is already accounted for.
    expect(covered).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("changes NOTHING on the row it absorbs — the claim stays dropped", async () => {
    const { tx, rows } = makeTx([dismissed({ qty: 1 })]);
    const before = { ...rows[0] };

    await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);

    // Not settled, not reduced, not split, no receipt stamped on it. A note must never silently
    // reopen or charge a report the office had already dismissed.
    expect(rows[0]).toEqual(before);
    expect(rows[0].settlementState).toBe(SETTLE_DISMISSED);
    expect(rows[0].settledByReceiptId).toBeUndefined();
  });

  it("keeps fieldDamageQty at the physically damaged quantity, not double it", async () => {
    const { tx, rows, line } = makeTx([dismissed({ qty: 1 })], { receivedQuantity: 1 });

    const covered = await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT);
    // The caller only creates a row for what was NOT covered. Nothing was left, so nothing is created.
    expect(covered).toBe(1);
    await recomputeCountersTx(tx, LINE);

    // ONE unit received, ONE quarantined. Before the fix this read 2.
    expect(line.fieldDamageQty).toBe(1);
    expect(line.fieldDamageQty as number).toBeLessThanOrEqual(rows[0].qty as number);
  });

  it("settles live claims FIRST and only absorbs the remainder", async () => {
    // 2 received: one report still open, one already dismissed. A note for both units should settle
    // the live one — a note is worth more spent on a real claim than on a closed one.
    const { tx, rows } = makeTx([
      damageRow({ id: "open1", qty: 1, declaredAt: new Date("2026-09-02T00:00:00Z") }),
      dismissed({ qty: 1, declaredAt: new Date("2026-09-01T00:00:00Z") }),
    ]);

    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 2, RECEIPT, AT)).toBe(2);

    const open = rows.find((r) => r.id === "open1")!;
    const drop = rows.find((r) => r.id === "d1")!;
    expect(open.settlementState).toBe(SETTLE_SETTLED);
    expect(open.settledByReceiptId).toBe(RECEIPT);
    // The dismissed one absorbed the leftover unit and stayed exactly as it was.
    expect(drop.settlementState).toBe(SETTLE_DISMISSED);
    // Two units reported, two rows, no third minted.
    expect(rows).toHaveLength(2);
  });

  it("absorbs only up to what it physically holds", async () => {
    // 1 unit dismissed, but the note reports 2 — the second is genuinely new damage on another unit.
    const { tx } = makeTx([dismissed({ qty: 1 })]);
    // Covered = 1; the caller opens a fresh exit for the uncovered one, which is correct.
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 2, RECEIPT, AT)).toBe(1);
  });

  it("absorbs part of a bigger dismissed row without splitting it", async () => {
    // Nothing about the row changes either way, so a slice has no second state to carry.
    const { tx, rows } = makeTx([dismissed({ qty: 3 })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT)).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(3);
  });

  it("never absorbs a WITHDRAWN report — those units were never damaged", async () => {
    // `withdrawn` + `dismissed` is the shape a reversed damage note leaves. The unit is fit and back
    // in the pool, so it holds nothing and must not soak up a real report.
    const { tx } = makeTx([dismissed({ qty: 1, custodyState: CUSTODY_WITHDRAWN })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT)).toBe(0);
  });

  it("never absorbs a report on kit already gone back to the provider", async () => {
    // `returned_to_supplier` is off our shelf, so it is not holding a unit here for a note to cover.
    const { tx } = makeTx([dismissed({ qty: 1, custodyState: CUSTODY_RETURNED_TO_SUPPLIER })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT)).toBe(0);
  });

  it("leaves the ordinary charge path completely unchanged", async () => {
    // No dismissed rows in play at all: phase two never runs and the behaviour is exactly as before.
    const { tx, rows } = makeTx([damageRow({ qty: 1 })]);
    expect(await settleOpenDamageAgainstNoteTx(tx, LINE, 1, RECEIPT, AT)).toBe(1);
    expect(rows[0].settlementState).toBe(SETTLE_SETTLED);
    expect(rows[0].settledByReceiptId).toBe(RECEIPT);
    expect(rows).toHaveLength(1);
  });

  it("still quarantines genuinely new damage after a dismissed event on the same hire", async () => {
    // 2 received. One dismissed. A note reports 2 — one is the dismissed unit, one is a new fault.
    const { tx, rows, line } = makeTx([dismissed({ qty: 1 })], { receivedQuantity: 2 });
    const covered = await settleOpenDamageAgainstNoteTx(tx, LINE, 2, RECEIPT, AT);
    expect(covered).toBe(1);

    // The caller opens a row for the uncovered unit — simulated here the way reportHireDamage does.
    await createExitTx(tx, {
      purchaseOrderRentalLineId: LINE,
      purchaseOrderId: "9".repeat(24),
      poCode: "PO-0042",
      warehouseId: "b".repeat(24),
      kind: "damage",
      qty: 2 - covered,
      itemName: "Fibre Tester",
      custodyState: CUSTODY_HELD_DAMAGED,
      reason: "Second unit cracked",
      sourceType: "warehouse_damage_note",
      sourceId: RECEIPT,
    } as NewCustodyExit);

    // Two physical units, two quarantine rows — one dismissed, one live. Never three.
    expect(rows).toHaveLength(2);
    expect(line.fieldDamageQty).toBe(2);
    expect(line.fieldDamageQty as number).toBeLessThanOrEqual(2);
  });
});
