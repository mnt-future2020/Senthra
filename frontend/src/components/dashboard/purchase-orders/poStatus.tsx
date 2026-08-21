import type { PoPriority, PoStatus } from "@/types/purchase-order";
import { formatDate } from "@/lib/formatDate";

// Shared presentation helpers for purchase orders — status badge, priority label, money.

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  pm_review: "PM Review",
  sent: "Sent",
  supplier_accepted: "Supplier Accepted",
  partially_received: "Partially Received",
  fully_received: "Fully Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

// DERIVED pseudo-statuses — filter values the list accepts that are not stored on a PO. Each is
// resolved server-side in purchase-order.repository's buildWhere, and each is the exact predicate an
// attention badge counts by, so clicking a badge opens precisely the rows it counted. Labelled as
// QUEUES so they read as distinct from the real statuses above (a "Send queue" spans Approved and
// PM Review; an "Approval queue" spans PRF-born drafts and Pending Approval).
export const PO_DERIVED_STATUS_OPTIONS = [
  { value: "awaiting_approval", label: "Approval queue" },
  { value: "awaiting_send", label: "Send queue" },
  // Everything the warehouse can still book in — Sent, Supplier Accepted and Partially Received.
  // "Deliveries to receive" opened `?status=sent` before, which is one of those three, so the chip
  // said 14 and the list showed 7.
  { value: "receivable", label: "Receiving queue" },
  { value: "overdue", label: "Delivery overdue" },
  // Arrived AND nothing left on hire — what the "Received — ready to close" badge opens. NOT the raw
  // `fully_received` status it used to: a rental order stays fully received forever once its kit
  // turned up, but it cannot be closed until the kit goes back, so the badge listed rows whose Close
  // button the server refuses. Same predicate the count uses (awaitingClosePoWhere on the server).
  { value: "awaiting_close", label: "Ready to close" },
];

// Statuses at which the supplier's acknowledgement may be recorded. MIRRORS the backend's
// ACCEPTANCE_RECORDABLE set (purchase-order.service.ts) — the server is authoritative; this only
// decides whether to show the control. Keep the two in sync.
export const ACCEPTANCE_RECORDABLE_STATUSES: PoStatus[] = ["sent", "supplier_accepted", "partially_received", "fully_received"];

// Statuses at which stock can be received against a PO. MIRRORS requireReceivablePurchaseOrder.
export const RECEIVABLE_STATUSES: PoStatus[] = ["sent", "supplier_accepted", "partially_received"];

const PO_STATUS_CLASSES: Record<PoStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  pending_approval: "bg-amber-500/12 text-amber-600",
  approved: "bg-sky-500/12 text-sky-600",
  pm_review: "bg-violet-500/12 text-violet-600",
  sent: "bg-indigo-500/12 text-indigo-600",
  supplier_accepted: "bg-teal-500/12 text-teal-600",
  partially_received: "bg-lime-500/12 text-lime-600",
  fully_received: "bg-emerald-500/12 text-emerald-600",
  closed: "bg-slate-500/12 text-slate-600",
  cancelled: "bg-rose-500/12 text-rose-600",
};

