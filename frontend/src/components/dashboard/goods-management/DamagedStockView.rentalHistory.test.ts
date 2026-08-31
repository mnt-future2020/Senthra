import { describe, expect, it } from "vitest";

import {
  countsAsCurrentDamage,
  hireHistory,
  rentalEntryStatus,
  toDamagedRows,
} from "./DamagedStockView";
import type { HireCustodyExit } from "@/types/rental";

// The hardening pass for rental damage HISTORY, kept beside `DamagedStockView.rental.test.ts` rather
// than inside it: that file covers the adapter's shape (one row per problem, the item in the item
// column, a loss reason printed as words), and this one covers what the history CLAIMS — the running
// total, what became of each event, and what it cost.

const exit = (over: Partial<HireCustodyExit> = {}): HireCustodyExit => ({
  id: "x1",
  purchaseOrderRentalLineId: "l1",
  purchaseOrderId: "p1",
  poCode: "PO-0073",
  warehouseId: "w1",
  kind: "damage",
  qty: 1,
  itemName: "Fibre Tester",
  custodyState: "held_damaged",
  settlementState: "unsettled",
  reason: "Screen cracked on site",
  notes: null,
  photoUrl: null,
  jobId: "j1",
  jobNumber: "JOB-2026-0041",
  engineerId: "e1",
  engineerName: "Kansha M",
  declaredBy: "wm@x.co",
  declaredAt: "2026-08-24T00:00:00.000Z",
  settledByReceiptId: null,
  settledAt: null,
  recoveredBy: null,
  recoveredAt: null,
  recoveryNotes: null,
  settledByCode: null,
  settledCharge: null,
  settledNotedAt: null,
  attachments: [],
  attachmentsReceiptId: null,
  sourceReceiptId: null,
  sourceCode: null,
  ...over,
});

