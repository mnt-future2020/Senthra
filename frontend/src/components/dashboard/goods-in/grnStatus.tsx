import type { GrnQualityStatus, GrnStatus } from "@/types/goods-in";

// Shared presentation helpers for goods receipts — status badge, quality label, UK date.

export const GRN_STATUS_LABELS: Record<GrnStatus, string> = {
  draft: "Draft",
  completed: "Completed",
  cancelled: "Cancelled",
};

const GRN_STATUS_CLASSES: Record<GrnStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  completed: "bg-emerald-500/12 text-emerald-600",
  cancelled: "bg-rose-500/12 text-rose-600",
};

export function GrnStatusBadge({ status }: { status: GrnStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${GRN_STATUS_CLASSES[status] ?? GRN_STATUS_CLASSES.draft}`}>
      {GRN_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export const GRN_QUALITY_LABELS: Record<GrnQualityStatus, string> = {
  passed: "Passed",
  partial: "Partial",
  failed: "Failed",
};

const GRN_QUALITY_CLASSES: Record<GrnQualityStatus, string> = {
  passed: "text-emerald-600",
  partial: "text-amber-600",
  failed: "text-rose-600 font-bold",
};

export function GrnQualityLabel({ status }: { status: GrnQualityStatus }) {
  return <span className={GRN_QUALITY_CLASSES[status] ?? "text-[var(--muted)]"}>{GRN_QUALITY_LABELS[status] ?? status}</span>;
}

// UK date — DD/MM/YYYY (en-GB).
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB");
}
