import type { Prisma } from "@prisma/client";

import { OPEN_EXIT_WHERE } from "./hireCustodyExit.repository.js";

import { addDays } from "../../utils/calendar-day.js";

// ── The hire predicate — ONE definition, three readers ─────────────────────────────────────────
//
// The attention badge counts these rows, the on-hire list opens them, and the reminder sweep emails
// about them. All three import from here, because a count and the list it opens computed by two
// predicates is a bug this codebase has already been bitten by — see the `?status=rework` and
// `?status=awaiting_send` notes in the attention registry.

/**
 * The hire states, in the order a hire moves through them. One list, read by validation, the
 * predicates and the UI.
 *
 * `awaiting_delivery` is where every new hire starts. The purchase order is a commitment to the
 * provider; it is not delivery. Until the warehouse confirms the kit arrived, the hire is not ON hire
 * — which is why every predicate below asks for `on_hire` and not merely "not returned": a hire that
 * has not arrived cannot be ending soon, and it certainly cannot be overdue for RETURN.
 *
 * `cancelled` is the exit for a hire nothing ever arrived against, and it is a FOURTH state rather
 * than a reuse of `returned` because the two are different facts and one report tells them apart:
 * `returnedWhere` below is the finance register, and a hire that never happened is not hire spend.
 * A hire that partly arrived ends `returned` — it happened — with the shortfall in
 * `cancelledQuantity`. Both are terminal; only these two let a purchase order close.
 */
export const HIRE_STATUSES = ["awaiting_delivery", "on_hire", "returned", "cancelled"] as const;
export type HireStatus = (typeof HIRE_STATUSES)[number];

/**
 * The states a hire can no longer be acted on from. A purchase order closes when every hire on it is
 * one of these, and every write path refuses one — exported so the guard and the writers cannot drift
 * into disagreeing about what "finished" means.
 */
export const TERMINAL_HIRE_STATUSES = ["returned", "cancelled"] as const;
export const isTerminalHireStatus = (status: string): boolean =>
  (TERMINAL_HIRE_STATUSES as readonly string[]).includes(status);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The hire's ORDER must still be live.
 *
 * Without this a deleted or cancelled purchase order keeps its rental lines — `softDelete` stamps
 * the header only — so the red badge counts a hire nobody can act on and the sweep keeps emailing
 * about it, while the return path refuses because the order itself can no longer be loaded. The
 * badge becomes unclearable.
 *
 * Every status but `cancelled` is included, deliberately: once kit is in our hands the hire's clock
 * runs whatever the order's paperwork is doing, and closing the order does not bring it back. What is
 * NOT enough for this is the RECEIVING queue — see ISSUED_ORDER.
 */
const LIVE_ORDER = {
  purchaseOrder: {
    is: {
      status: { not: "cancelled" },
      // Mongo: a row whose create omitted the field does not match `{ deletedAt: null }`.
      OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
    },
  },
} satisfies Prisma.PurchaseOrderRentalLineWhereInput;

/**
 * The order has been ISSUED to the supplier — the only window in which a hire can be received.
 *
 * The same three statuses goods-in receives against (purchase-order.repository's
 * RECEIVABLE_PO_STATUSES), because the client's rule is that a hire follows the IRM flow exactly. A
 * draft order has not been sent, so kit arriving against it is kit arriving against an order the
 * supplier never got.
 *
 * This narrows the receiving QUEUE and the chase badge, not the deadline predicates: a queue that
 * lists rows whose Receive button the service then refuses is worse than one that lists nothing.
 *
 * Nothing goes quiet by being excluded — an unissued order is on a queue of its own the whole time
 * (draft-from-PRF and pending_approval on the approval queue, approved and pm_review on awaiting
 * send), and the work owed there is "approve and send it", not "receive it".
 */
const ISSUED_ORDER = {
  purchaseOrder: {
    is: {
      ...LIVE_ORDER.purchaseOrder.is,
      status: { in: ["sent", "supplier_accepted", "partially_received"] },
    },
  },
} satisfies Prisma.PurchaseOrderRentalLineWhereInput;

/**
 * Narrow any hire predicate to the orders addressed to a set of warehouses.
 *
 * ONE helper because the warehouse's receiving pane and the badge that sends people to it have to
 * select the SAME rows, and they were written separately — the pane merged the warehouse into the
 * predicate inline. A hire the pane lists and no badge counts is precisely the hole this closes.
 *
 * `undefined` means "not warehouse-scoped" and passes the predicate through untouched; an EMPTY
 * array is a real scope of no warehouses and must select nothing, not everything.
 */