// ── "Total after this" must describe NOW ───────────────────────────────────────────────────────
//
// The modal prints the running total as a claim about the standing tally ("Total after this: N
// damaged"), directly under a heading that states the card's quantity. Those two numbers are read
// together, so they have to BE the same number — and they were not: the card is built from the events
// the server's OPEN query returns, while the modal is handed every event on the hire line, and summing
// all of them made a hire with one open report beside two already charged print 3 under a heading that
// said 1.
describe("hireHistory — the running total is the CURRENT damaged quantity", () => {
  /**
   * What `findOpenByWarehouses` hands the pane for this line.
   *
   * Written out literally rather than by calling `countsAsCurrentDamage`, so these tests still fail if
   * that predicate is quietly widened — a fixture built from the code under test cannot catch it
   * drifting away from the server rule it mirrors.
   */
  const serverOpen = (all: HireCustodyExit[]) =>
    all.filter(
      (e) =>
        e.settlementState === "unsettled" &&
        !["withdrawn", "recovered", "returned_to_supplier"].includes(e.custodyState),
    );

  /** The production pipeline in the order the component runs it: card from the open set, modal from all. */
  const pane = (all: HireCustodyExit[]) => {
    const card = toDamagedRows(serverOpen(all))[0]!;
    return { card, history: hireHistory(card, all) };
  };

  it("counts an unsettled report", () => {
    const { card, history } = pane([exit({ id: "a", qty: 2 })]);
    expect(card.quantity).toBe(2);
    expect(history.entries[0]).toMatchObject({ balanceAfter: 2, countsToTotal: true });
  });

  it("drops a SETTLED report out of the current total", () => {
    // Charged to the provider: the claim is answered, so it is history — however much the tester is
    // still sitting on the shelf.
    const { card, history } = pane([
      exit({ id: "live", qty: 1, declaredAt: "2026-08-24T00:00:00.000Z" }),
      exit({ id: "paid", qty: 5, settlementState: "settled", declaredAt: "2026-08-25T00:00:00.000Z" }),
    ]);
    expect(card.quantity).toBe(1);
    const paid = history.entries.find((e) => e.id === "paid")!;
    expect(paid.countsToTotal).toBe(false);
    expect(paid.balanceAfter).toBe(1); // unmoved by an event that no longer counts
  });

  it("drops a DISMISSED report out of the current total", () => {
    const { card, history } = pane([
      exit({ id: "live", qty: 1, declaredAt: "2026-08-24T00:00:00.000Z" }),
      exit({ id: "free", qty: 4, settlementState: "dismissed", declaredAt: "2026-08-25T00:00:00.000Z" }),
    ]);
    expect(card.quantity).toBe(1);
    expect(history.entries.find((e) => e.id === "free")).toMatchObject({ countsToTotal: false, balanceAfter: 1 });
  });

  it("drops a WITHDRAWN report out of the current total", () => {
    // A withdrawn report never happened of record. Counting it would quarantine equipment on the
    // strength of a report somebody took back.
    const { card, history } = pane([
      exit({ id: "live", qty: 1, declaredAt: "2026-08-24T00:00:00.000Z" }),
      exit({ id: "gone", qty: 3, custodyState: "withdrawn", declaredAt: "2026-08-25T00:00:00.000Z" }),
    ]);
    expect(card.quantity).toBe(1);
    expect(history.entries.find((e) => e.id === "gone")).toMatchObject({ countsToTotal: false, balanceAfter: 1 });
  });

  it("drops equipment the provider has COLLECTED out of the current total", () => {
    // Still owed for, but not broken in this building — which is what this pool counts.
    const { card, history } = pane([
      exit({ id: "live", qty: 1, declaredAt: "2026-08-24T00:00:00.000Z" }),
      exit({
        id: "gone",
        qty: 2,
        custodyState: "returned_to_supplier",
        settlementState: "settled",
        declaredAt: "2026-08-25T00:00:00.000Z",
      }),
    ]);
    expect(card.quantity).toBe(1);
    expect(history.entries.find((e) => e.id === "gone")).toMatchObject({ countsToTotal: false });
  });

  /**
   * THE INVARIANT, on the shape live data actually holds — WH-0011's PO-0054 hire line carries two open
   * reports and one already charged. Before the fix the card said 2 and the newest entry said 3.
   */
  it("ends on the same total the card is built from, across a mixed lifecycle", () => {
    const all = [
      exit({ id: "backfill", qty: 1, declaredAt: "2026-08-24T06:49:00.000Z" }),
      exit({ id: "job", qty: 1, declaredAt: "2026-08-24T10:41:00.000Z" }),
      exit({ id: "charged", qty: 1, settlementState: "settled", declaredAt: "2026-08-25T11:36:00.000Z" }),
      exit({ id: "dismissed", qty: 1, settlementState: "dismissed", declaredAt: "2026-08-26T00:00:00.000Z" }),
      exit({ id: "withdrawn", qty: 1, custodyState: "withdrawn", declaredAt: "2026-08-27T00:00:00.000Z" }),
    ];
    const { card, history } = pane(all);
    expect(card.quantity).toBe(2);

    // Newest first, as the API returns them — so the entry the reader sees FIRST is the one that has
    // to agree with the heading above it.
    const newest = [...history.entries].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0]!;
    expect(newest.balanceAfter).toBe(card.quantity);

    // And no entry anywhere may claim more current damage than actually stands.
    for (const e of history.entries) expect(e.balanceAfter).toBeLessThanOrEqual(card.quantity);
  });

  it("still reconciles when every report has been answered", () => {
    // WH-0005's PO-0073 shape: nothing open, so the pane shows no row at all — and a history opened for
    // that line must not invent a standing total for equipment nobody owes an answer on.
    const all = [
      exit({ id: "a", qty: 3, settlementState: "settled", declaredAt: "2026-08-26T00:00:00.000Z" }),
      exit({ id: "b", qty: 1, settlementState: "dismissed", declaredAt: "2026-08-31T00:00:00.000Z" }),
    ];
    expect(toDamagedRows(serverOpen(all))).toHaveLength(0);

    const history = hireHistory({ ...toDamagedRows(all)[0]!, quantity: 0 }, all);
    for (const e of history.entries) {
      expect(e.countsToTotal).toBe(false);
      expect(e.balanceAfter).toBe(0);
    }
  });

  it("never reports a restore — a hire has nowhere to be restored to", () => {
    // The owned modal colours a negative delta green as units rejoining usable stock. A hire goes back
    // to the provider broken; a green line would say it rejoined ours.
    const all = [exit({ id: "a" }), exit({ id: "b", settlementState: "settled" })];
    for (const e of hireHistory(toDamagedRows([exit({ id: "a" })])[0]!, all).entries) {
      expect(e.type).toBe("write_off");
      expect(e.quantityDelta).toBeGreaterThan(0);
    }
  });
});

