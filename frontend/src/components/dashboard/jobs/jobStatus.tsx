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

// DERIVED pseudo-statuses — filter values the list accepts that are not stored on a job. Each is
// resolved server-side in job.repository's buildWhere, and each is the exact predicate a dashboard
// card or attention badge counts by, so clicking one opens precisely the rows it counted.
export const JOB_DERIVED_STATUS_OPTIONS = [
  // Work in flight: Assigned, Accepted and In progress. What the Overview's "Active Jobs" card
  // counts — it opened the unfiltered list before, so "Active Jobs 18" landed on every job ever
  // raised with nothing on screen saying which 18 were meant.
  { value: "active", label: "Active (in flight)" },
  { value: "overdue", label: "Overdue" },
];

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

export const JOB_LINE_TYPES: JobLineType[] = ["customer_stock", "irm", "rental", "misc"];
export const JOB_LINE_TYPE_LABELS: Record<JobLineType, string> = {
  customer_stock: "Customer stock",
  irm: "IRM item",
  rental: "Rental item",
  misc: "Miscellaneous",
};

export const INSTALLER_TYPES = ["internal", "external"] as const;
export const INSTALLER_TYPE_LABELS: Record<string, string> = {
  internal: "Internal",
  external: "External",
};

// Re-exported so the module's existing importers keep the same entry point. The local copies were
// the drifted ones: `formatDate` rendered 03/08/2026 while Settings → Company promises on-screen
// dates in DD Mon YYYY. See lib/formatDate.ts.
export { formatDate, formatDateTime } from "@/lib/formatDate";

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
  /**
   * Of `vanQty`, how much may be handed back at ANY warehouse — IRM only.
   *
   * Customer stock cannot: a CustomerStockEntry IS one location and a return credits that entry, so an
   * away-from-home consignment return has nowhere to land without the record claiming the customer's
   * stock is at a warehouse that doesn't physically have it. scanLookup and postReturn have always
   * refused it; only these kit lists said otherwise. Misc isn't stock-tracked at all.
   */
  vanReturnableQty: number;
  pendingVanQty: number; // agreed but not yet handed over
  /** Still to be collected from this line's warehouse — planned, minus what has been issued, minus
   *  what a van is bringing. */
  outstandingWarehouseQty: number;
  /** The warehouse's WHOLE obligation: already issued + still owed. What a kit list should show. */
  warehouseShare: number;
  vanOnly: boolean;
}
// `jobCancelled` turns off the "still to collect" half. A cancelled job can't be issued against
// (postIssue refuses it) and its pending handovers are withdrawn the moment it's cancelled, so units
// that never left the warehouse are never coming — printing "N to collect" sends an engineer to a
// warehouse for work that no longer exists. What already MOVED is untouched: those units are real and
// still have to be returned.
export function kitLineSourceSplit(line: JobKitLine, opts: { jobCancelled?: boolean } = {}): KitLineSourceSplit {
  const sources = line.vanSources ?? [];
  const sum = (status: string) => sources.filter((v) => v.status === status).reduce((n, v) => n + v.quantity, 0);
  const vanQty = sum("completed");
  const pendingVanQty = sum("pending");
  // Whatever the van didn't supply came from the warehouse. Clamped: a return posted at another
  // warehouse can push `issued` below `vanQty`, and a negative would render as nonsense.
  const warehouseQty = Math.max(0, line.issued - vanQty);
  const vanReturnableQty = line.lineType === "irm" ? vanQty : 0;
  // What the warehouse still owes. `warehouseQty` is derived from `issued`, so it answers "how much of
  // what already MOVED came from here" — correct after the fact, and zero on a line the planner has
  // just split, which is exactly when the engineer needs to know where to collect the remainder.
  // Floored: an over-issue (or a return posted at another site) must not render as "-1 to collect".
  const outstandingWarehouseQty = opts.jobCancelled ? 0 : Math.max(0, line.qty - line.issued - pendingVanQty);
  return {
    vanQty,
    vanReturnableQty,
    pendingVanQty,
    warehouseQty,
    outstandingWarehouseQty,
    warehouseShare: warehouseQty + outstandingWarehouseQty,
    // Gated on the RETURNABLE portion, not the van portion: a fully van-supplied consignment line is
    // still owed to its entry's warehouse, so "Return at any warehouse" must not fire on it.
    vanOnly: line.issued > 0 && vanReturnableQty >= line.issued,
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
