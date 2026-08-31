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
 * What a hire line is holding for the provider right now: everything that arrived, less what went back
 * to them, less what is gone.
 *
 * The client's copy of the server's `hireHeldByUs`, and the three terms are the same three for the same
 * reason — a unit declared LOST is not ours to hand over, so counting it here would offer a collecting
 * driver equipment that is not in the building. Damage is deliberately absent: a broken tester is still
 * standing on the shelf and still goes back on the note.
 */
export function heldOnHire(line: { receivedQuantity: number; returnedQuantity: number; lostQuantity?: number }): number {
  return Math.max(0, line.receivedQuantity - line.returnedQuantity - (line.lostQuantity ?? 0));
}

/**
 * What may go out to a NEW job — the only figure a screen may label "available".
 *
 * Held, minus what is already in a van, minus what is on the shelf broken. Mirrors the server's
 * `hireIssuable` exactly, because a pane promising units the scan will refuse is worse than a pane
 * showing nothing: the person who promised them finds out at the counter.
 */
export function issuableOnHire(line: {
  receivedQuantity: number;
  returnedQuantity: number;
  lostQuantity?: number;
  issuedQuantity?: number;
  damagedHeldQuantity?: number;
}): number {
  const shelf = Math.max(0, heldOnHire(line) - (line.issuedQuantity ?? 0));
  return Math.max(0, shelf - Math.min(shelf, line.damagedHeldQuantity ?? 0));
}

/**
 * WHERE what we hold actually is: how much is on the shelf, and how much is out on a job.
 *
 * `heldOnHire` is what we owe the provider — and some of it can be in a van. Those are different
 * numbers and only the first one can be handed to a collecting driver, which is exactly what
 * `createRentalReturn` enforces server-side (its `withEngineers`/`onShelf` guard). A warehouse pane
 * showing only the total made a row read "3 held", let someone try to return 3, and answered with a
 * 409 explaining that one was on a job — a correct refusal that arrived too late to be useful.
 *
 * Both clamped, and `withEngineers` clamped to the holding rather than trusted: `issuedQuantity` is a
 * maintained counter, and a hand-edited or pre-column row must not be able to produce a negative
 * shelf figure or a split that exceeds the whole. The two always sum to `heldOnHire`.
 */
export function hireCustodySplit(line: {
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity?: number;
}): { atWarehouse: number; withEngineers: number } {
  const held = heldOnHire(line);
  const withEngineers = Math.min(Math.max(0, line.issuedQuantity ?? 0), held);
  return { atWarehouse: held - withEngineers, withEngineers };
}

/** Which deadline window is the worst news — what a grouped row has to inherit from its lines. */
const WINDOW_RANK = { ok: 0, expiring: 1, overdue: 2 } as const;
export type HireWindow = keyof typeof WINDOW_RANK;

/** One catalogue item at one depot, and the hire lines that make it up. */
export interface HireItemGroup<T> {
  key: string;
  itemName: string;
  rentalItemCode: string | null;
  lines: T[];
  /** Summed over the lines: what we owe the provider, where it is, and what may go out today. */
  held: number;
  atWarehouse: number;
  withEngineers: number;
  availableToIssue: number;
  /** The soonest deadline in the group, and the worst window any line is in. */
  earliestEnd: string;
  worstWindow: HireWindow;
}

/** The row shape grouping needs — kept structural so a test can pass plain objects. */
export interface GroupableHire {
  id: string;
  rentalItemId: string;
  rentalItemCode: string | null;
  itemName: string;
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity?: number;
  availableToIssue?: number;
  hireEndDate: string;
  window: HireWindow;
}

/**
 * Collapse a depot's hire lines into ONE row per catalogue item.
 *
 * A hire LINE is a contract — one item, one period, one price — so a depot holding the same tester on
 * three periods legitimately has three lines, and one that ordered three units as three lines of one
 * has three more. Correct bookkeeping, and unreadable as a stock list: one warehouse showed ELEVEN
 * rows of "Fibre Tester", which reads as a yard full of testers when the answer to "can I issue one"
 * was six.
 *
 * A user asks about the ITEM. So the item is the row, and the contracts sit under it — collapsed, not
 * merged. Merging would be wrong: each line has its own deadline, its own Return and its own Damage
 * action, and a collection note is raised per order. This changes what is READ, never what is ACTED
 * on.
 *
 * `worstWindow` is the group's badge, and it takes the worst of its lines rather than the earliest
 * one's: a group holding an overdue hire and a healthy one is an overdue group, whatever order the
 * lines arrived in. `earliestEnd` is the soonest deadline, which is the one that costs money next.
 *
 * Keyed on `rentalItemId`, never the name — two catalogue items can share a name, and merging them
 * would sum quantities across different equipment.
 */
