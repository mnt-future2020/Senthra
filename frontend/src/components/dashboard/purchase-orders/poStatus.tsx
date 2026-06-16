import type { PoPriority, PoStatus } from "@/types/purchase-order";

// Shared presentation helpers for purchase orders — status badge, priority label, money.

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending Approval",
  approved: "Approved",
  sent: "Sent",
  partially_received: "Partially Received",
  fully_received: "Fully Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

const PO_STATUS_CLASSES: Record<PoStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  pending_approval: "bg-amber-500/12 text-amber-600",
  approved: "bg-sky-500/12 text-sky-600",
  sent: "bg-indigo-500/12 text-indigo-600",
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

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
