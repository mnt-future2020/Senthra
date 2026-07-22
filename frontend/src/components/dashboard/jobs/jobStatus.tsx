import type { JobKitLine, JobLineType, JobPriority, JobStatus, JobType } from "@/types/job";

// Shared presentation helpers for the Jobs module — status chip, labels, UK date.
// Self-contained: does NOT depend on the portal's JobStatusChip (owned elsewhere).

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  assigned: "Assigned",
  accepted: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const JOB_STATUS_CLASSES: Record<JobStatus, string> = {
  draft: "bg-[var(--surface-2)] text-[var(--muted)]",
  assigned: "bg-amber-500/12 text-amber-600",
  accepted: "bg-sky-500/12 text-sky-600",
  in_progress: "bg-indigo-500/12 text-indigo-600",
  completed: "bg-emerald-500/12 text-emerald-600",
  rejected: "bg-orange-500/12 text-orange-600",
  cancelled: "bg-rose-500/12 text-rose-600",
};

export function JobStatusChip({ status }: { status: string }) {
  const s = status as JobStatus;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${JOB_STATUS_CLASSES[s] ?? JOB_STATUS_CLASSES.draft}`}>
      {JOB_STATUS_LABELS[s] ?? status}
    </span>
  );
}

// Goods-lifecycle (stock) status — shows whether warehouse stock has been issued for a job.
export const GOODS_STATUS_LABELS: Record<string, string> = {
  not_issued: "Not issued",
  partially_issued: "Partial",
  issued: "Issued",
  awaiting_return: "Awaiting return",
  reconciled: "Reconciled",
};

const GOODS_STATUS_CLASSES: Record<string, string> = {
  not_issued: "bg-[var(--surface-2)] text-[var(--faint)]",
  partially_issued: "bg-amber-500/15 text-amber-600",
  issued: "bg-sky-500/12 text-sky-600",
  awaiting_return: "bg-indigo-500/12 text-indigo-600",
  reconciled: "bg-emerald-500/12 text-emerald-600",
};

export function GoodsStatusChip({ status }: { status?: string | null }) {
  if (!status) return <span className="text-[var(--faint)]">—</span>;
  const label = GOODS_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
  const cls = GOODS_STATUS_CLASSES[status] ?? "bg-[var(--surface-2)] text-[var(--faint)]";
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${cls}`}>
      {label}
    </span>
  );
}

export const JOB_PRIORITIES: JobPriority[] = ["low", "normal", "high", "urgent"];
export const JOB_PRIORITY_LABELS: Record<JobPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const JOB_TYPES: JobType[] = ["installation", "survey", "maintenance", "decommission", "other"];
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  installation: "Installation",
  survey: "Survey",
  maintenance: "Maintenance",
  decommission: "Decommission",
  other: "Other",
};

export const JOB_LINE_TYPES: JobLineType[] = ["customer_stock", "irm", "misc"];
export const JOB_LINE_TYPE_LABELS: Record<JobLineType, string> = {
  customer_stock: "Customer stock",
  irm: "IRM item",
  misc: "Miscellaneous",
};

export const INSTALLER_TYPES = ["internal", "external"] as const;
export const INSTALLER_TYPE_LABELS: Record<string, string> = {
  internal: "Internal",
  external: "External",
};

// UK date — DD/MM/YYYY (en-GB).
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB");
}

// Date + time — used for start/complete timestamps where the time of day matters.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A kit line MERGES sources: the same item at the same warehouse is one row, so units collected from
// the warehouse and units handed over from another engineer's van end up on a single line (e.g.
// "planned 3" = 2 from stock + 1 from a van). Showing only one origin would misreport the other, so
// the two views break the row down with this.
//
// `vanOnly` also decides where leftovers may go back: van stock never left a warehouse, so none is
// owed it and it can be scanned in anywhere. A line with ANY warehouse-issued qty still owes that
// part to its own warehouse — matching findVanOnlyKitLine on the server.
export interface KitLineSourceSplit {
  warehouseQty: number; // issued from this line's own warehouse
  vanQty: number; // handed over from a van (transfer completed)
  pendingVanQty: number; // agreed but not yet handed over
  vanOnly: boolean;
}
export function kitLineSourceSplit(line: JobKitLine): KitLineSourceSplit {
  const sources = line.vanSources ?? [];
  const sum = (status: string) => sources.filter((v) => v.status === status).reduce((n, v) => n + v.quantity, 0);
  const vanQty = sum("completed");
  return {
    vanQty,
    pendingVanQty: sum("pending"),
    // Whatever the van didn't supply came from the warehouse. Clamped: a return posted at another
    // warehouse can push `issued` below `vanQty`, and a negative would render as nonsense.
    warehouseQty: Math.max(0, line.issued - vanQty),
    vanOnly: line.issued > 0 && vanQty >= line.issued,
  };
}

// When the engineer returns units of an item at one warehouse that were actually issued from ANOTHER
// warehouse (the same fungible item is on the job at >1 warehouse), this line's Returned exceeds its
// Issued. This note explains the surplus and names the source warehouse(s) — the same item's sibling
// lines that are still short a return. Returns null for ordinary lines (Returned ≤ Issued).
export function crossWarehouseReturnNote(line: JobKitLine, lines: JobKitLine[]): string | null {
  const excess = line.returned - line.issued;
  if (excess <= 0) return null;
  const sources = lines.filter(
    (l) =>
      l.id !== line.id &&
      ((line.irmItemId && l.irmItemId === line.irmItemId) ||
        (line.customerStockEntryId && l.customerStockEntryId === line.customerStockEntryId)) &&
      l.issued - l.returned > 0,
  );
  const names = [...new Set(sources.map((l) => l.warehouseName).filter((n): n is string => !!n))];
  return `+${excess} from ${names.length ? names.join(", ") : "another warehouse"}`;
}
