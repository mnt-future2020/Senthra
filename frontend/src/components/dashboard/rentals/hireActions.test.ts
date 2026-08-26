import { describe, expect, it } from "vitest";

import {
  canManageHires,
  damageableNow,
  groupHiresByItem,
  heldOnHire,
  hireCustodySplit,
  deliveryReversalBlocker,
  issuableOnHire,
  netOrdered,
  noteReversalBlocker,
  shortfallAfterDelivery,
  canMoveHires,
  canSettleHires,
  hireKeepsOrderOpen,
  hireTakesDelivery,
  isTerminalHireStatus,
} from "./hireActions";
import type { HireReversalFacts } from "./hireActions";
import type { HireStatus } from "@/types/rental";

// A hire line as the screens actually hold one. Typed on its own shape rather than on the narrow
// `HireActionLine` the predicates accept: the predicates read two fields, the fixture describes a
// ROW, and pinning it to the narrower type is what made `receivedQuantity` a type error here while
// vitest ran green — the frontend had no `typecheck` script, so nothing caught it until `next build`.
type TestLine = {
  hireStatus: HireStatus;
  quantity: number;
  receivedQuantity: number;
  fullyReceived: boolean;
  returnedQuantity: number;
};
const line = (over: Partial<TestLine> = {}): TestLine => ({
  hireStatus: "awaiting_delivery",
  quantity: 5,
  receivedQuantity: 0,
  fullyReceived: false,
  returnedQuantity: 0,
  ...over,
});

describe("isTerminalHireStatus", () => {
  // The server's TERMINAL_HIRE_STATUSES, hand-mirrored — the same arrangement every other rule this
  // module shares with the API uses. Both terminal states, or the client and the server disagree
  // about what "finished" means and one of them shows a button the other refuses.
  it("counts both ways a hire ends, not just the one that went back", () => {
    expect(isTerminalHireStatus("returned")).toBe(true);
    expect(isTerminalHireStatus("cancelled")).toBe(true);
    expect(isTerminalHireStatus("on_hire")).toBe(false);
    expect(isTerminalHireStatus("awaiting_delivery")).toBe(false);
  });
});

// Mirrors the server's `awaitingDeliveryWhere`. Asked as "is anything still expected", never as
// `quantity - received > 0`: after a short close those are different questions, and the arithmetic
// one puts a Receive button on a hire the API refuses.
describe("hireTakesDelivery", () => {
  it("is true while units are genuinely still owed", () => {
    expect(hireTakesDelivery(line({ receivedQuantity: 2, hireStatus: "on_hire" }))).toBe(true);
    expect(hireTakesDelivery(line())).toBe(true);
  });

  it("is false once every ordered unit has arrived", () => {
    expect(hireTakesDelivery(line({ receivedQuantity: 5, fullyReceived: true, hireStatus: "on_hire" }))).toBe(false);
  });

  // The short close is the case the quantity subtraction gets wrong: 2 of 5 here, the other 3 recorded
  // as never arriving. `quantity - received` still reads 3, but nothing is expected and the server
  // refuses the delivery — a button that can only fail.
  it("is false on a part-delivered hire whose shortfall was closed short", () => {
    expect(
      hireTakesDelivery(line({ receivedQuantity: 2, fullyReceived: true, hireStatus: "on_hire" })),
    ).toBe(false);
  });

  // Nothing ever arrived and nothing ever will. `fullyReceived` is true here for the same reason —
  // it means "nothing more is expected" — but the status is the belt to that braces.
  it("is false on a cancelled hire", () => {
    expect(hireTakesDelivery(line({ hireStatus: "cancelled", fullyReceived: true }))).toBe(false);
  });
});

