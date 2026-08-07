"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/Skeleton";
import type { StockRequestStatus } from "@/types/customer";
import type { JobStatus, PortalJobStage } from "@/types/job";

// Shared presentation helpers for the customer portal pages. Keeping them in one
// place keeps the portal's look (header cards, status pills, dates, tables, and the
// layout-matched skeletons) consistent across Dashboard / Projects / Sites / Stock
// Requests — and aligned with the admin module's card-and-skeleton conventions.

// Re-exported under this module's existing names so the portal's importers are unchanged.
export { formatDate as fmtDate, formatDateTime as fmtDateTime } from "@/lib/formatDate";

// Header card for something the top bar CANNOT already say: a record's own identity (a job's name
// and number) or a greeting ("Welcome, Acme Ltd"). NOT for a page title — the top bar carries that,
// and repeating it here is what this card used to do on nine portal and engineer screens, costing
// ~110px of a laptop viewport apiece to restate a word already on the page. Page-level TABS and
// ACTIONS belong in PageActions, which renders them into the top bar itself.
export function PortalHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="min-w-0">
        <h1 className="truncate text-xl font-extrabold tracking-tight text-[var(--ink)]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function HeaderCardSkeleton({ action }: { action?: boolean }) {
  return (
    <div
      className="flex items-start justify-between gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="space-y-2.5">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      {action && <Skeleton className="h-9 w-32 shrink-0 rounded-xl" />}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  active: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]",
  inactive: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
  planned: "border-[var(--accent)]/30 bg-[var(--accent-10)] text-[var(--accent)]",
  on_hold: "border-amber-500/30 bg-amber-500/10 text-amber-600",
  completed: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]",
};
const STATUS_DOT: Record<string, string> = {
  active: "bg-[var(--pos)]",
  inactive: "bg-[var(--faint)]",
  planned: "bg-[var(--accent)]",
  on_hold: "bg-amber-500",
  completed: "bg-[var(--faint)]",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  planned: "Planned",
  on_hold: "On hold",
  completed: "Completed",
};