export function groupHiresByItem<T extends GroupableHire>(rows: readonly T[]): HireItemGroup<T>[] {
  const groups = new Map<string, HireItemGroup<T>>();
  for (const r of rows) {
    let g = groups.get(r.rentalItemId);
    if (!g) {
      g = {
        key: r.rentalItemId,
        itemName: r.itemName,
        rentalItemCode: r.rentalItemCode,
        lines: [],
        held: 0,
        atWarehouse: 0,
        withEngineers: 0,
        availableToIssue: 0,
        earliestEnd: r.hireEndDate,
        worstWindow: r.window,
      };
      groups.set(r.rentalItemId, g);
    }
    const split = hireCustodySplit(r);
    g.lines.push(r);
    g.held += heldOnHire(r);
    g.atWarehouse += split.atWarehouse;
    g.withEngineers += split.withEngineers;
    // Absent means the server did not answer, and the safe reading of "unknown" on a figure that
    // authorises handing equipment out is zero — never the physical count standing in for it.
    g.availableToIssue += r.availableToIssue ?? 0;
    if (r.hireEndDate < g.earliestEnd) g.earliestEnd = r.hireEndDate;
    if (WINDOW_RANK[r.window] > WINDOW_RANK[g.worstWindow]) g.worstWindow = r.window;
  }
  // Worst news first — a depot opens this pane to find what is overdue, not to read an alphabet. Ties
  // broken by name so the order is stable across reloads rather than following the query's ordering.
  return [...groups.values()].sort(
    (a, b) => WINDOW_RANK[b.worstWindow] - WINDOW_RANK[a.worstWindow] || a.itemName.localeCompare(b.itemName),
  );
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
export function damageableNow(line: { receivedQuantity: number; returnedQuantity: number; damagedQuantity: number; lostQuantity?: number }): number {
  // `heldOnHire`, so a lost unit cannot be reported damaged: it is not here to inspect, and claiming
  // damage on equipment nobody can produce is the weakest possible position in a supplier dispute.
  const held = heldOnHire(line);
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
 * What this hire has left that NOTHING has claimed — the most a delivery reversal may unwind.
 *
 * Mirrors `hireUntouched` on the server, and it is the same number as `issuableOnHire` for the same
 * reason: both ask whether anything has a claim on the unit. Kept as its own name because the two
 * questions are read in different places and a reader of one should not have to know the other.
 */
export function untouchedOnHire(line: {
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity: number;
  lostQuantity: number;
  damagedHeldQuantity: number;
}): number {
  return issuableOnHire(line);
}

/** Everything a reversal decision needs from a hire line — the shape both callers below take. */
export interface HireReversalFacts {
  hireStatus: HireStatus;
  shortClosedAt: string | null;
  receivedQuantity: number;
  returnedQuantity: number;
  issuedQuantity: number;
  lostQuantity: number;
  damagedHeldQuantity: number;
}

/**
 * Why the server would refuse to reverse a delivery of `qty` units against this hire — short enough
 * to sit under a row — or null if it would accept it.
 *
 * REVERSING A DELIVERY ASSERTS THE UNITS NEVER CAME. That is only true of a unit still standing on
 * our shelf, whole, and claimed by nobody. This used to test the hire's STATUS, which catches exactly
 * one of the four ways a unit stops being untouched and let the other three through: kit in an
 * engineer's van, a unit declared lost, and a unit reported damaged here all left the button showing.
 *
 * The prose is deliberately shorter than the server's. This one goes under a row to explain a missing
 * button; the server's goes into a toast after a request nobody expected to fail, and has to carry
 * the whole account. Both are computed from the same rule, so they cannot disagree about the answer.
 */
export function deliveryReversalBlocker(hire: HireReversalFacts, qty: number): string | null {
  // Stated, not inferred. A hire closed short with everything already back is set terminal without
  // its `returnedQuantity` moving, so the arithmetic alone would not see it (see closeHireShort).
  if (isTerminalHireStatus(hire.hireStatus)) return "this hire has finished";
  if (hire.shortClosedAt) return "this hire was closed short";
  if (untouchedOnHire(hire) >= qty) return null;

  const { atWarehouse } = hireCustodySplit(hire);
  const damagedHere = Math.min(atWarehouse, hire.damagedHeldQuantity);
  const claims = [
    hire.returnedQuantity > 0 ? `${hire.returnedQuantity} already back with the supplier` : "",
    hire.issuedQuantity > 0 ? `${hire.issuedQuantity} out with an engineer` : "",
    hire.lostQuantity > 0 ? `${hire.lostQuantity} declared lost` : "",
    damagedHere > 0 ? `${damagedHere} reported damaged here` : "",
  ].filter(Boolean);
  return claims.length > 0 ? claims.join(", ") : "its units are no longer all on the shelf";
}

/**
 * Why this hire note can no longer be reversed, or null if it still can.
 *
 * Reversing is direction-aware on the server, and the legs are not alike:
 *
 *   • a DELIVERY is refused once anything has happened to the units it delivered — see above.
 *   • a COLLECTION is not: undoing one is how a hire REOPENS ("they collected the wrong order"), and
 *     it only ever gives units back, so no total can go negative.
 *   • a DAMAGE claim is not: the report cannot be CREATED after the kit goes back, but withdrawing
 *     one we already made is a different question.
 *   • a LOSS settlement is not: it withdraws money and moves no equipment at all.
 *
 * The FIRST blocker wins, matching the server, which walks the note's lines and throws on the first.
 */
export function noteReversalBlocker(
  direction: string,
  noteLines: readonly { purchaseOrderRentalLineId: string; receivedQuantity: number }[],
  hiresById: ReadonlyMap<string, HireReversalFacts>,
): string | null {
  if (direction !== "in") return null;
  for (const l of noteLines) {
    const hire = hiresById.get(l.purchaseOrderRentalLineId);
    // A line whose hire is not on the order in front of us: the server holds the facts, so let it
    // answer rather than guessing from an absence.
    if (!hire) continue;
    const blocker = deliveryReversalBlocker(hire, l.receivedQuantity);
    if (blocker) return blocker;
  }
  return null;
}

/** Damage already on file for one hire line, as the damage form needs it. See damageReportCap. */
export interface OpenDamageOnLine {
  /**
   * Units a report is physically holding out of the pool: open ones PLUS dismissed ones.
   *
   * The ONLY figure the cap needs. A separate "awaiting a note" count used to sit beside it, from when
   * a report could be filed AGAINST an open one and had to be capped by it. Nothing settles by quantity
   * any more — damage on file is acted on through its own record — so it was a number nothing read.
   */
  quarantined: number;
}

/**
 * HOW MUCH DAMAGE THIS REPORT MAY CLAIM: the ordinary cap, MINUS whatever a report already on file is
 * holding out of the pool.
 *
 * MIRRORS reportHireDamage EXACTLY, and that subtraction is the whole double-quarantine guard. The bug
 * it closes was a mismatch between two caps: the form offered units never TALLIED as damaged while the
 * service allocated against units with an OPEN REPORT. Different populations, and a genuinely new
 * broken unit fell into the gap — absorbed into an older report, so one quarantine covered two broken
 * units and the second stayed issuable.
 *
 * `quarantined` counts DISMISSED reports too: dismissing drops the claim, not the damage, so the unit
 * is still broken and still off the shelf. Subtracting both makes over-quarantining arithmetically
 * impossible, which is what let the "is this the same damage?" question go away — a report here can
 * only ever mean "more damage was found", and damage already on file is acted on through its own
 * record.
 *
 * `remainder` is `damageableNow` for the line — the caller already has it.
 */
export function damageReportCap(remainder: number, open: OpenDamageOnLine | undefined): number {
  return Math.max(0, remainder - (open?.quarantined ?? 0));
}

/**
 * A postal address with its repeated parts removed.
 *
 * The server composes these from a line address, an order override or a warehouse, and the parts it
 * joins can legitimately carry the same text twice — a site whose building and estate are recorded in
 * both address lines printed "Unit 4, Industrial Estate, Unit 4, Industrial Estate, London, …", which
 * reads as a data fault to anyone looking at it and costs a line of screen to say nothing.
 *
 * Deduped by SEGMENT and case-insensitively, keeping first appearance so the order still reads
 * outwards. Deliberately not consecutive-only: the duplication that actually occurs is a repeated
 * PAIR, which a neighbour comparison walks straight past.
 */
export function tidyAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of address.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
