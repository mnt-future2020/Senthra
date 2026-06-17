import type { DispatchReason, GoodsOutStatus } from "@/types/goods-out";

// Shared presentation helpers for the Goods Out module — status badge, reason labels, UK date.

export const GOODS_OUT_STATUS_LABELS: Record<GoodsOutStatus, string> = {
  draft: "Draft",
  dispatched: "Dispatched",
  cancelled: "Cancelled",
};

const GOODS_OUT_STATUS_CLASSES: Record<GoodsOutStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  dispatched: "bg-emerald-500/12 text-emerald-600",
  cancelled: "bg-rose-500/12 text-rose-600",
};

export function GoodsOutStatusBadge({ status }: { status: GoodsOutStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${GOODS_OUT_STATUS_CLASSES[status] ?? GOODS_OUT_STATUS_CLASSES.draft}`}>
      {GOODS_OUT_STATUS_LABELS[status] ?? status}
    </span>
  );
}

// The dispatch-reason taxonomy (value → label). Order is the dropdown order.
export const DISPATCH_REASONS: DispatchReason[] = [
  "job_work",
  "customer_request",
  "installation",
  "maintenance",
  "replacement",
  "warehouse_replenishment",
  "emergency_dispatch",
  "other",
];
export const DISPATCH_REASON_LABELS: Record<DispatchReason, string> = {
  job_work: "Job work",
  customer_request: "Customer request",
  installation: "Installation",
  maintenance: "Maintenance",
  replacement: "Replacement",
  warehouse_replenishment: "Warehouse replenishment",
  emergency_dispatch: "Emergency dispatch",
  other: "Other",
};

// UK date — DD/MM/YYYY (en-GB).
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB");
}