// Mirrors the server's close guard, which asks `isTerminalHireStatus` on every hire. Asking
// `!== "returned"` instead leaves Close disabled forever on an order whose last hire was cancelled —
// the same dead-end the short close was written to remove, reached from the order page.
// The server splits the hire keys three ways by who is in a position to know the thing being
// recorded. Nine screens were each spelling a pair of them out by hand, which is how a role gets a
// permission and no button to use it.
describe("who can do what to a hire", () => {
  const holder = (...keys: string[]) => (k: string) => keys.includes(k);

  it("lets any of the three keys work the floor — receive, return, report damage", () => {
    expect(canMoveHires(holder("rentals.hire.receive"))).toBe(true);
    expect(canMoveHires(holder("rentals.hire.settle"))).toBe(true);
    expect(canMoveHires(holder("rentals.hire.manage"))).toBe(true);
    expect(canMoveHires(holder("rentals.view"))).toBe(false);
  });

  // Closing a hire short, reversing a note, agreeing a damage figure. A scanner alone does not
  // rewrite a committed record — but the warehouse manager who typed it wrong is the one who knows.
  it("needs `settle` to correct a committed record, and a bare receiver cannot", () => {
    expect(canSettleHires(holder("rentals.hire.settle"))).toBe(true);
    expect(canSettleHires(holder("rentals.hire.manage"))).toBe(true);
    expect(canSettleHires(holder("rentals.hire.receive"))).toBe(false);
  });

  // The one thing the floor genuinely cannot decide: extending a hire commits fresh money.
  it("keeps extending a hire to `manage` alone", () => {
    expect(canManageHires(holder("rentals.hire.manage"))).toBe(true);
    expect(canManageHires(holder("rentals.hire.settle"))).toBe(false);
    expect(canManageHires(holder("rentals.hire.receive"))).toBe(false);
  });
});

// Reversing is direction-aware on the server, and only ONE of the three legs is refused once a hire
// has gone back. The button was gated on the ORDER's status alone, so on a returned hire it offered a
// delivery reversal that could only ever fail.
// Damage is a count of UNITS across the whole hire, and the server caps a new report at units NEVER
// recorded damaged — intersected with what is actually here. The screens were still subtracting the
// tally from what is HELD, which is a different sum the moment a damaged unit goes back.
// ── Where the kit we hold actually IS ──────────────────────────────────────────────────────────
//
// The warehouse's on-hire pane showed one figure, "units held" = received − returned, which is what we
// owe the provider. Some of that can be in an engineer's van. A row reading "3 held" therefore invited
// someone to hand three units to a collecting driver when only two were in the building — and
// `createRentalReturn` refused with a 409 explaining the difference, correctly and far too late to be
// useful. These are the client's copy of that server-side split.
describe("heldOnHire", () => {
  it("is what arrived less what has gone back", () => {
    expect(heldOnHire({ receivedQuantity: 5, returnedQuantity: 2 })).toBe(3);
  });

  it("never goes negative on a hand-edited row", () => {
    expect(heldOnHire({ receivedQuantity: 1, returnedQuantity: 4 })).toBe(0);
  });
});

