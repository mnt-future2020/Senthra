import type { PoPriority, PoStatus } from "@/types/purchase-order";

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

export { formatDate } from "@/lib/formatDate";