// Dot + label status pill, matching the shared admin StatusBadge styling but able to
// carry the project/site statuses (planned / on_hold / completed) too.
export function StatusChip({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${STATUS_STYLE[value] ?? STATUS_STYLE.inactive}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[value] ?? STATUS_DOT.inactive}`} />
      {STATUS_LABEL[value] ?? value}
    </span>
  );
}

const REQ_STATUS_STYLE: Record<StockRequestStatus, { cls: string; dot: string; label: string }> = {
  pending: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", dot: "bg-amber-500", label: "Pending" },
  approved: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", dot: "bg-[var(--pos)]", label: "Approved" },
  rejected: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", dot: "bg-[var(--neg)]", label: "Rejected" },
  assigned: { cls: "border-blue-500/30 bg-blue-500/10 text-blue-600", dot: "bg-blue-500", label: "Assigned" },
  partially_received: { cls: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600", dot: "bg-indigo-500", label: "Partially received" },
  completed: { cls: "border-[var(--accent)]/30 bg-[var(--accent-10)] text-[var(--accent)]", dot: "bg-[var(--accent)]", label: "Completed" },
};

export function RequestStatusChip({ value }: { value: StockRequestStatus }) {
  const s = REQ_STATUS_STYLE[value] ?? REQ_STATUS_STYLE.pending;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

// Job lifecycle status pill (engineer portal Jobs). Mirrors RequestStatusChip's style block but
// carries the Job status machine: draft → assigned → accepted → in_progress → completed (or cancelled).
const JOB_STATUS_STYLE: Record<JobStatus, { cls: string; dot: string; label: string }> = {
  draft: { cls: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]", dot: "bg-[var(--faint)]", label: "Draft" },
  assigned: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-600", dot: "bg-amber-500", label: "Assigned" },
  accepted: { cls: "border-[var(--accent)]/30 bg-[var(--accent-10)] text-[var(--accent)]", dot: "bg-[var(--accent)]", label: "Accepted" },
  in_progress: { cls: "border-blue-500/30 bg-blue-500/10 text-blue-600", dot: "bg-blue-500", label: "In progress" },
  completed: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", dot: "bg-[var(--pos)]", label: "Completed" },
  rejected: { cls: "border-orange-500/30 bg-orange-500/10 text-orange-600", dot: "bg-orange-500", label: "Rejected" },
  cancelled: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", dot: "bg-[var(--neg)]", label: "Cancelled" },
};

export function JobStatusChip({ value }: { value: string }) {
  const s = JOB_STATUS_STYLE[value as JobStatus] ?? JOB_STATUS_STYLE.draft;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

// The CUSTOMER's four stages, not the seven statuses above. Separate from JobStatusChip on purpose:
// that one is the engineer/office view of our own workflow, and pointing both at one style map
// would mean the next status added to the machine quietly appears on a customer's screen with
// whatever internal word we happened to give it. The server never sends a status here — see
// PortalJobStage — so there is nothing to fall through to but a stage.
const JOB_STAGE_STYLE: Record<PortalJobStage, { cls: string; dot: string; label: string }> = {
  scheduled: { cls: "border-[var(--accent)]/30 bg-[var(--accent-10)] text-[var(--accent)]", dot: "bg-[var(--accent)]", label: "Scheduled" },
  in_progress: { cls: "border-blue-500/30 bg-blue-500/10 text-blue-600", dot: "bg-blue-500", label: "In progress" },
  completed: { cls: "border-[var(--pos)]/30 bg-[var(--pos)]/10 text-[var(--pos)]", dot: "bg-[var(--pos)]", label: "Completed" },
  cancelled: { cls: "border-[var(--neg)]/30 bg-[var(--neg)]/10 text-[var(--neg)]", dot: "bg-[var(--neg)]", label: "Cancelled" },
};

export function JobStageChip({ value }: { value: PortalJobStage }) {
  const s = JOB_STAGE_STYLE[value] ?? JOB_STAGE_STYLE.scheduled;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${s.cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/** The stage filter's options, sharing the labels above so the dropdown and the column agree. */
export const JOB_STAGE_OPTIONS: { value: PortalJobStage; label: string }[] = (
  Object.keys(JOB_STAGE_STYLE) as PortalJobStage[]
).map((v) => ({ value: v, label: JOB_STAGE_STYLE[v].label }));

// Empty-state card with an icon, title and hint.
export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
      <Icon className="h-7 w-7 text-[var(--faint)]" />
      <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
      {hint && <p className="max-w-sm text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

// A read-only data table inside a surface card — the shared shell for the portal's
// Projects / Sites / Stock Requests tables (header row + horizontal scroll).
// `fill` switches the card to the dashboard's inline-scroll contract: the card takes the
// remaining height of a `flex h-full flex-col` page, only the table body scrolls, and the
// header row stays pinned (sticky) — matching the admin list views (e.g. UsersView).
export function TableCard({
  headers,
  minWidth = 640,
  fill = false,
  children,
}: {
  headers: React.ReactNode[];
  minWidth?: number;
  fill?: boolean;
  children: React.ReactNode;
}) {
  const table = (
    <table className="w-full text-left text-sm" style={{ minWidth }}>
      <thead className={fill ? "sticky top-0 z-10 bg-[var(--surface)]" : undefined}>
        <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
          {headers.map((h, i) => (
            <th key={i} className={`px-4 py-3 ${h === "" ? "" : "font-bold"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
  if (!fill) {
    return (
      <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {table}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="min-h-0 flex-1 overflow-auto">{table}</div>
    </div>
  );
}

// Skeleton rows that mirror a TableCard's columns. `cells` are full Skeleton class
// strings (one per column) so each placeholder matches its real cell's shape — the
// header labels show immediately, only the cells shimmer (exactly like the admin
// table skeletons).
export function TableCardSkeleton({
  headers,
  cells,
  rows = 6,
  minWidth = 640,
  fill = false,
}: {
  headers: React.ReactNode[];
  cells: string[];
  rows?: number;
  minWidth?: number;
  fill?: boolean;
}) {
  return (
    <TableCard headers={headers} minWidth={minWidth} fill={fill}>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="border-b border-[var(--border)] last:border-0">
          {cells.map((cls, c) => (
            <td key={c} className="px-4 py-3">
              <Skeleton className={cls} />
            </td>
          ))}
        </tr>
      ))}
    </TableCard>
  );
}

// A single dashboard stat-card placeholder.
export function StatCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <Skeleton className="h-9 w-9 rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-12" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

// ── Read-only detail view ─────────────────────────────────────────────────────────────────────
// The portal's lists are deliberately narrow: a handful of columns that stay readable on a phone.
// That means every list drops fields the customer is entitled to see, and until these existed
// there was nowhere to put them — the tables were the whole portal, with nothing clickable in it.
//
// A MODAL rather than a detail route, because the lists are server-paged with the page in the URL:
// navigating away and back re-fetches and can land the customer on a different page than the row
// they opened. A modal keeps the list exactly where it was underneath.

/**
 * One label/value pair. Renders an em dash for anything empty so a gap never reads as a bug.
 *
 * `hint` is for a value that needs explaining rather than just showing — where the fact alone would
 * leave the customer with a question. Prefer it over styling the value to imply something (striking
 * a superseded name, say): a label states what a value IS, so any formatting that contradicts the
 * label just makes the pair unreadable. Say it in words instead.
 */
export function DetailRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    // min-w-0 + break: DetailGrid puts these in a 2-column grid from `sm` up, and a grid item
    // defaults to min-width:auto — so an unbreakable value (an email, a long reference) refuses to
    // shrink and spills into the neighbouring column instead of wrapping inside its own.
    <div className="flex min-w-0 flex-col gap-0.5 py-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</span>
      <span className={`wrap-break-word text-sm ${empty ? "text-[var(--faint)]" : "text-[var(--ink)]"}`}>
        {empty ? "—" : value}
      </span>
      {hint && <span className="text-[11px] leading-snug text-[var(--muted)]">{hint}</span>}
    </div>
  );
}

/** Two columns from `sm` up, one on a phone. Wrap DetailRow children in this. */
export function DetailGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-6 divide-y divide-[var(--border)] sm:grid-cols-2 sm:divide-y-0">{children}</div>;
}

/** Makes a table row look and behave like something you can open — including via the keyboard. */
export const clickableRowCls =
  "cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none";