export function atWarehouses(
  where: Prisma.PurchaseOrderRentalLineWhereInput,
  warehouseIds: string[] | undefined,
): Prisma.PurchaseOrderRentalLineWhereInput {
  if (!warehouseIds) return where;
  // Built from the predicate's OWN order clause, not from LIVE_ORDER: the receiving predicates carry
  // the narrower ISSUED_ORDER, and rebuilding from the wide one would silently hand the warehouse
  // pane back the draft orders the queue had just been narrowed to exclude.
  const order = where.purchaseOrder?.is ?? LIVE_ORDER.purchaseOrder.is;
  return {
    ...where,
    purchaseOrder: { is: { ...order, warehouseId: { in: warehouseIds } } },
  };
}

/**
 * Kit we are still holding — on hire, and not all of it already handed back.
 *
 * `fullyReturned` is the second half for the same reason `fullyReceived` is on the receiving queue: a
 * hire goes back in PARTS. Once the last unit we hold has been collected, the deadline is nobody's
 * work any more — but the line can still be legitimately `on_hire` when units of it were never
 * delivered, and closing it would drop those out of the receiving queue forever. So the deadlines ask
 * about the quantity, and the status is left to say what it means.
 */
const STILL_OUT = {
  hireStatus: "on_hire",
  fullyReturned: false,
} satisfies Prisma.PurchaseOrderRentalLineWhereInput;

/**
 * When the reminder becomes due — CLAMPED so it can never fall before the hire starts.
 *
 * Stored on the row rather than computed at query time because the real condition,
 * `hireEndDate - notifyDaysBefore <= today`, compares two COLUMNS to each other, which a
 * Prisma/MongoDB `where` cannot express. Storing the crossing date makes the predicate one indexed
 * range comparison, which is what lets the badge, the list and the sweep share it.
 *
 * The clamp is why validation does NOT refuse a lead longer than the hire: the lead defaults to 3,
 * so refusing it would make every hire shorter than four days unsavable until someone hand-edited
 * that line. A 2-day hire with a 3-day lead is reminded on its start date, never before it.
 *
 * Both arguments are UTC midnights (utils/calendar-day.ts), so the arithmetic is exact even across
 * a DST change.
 */
export function computeNotifyOnDate(hireStartDate: Date, hireEndDate: Date, notifyDaysBefore: number): Date {
  const raw = addDays(hireEndDate, -notifyDaysBefore);
  return raw.getTime() < hireStartDate.getTime() ? hireStartDate : raw;
}

/**
 * A live hire whose reminder is due and which has not yet run out.
 *
 * `todayStart` is the start of today IN THE COMPANY TIMEZONE, resolved by the caller through
 * `startOfDayIn(...)` — never from a client-supplied zone.
 *
 * The upper bound on `hireEndDate` matters: without it every OVERDUE hire would also satisfy
 * "expiring soon" and one line would land on both badges, so the sidebar rollup would count it
 * twice.
 */
export function expiringSoonWhere(todayStart: Date): Prisma.PurchaseOrderRentalLineWhereInput {
  return {
    ...LIVE_ORDER,
    ...STILL_OUT,
    notifyOnDate: { lte: new Date(todayStart.getTime() + MS_PER_DAY - 1) },
    hireEndDate: { gte: todayStart },
  };
}

/** A live hire whose end date has passed. Disjoint from `expiringSoonWhere` by construction. */
export function overdueWhere(todayStart: Date): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, ...STILL_OUT, hireEndDate: { lt: todayStart } };
}

/**
 * Hires carrying damage or loss the office has not finished with — the settle worklist, and what the
 * `rentals.custody_to_settle` badge opens.
 *
 * Asked of the EXIT ROWS through the relation, using the SAME `OPEN_EXIT_WHERE` the badge counts, so
 * the two cannot disagree. They did: this filtered `fieldDamageQty`/`lostQuantity` — cached counters
 * that answer "what is damaged and still HERE" and "what is gone" — while the badge asked about
 * SETTLEMENT. Damage collected but never priced was counted and listed nowhere, leaving a badge with
 * no rows behind it; a warehouse report born settled was listed forever and counted by nothing.
 *
 * The counters are still right for what they are for (availability, the order line's own badges).
 * They simply cannot express this question, because "unsettled" is a fact about a row and not a
 * quantity on the line — which is also why a recovered-and-charged loss, whose counters read zero,
 * was reachable from no screen at all until this arm existed.
 */
export function unsettledCustodyWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, custodyExits: { some: OPEN_EXIT_WHERE } };
}

