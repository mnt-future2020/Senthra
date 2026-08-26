import { describe, expect, it } from "vitest";

import type { HireCustodyExit } from "@/types/rental";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canDismiss, isOpen, settlementTag } from "./HireCustodyTimeline";

/**
 * WHEN "NOTHING IS OWED" IS AN ANSWER A RECORD CAN BE GIVEN.
 *
 * A damage report reaches the office in one of three states of truth, and until this predicate existed
 * only two of them could be said:
 *
 *   • the provider owes us for it            → charge it, which raises their damage note
 *   • the report was wrong                   → withdraw the note that opened it
 *   • the units ARE broken, nobody is billed → dismissed, and this is the one that had no button
 *
 * The third is the ordinary case — fair wear on a long hire, a fault the provider agreed to absorb, a
 * scuff not worth the invoice — and damage found on a JOB could not reach it at all: its record is
 * opened by a return movement rather than a document, so there is nothing to withdraw, and a charge
 * was the only way off the worklist. Clearing a fair-wear report that way filed a damage claim nobody
 * was making.
 *
 * These mirror the conditions the panel renders the action on, by importing the very predicate it
 * uses, so the two cannot drift apart.
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
    settledCharge: null,
    ...over,
  }) as HireCustodyExit;

describe("canDismiss — which records may be closed with no supplier charge", () => {
  it("offers it on a JOB-reported damage report — the case that had no other way out", () => {
    // No note behind it (`sourceReceiptId: null`), so "withdraw this report" is not available and a
    // charge was the only remaining action. This is the whole reason the action exists.
    expect(canDismiss(exit({ sourceReceiptId: null }))).toBe(true);
  });

  it("offers it on a WAREHOUSE-reported damage report too", () => {
    // A note behind it means it could also be withdrawn — but withdrawing says the damage never
    // happened, which is a different statement from "it happened and nobody is paying".
    expect(canDismiss(exit({ sourceReceiptId: "r1", sourceCode: "HDM-0007" }))).toBe(true);
  });

  it("offers it on kit the provider has already collected", () => {
    // The commonest moment a charge is dropped is when they dispute the invoice, weeks after
    // collection. Custody is `returned_to_supplier` and the money question is still open.
    expect(canDismiss(exit({ custodyState: "returned_to_supplier" }))).toBe(true);
  });

  it("never offers it on a LOSS", () => {
    // Writing off somebody else's missing equipment without charging for it is a decision about the
    // whole hire, not about one report. The server refuses it, so the button must not appear.
    expect(canDismiss(exit({ kind: "loss", custodyState: "lost" }))).toBe(false);
    expect(canDismiss(exit({ kind: "loss", custodyState: "recovered" }))).toBe(false);
  });

  it("never offers it once the provider has been charged", () => {
    // There is a live claim on a document. Dropping it silently would hide that; the charge has to be
    // withdrawn first, which is its own action with its own reason.
    expect(canDismiss(exit({ settlementState: "settled", settledByReceiptId: "r2" }))).toBe(false);
  });

  it("never offers it twice — a dismissed record is not still open", () => {
    // Idempotency is enforced server-side by a compare-and-set, but the button disappearing is what
    // stops the second click being made at all.
    expect(canDismiss(exit({ settlementState: "dismissed" }))).toBe(false);
  });

  it("never offers it on a withdrawn or recovered record", () => {
    // Neither owes the provider anything already, so there is no claim left to drop and writing a
    // decision date on one would record a decision nobody took.
    expect(canDismiss(exit({ custodyState: "withdrawn", settlementState: "dismissed" }))).toBe(false);
    expect(canDismiss(exit({ custodyState: "recovered" }))).toBe(false);
  });

  it("is exactly `isOpen` narrowed to damage — it invents no second notion of open", () => {
    // The panel's header count, its row tags and its charge button all read `isOpen`. If dismissal
    // used a rule of its own, a record could be dismissible while the panel called it answered.
    for (const e of [
      exit(),
      exit({ custodyState: "returned_to_supplier" }),
      exit({ settlementState: "settled" }),
      exit({ settlementState: "dismissed" }),
      exit({ custodyState: "withdrawn" }),
      exit({ custodyState: "recovered" }),
    ]) {
      expect(canDismiss(e)).toBe(isOpen(e) && e.kind === "damage");
    }
  });
});

// ── WHAT A DISMISSED RECORD SAYS ABOUT THE EQUIPMENT ──────────────────────────────────────────
//
// "Nothing owed" is true about the MONEY and says nothing about the kit — and a reader carries it
// straight over anyway, because `dismissed` sounds like `withdrawn` and a withdrawn report really does
// put units back into the issuable pool. A dismissed one does not: `fieldDamageQty` still counts that
// unit and `hireIssuable` still subtracts it.
//
// It matters most here because the Damaged Stock pane filters on `unsettled` and so drops a dismissed
// row — exactly as it already drops a charged one. This timeline is unfiltered, which makes it the one
// screen still listing these units, and therefore the one that has to say what state they are in.
describe("settlementTag — dismissed must never read as repaired or available", () => {
  it("says the equipment is still damaged when it is still here", () => {
    expect(settlementTag({ settlementState: "dismissed", custodyState: "held_damaged" })).toBe(
      "No charge · still damaged",
    );
  });

  it("never renders a bare 'Nothing owed' for kit still held broken", () => {
    const tag = settlementTag({ settlementState: "dismissed", custodyState: "held_damaged" });
    expect(tag).not.toBe("Nothing owed");
    expect(tag.toLowerCase()).toContain("damaged");
  });

  it("says returned rather than 'still damaged' once the provider has it", () => {
    // "Still damaged" would be describing equipment we do not have.
    expect(settlementTag({ settlementState: "dismissed", custodyState: "returned_to_supplier" })).toBe(
      "No charge · returned damaged",
    );
  });

  it("leaves 'Nothing owed' alone where it IS the whole truth", () => {
    // A withdrawn report never happened and a recovered loss is back on the shelf. Neither owes the
    // provider anything and neither is holding a unit, so there is nothing to qualify.
    expect(settlementTag({ settlementState: "dismissed", custodyState: "withdrawn" })).toBe("Nothing owed");
    expect(settlementTag({ settlementState: "dismissed", custodyState: "recovered" })).toBe("Nothing owed");
  });

  it("leaves the other two settlement states exactly as they were", () => {
    expect(settlementTag({ settlementState: "unsettled", custodyState: "held_damaged" })).toBe("Not yet charged");
    expect(settlementTag({ settlementState: "settled", custodyState: "held_damaged" })).toBe("Charged");
  });

  it("never claims a dismissed record is fixed, back, or available", () => {
    for (const custodyState of ["held_damaged", "returned_to_supplier", "withdrawn", "recovered"]) {
      const tag = settlementTag({ settlementState: "dismissed", custodyState }).toLowerCase();
      for (const forbidden of ["repaired", "fixed", "available", "issuable", "back on the shelf"]) {
        expect(tag).not.toContain(forbidden);
      }
    }
  });
});

// ── NESTED DIALOGS ARE A KEYBOARD TRAP ────────────────────────────────────────────────────────
//
// The detail Modal and the ConfirmDialog each install a document-level focus trap. Opening a confirm
// from inside the still-open detail puts two of them on the page: Tab is pulled back to the textarea
// so the confirm button is unreachable, and Escape closes both at once.
//
// A SOURCE-LEVEL check because these suites run in Node with no DOM and no testing-library, and the
// invariant is structural anyway: the four `open*` helpers are the only way a dialog is opened from
// the detail, and each must close the detail first. The same shape as `rental.boundary.test.ts`, which
// likewise pins a rule the type system cannot express.
describe("every dialog opened from the record detail closes it first", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./HireCustodyTimeline.tsx", import.meta.url)),
    "utf8",
  );

  it.each(["openDismiss", "openUndo", "openRecover", "openCharge"])(
    "%s calls setDetail(null) before opening its dialog",
    (helper) => {
      const body = src.slice(src.indexOf(`const ${helper} = (`));
      const open = body.indexOf("{");
      const close = body.indexOf("\n  };");
      expect(open).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(open);
      expect(body.slice(open, close)).toContain("setDetail(null)");
    },
  );

  it("opens the dismiss confirm ONLY through that helper", () => {
    // An inline `setDismissing(...)` in a click handler is how the trap got in the first time: it set
    // the confirm without clearing the detail. The helper is the one place allowed to call it.
    const setters = src.match(/setDismissing\(/g) ?? [];
    // One in the helper, one in each `onClose`/reset — none inside a button's onClick.
    expect(src).not.toMatch(/onClick=\{\(\) => \{[^}]*setDismissing\(/);
    expect(setters.length).toBeGreaterThan(0);
  });
});
