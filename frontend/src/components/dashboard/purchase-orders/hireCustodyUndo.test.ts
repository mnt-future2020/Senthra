import { describe, expect, it } from "vitest";

import type { HireCustodyExit } from "@/types/rental";

/**
 * WHICH UNDO A RECORD OFFERS, and how far it reaches.
 *
 * Two different notes hang off one custody record and reversing them means opposite things:
 *
 *   • the SOURCE note is the warehouse report that opened the record. Withdrawing it says the damage
 *     never happened, so the units go back into what can be sent out.
 *   • the SETTLING note is the charge raised against it. Withdrawing that says the figure was wrong
 *     while the tester stays broken — the record returns to the worklist and no equipment moves.
 *
 * Damage found on a JOB has no source note at all: it was raised by a movement on the return, which
 * is not a document anybody can reverse. Offering "withdraw this report" there would be a button that
 * could only 404.
 *
 * These mirror the conditions the panel renders on, so a change to either has to come here first.
 */
const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit =>
  ({
    id: "e1",
    kind: "damage",
    qty: 1,
    custodyState: "held_damaged",
    settlementState: "unsettled",
    sourceReceiptId: null,
    sourceCode: null,
    settledByReceiptId: null,
    settledByCode: null,
    ...over,
  }) as HireCustodyExit;

const offersReportUndo = (e: HireCustodyExit) => Boolean(e.sourceReceiptId) && e.custodyState === "held_damaged";
const offersChargeUndo = (e: HireCustodyExit) => Boolean(e.settledByReceiptId) && e.settlementState === "settled";

describe("which undo a custody record offers", () => {
  it("offers the report undo on damage found HERE", () => {
    expect(offersReportUndo(exit({ sourceReceiptId: "r1", sourceCode: "HDM-0002" }))).toBe(true);
  });

  // The regression this guards: an engineer's report has no note behind it, so the button would name
  // a document that does not exist.
  it("offers no report undo on damage found on a JOB", () => {
    expect(offersReportUndo(exit({ jobNumber: "JOB-2026-0041" }))).toBe(false);
  });

  // Already withdrawn, or already gone back to the supplier: the server's compare-and-set would refuse
  // it, so the button must not be there to press.
  it("offers no report undo once the record has moved on", () => {
    expect(offersReportUndo(exit({ sourceReceiptId: "r1", custodyState: "withdrawn" }))).toBe(false);
    expect(offersReportUndo(exit({ sourceReceiptId: "r1", custodyState: "returned_to_supplier" }))).toBe(false);
  });

  it("offers the charge undo only while a charge actually stands", () => {
    expect(offersChargeUndo(exit({ settledByReceiptId: "n1", settlementState: "settled" }))).toBe(true);
    expect(offersChargeUndo(exit({ settledByReceiptId: "n1", settlementState: "unsettled" }))).toBe(false);
    expect(offersChargeUndo(exit())).toBe(false);
  });

  // A job-reported record that has been CHARGED can have the money taken back even though it has no
  // report to withdraw. The two undos are independent, which is the whole reason they are two buttons.
  it("offers the charge undo on a job record, which has no report undo", () => {
    const charged = exit({ jobNumber: "JOB-2026-0041", settledByReceiptId: "n1", settlementState: "settled" });
    expect(offersChargeUndo(charged)).toBe(true);
    expect(offersReportUndo(charged)).toBe(false);
  });
});

/**
 * ONE NOTE IS NOT ALWAYS ONE RECORD.
 *
 * The report form consumes any open job-reported damage on the line before opening fresh records of
 * its own, so a single HDM can be the SOURCE of one record and the SETTLEMENT of another. Reversing it
 * undoes both — and a confirm that named only the record you clicked from would be describing a third
 * of what is about to happen.
 */
const alsoAffected = (exits: HireCustodyExit[], receiptId: string, exceptId: string): number =>
  exits.filter((e) => e.id !== exceptId && (e.sourceReceiptId === receiptId || e.settledByReceiptId === receiptId)).length;

describe("how far one withdrawal reaches", () => {
  const rows = [
    exit({ id: "a", sourceReceiptId: "n1" }),
    exit({ id: "b", settledByReceiptId: "n1", settlementState: "settled" }),
    exit({ id: "c", sourceReceiptId: "n2" }),
  ];

  it("counts records the same note settled, not just the ones it opened", () => {
    expect(alsoAffected(rows, "n1", "a")).toBe(1);
  });

  it("never counts the record being withdrawn from", () => {
    expect(alsoAffected(rows, "n2", "c")).toBe(0);
  });

  it("counts nothing for a note that stands alone", () => {
    expect(alsoAffected([rows[2]], "n2", "c")).toBe(0);
  });
});