/** Every live hire, whatever its window — the on-hire list's unfiltered view. */
export function onHireWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, ...STILL_OUT };
}

/**
 * The order states in which kit can legitimately be IN OUR HANDS — the paperwork half of
 * "available to issue".
 *
 * Deliberately WIDER than ISSUED_ORDER by exactly one status, `fully_received`, and that difference
 * is load-bearing: a fully-received order is the ordinary resting state of a hire that is sitting on
 * the shelf waiting to go out, so narrowing this to the RECEIVING window would make every completely
 * delivered hire un-issuable — the common case, broken. This is the same set, and the same reasoning,
 * as `HOLDING_PO_STATUSES` in rental-receipt.service (where a return is allowed from), retyped here
 * rather than imported because purchase-order.repository imports THIS module and the reverse import
 * would close a cycle — the same trade-off ISSUED_ORDER above already makes.
 *
 * `closed` is absent because closing is refused while any hire is still out (see
 * `closePurchaseOrder`), so a closed order has nothing left to lend. `draft` and the approval states
 * are absent because the supplier was never sent the order: kit cannot have arrived against it, and
 * the receive path refuses them outright. Excluding them here is DEFENCE IN DEPTH against rows that
 * predate that guard — it stops such a row being offered, and repairs nothing. See the note on
 * `issuableWhere`.
 */
export const HOLDING_ORDER_STATUSES = ["sent", "supplier_accepted", "partially_received", "fully_received"] as const;

const HOLDING_ORDER = {
  purchaseOrder: {
    is: {
      ...LIVE_ORDER.purchaseOrder.is,
      status: { in: [...HOLDING_ORDER_STATUSES] },
    },
  },
} satisfies Prisma.PurchaseOrderRentalLineWhereInput;

/**
 * A hire we may issue to a NEW job — "available to issue", which is NOT the same question as
 * "on hire".
 *
 * Its own predicate rather than a flavour of `onHireWhere`, and the separation is the whole point.
 * `onHireWhere` answers "what are we still holding": the on-hire board, the overdue badge, the
 * reminder sweep and the return-chasing views all count from it, and every one of them MUST keep
 * counting an expired hire — that is precisely the row somebody has to chase. Narrowing that
 * predicate to hide expired hires would make the overdue badge uncountable and unclearable, which is
 * the failure mode the module's own header warns about.
 *
 * What this adds on top of "still out" is the two things that gate LENDING:
 *
 *   1. `hireEndDate >= todayStart` — the hire period is still running. Sending kit out on a hire that
 *      was due back last week commits us to a breach we have already been billed for, and the unit
 *      the provider is waiting to collect walks out of the building instead. Compared with `gte` and
 *      not `gt` so a hire ending TODAY is still issuable: a hire is valid THROUGH its end date, which
 *      is exactly the boundary `overdueWhere` draws from the other side (`lt: todayStart`). The two
 *      are complements by construction, so no hire can ever be both expired and not-yet-overdue.
 *   2. `HOLDING_ORDER` — the order is one the kit could actually have arrived against.
 *
 * `todayStart` is the start of today IN THE COMPANY TIMEZONE, resolved by the caller through
 * `startOfDayIn(...)` — never from a client clock, and resolved ONCE per request so that every line
 * of a multi-line scan is judged against one date even if the request straddles midnight.
 *
 * Read-side use of this is not sufficient on its own: a stale tab holds an availability answer from
 * before the deadline passed. The write path re-asserts the same window inside its conditional update
 * (`adjustHireIssuedQtyTx`), so the two agree and neither can be talked past.
 */
export function issuableWhere(todayStart: Date): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...HOLDING_ORDER, ...STILL_OUT, hireEndDate: { gte: todayStart } };
}

/**
 * The same question asked of a ROW already in hand: may we issue off this hire today?
 *
 * `issuableWhere` selects rows in the database; this decides about one we have already loaded. Both
 * exist because the two callers genuinely differ — the scan and the availability readers QUERY, while
 * the warehouse's on-hire pane loads every live hire (expired and unsent ones included, because it is
 * a chasing view) and then has to label each row. A list that could only be filtered would have to
 * drop the very rows it exists to show.
 *
 * They are held together by `rentalHire.predicate.test.ts`, which runs one set of cases through both
 * and asserts they agree. That test is the point of writing this here rather than inline in a mapper:
 * a screen that decided "issuable" for itself is exactly how a pane comes to promise stock the scan
 * then refuses, which is the bug this pair was written to end.
 *
 * Every clause of `issuableWhere` is re-asserted, none assumed. The on-hire list can be filtered to
 * `returned` or `cancelled` hires, so "the query already guaranteed it" is untrue of this caller.
 */