export function PoStatusBadge({ status }: { status: PoStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${PO_STATUS_CLASSES[status] ?? PO_STATUS_CLASSES.draft}`}>
      {PO_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * WHERE THIS ORDER'S HIRED KIT IS NOW — the fact `po.status` cannot carry.
 *
 * The status describes RECEIVING: `fully_received` means every ordered unit turned up, and it stays
 * true forever once it happens. On a goods order that is the whole story. On a hire it is half of
 * one — the kit then has to go back — so an order whose equipment was returned days ago still reads
 * "Fully Received" at the top, and the only word saying otherwise was a small badge inside the rental
 * table. Somebody scanning the header concluded the kit was still with us.
 *
 * Two facts, two chips, and the status machine untouched: it drives the badges, the close guard, the
 * receiving queue, every list filter and the exports, and forking it for one line type would be a
 * large change to say something it was never asked.
 *
 * Deliberately states no DEADLINE. Whether a hire is overdue is decided server-side in the company
 * timezone, by the same predicate the attention badges count — re-deciding it here from the browser's
 * clock is how a chip and a badge come to disagree by a day. The due DATE is a fact and is shown; the
 * judgement stays where it is owned.
 */
export interface HireSummary {
  label: string;
  /** done = everything back · live = still out · wait = nothing has arrived yet. */
  tone: "done" | "live" | "wait";
  /**
   * The arithmetic behind the label, for the chip's tooltip. Absent when the label already says
   * everything — a tooltip that repeats what is on screen is noise a reader learns to ignore.
   *
   * Exists because the chip is the ANSWER and the order's own lines are the LEDGER. On the detail
   * page it sits directly above a line reading "5 Each · 4 received · 1 cancelled", and a reader
   * should not have to reconcile 4 against 5 in their head. This costs no layout.
   */
  title?: string;
}

export function hireSummary(
  rentalItems: {
    hireStatus: string;
    quantity: number;
    receivedQuantity: number;
    returnedQuantity: number;
    /** Units written off by a short close — nobody is waiting for these. */
    cancelledQuantity?: number;
    hireEndDate: string;
  }[],
): HireSummary | null {
  // A goods-only order has nothing to say here, and an empty chip is worse than no chip.
  if (rentalItems.length === 0) return null;

  const out = rentalItems.filter((r) => r.hireStatus === "on_hire");
  if (out.length === 0) {
    // Nothing is out. That is either FINISHED or NOT YET ARRIVED, and telling them apart is the whole
    // job here — a finished hire labelled "awaiting delivery" tells the reader to expect equipment
    // that is never coming.
    //
    // Asked against both terminal states. Written as `every(returned)` it predated `cancelled`, so a
    // hire that never happened — and a mixed order with one of each — fell through to the waiting
    // branch, which is the one reading that cannot be true.
    const finished = rentalItems.filter((r) => r.hireStatus === "returned" || r.hireStatus === "cancelled");
    if (finished.length === rentalItems.length) {
      // Named for what actually happened, because the two are different facts and the register that
      // reports hire spend tells them apart: a cancelled hire never happened and is not spend.
      if (finished.every((r) => r.hireStatus === "cancelled")) return { label: "Hire cancelled", tone: "done" };
      if (finished.every((r) => r.hireStatus === "returned")) return { label: "Hire returned", tone: "done" };
      return { label: "Hire finished", tone: "done" };
    }
    return { label: "Hire awaiting delivery", tone: "wait" };
  }

  // UNITS, not lines: an order can carry one line of five testers, and "1 of 1" would be a lie about
  // what is standing in the yard. Clamped, because a return can be recorded against units that were
  // later given back by a reversal.
  const held = out.reduce((sum, r) => sum + Math.max(0, r.receivedQuantity - r.returnedQuantity), 0);
  // NET of what was written off. "4 of 5" promises a fifth unit; after a short close that unit was
  // formally abandoned, with a reason, on the record — so the honest denominator is what this hire
  // will EVER hold, not what was once ordered. The order's own lines still show `5 · 1 cancelled`,
  // which is where the original figure belongs.
  const ordered = rentalItems.reduce((sum, r) => sum + Math.max(0, r.quantity - (r.cancelledQuantity ?? 0)), 0);
  // The soonest deadline among the lines that are actually out — the one that matters first.
  const due = out.reduce((soonest, r) => (r.hireEndDate < soonest ? r.hireEndDate : soonest), out[0]!.hireEndDate);

  // `of N` says ONE thing: some units are not with us. When they all are it says nothing, and costs a
  // reader two numbers to compare instead of one to read — "4 of 4" even sends them looking for a
  // fifth unit that was written off. Dropped when it carries no fact, which is the rule every other
  // quantity on these screens already follows: the warehouse queue writes "of 5 · 4 already here"
  // only once some have arrived, the on-hire row writes "2 here" only once they differ.
  //
  // The SHAPE is then information in itself: "4" and "4 of 5" are told apart at a glance, where an
  // unconditional "X of Y" has to be read twice.
  const count = held === ordered ? `${held}` : `${held} of ${ordered}`;

  // What the label leaves out, and only when there is something. `gross` is what the supplier was
  // sent; the label counts against the NET, so a written-off unit has to be named or the two figures
  // look like a contradiction.
  const gross = rentalItems.reduce((sum, r) => sum + r.quantity, 0);
  const writtenOff = gross - ordered;
  // Counted from what was actually GIVEN BACK, not inferred as `ordered - held`: that subtraction
  // also swallows units the supplier never delivered, and reported them as returned. An order for 5
  // with 2 received and nothing returned read "5 ordered · 3 back · 2 on hire" — asserting three
  // units came home that never left the supplier's yard. Capped at what arrived, for the same
  // reversal case that clamps `held`.
  const back = rentalItems.reduce(
    (sum, r) => sum + Math.min(Math.max(0, r.returnedQuantity), Math.max(0, r.receivedQuantity)),
    0,
  );
  // The rest of the net order: ordered, not written off, and not yet through the door. Named so the
  // tooltip's figures add up to the one it opens with instead of leaving a silent gap.
  const awaiting = Math.max(0, ordered - held - back);
  const parts = [
    `${gross} ordered`,
    ...(writtenOff > 0 ? [`${writtenOff} written off`] : []),
    ...(awaiting > 0 ? [`${awaiting} not yet delivered`] : []),
    ...(back > 0 ? [`${back} back`] : []),
    `${held} on hire`,
  ];
  return {
    label: `On hire · ${count} · due ${formatDate(due)}`,
    tone: "live",
    title: parts.length > 2 ? parts.join(" · ") : undefined,
  };
}

const HIRE_TONE: Record<HireSummary["tone"], string> = {
  done: "bg-[var(--pos,#16a34a)]/12 text-[var(--pos,#16a34a)]",
  live: "bg-[var(--accent)]/12 text-[var(--accent)]",
  wait: "bg-[var(--surface-2)] text-[var(--muted)]",
};

/** The chip itself. Renders nothing on an order with no hires, so callers need no guard. */
export function HireStateBadge({ rentalItems }: { rentalItems: Parameters<typeof hireSummary>[0] }) {
  const summary = hireSummary(rentalItems);
  if (!summary) return null;
  return (
    <span
      title={summary.title}
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${HIRE_TONE[summary.tone]}`}
    >
      {summary.label}
    </span>
  );
}

export const PO_PRIORITY_LABELS: Record<PoPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

const PO_PRIORITY_CLASSES: Record<PoPriority, string> = {
  low: "text-[var(--faint)]",
  normal: "text-[var(--muted)]",
  high: "text-amber-600",
  urgent: "text-rose-600 font-bold",
};

export function PoPriorityLabel({ priority }: { priority: PoPriority }) {
  return <span className={PO_PRIORITY_CLASSES[priority] ?? "text-[var(--muted)]"}>{PO_PRIORITY_LABELS[priority] ?? priority}</span>;
}

// Format a pounds amount in en-GB. currency defaults to GBP.
export function formatMoney(pounds: number | null | undefined, currency = "GBP"): string {
  if (pounds == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pounds);
  } catch {
    return `£${pounds.toFixed(2)}`;
  }
}

export { formatDate };
