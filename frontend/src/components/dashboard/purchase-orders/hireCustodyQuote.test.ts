import { describe, expect, it } from "vitest";

import { awaitingQuote, isOpen, needsCredit } from "./HireCustodyTimeline";
import type { HireCustodyExit } from "@/types/rental";

/**
 * A NOTE RAISED WITHOUT A PRICE IS THE NORMAL ORDER OF EVENTS, not a mistake: the damage is written
 * down the day it is found, and the provider's quote arrives the following week. `settledAt` says the
 * claim has been PUT to them; `settledCharge` says whether they have answered.
 *
 * The record was invisible in between. `isOpen` says false the moment a note exists, so a report
 * sitting for a month with no figure counted as nothing, showed "no charge" — which reads as "they are
 * not charging us" — and offered no way to enter the price when it came.
 */
const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit =>
  ({
    id: "e1",
    kind: "damage",
    qty: 1,
    custodyState: "held_damaged",
    settlementState: "settled",
    settledByCode: "HDM-0001",
    settledByReceiptId: "n1",
    settledCharge: null,
    sourceReceiptId: null,
    ...over,
  }) as HireCustodyExit;

describe("awaitingQuote", () => {
  it("flags a claim on a note the provider has not priced", () => {
    expect(awaitingQuote(exit())).toBe(true);
  });

  it("ignores one they have priced", () => {
    expect(awaitingQuote(exit({ settledCharge: 66 }))).toBe(false);
  });

  // A charge of ZERO is an answer — they looked at it and are not billing us. Different fact from
  // silence, and only one of them is somebody's job to chase.
  it("treats a quoted zero as answered", () => {
    expect(awaitingQuote(exit({ settledCharge: 0 }))).toBe(false);
  });

  it("ignores a record with no note at all — that one needs raising, not pricing", () => {
    expect(awaitingQuote(exit({ settlementState: "unsettled", settledByReceiptId: null, settledByCode: null }))).toBe(false);
  });

  // Neither is waiting for a price. A recovered loss is waiting for the opposite.
  it("ignores withdrawn and recovered records", () => {
    expect(awaitingQuote(exit({ custodyState: "withdrawn", settlementState: "dismissed" }))).toBe(false);
    expect(awaitingQuote(exit({ kind: "loss", custodyState: "recovered" }))).toBe(false);
  });
});

/**
 * ONE COUNT FOR ONE ERRAND. "Nobody has put this to the provider" and "the provider has not priced it"
 * are the same job on the office's list — find out what this costs. Two pills would make the reader
 * add them up.
 */
describe("what the panel counts as work", () => {
  const toCharge = (rows: HireCustodyExit[]) => rows.filter((e) => isOpen(e) || awaitingQuote(e)).length;

  it("counts a record with no note and one with an unpriced note alike", () => {
    expect(toCharge([exit({ settlementState: "unsettled", settledByReceiptId: null }), exit()])).toBe(2);
  });

  it("counts a priced record as finished", () => {
    expect(toCharge([exit({ settledCharge: 66 })])).toBe(0);
  });

  // The two states are mutually exclusive, which is what lets the row show exactly one action.
  it("never treats a record as both unraised and unpriced", () => {
    for (const e of [exit(), exit({ settlementState: "unsettled", settledByReceiptId: null }), exit({ settledCharge: 66 })]) {
      expect(isOpen(e) && awaitingQuote(e)).toBe(false);
    }
  });

  // And it must not collide with the other errand, which runs the other way.
  it("never treats a record as both unpriced and owed a credit", () => {
    const recovered = exit({ kind: "loss", custodyState: "recovered", settledCharge: 90 });
    expect(needsCredit(recovered)).toBe(true);
    expect(awaitingQuote(recovered)).toBe(false);
  });
});

/**
 * ONE NOTE, ONE BUTTON.
 *
 * A warehouse damage report SETTLES ITS OWN RECORD — the report path opens the exit and immediately
 * marks it settled against the same note — so on every record found here, the source note and the
 * settling note are the same document. Offering both undos gave two buttons that reverse one note,
 * with confirms describing opposite outcomes: "the equipment does not change" was false, because
 * withdrawing that note withdraws the report along with the charge.
 */
const offersChargeUndo = (e: HireCustodyExit) =>
  Boolean(e.settledByReceiptId) && e.settlementState === "settled" && e.settledByReceiptId !== e.sourceReceiptId;
const offersReportUndo = (e: HireCustodyExit) =>
  Boolean(e.sourceReceiptId) && (e.custodyState === "held_damaged" || e.custodyState === "returned_to_supplier");

describe("which undo a record offers", () => {
  it("offers only the report undo when one note did both", () => {
    const warehouse = exit({ sourceReceiptId: "n1", settledByReceiptId: "n1", settledCharge: 66 });
    expect(offersReportUndo(warehouse)).toBe(true);
    expect(offersChargeUndo(warehouse)).toBe(false);
  });

  // Damage found on a JOB is raised by a movement on the return, not a note — so there is no report to
  // withdraw, and a later note settled it. The charge undo is the only one it can offer.
  it("offers only the charge undo on a job record settled later", () => {
    const job = exit({ jobNumber: "JOB-2026-0041", sourceReceiptId: null, settledByReceiptId: "n2", settledCharge: 66 });
    expect(offersReportUndo(job)).toBe(false);
    expect(offersChargeUndo(job)).toBe(true);
  });

  // Both, and genuinely: a warehouse report that a DIFFERENT note later settled.
  it("offers both when the two notes really are different documents", () => {
    const split = exit({ sourceReceiptId: "n1", settledByReceiptId: "n2", settledCharge: 66 });
    expect(offersReportUndo(split)).toBe(true);
    expect(offersChargeUndo(split)).toBe(true);
  });
});
