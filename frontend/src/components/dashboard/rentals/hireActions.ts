import type { HireStatus } from "@/types/rental";

// ── Who can do what to a hire ───────────────────────────────────────────────────────────────────
//
// The server splits the hire keys three ways by who is in a position to KNOW the thing being
// recorded (see permissions.ts and the two hire route files). Mirrored once here rather than spelled
// out on each of the nine screens that ask — a pair of keys hand-written in nine places is how a role
// ends up holding a permission with no button to use it.

/** Working the kit: book it in, hand it back, photograph what is broken. The floor's own work. */
export const HIRE_FLOOR_PERMISSIONS = ["rentals.hire.receive", "rentals.hire.settle", "rentals.hire.manage"];

/**
 * CORRECTING a committed record: close a hire short, reverse a note, agree a damage charge.
 *
 * Not the bare floor key — a scanner alone should not rewrite what already happened. Not procurement
 * either: every one of these is warehouse-scoped at the service, and the person who typed a note
 * wrong is the one who knows it.
 */
export const HIRE_SETTLE_PERMISSIONS = ["rentals.hire.settle", "rentals.hire.manage"];

/** Committing fresh money to the supplier — extending a hire. The one call the floor cannot make. */
export const HIRE_MANAGE_PERMISSIONS = ["rentals.hire.manage"];

type Can = (permission: string) => boolean;

export const canMoveHires = (can: Can): boolean => HIRE_FLOOR_PERMISSIONS.some(can);
export const canSettleHires = (can: Can): boolean => HIRE_SETTLE_PERMISSIONS.some(can);
export const canManageHires = (can: Can): boolean => HIRE_MANAGE_PERMISSIONS.some(can);

// What a hire will still ACCEPT — the questions every screen asks before it offers a button.
//
// Hand-mirrored from the server (rentalHire.predicate.ts and the guards in purchase-order.service /
// rental-receipt.service), the same arrangement the rest of this module already lives with. The rule
// these exist to keep is the one the on-hire board states out loud: a button the API refuses is not
// an option, and a Close greyed out with "still on hire" on an order the API would close is worse —
// it reads as a missing feature and sends the user looking for a step that does not exist.
//
// Extracted rather than written inline because they were inline, and both drifted the moment
// `cancelled` and the short close arrived.

/**
 * The states a hire can no longer be acted on from — the server's TERMINAL_HIRE_STATUSES.
 *
 * `cancelled` is as final as `returned` and is NOT a flavour of it: nothing ever arrived, so it is
 * not hire spend and it stays out of the finished-hire register. For the purpose of "can anything
 * still happen to this line", though, the two are the same answer.
 */
export const TERMINAL_HIRE_STATUSES: readonly HireStatus[] = ["returned", "cancelled"];

export const isTerminalHireStatus = (status: HireStatus): boolean => TERMINAL_HIRE_STATUSES.includes(status);

/** The columns every predicate here reads. Satisfied by both `PoRentalLine` and `OnHireLine`. */
export interface HireActionLine {
  hireStatus: HireStatus;
  fullyReceived: boolean;
}

/**
 * Is this hire still expecting a delivery?
 *
 * The client's copy of `awaitingDeliveryWhere`, and it asks the same two things in the same way:
 * `fullyReceived` is false and the hire has not finished.
 *
 * Deliberately NOT `quantity - receivedQuantity > 0`. Those agreed until the short close existed;
 * now they part company on exactly the line that matters. A hire that ordered 5, received 2 and had
 * the other 3 recorded as never arriving still subtracts to 3 outstanding — but nothing is expected,
 * the receiving queue has let it go, and `createRentalReceipt` refuses a line carrying
 * `shortClosedAt`. `fullyReceived` is the column that means "nothing more is expected", which is the
 * question actually being asked.
 */
export function hireTakesDelivery(line: HireActionLine): boolean {
  return !line.fullyReceived && !isTerminalHireStatus(line.hireStatus);
}

/**
 * Does this hire stop its purchase order being closed?
 *
 * The client's copy of `closePurchaseOrder`'s guard, which asks `isTerminalHireStatus` on every hire.
 * Written as `!== "returned"` it kept Close disabled on an order whose last hire was CANCELLED —
 * with a tooltip telling the user to record a return that can never happen, on kit that never
 * arrived. That is the dead-end the short close was written to remove, reached from the order page
 * instead of the board.
 */
export function hireKeepsOrderOpen(line: HireActionLine): boolean {
  return !isTerminalHireStatus(line.hireStatus);
}