describe("hireCustodySplit", () => {
  it("puts everything on the shelf when nothing is out on a job", () => {
    expect(hireCustodySplit({ receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 0 })).toEqual({
      atWarehouse: 3,
      withEngineers: 0,
    });
  });

  // The screenshot case: 3 on hire, 1 with Kansha, so only 2 can go back to the provider today.
  it("separates what is on a job from what is on the shelf", () => {
    expect(hireCustodySplit({ receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 1 })).toEqual({
      atWarehouse: 2,
      withEngineers: 1,
    });
  });

  it("counts units already gone back to the provider against the holding first", () => {
    expect(hireCustodySplit({ receivedQuantity: 5, returnedQuantity: 2, issuedQuantity: 1 })).toEqual({
      atWarehouse: 2,
      withEngineers: 1,
    });
  });

  // The invariant the pane depends on: the two halves are a SPLIT of the holding, so a row can never
  // display parts that add up to more (or less) than the number above them.
  it("always sums to what is held", () => {
    for (const line of [
      { receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 1 },
      { receivedQuantity: 5, returnedQuantity: 2, issuedQuantity: 3 },
      { receivedQuantity: 1, returnedQuantity: 1, issuedQuantity: 0 },
      { receivedQuantity: 4, returnedQuantity: 0, issuedQuantity: 4 },
    ]) {
      const s = hireCustodySplit(line);
      expect(s.atWarehouse + s.withEngineers).toBe(heldOnHire(line));
    }
  });

  // `issuedQuantity` is a maintained counter; a stale or hand-edited one must not be able to print a
  // negative shelf figure, which would read as a fault in the pane rather than in the data.
  it("clamps a counter that claims more is out than is held", () => {
    expect(hireCustodySplit({ receivedQuantity: 2, returnedQuantity: 0, issuedQuantity: 9 })).toEqual({
      atWarehouse: 0,
      withEngineers: 2,
    });
  });

  it("treats a negative counter as nothing out", () => {
    expect(hireCustodySplit({ receivedQuantity: 2, returnedQuantity: 0, issuedQuantity: -3 })).toEqual({
      atWarehouse: 2,
      withEngineers: 0,
    });
  });

  // A row written before the column existed carries no `issuedQuantity` at all. Absent is zero — the
  // same reading the server's own guard gives a missing counter — so the pane degrades to "all of it
  // is here" rather than rendering NaN.
  it("reads an absent counter as zero", () => {
    expect(hireCustodySplit({ receivedQuantity: 3, returnedQuantity: 0 })).toEqual({
      atWarehouse: 3,
      withEngineers: 0,
    });
  });
});