export function isIssuableHire(
  line: {
    hireStatus: string;
    fullyReturned: boolean | null;
    hireEndDate: Date;
    orderStatus: string | null;
    orderDeleted: boolean;
  },
  todayStart: Date,
): boolean {
  if (line.hireStatus !== "on_hire" || line.fullyReturned) return false;
  if (line.orderDeleted) return false;
  if (!line.orderStatus || !(HOLDING_ORDER_STATUSES as readonly string[]).includes(line.orderStatus)) return false;
  // `gte`: a hire is valid THROUGH its end date — the same boundary, from the same side, as the
  // predicate's `hireEndDate: { gte: todayStart }`.
  return line.hireEndDate.getTime() >= todayStart.getTime();
}

/**
 * Units still to come — the queue the warehouse works from.
 *
 * Asked as "not fully received", NOT as `hireStatus === "awaiting_delivery"`. A part-delivered line is
 * already `on_hire` (the units that are here are on hire, and their return deadline runs), so a
 * status-only queue dropped the outstanding units the moment the first one arrived: 2 of 5 delivered
 * and the other 3 stopped being anybody's job.
 *
 * Both terminal states are excluded rather than implied — a hire that went back is finished whatever
 * its quantities say, and one closed short is finished by definition: `fullyReceived` is set true on
 * that path precisely so the units nobody is waiting for leave this queue. The status test is the
 * belt to that braces, and it is what stops a `cancelled` line (which never received anything, so
 * `fullyReceived` is false) reappearing here forever.
 */
export function awaitingDeliveryWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...ISSUED_ORDER, fullyReceived: false, hireStatus: { notIn: [...TERMINAL_HIRE_STATUSES] } };
}

/**
 * NOTHING has arrived, and the hire has already STARTED — kit that should be here and is not.
 *
 * The receive step introduces a way for a hire to fall off every radar: unreceived lines are excluded
 * from "ending soon", from "overdue for return" and from the reminder sweep, so one forgotten click
 * would leave a hire billing quietly with nothing chasing it. This is the entry that stops that —
 * the badge asks about the step itself rather than the deadline behind it.
 *
 * Asked on `hireStatus`, NOT on `fullyReceived`, and that is the whole point. Every rentals.* badge
 * rolls up to the same sidebar row, so two of them matching one line makes that number count it twice
 * — the reason `expiringSoonWhere` carries its `hireEndDate` upper bound. A part-delivered line is
 * already `on_hire`, so a `fullyReceived: false` test here would have it land on this badge AND on
 * whichever return-deadline badge it was due for. Keying on the status makes the three disjoint by
 * construction, and it is what the label promises: "Hires not yet received" is untrue of a hire that
 * is partly here.
 *
 * Those outstanding units are not dropped — they stay in `awaitingDeliveryWhere` above, which is the
 * warehouse's receiving queue (`wh.rental_intake`). That is a DIFFERENT sidebar row, so it cannot
 * double-count, and it is where the units are actually booked in.
 */
export function overdueDeliveryWhere(todayStart: Date): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...ISSUED_ORDER, hireStatus: "awaiting_delivery", hireStartDate: { lte: todayStart } };
}

/**
 * FINISHED hires — the register a finance report is built from.
 *
 * Asked on the STATUS, not on `fullyReturned`, and the difference is load-bearing. A line whose
 * delivered units have all gone back but whose remaining units never arrived is `fullyReturned` and
 * still `on_hire`: those units are still owed, still on the receiving queue, and the hire is not
 * over. Only `createRentalReturn` closing the loop — everything ordered arrived, everything that
 * arrived went back — writes `returned`, and that is the fact a period report means by "completed".
 *
 * Cancelled and deleted orders stay excluded (LIVE_ORDER), exactly as they are everywhere else here:
 * a hire on a cancelled order is not hire spend. Neither is a hire CANCELLED in its own right —
 * nothing ever arrived against it — which is why that is a separate status and not a flavour of
 * `returned`.
 */
export function returnedWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, hireStatus: "returned" };
}

/**
 * Hires that never happened — ordered, nothing ever arrived, closed short with a reason.
 *
 * Its own predicate rather than a flavour of `returnedWhere` because that one is the finance
 * register and this is not hire spend. But it still needs somewhere to be READ: a record that can be
 * created and then found on no screen is a record nobody can audit, which is why the on-hire board
 * carries a pill for it beside Returned.
 */
export function cancelledWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, hireStatus: "cancelled" };
}