/**
 * What this hire will EVER hold — ordered, less anything written off.
 *
 * The denominator for every "X of Y" a hire prints. `quantity` alone is what the supplier was sent
 * and agreed to, and it stays on the order for that reason — but after a short close it includes
 * units formally abandoned, so a screen showing "3 of 5" promises equipment that is never coming.
 * The original figure belongs on the order's own line, beside the reason it was written off.
 *
 * Clamped: nothing here should ever subtract its way past zero.
 */
export function netOrdered(line: { quantity: number; cancelledQuantity?: number }): number {
  return Math.max(0, line.quantity - (line.cancelledQuantity ?? 0));
}

/**
 * How many units of this hire can still be REPORTED damaged.
 *
 * The client's copy of `reportHireDamage`'s cap, and it is two ceilings with the lower winning:
 *
 *   • only kit HELD can break here — `received - returned`;
 *   • only units NEVER recorded damaged are left to record — `received - damaged`.
 *
 * The second is netted against what was RECEIVED, not against what is held, and that is the whole
 * point. `damagedQuantity` counts every unit recorded damaged over the hire's life, including ones
 * that have since gone back; a unit that went back damaged is off the site but still on the record.
 * Subtracting it from the HOLDING — which the screens used to do — charges it twice: it refused the
 * undamaged unit standing behind it, and with two returned damaged it went negative, dropping the
 * line off the damage form and hiding the Report damage button on a hire we are still holding.
 */
export function damageableNow(line: { receivedQuantity: number; returnedQuantity: number; damagedQuantity: number }): number {
  const held = line.receivedQuantity - line.returnedQuantity;
  const neverReported = line.receivedQuantity - line.damagedQuantity;
  return Math.max(0, Math.min(held, neverReported));
}

/**
 * Units left outstanding once THIS delivery is counted — what a receiver would be writing off.
 *
 * "4 came, the 5th never will" is ONE event at the receiving bay. Modelled as two separate actions it
 * needed a modal that computed the shortfall from what the SERVER held, so a form with 4 typed and
 * nothing saved offered to write off all 5 — and discarded the 4 on the way. Counting the delivery
 * being entered is what makes the offer describe what the user actually means.
 *
 * Clamped at zero: an over-entry is caught by the form's own cap, and a negative here would report a
 * phantom write-off while they fix it. A blank box is nothing received, not an error.
 */
export function shortfallAfterDelivery(outstanding: number, receivingNow: number): number {
  return Math.max(0, outstanding - (Number.isFinite(receivingNow) ? receivingNow : 0));
}

/**
 * Would the server refuse to reverse a DELIVERY against this hire?
 *
 * TWO refusals, and mirroring only the first is what left the button 409ing:
 *
 *   • the hire has FINISHED — giving back an arrival for kit that demonstrably already went back
 *     makes the line return more than it ever received;
 *   • the hire was CLOSED SHORT — the reversal recomputes `receivedQuantity` and knows nothing about
 *     `cancelledQuantity`, so it would leave the shortfall describing units the line no longer has,
 *     and the line could never take a delivery again (a short-closed line refuses one).
 *
 * The second is the one a status test misses: a part-delivered hire closed short keeps whatever it is
 * holding and stays `on_hire`.
 */
export function hireRefusesDeliveryReversal(line: {
  hireStatus: HireStatus;
  shortClosedAt: string | null;
}): boolean {
  return isTerminalHireStatus(line.hireStatus) || Boolean(line.shortClosedAt);
}

/**
 * Can this hire note still be reversed?
 *
 * Reversing is direction-aware on the server, and only ONE of the three legs is refused once a hire
 * has finished:
 *
 *   • a DELIVERY cannot be given back for kit that demonstrably already went back — the arithmetic
 *     would have the line returning more than it ever received, `held` goes negative, and the pane
 *     that lists `held > 0` drops the one row proving it broke. The server throws.
 *   • a COLLECTION can: undoing one is how a hire REOPENS ("they collected the wrong order"), and
 *     refusing it would remove the only way back on the exact hire that needs it.
 *   • a DAMAGE claim can: the report cannot be CREATED after the kit goes back, but withdrawing one
 *     we already made is a different question.
 *
 * The button was gated on the ORDER's status alone, which says nothing about any of this, so a
 * returned hire offered a delivery reversal that could only ever fail. ANY finished line on the note
 * is enough to refuse: the server walks every line and throws on the first.
 */
export function noteCanBeReversed(
  direction: string,
  hireLineIds: readonly string[],
  finishedHireLineIds: ReadonlySet<string>,
): boolean {
  if (direction !== "in") return true;
  return !hireLineIds.some((id) => finishedHireLineIds.has(id));
}

