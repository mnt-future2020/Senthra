import type { Prisma } from "@prisma/client";

import { addDays } from "../../utils/calendar-day.js";

// ── The hire predicate — ONE definition, three readers ─────────────────────────────────────────
//
// The attention badge counts these rows, the on-hire list opens them, and the reminder sweep emails
// about them. All three import from here, because a count and the list it opens computed by two
// predicates is a bug this codebase has already been bitten by — see the `?status=rework` and
// `?status=awaiting_send` notes in the attention registry.

/**
 * The three hire states, in the order a hire moves through them. One list, read by validation, the
 * predicates and the UI.
 *
 * `awaiting_delivery` is where every new hire starts. The purchase order is a commitment to the
 * provider; it is not delivery. Until the warehouse confirms the kit arrived, the hire is not ON hire
 * — which is why every predicate below asks for `on_hire` and not merely "not returned": a hire that
 * has not arrived cannot be ending soon, and it certainly cannot be overdue for RETURN.
 */
export const HIRE_STATUSES = ["awaiting_delivery", "on_hire", "returned"] as const;
export type HireStatus = (typeof HIRE_STATUSES)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The hire's ORDER must still be live.
 *
 * Without this a deleted or cancelled purchase order keeps its rental lines — `softDelete` stamps
 * the header only — so the red badge counts a hire nobody can act on and the sweep keeps emailing
 * about it, while "mark returned" refuses because the order itself can no longer be loaded. The
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

/** Every live hire, whatever its window — the on-hire list's unfiltered view. */
export function onHireWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, ...STILL_OUT };
}

/**
 * Units still to come — the queue the warehouse works from.
 *
 * Asked as "not fully received", NOT as `hireStatus === "awaiting_delivery"`. A part-delivered line is
 * already `on_hire` (the units that are here are on hire, and their return deadline runs), so a
 * status-only queue dropped the outstanding units the moment the first one arrived: 2 of 5 delivered
 * and the other 3 stopped being anybody's job.
 *
 * `returned` is excluded rather than implied — a hire that went back is finished whatever its
 * quantities say, and the alternative is a returned line reappearing in a receiving queue forever.
 */
export function awaitingDeliveryWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...ISSUED_ORDER, fullyReceived: false, hireStatus: { not: "returned" } };
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
 * a hire on a cancelled order is not hire spend.
 */
export function returnedWhere(): Prisma.PurchaseOrderRentalLineWhereInput {
  return { ...LIVE_ORDER, hireStatus: "returned" };
}
