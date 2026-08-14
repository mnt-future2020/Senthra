import type { PrfStatus } from "@/types/purchase-request";

// Shared presentation helpers for purchase requests — status badge + re-exported money/date
// formatters (same rendering as purchase orders, so the two documents read consistently).

export { formatDate, formatMoney } from "@/components/dashboard/purchase-orders/poStatus";

export const PRF_STATUS_LABELS: Record<PrfStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Finance Approved",
  converted: "Converted",
  cancelled: "Cancelled",
};

// DERIVED pseudo-status — a filter value the list accepts that is not stored on a PRF. Resolved
// server-side in purchase-request.repository's buildWhere from the same predicate the "Rejected —
// needs rework" badge counts, so clicking that badge opens precisely the rows it counted. Labelled as
// a QUEUE so it reads as distinct from the real statuses above: every one of these IS a draft, but
// only the ones sent back for rework.
export const PRF_DERIVED_STATUS_OPTIONS = [{ value: "rework", label: "Rework queue" }];

const PRF_STATUS_CLASSES: Record<PrfStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  submitted: "bg-amber-500/12 text-amber-600",
  approved: "bg-sky-500/12 text-sky-600",
  converted: "bg-emerald-500/12 text-emerald-600",
  cancelled: "bg-rose-500/12 text-rose-600",
};

export function PrfStatusBadge({ status }: { status: PrfStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${PRF_STATUS_CLASSES[status] ?? PRF_STATUS_CLASSES.draft}`}>
      {PRF_STATUS_LABELS[status] ?? status}
    </span>
  );
}
