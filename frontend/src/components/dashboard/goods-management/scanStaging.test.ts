import { describe, expect, it } from "vitest";

import { capOf, collapsesByDefault, expandMatch, groupLines, lineKey, postableLines, stageScan, type ScanLine } from "./scanStaging";
import type { ScanMatch } from "@/types/goodsManagement";

const NOW = 1_700_000_000_000;

const irm = (over: Partial<ScanMatch> = {}): ScanMatch => ({
  source: "irm",
  irmItemId: "i1",
  jobKitLineId: "k1",
  itemName: "Cat6 Cable",
  plannedQty: 5,
  alreadyIssued: 0,
  remainingIssuable: 5,
  heldByEngineer: 0,
  available: 20,
  ...over,
});

/** A rental return resolved to two hires of the same tester — the shape the bug was found in. */
const rentalReturn = (over: Partial<ScanMatch> = {}): ScanMatch => ({
  source: "rental",
  rentalItemId: "r1",
  jobKitLineId: "k9",
  itemName: "Fibre Tester",
  plannedQty: 2,
  alreadyIssued: 2,
  remainingIssuable: 0,
  heldByEngineer: 1,
  available: 0,
  purchaseOrderRentalLineId: "hireA",
  hire: { poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", itemName: "Fibre Tester", overdue: false },
  hires: [
    { purchaseOrderRentalLineId: "hireA", poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", overdue: false, qty: 1 },
    { purchaseOrderRentalLineId: "hireB", poCode: "PO-0057", hireEndDate: "2026-10-21T00:00:00.000Z", overdue: false, qty: 1 },
  ],
  ...over,
});

describe("lineKey", () => {
  it("keeps a rental's two hires apart", () => {
    // The bug: keyed by the kit line alone, both hires of one tester were the SAME card — so the
    // second scan bumped the first card into its own 1-unit ceiling and vanished.
    const [a, b] = expandMatch(rentalReturn(), false);
    expect(lineKey(a)).not.toBe(lineKey(b));
  });

  it("still keys non-rentals by their item, so a re-scan bumps rather than duplicates", () => {
    expect(lineKey(irm())).toBe(lineKey(irm({ plannedQty: 99 })));
    expect(lineKey({ ...irm(), source: "customer", irmItemId: undefined, customerStockEntryId: "c1" })).toBe("c1");
    // Misc lines carry no stock id at all — the kit line is the only thing that identifies them.
    expect(lineKey({ ...irm(), source: "misc", irmItemId: undefined })).toBe("k1");
  });
});

describe("expandMatch", () => {
  it("splits a rental return into one card per hire, each with its own cap and deadline", () => {
    expect(expandMatch(rentalReturn(), false)).toEqual([
      expect.objectContaining({
        purchaseOrderRentalLineId: "hireA",
        heldByEngineer: 1,
        hire: { poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", itemName: "Fibre Tester", overdue: false },
      }),
      expect.objectContaining({
        purchaseOrderRentalLineId: "hireB",
        heldByEngineer: 1,
        hire: { poCode: "PO-0057", hireEndDate: "2026-10-21T00:00:00.000Z", itemName: "Fibre Tester", overdue: false },
      }),
    ]);
  });

  it("leaves every other scan exactly as it came", () => {
    // One hire, no hires at all, and a non-rental all stay a single card — the fan-out is the
    // exception, not the new normal.
    expect(expandMatch(irm(), true)).toEqual([irm()]);
    const single = rentalReturn({ hires: [{ purchaseOrderRentalLineId: "hireA", poCode: "PO-0054", hireEndDate: null, overdue: false, qty: 1 }] });
    expect(expandMatch(single, false)).toEqual([single]);
    const issue = rentalReturn({ hires: undefined, remainingIssuable: 3, heldByEngineer: 0 });
    expect(expandMatch(issue, true)).toEqual([issue]);
  });
});

describe("stageScan — returns", () => {
  const staged = expandMatch(rentalReturn(), false);

  it("stages every hire from ONE scan, and counts that scan once", () => {
    // The whole point: a kit line reading "issued 2" now shows both units in the panel after a single
    // scan. Only the first is counted — a scan is one physical unit — and the second is there to be
    // dialled up, not hidden behind a post-and-rescan.
    const lines = stageScan([], staged, false, NOW);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => [l.match.purchaseOrderRentalLineId, l.goodQty])).toEqual([
      ["hireA", 1],
      ["hireB", 0],
    ]);
  });

  it("fills the soonest deadline first, then moves to the next hire", () => {
    const once = stageScan([], staged, false, NOW);
    const twice = stageScan(once, staged, false, NOW);
    expect(twice.map((l) => l.goodQty)).toEqual([1, 1]); // hireA was full, so the 2nd scan went to hireB
    expect(twice).toHaveLength(2); // and did NOT duplicate a card
  });

  it("is a no-op once every hire is full", () => {
    const full = stageScan(stageScan([], staged, false, NOW), staged, false, NOW);
    expect(stageScan(full, staged, false, NOW).map((l) => l.goodQty)).toEqual([1, 1]);
  });

  it("counts the damaged portion against the same cap as the good one", () => {
    // Held 1, already marked damaged ⇒ the card is full, and the scan must roll to the next hire
    // rather than pushing good + damaged over what the engineer actually holds.
    const withDamage: ScanLine[] = [
      { key: "a", match: staged[0], qty: 0, goodQty: 0, damagedQty: 1 },
    ];
    const next = stageScan(withDamage, staged, false, NOW);
    expect(next[0]).toMatchObject({ goodQty: 0, damagedQty: 1 });
    expect(next[1]).toMatchObject({ match: expect.objectContaining({ purchaseOrderRentalLineId: "hireB" }), goodQty: 1 });
  });

  // Cards can sit staged for a long time now that one scan fans out, and the world moves underneath
  // them: another warehouse issues off the same hire, or the engineer hands units back elsewhere. A
  // re-scan is the operator asking again, so it must bring the answer back with it — a stale cap makes
  // the POST 409 and takes the whole movement down, including the lines that were fine.
  it("refreshes a staged card's caps from the newer scan", () => {
    const staged = expandMatch(rentalReturn(), false);
    const before = stageScan([], staged, false, NOW);
    const fresher = expandMatch(rentalReturn({ hires: [
      { purchaseOrderRentalLineId: "hireA", poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", overdue: true, qty: 4 },
      { purchaseOrderRentalLineId: "hireB", poCode: "PO-0057", hireEndDate: "2026-10-21T00:00:00.000Z", overdue: false, qty: 1 },
    ] }), false);

    const after = stageScan(before, fresher, false, NOW);
    expect(after[0].match.heldByEngineer).toBe(4);
    expect(after[0].match.hire?.overdue).toBe(true); // the deadline moved too, and the card says so
    expect(after).toHaveLength(2); // refreshed in place, not duplicated
  });

  it("clamps a typed quantity down when the newer scan says there is less", () => {
    // The operator typed 2 while the engineer still held 2; by the time they scan again one has gone
    // back at another depot. Showing 2 against a cap of 1 is the state that 409s at the till.
    const staged = expandMatch(rentalReturn({ hires: undefined, heldByEngineer: 2 }), false);
    const before = stageScan(stageScan([], staged, false, NOW), staged, false, NOW);
    expect(before[0].goodQty).toBe(2);

    const after = stageScan(before, expandMatch(rentalReturn({ hires: undefined, heldByEngineer: 1 }), false), false, NOW);
    expect(after[0]).toMatchObject({ goodQty: 1, damagedQty: 0 });
  });

  it("clamps the damaged portion first when the cap shrinks below both", () => {
    // Good must never be silently promoted over evidence-backed damage: the damaged units have a photo
    // and a reason attached, so the good portion is what gives way.
    const staged = expandMatch(rentalReturn({ hires: undefined, heldByEngineer: 3 }), false);
    const lines: ScanLine[] = [{ key: "a", match: staged[0], qty: 0, goodQty: 2, damagedQty: 1 }];
    const after = stageScan(lines, expandMatch(rentalReturn({ hires: undefined, heldByEngineer: 1 }), false), false, NOW);
    expect(after[0]).toMatchObject({ goodQty: 0, damagedQty: 1 });
  });

  it("caps a single-hire return at what that hire holds", () => {
    const one = expandMatch(rentalReturn({ hires: undefined, heldByEngineer: 2 }), false);
    const twice = stageScan(stageScan([], one, false, NOW), one, false, NOW);
    const thrice = stageScan(twice, one, false, NOW);
    expect(thrice).toHaveLength(1);
    expect(thrice[0].goodQty).toBe(2);
  });
});

describe("stageScan — issues", () => {
  it("adds a card at 1 and bumps it on a re-scan", () => {
    const once = stageScan([], [irm()], true, NOW);
    expect(once).toEqual([expect.objectContaining({ qty: 1, goodQty: 0, damagedQty: 0 })]);
    expect(stageScan(once, [irm()], true, NOW).map((l) => l.qty)).toEqual([2]);
  });

  it("never exceeds what is still issuable", () => {
    const m = irm({ remainingIssuable: 1 });
    const twice = stageScan(stageScan([], [m], true, NOW), [m], true, NOW);
    expect(twice.map((l) => l.qty)).toEqual([1]);
  });

  it("leaves other staged lines untouched", () => {
    const other = irm({ irmItemId: "i2", jobKitLineId: "k2", itemName: "Patch Panel" });
    const lines = stageScan(stageScan([], [irm()], true, NOW), [other], true, NOW);
    expect(lines.map((l) => [l.match.itemName, l.qty])).toEqual([
      ["Cat6 Cable", 1],
      ["Patch Panel", 1],
    ]);
  });
});

describe("capOf", () => {
  it("reads the issuable remainder on the way out and the held qty on the way back", () => {
    expect(capOf(irm({ remainingIssuable: 4, heldByEngineer: 2 }), true)).toBe(4);
    expect(capOf(irm({ remainingIssuable: 4, heldByEngineer: 2 }), false)).toBe(2);
  });
});

/** An issue scan spread over three hires — 5 planned, drawn 2 + 2 + 1. */
const rentalIssue = (over: Partial<ScanMatch> = {}): ScanMatch => ({
  source: "rental",
  rentalItemId: "r1",
  jobKitLineId: "k9",
  itemName: "Fibre Tester",
  plannedQty: 5,
  alreadyIssued: 0,
  remainingIssuable: 2,
  heldByEngineer: 0,
  available: 2,
  purchaseOrderRentalLineId: "hireA",
  hire: { poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", itemName: "Fibre Tester", overdue: false },
  hires: [
    { purchaseOrderRentalLineId: "hireA", poCode: "PO-0054", hireEndDate: "2026-09-30T00:00:00.000Z", overdue: false, qty: 2, available: 2 },
    { purchaseOrderRentalLineId: "hireB", poCode: "PO-0057", hireEndDate: "2026-10-21T00:00:00.000Z", overdue: false, qty: 2, available: 6 },
    { purchaseOrderRentalLineId: "hireC", poCode: "PO-0061", hireEndDate: "2026-11-02T00:00:00.000Z", overdue: false, qty: 1, available: 3 },
  ],
  ...over,
});

describe("expandMatch — issue leg", () => {
  it("gives each hire its own issuable cap", () => {
    const cards = expandMatch(rentalIssue(), true);
    expect(cards.map((c) => [c.purchaseOrderRentalLineId, c.remainingIssuable])).toEqual([
      ["hireA", 2],
      ["hireB", 2],
      ["hireC", 1],
    ]);
  });

  it("shows each hire's REAL stock as Available, not the slice this job takes", () => {
    // hireB lends 2 to this line but holds 6. Printing 2 would have the depot's stock appear to shrink
    // to whatever the job in front of you happened to ask for.
    expect(expandMatch(rentalIssue(), true).map((c) => c.available)).toEqual([2, 6, 3]);
  });

  it("stages the whole spread from one scan, counting that scan once", () => {
    const lines = stageScan([], expandMatch(rentalIssue(), true), true, NOW);
    expect(lines.map((l) => [l.match.purchaseOrderRentalLineId, l.qty])).toEqual([
      ["hireA", 1],
      ["hireB", 0],
      ["hireC", 0],
    ]);
  });
});

describe("groupLines", () => {
  it("gathers one item's hires into a single group and totals them", () => {
    const lines = stageScan([], expandMatch(rentalIssue(), true), true, NOW);
    const [group] = groupLines(lines, true);
    expect(group).toMatchObject({ key: "k9", itemName: "Fibre Tester", staged: 1, cap: 5 });
    expect(group.lines).toHaveLength(3);
  });

  it("keeps unrelated items in their own groups, in the order they were scanned", () => {
    const lines = stageScan(stageScan([], [irm()], true, NOW), expandMatch(rentalIssue(), true), true, NOW);
    expect(groupLines(lines, true).map((g) => [g.itemName, g.lines.length])).toEqual([
      ["Cat6 Cable", 1],
      ["Fibre Tester", 3],
    ]);
  });

  it("totals the good AND damaged portions on a return", () => {
    const staged = expandMatch(rentalReturn(), false);
    const lines: ScanLine[] = [
      { key: "a", match: staged[0], qty: 0, goodQty: 0, damagedQty: 1 },
      { key: "b", match: staged[1], qty: 0, goodQty: 1, damagedQty: 0 },
    ];
    expect(groupLines(lines, false)[0]).toMatchObject({ staged: 2, cap: 2 });
  });
});

describe("postableLines", () => {
  // A card left at zero is an OFFER the operator declined, not a line. It matters because the extra
  // hire cards arrive empty by design: posting them would send qty 0, which the server rejects for the
  // whole movement (`qty` is min 1), and REFUSING to post until every card is filled would make a scan
  // that offers three hires impossible to complete unless the job wanted all three.
  it("drops cards nobody put a quantity on", () => {
    const staged = stageScan([], expandMatch(rentalIssue(), true), true, NOW);
    expect(postableLines(staged, true).map((l) => l.match.purchaseOrderRentalLineId)).toEqual(["hireA"]);
  });

  it("keeps a return card that is damaged-only", () => {
    const staged = expandMatch(rentalReturn(), false);
    const lines: ScanLine[] = [
      { key: "a", match: staged[0], qty: 0, goodQty: 0, damagedQty: 1 },
      { key: "b", match: staged[1], qty: 0, goodQty: 0, damagedQty: 0 },
    ];
    expect(postableLines(lines, false).map((l) => l.key)).toEqual(["a"]);
  });

  it("returns nothing when the whole list is empty-handed — the panel disables Post on this", () => {
    const staged = expandMatch(rentalReturn(), false);
    const lines: ScanLine[] = staged.map((m, i) => ({ key: `k${i}`, match: m, qty: 0, goodQty: 0, damagedQty: 0 }));
    expect(postableLines(lines, false)).toEqual([]);
  });
});

describe("collapsesByDefault", () => {
  // A group is collapsed only when the repetition itself becomes the problem. Two or three cards read
  // as a list; six identical item names read as a bug, and the operator scrolls past the Post button.
  it("leaves small groups open and folds away the big ones", () => {
    expect(collapsesByDefault(1)).toBe(false);
    expect(collapsesByDefault(3)).toBe(false);
    expect(collapsesByDefault(4)).toBe(true);
  });
});
