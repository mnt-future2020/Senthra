import { describe, expect, it } from "vitest";

import { chargedTotal } from "./HireCustodyTimeline";
import type { HireCustodyExit } from "@/types/rental";

// WHAT THE ORDER HAS BEEN CHARGED, added up once.
//
// `settledCharge` is what the settling note charged for a record's HIRE LINE. Two ways the same money
// used to be reachable more than once:
//
//   • one note covering two hire lines handed each of its records the whole DOCUMENT total, so two
//     records reported £4 each against a £4 note;
//   • one note line settling two records on that line (two engineer reports of a unit each, answered
//     by a single note) reported that line's charge once per record.
//
// The first is fixed on the server, which now attributes per hire line. The second is fixed here.

const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit =>
  ({
    id: "x1",
    purchaseOrderRentalLineId: "l1",
    purchaseOrderId: "p1",
    poCode: "PO-0073",
    warehouseId: "w1",
    kind: "damage",
    qty: 1,
    itemName: "Fibre Tester",
    custodyState: "held_damaged",
    settlementState: "settled",
    reason: "Cracked casing",
    notes: null,
    photoUrl: null,
    jobId: null,
    jobNumber: null,
    engineerId: null,
    engineerName: null,
    declaredBy: "eng@x.co",
    declaredAt: "2026-08-27T00:00:00.000Z",
    settledByReceiptId: "n1",
    settledAt: "2026-08-31T05:44:17.000Z",
    recoveredBy: null,
    recoveredAt: null,
    recoveryNotes: null,
    settledByCode: "HDM-0014",
    settledCharge: 1,
    settledNotedAt: "2026-08-31T00:00:00.000Z",
    sourceReceiptId: null,
    sourceCode: null,
    attachments: [],
    attachmentsReceiptId: null,
    ...over,
  }) as HireCustodyExit;

describe("chargedTotal", () => {
  it("adds nothing when nothing has been quoted", () => {
    expect(chargedTotal([])).toBe(0);
    expect(chargedTotal([exit({ settledCharge: null, settlementState: "unsettled", settledByReceiptId: null })])).toBe(0);
  });

  it("adds one charge per settled record on its own note", () => {
    expect(chargedTotal([exit(), exit({ id: "x2", settledByReceiptId: "n2", settledCharge: 3 })])).toBe(4);
  });

  it("counts ONE note line once, however many records it settled", () => {
    // THE BUG. Two engineer reports of a unit each on the same hire, answered by one £1 note line: the
    // supplier is owed £1 and the header used to say £2.
    const total = chargedTotal([exit({ id: "x1" }), exit({ id: "x2" })]);
    expect(total).toBe(1);
  });

  it("still counts both lines of a note that covers two hires", () => {
    // Not deduped by note alone: a note charging £1 on one hire line and £3 on another really does owe
    // £4, and collapsing on the note id would lose half of it.
    expect(
      chargedTotal([exit({ id: "x1" }), exit({ id: "x2", purchaseOrderRentalLineId: "l2", settledCharge: 3 })]),
    ).toBe(4);
  });

  it("keeps a zero charge, which is an agreed figure and not a missing one", () => {
    // `0` is "we asked and they are not charging"; `null` is "nothing quoted yet". Only the second is
    // skipped, and neither may be turned into the other.
    expect(chargedTotal([exit({ settledCharge: 0 })])).toBe(0);
    expect(chargedTotal([exit({ settledCharge: 0 }), exit({ id: "x2", settledByReceiptId: "n2", settledCharge: 2 })])).toBe(2);
  });

  it("does not fold unsettled records into each other", () => {
    // An unsettled record shares no note, so it must key on itself. Two of them carrying a figure —
    // possible only through a charge recorded straight onto the record — stay two.
    expect(
      chargedTotal([
        exit({ id: "x1", settledByReceiptId: null, settledCharge: 1 }),
        exit({ id: "x2", settledByReceiptId: null, settledCharge: 2 }),
      ]),
    ).toBe(3);
  });

  it("ignores withdrawn and dismissed records that carry no figure", () => {
    expect(
      chargedTotal([
        exit({ id: "x1", custodyState: "withdrawn", settlementState: "dismissed", settledByReceiptId: null, settledCharge: null }),
        exit({ id: "x2", settledByReceiptId: "n2", settledCharge: 5 }),
      ]),
    ).toBe(5);
  });
  it("drops the charge when the note behind it is reversed", () => {
    // Reversing a note releases every record it settled: `unwindCustody` clears `settledByReceiptId`
    // and returns the row to `unsettled`, so the settlement lookup finds no note and `settledCharge`
    // comes back null. The withdrawn money must not linger in the header on the strength of a figure
    // the record no longer carries.
    const released = exit({ settlementState: "unsettled", settledByReceiptId: null, settledAt: null, settledByCode: null, settledCharge: null });
    expect(chargedTotal([released])).toBe(0);
    // And a second record that WAS on that same note is released with it — neither may be left behind.
    expect(chargedTotal([released, exit({ id: "x2", settlementState: "unsettled", settledByReceiptId: null, settledByCode: null, settledCharge: null })])).toBe(0);
  });

  /**
   * THE LIVE ORDER, so the dedupe cannot quietly over-collapse.
   *
   * PO-0073 carries seven settled records on ONE hire line, each on its OWN note — HDM-0003 £66,
   * HLS-0002 £90, HLS-0003 £22, HDM-0010 £7, HLS-0004 £2, HDM-0011 £1, HDM-0014 £1 — plus a dismissed
   * report and two withdrawn ones carrying no figure. The header reads £189.00 today and must keep
   * reading it: keying on the note alone would be wrong in the other direction and collapse these to £1.
   */
  it("reproduces the live PO-0073 total of 189", () => {
    const notes: [string, string, number][] = [
      ["a", "HDM-0003", 66], ["b", "HLS-0002", 90], ["c", "HLS-0003", 22],
      ["d", "HDM-0010", 7], ["e", "HLS-0004", 2], ["f", "HDM-0011", 1], ["g", "HDM-0014", 1],
    ];
    const settled = notes.map(([id, code, charge]) =>
      exit({ id, settledByReceiptId: id, settledByCode: code, settledCharge: charge }),
    );
    const noFigure = [
      exit({ id: "dismissed", settlementState: "dismissed", settledByReceiptId: null, settledByCode: null, settledCharge: null }),
      exit({ id: "w1", custodyState: "withdrawn", settlementState: "dismissed", settledByReceiptId: null, settledByCode: null, settledCharge: null }),
      exit({ id: "w2", custodyState: "withdrawn", settlementState: "dismissed", settledByReceiptId: null, settledByCode: null, settledCharge: null }),
    ];
    expect(chargedTotal([...settled, ...noFigure])).toBe(189);
  });
});
