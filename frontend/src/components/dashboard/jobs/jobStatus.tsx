import type { JobLineType, JobPriority, JobStatus, JobType } from "@/types/job";

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
