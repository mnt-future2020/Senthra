import { describe, expect, it } from "vitest";

import {
  canManageHires,
  damageableNow,
  hireRefusesDeliveryReversal,
  netOrdered,
  noteCanBeReversed,
  shortfallAfterDelivery,
  canMoveHires,
  canSettleHires,
  hireKeepsOrderOpen,
  hireTakesDelivery,
  isTerminalHireStatus,
} from "./hireActions";
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

describe("hireRefusesDeliveryReversal", () => {
  // TWO server refusals, not one. The status catches a hire that went back; `shortClosedAt` catches a
  // part-delivered one that stopped expecting the rest and is STILL on hire — reversing its delivery
  // would leave `cancelledQuantity` describing units the line no longer has, and the line could never
  // take a delivery again. Mirroring only the first left the button 409ing on the second.
  it("refuses on a finished hire", () => {
    expect(hireRefusesDeliveryReversal({ hireStatus: "returned", shortClosedAt: null })).toBe(true);
    expect(hireRefusesDeliveryReversal({ hireStatus: "cancelled", shortClosedAt: null })).toBe(true);
  });

  it("refuses on a hire closed short that is still on hire", () => {
    expect(hireRefusesDeliveryReversal({ hireStatus: "on_hire", shortClosedAt: "2026-09-05" })).toBe(true);
  });

  it("allows an ordinary live hire", () => {
    expect(hireRefusesDeliveryReversal({ hireStatus: "on_hire", shortClosedAt: null })).toBe(false);
    expect(hireRefusesDeliveryReversal({ hireStatus: "awaiting_delivery", shortClosedAt: null })).toBe(false);
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

describe("noteCanBeReversed", () => {
  const finished = new Set(["line-returned"]);

  // Giving back an ARRIVAL for kit that has demonstrably already gone back is the one the server
  // refuses: "has already been returned — this delivery can no longer be reversed".
  it("refuses a delivery reversal once the hire it delivered has finished", () => {
    expect(noteCanBeReversed("in", ["line-returned"], finished)).toBe(false);
  });

  it("allows a delivery reversal while the hire is still live", () => {
    expect(noteCanBeReversed("in", ["line-live"], finished)).toBe(true);
  });

  // Undoing a collection is how a hire REOPENS — "they collected the wrong order". Refusing it on a
  // returned hire would remove the only way back, on the exact hire that needs it.
  it("allows a collection to be undone on a finished hire — that is what reopens it", () => {
    expect(noteCanBeReversed("out", ["line-returned"], finished)).toBe(true);
  });

  // Withdrawing a claim we ourselves made stays possible after the kit goes back. The report cannot
  // be CREATED then, but that is a different question from taking one back.
  it("allows a damage claim to be withdrawn on a finished hire", () => {
    expect(noteCanBeReversed("damage", ["line-returned"], finished)).toBe(true);
  });

  // A note can carry several lines. One finished hire on it is enough — the server walks every line
  // and throws on the first, so a partially-offered reversal would still fail as a whole.
  it("refuses a multi-line delivery when ANY of its hires has finished", () => {
    expect(noteCanBeReversed("in", ["line-live", "line-returned"], finished)).toBe(false);
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