// ── One row per ITEM, not per contract ─────────────────────────────────────────────────────────
//
// A hire LINE is a contract — one item, one period, one price — so a depot holding the same tester on
// three periods legitimately has three lines. Correct bookkeeping, unreadable as a stock list: one
// warehouse showed ELEVEN rows of "Fibre Tester", which reads as a yard full of testers when the
// answer to "can I issue one" was six.
describe("groupHiresByItem", () => {
  const line = (over: Partial<Parameters<typeof groupHiresByItem>[0][number]> = {}) => ({
    id: "l1",
    rentalItemId: "item-a",
    rentalItemCode: "RNT-0005",
    itemName: "Fibre Tester",
    receivedQuantity: 3,
    returnedQuantity: 0,
    issuedQuantity: 0,
    availableToIssue: 3,
    hireEndDate: "2026-09-30T00:00:00.000Z",
    window: "ok" as const,
    ...over,
  });

  it("collapses many contracts of one item into a single row", () => {
    const groups = groupHiresByItem([line({ id: "a" }), line({ id: "b" }), line({ id: "c" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].lines).toHaveLength(3);
    expect(groups[0].itemName).toBe("Fibre Tester");
  });

  // The whole reason for grouping: the totals answer the question without the reader summing rows and
  // remembering which were expired.
  it("sums held, the custody split and what may actually be issued", () => {
    const groups = groupHiresByItem([
      // Expired: physically here, but nothing may go out. This is the row that used to mislead.
      line({ id: "a", receivedQuantity: 3, issuedQuantity: 1, availableToIssue: 0, window: "overdue", hireEndDate: "2026-08-16T00:00:00.000Z" }),
      line({ id: "b", receivedQuantity: 3, issuedQuantity: 0, availableToIssue: 3 }),
    ]);
    expect(groups[0]).toMatchObject({
      held: 6,
      atWarehouse: 5,
      withEngineers: 1,
      availableToIssue: 3, // NOT 5 — the expired hire's two shelf units cannot go out
    });
  });

  // Two catalogue items can share a name. Summing them would report quantities across different
  // equipment, which is worse than the fragmentation it was meant to fix.
  it("keys on the item id, never the name", () => {
    const groups = groupHiresByItem([line({ rentalItemId: "item-a" }), line({ rentalItemId: "item-b" })]);
    expect(groups).toHaveLength(2);
  });

  it("takes the soonest deadline in the group", () => {
    const groups = groupHiresByItem([
      line({ id: "a", hireEndDate: "2026-10-30T00:00:00.000Z" }),
      line({ id: "b", hireEndDate: "2026-08-16T00:00:00.000Z" }),
      line({ id: "c", hireEndDate: "2026-09-30T00:00:00.000Z" }),
    ]);
    expect(groups[0].earliestEnd).toBe("2026-08-16T00:00:00.000Z");
  });

  // The WORST window, not the first line's: a group holding one overdue hire is an overdue group, or
  // the badge would depend on the order rows happened to arrive in.
  it("inherits the worst window from its lines, whatever the order", () => {
    expect(groupHiresByItem([line({ id: "a" }), line({ id: "b", window: "overdue" })])[0].worstWindow).toBe("overdue");
    expect(groupHiresByItem([line({ id: "a", window: "overdue" }), line({ id: "b" })])[0].worstWindow).toBe("overdue");
    expect(groupHiresByItem([line({ id: "a" }), line({ id: "b", window: "expiring" })])[0].worstWindow).toBe("expiring");
  });

  it("puts the worst news first, then sorts by name for a stable order", () => {
    const groups = groupHiresByItem([
      line({ id: "a", rentalItemId: "z", itemName: "Zebra Tester" }),
      line({ id: "b", rentalItemId: "o", itemName: "Overdue Item", window: "overdue" }),
      line({ id: "c", rentalItemId: "a", itemName: "Alpha Tester" }),
    ]);
    expect(groups.map((g) => g.itemName)).toEqual(["Overdue Item", "Alpha Tester", "Zebra Tester"]);
  });

  // An absent figure means the server did not answer. On a number that authorises handing equipment
  // out, the safe reading of "unknown" is zero — never the physical count standing in for it.
  it("treats a missing availability figure as nothing issuable", () => {
    const rows = [line({ availableToIssue: undefined })];
    expect(groupHiresByItem(rows)[0].availableToIssue).toBe(0);
    // …while the physical figures still report honestly.
    expect(groupHiresByItem(rows)[0].held).toBe(3);
  });

  it("returns nothing for an empty set rather than an empty group", () => {
    expect(groupHiresByItem([])).toEqual([]);
  });
});

describe("damageableNow", () => {
  it("is what is held while nothing has been reported", () => {
    expect(damageableNow({ receivedQuantity: 3, returnedQuantity: 0, damagedQuantity: 0 })).toBe(3);
  });

  it("takes off units already reported", () => {
    expect(damageableNow({ receivedQuantity: 3, returnedQuantity: 0, damagedQuantity: 2 })).toBe(1);
  });

  // THE CASE THE SCREENS GOT WRONG. One unit went back damaged, so it is off the site but still on
  // the record. Two undamaged units are here and can still break. `held - damaged` says 1; the
  // server allows 2, and the form would not let the second be reported at all.
  it("does not net a RETURNED damaged unit against the undamaged ones still here", () => {
    expect(damageableNow({ receivedQuantity: 3, returnedQuantity: 1, damagedQuantity: 1 })).toBe(2);
  });

  // ...and the other way: two went back damaged, one clean unit is left. `held - damaged` goes
  // NEGATIVE, which dropped the line off the form and hid the Report damage button entirely.
  it("never goes negative, and still offers the clean unit that is left", () => {
    expect(damageableNow({ receivedQuantity: 3, returnedQuantity: 2, damagedQuantity: 2 })).toBe(1);
  });

  it("is nothing once everything here is already reported", () => {
    expect(damageableNow({ receivedQuantity: 2, returnedQuantity: 0, damagedQuantity: 2 })).toBe(0);
  });

  it("is nothing once the kit has gone back", () => {
    expect(damageableNow({ receivedQuantity: 3, returnedQuantity: 3, damagedQuantity: 0 })).toBe(0);
  });
});

// "4 came, the 5th never will" is ONE event at the receiving bay, and it used to need two actions
// with a trap between them: the modal computed the shortfall from what the SERVER held, so a form
// with 4 typed and nothing saved offered to write off all 5 and throw the 4 away.
// Every screen that prints a hire quantity as "X of Y" was using the ORDERED figure as Y. After a
// short close that figure includes units formally abandoned, so each of them promised equipment that
// is never coming — the collection note read "3 of 5" on a hire that will only ever hold 4.
describe("netOrdered", () => {
  it("is the ordered figure while nothing has been written off", () => {
    expect(netOrdered({ quantity: 5, cancelledQuantity: 0 })).toBe(5);
  });

  it("takes off what was written off", () => {
    expect(netOrdered({ quantity: 5, cancelledQuantity: 1 })).toBe(4);
  });

  // A line whose whole order was abandoned holds nothing, and "0 of 0" must not become "0 of -1" on
  // any screen that subtracts from it.
  it("never goes below zero", () => {
    expect(netOrdered({ quantity: 5, cancelledQuantity: 9 })).toBe(0);
  });

  // Rows written before the column existed, and every non-rental caller, pass nothing.
  it("treats a missing figure as nothing written off", () => {
    expect(netOrdered({ quantity: 5 })).toBe(5);
  });
});

describe("shortfallAfterDelivery", () => {
  it("is what is left once this delivery is counted", () => {
    expect(shortfallAfterDelivery(5, 4)).toBe(1);
    expect(shortfallAfterDelivery(5, 0)).toBe(5);
  });

  // Nothing to write off — the delivery covers the line, so the offer must not appear at all.
  it("is nothing when the delivery closes the line", () => {
    expect(shortfallAfterDelivery(5, 5)).toBe(0);
  });

  // A typed figure over the cap is caught by the form's own validation; this must not go negative and
  // report a phantom write-off in the meantime.
  it("never goes negative on an over-entry", () => {
    expect(shortfallAfterDelivery(5, 7)).toBe(0);
  });

  // A half-typed box is not "everything is outstanding" — it is not a number yet, and the offer
  // should describe the line as it stands rather than flickering.
  it("treats a blank or unparseable entry as nothing received", () => {
    expect(shortfallAfterDelivery(5, Number.NaN)).toBe(5);
  });
});

describe("deliveryReversalBlocker / noteReversalBlocker", () => {
  const live = (over: Partial<HireReversalFacts> = {}): HireReversalFacts => ({
    hireStatus: "on_hire",
    shortClosedAt: null,
    receivedQuantity: 2,
    returnedQuantity: 0,
    issuedQuantity: 0,
    lostQuantity: 0,
    damagedHeldQuantity: 0,
    ...over,
  });

  // REVERSING A DELIVERY ASSERTS THE UNITS NEVER CAME — true only of a unit still on our shelf, whole
  // and claimed by nobody. The gate used to test the hire's STATUS, which catches exactly one of the
  // four ways a unit stops being untouched. These three are the ones it let through: each left the
  // button showing on a delivery the server refuses, and pressing it drove `received` below what the
  // surviving records account for, where every screen clamps the negative away.
  it("refuses while any of it is out with an engineer", () => {
    expect(deliveryReversalBlocker(live({ issuedQuantity: 1 }), 2)).toMatch(/1 out with an engineer/);
  });

  it("refuses once a unit has been declared lost", () => {
    expect(deliveryReversalBlocker(live({ lostQuantity: 1 }), 2)).toMatch(/1 declared lost/);
  });

  it("refuses while a unit is reported damaged in our custody", () => {
    expect(deliveryReversalBlocker(live({ damagedHeldQuantity: 1 }), 2)).toMatch(/1 reported damaged here/);
  });

  it("names every claim in the way, not just the first", () => {
    const reason = deliveryReversalBlocker(live({ receivedQuantity: 4, issuedQuantity: 1, lostQuantity: 1, damagedHeldQuantity: 1 }), 4);
    expect(reason).toMatch(/1 out with an engineer, 1 declared lost, 1 reported damaged here/);
  });

  // THE CASE THE QUANTITY RULE EXISTS TO ALLOW, and the reason this is not simply "anything issued
  // blocks everything": a hire with two deliveries can still unwind the note whose own units never
  // moved. A blanket refusal would take the correction path away from the busiest orders.
  it("allows a delivery whose own units are all still on the shelf", () => {
    expect(deliveryReversalBlocker(live({ receivedQuantity: 5, issuedQuantity: 3 }), 2)).toBeNull();
  });

  // Stated rather than inferred. A full return leaves nothing untouched, so the arithmetic would catch
  // the ordinary case — but a hire closed short with everything already back is set terminal without
  // its `returnedQuantity` moving, and only the status says so.
  it("refuses on a finished hire", () => {
    expect(deliveryReversalBlocker(live({ hireStatus: "returned" }), 2)).toMatch(/finished/);
    expect(deliveryReversalBlocker(live({ hireStatus: "cancelled" }), 2)).toMatch(/finished/);
  });

  it("refuses on a hire closed short that is still on hire", () => {
    expect(deliveryReversalBlocker(live({ shortClosedAt: "2026-09-05" }), 2)).toMatch(/closed short/);
  });

  it("allows an ordinary live hire", () => {
    expect(deliveryReversalBlocker(live(), 2)).toBeNull();
  });

  // ── The note-level wrapper: which LEGS the rule applies to at all ───────────────────────────────
  const hires = new Map<string, HireReversalFacts>([["line-lost", live({ lostQuantity: 1 })], ["line-live", live()]]);
  const noteFor = (id: string) => [{ purchaseOrderRentalLineId: id, receivedQuantity: 2 }];

  it("refuses a delivery reversal once something has claimed its units", () => {
    expect(noteReversalBlocker("in", noteFor("line-lost"), hires)).toMatch(/declared lost/);
  });

  it("allows a delivery reversal while nothing has", () => {
    expect(noteReversalBlocker("in", noteFor("line-live"), hires)).toBeNull();
  });

  // Undoing a collection is how a hire REOPENS — "they collected the wrong order". It only ever gives
  // units back, so no total can go negative and there is nothing to refuse.
  it("allows a collection to be undone whatever the hire holds", () => {
    expect(noteReversalBlocker("out", noteFor("line-lost"), hires)).toBeNull();
  });

  // Withdrawing a claim we ourselves made stays possible; a loss settlement withdraws money and moves
  // no equipment at all.
  it("allows a damage claim and a loss settlement to be withdrawn", () => {
    expect(noteReversalBlocker("damage", noteFor("line-lost"), hires)).toBeNull();
    expect(noteReversalBlocker("loss", noteFor("line-lost"), hires)).toBeNull();
  });

  // A note can carry several lines. The first blocker wins, matching the server, which walks every
  // line and throws on the first — a partially-offered reversal would still fail as a whole.
  it("refuses a multi-line delivery when ANY of its hires has a claim", () => {
    expect(noteReversalBlocker("in", [...noteFor("line-live"), ...noteFor("line-lost")], hires)).toMatch(/declared lost/);
  });

  // The order in front of us does not always hold every line a note names. Guessing from an absence
  // is how a gate refuses something the server would allow; the server has the facts, so it answers.
  it("defers to the server on a line the page does not hold", () => {
    expect(noteReversalBlocker("in", noteFor("line-unknown"), hires)).toBeNull();
  });
});

describe("hireKeepsOrderOpen", () => {
  it("is false for both terminal states", () => {
    expect(hireKeepsOrderOpen(line({ hireStatus: "returned" }))).toBe(false);
    expect(hireKeepsOrderOpen(line({ hireStatus: "cancelled" }))).toBe(false);
  });

  it("is true while the hire is still live", () => {
    expect(hireKeepsOrderOpen(line({ hireStatus: "on_hire" }))).toBe(true);
    expect(hireKeepsOrderOpen(line({ hireStatus: "awaiting_delivery" }))).toBe(true);
  });
});

// The client's copy of the server's custody arithmetic. It exists because a pane promising units the
// scan will refuse is worse than a pane showing nothing — the person who promised them finds out at
// the counter — so these cases are deliberately the same ones the server's own suite walks.
describe("lost and damaged units in the client's arithmetic", () => {
  const line = (over: Record<string, number> = {}) => ({
    receivedQuantity: 5,
    returnedQuantity: 0,
    lostQuantity: 0,
    issuedQuantity: 0,
    damagedQuantity: 0,
    damagedHeldQuantity: 0,
    ...over,
  });

  it("drops a lost unit out of what we hold", () => {
    // We cannot hand back what we do not have. Counting it would offer a collecting driver equipment
    // that is not in the building.
    expect(heldOnHire(line({ lostQuantity: 2 }))).toBe(3);
  });

  it("keeps a damaged unit in what we hold, and out of what may be issued", () => {
    const l = line({ damagedHeldQuantity: 1 });
    expect(heldOnHire(l)).toBe(5); // still ours to give back, broken or not
    expect(issuableOnHire(l)).toBe(4); // …but it must not go out to a new job
  });

  it("nets the van and the damage together without double-counting either", () => {
    expect(issuableOnHire(line({ issuedQuantity: 2, damagedHeldQuantity: 1 }))).toBe(2);
  });

  it("refuses to report damage on a unit that is lost rather than broken", () => {
    // Claiming damage on equipment nobody can produce is the weakest possible position in a supplier
    // dispute, so the cap is what we HOLD, not what arrived.
    expect(damageableNow(line({ lostQuantity: 5 }))).toBe(0);
  });

  it("reads a row from a server that has not sent the newer counters as none-lost, none-damaged", () => {
    expect(heldOnHire({ receivedQuantity: 3, returnedQuantity: 0 })).toBe(3);
    expect(issuableOnHire({ receivedQuantity: 3, returnedQuantity: 0 })).toBe(3);
  });
});

/**
 * A HIRE THAT HOLDS NOTHING IS NOT A HIRE THAT HAPPENED TO NOBODY.
 *
 * `heldOnHire` subtracts `lostQuantity` — correctly, a unit nobody can produce is not ours to hand
 * back — so a hire whose units are ALL declared lost holds zero. The warehouse pane filtered its rows
 * on `held > 0`, and that hire left the screen entirely, taking its "N declared lost" line and its
 * share of the summary total with it: the one pane somebody opens to ask what happened to a hire was
 * the last place its loss was visible.
 */
describe("a fully-lost hire is still worth showing", () => {
  const line = { receivedQuantity: 3, returnedQuantity: 0, lostQuantity: 3, issuedQuantity: 0, damagedHeldQuantity: 0 };

  it("holds nothing", () => {
    expect(heldOnHire(line)).toBe(0);
  });

  it("is kept by the pane's row filter anyway", () => {
    const keep = (r: typeof line) => heldOnHire(r) > 0 || (r.lostQuantity ?? 0) > 0;
    expect(keep(line)).toBe(true);
  });

  // And a hire that genuinely has nothing on it still drops out — the filter must not become "show
  // everything", which is what a returned hire would then be.
  it("still drops a hire that is simply finished", () => {
    const keep = (r: typeof line) => heldOnHire(r) > 0 || (r.lostQuantity ?? 0) > 0;
    expect(keep({ ...line, lostQuantity: 0, returnedQuantity: 3 })).toBe(false);
  });
});
