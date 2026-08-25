import { describe, expect, it } from "vitest";

import { isOpen, needsCredit } from "./HireCustodyTimeline";
import type { HireCustodyExit } from "@/types/rental";

/**
 * THE MONEY DOES NOT COME BACK WITH THE EQUIPMENT.
 *
 * A unit is declared lost, the provider charges us for it, and then it turns up behind the racking.
 * `recoverHireLoss` puts the equipment straight back on the shelf — that half looks after itself. The
 * charge does not: it stands, settled, against equipment we now have, and somebody has to claim the
 * credit or withdraw it.
 *
 * `isOpen` says false on a recovered record, correctly — it is not waiting for a figure. So without a
 * predicate of its own this work is invisible: every count, tag and colour on the panel reads the
 * record as finished.
 */
const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit =>
  ({
    id: "e1",
    kind: "loss",
    qty: 1,
    custodyState: "lost",
    settlementState: "unsettled",
    settledByCode: null,
    settledCharge: null,
    ...over,
  }) as HireCustodyExit;

describe("needsCredit", () => {
  it("flags a loss that was charged for and then found", () => {
    expect(needsCredit(exit({ custodyState: "recovered", settlementState: "settled" }))).toBe(true);
  });

  // Nothing was ever agreed, so there is nothing to claim back. The record is simply closed.
  it("ignores a find nobody had been charged for", () => {
    expect(needsCredit(exit({ custodyState: "recovered", settlementState: "unsettled" }))).toBe(false);
  });

  // Still lost. The charge is correct and the equipment is genuinely gone.
  it("ignores a loss still outstanding", () => {
    expect(needsCredit(exit({ custodyState: "lost", settlementState: "settled" }))).toBe(false);
  });

  // THE ONE THIS MUST NOT CATCH. Damaged kit collected by the provider is settled and stays settled:
  // they took away something we broke, and the charge was for breaking it. Treating that as a credit
  // would send somebody to claim money back on every damage charge the module ever raises.
  it("ignores a damage charge on kit the provider has collected", () => {
    expect(needsCredit(exit({ kind: "damage", custodyState: "returned_to_supplier", settlementState: "settled" }))).toBe(false);
  });

  it("ignores a withdrawn report", () => {
    expect(needsCredit(exit({ kind: "damage", custodyState: "withdrawn", settlementState: "dismissed" }))).toBe(false);
  });
});

/**
 * The two errands are OPPOSITE, which is why they are counted separately. One owes the provider money
 * and the other is owed it; a single number would send somebody to raise a charge on a record that
 * already carries one.
 */
describe("the two kinds of outstanding work do not overlap", () => {
  const rows = [
    exit({ id: "a", custodyState: "lost", settlementState: "unsettled" }),
    exit({ id: "b", custodyState: "recovered", settlementState: "settled" }),
    exit({ id: "c", kind: "damage", custodyState: "held_damaged", settlementState: "settled" }),
  ];

  it("counts one to charge and one to credit", () => {
    expect(rows.filter(isOpen).map((r) => r.id)).toEqual(["a"]);
    expect(rows.filter(needsCredit).map((r) => r.id)).toEqual(["b"]);
  });

  it("never counts the same record as both", () => {
    for (const r of rows) expect(isOpen(r) && needsCredit(r)).toBe(false);
  });
});