// ── Withdrawn is not live damage ───────────────────────────────────────────────────────────────
//
// The PO timeline has always said "Report withdrawn"; this modal rendered the same record as a plain
// "Damage reported" in the same alarm red, with its units inside the running total. One record, two
// screens, two contradictory readings.
describe("withdrawn damage", () => {
  it("labels a withdrawn report as withdrawn rather than as a live one", () => {
    const withdrawn = exit({ custodyState: "withdrawn" });
    const [entry] = hireHistory({ ...toDamagedRows([withdrawn])[0]!, quantity: 0 }, [withdrawn]).entries;
    expect(entry!.status).toBe("withdrawn");
    expect(entry!.countsToTotal).toBe(false);
  });

  it("keeps the withdrawn record VISIBLE — history is labelled, never edited", () => {
    const all = [exit({ id: "live" }), exit({ id: "gone", custodyState: "withdrawn" })];
    const history = hireHistory(toDamagedRows([exit({ id: "live" })])[0]!, all);
    expect(history.entries.map((e) => e.id).sort()).toEqual(["gone", "live"]);
  });

  it("reads CUSTODY before settlement, so a withdrawn-and-dismissed record says withdrawn", () => {
    // Both withdrawn rows on the live PO-0073 are exactly this pair. "No charge" would state the least
    // important half of a record that was retracted outright.
    expect(rentalEntryStatus({ custodyState: "withdrawn", settlementState: "dismissed" })).toBe("withdrawn");
  });
});

// ── Status and the predicate cannot drift apart ────────────────────────────────────────────────
describe("rentalEntryStatus / countsAsCurrentDamage", () => {
  const CUSTODY = ["held_damaged", "returned_to_supplier", "withdrawn", "lost", "recovered"];
  const SETTLEMENT = ["unsettled", "settled", "dismissed"];

  it("counts exactly the records it calls active, over every state combination", () => {
    for (const custodyState of CUSTODY) {
      for (const settlementState of SETTLEMENT) {
        const e = { custodyState, settlementState };
        expect(countsAsCurrentDamage(e)).toBe(rentalEntryStatus(e) === "active");
      }
    }
  });

  it("names each answered state, so the reader is never left with a bare colour", () => {
    expect(rentalEntryStatus({ custodyState: "held_damaged", settlementState: "settled" })).toBe("charged");
    expect(rentalEntryStatus({ custodyState: "held_damaged", settlementState: "dismissed" })).toBe("no_charge");
    expect(rentalEntryStatus({ custodyState: "returned_to_supplier", settlementState: "settled" })).toBe("returned");
    expect(rentalEntryStatus({ custodyState: "recovered", settlementState: "settled" })).toBe("recovered");
    expect(rentalEntryStatus({ custodyState: "held_damaged", settlementState: "unsettled" })).toBe("active");
  });
});

// ── What the fault cost, and on which document ─────────────────────────────────────────────────
//
// Both fields were already arriving from the API and being dropped in this adapter, which left the one
// screen a warehouse reads unable to answer "what did that cost" while the order page two clicks away
// printed the figure and its note code.
describe("rental charge traceability", () => {
  const entryFor = (over: Partial<HireCustodyExit>) => {
    const e = exit(over);
    return hireHistory({ ...toDamagedRows([e])[0]!, quantity: e.qty }, [e]).entries[0]!;
  };

  it("carries the charge amount through to the history entry", () => {
    expect(
      entryFor({ settlementState: "settled", settledByReceiptId: "r1", settledByCode: "HDM-0011", settledCharge: 189 }),
    ).toMatchObject({ status: "charged", settledCharge: 189 });
  });

  it("carries the settlement reference — a figure with nothing to look it up by is not an answer", () => {
    expect(entryFor({ settlementState: "settled", settledByCode: "HDM-0014", settledCharge: 1 }).settledByCode).toBe(
      "HDM-0014",
    );
  });

  it("keeps 'no figure quoted yet' distinct from a charge of zero", () => {
    // A note raised before the provider has priced it carries no figure. Flattening that to £0.00 would
    // report a settled cost of nothing on a claim nobody has answered.
    const e = entryFor({ settlementState: "settled", settledByCode: "HDM-0011", settledCharge: null });
    expect(e.settledCharge).toBeNull();
    expect(e.settledByCode).toBe("HDM-0011");
  });

  it("shows a dismissed record as no charge, with no document behind it", () => {
    const e = entryFor({ settlementState: "dismissed" });
    expect(e.status).toBe("no_charge");
    expect(e.settledByCode).toBeNull();
    expect(e.settledCharge).toBeNull();
  });

  it("says nothing about money on a record nobody has answered yet", () => {
    const e = entryFor({});
    expect(e.status).toBe("active");
    expect(e.settledByCode).toBeNull();
  });
});
