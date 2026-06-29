"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/Skeleton";
import type { StockRequestStatus } from "@/types/customer";
import type { JobStatus } from "@/types/job";

// Shared presentation helpers for the customer portal pages. Keeping them in one
// place keeps the portal's look (header cards, status pills, dates, tables, and the
// layout-matched skeletons) consistent across Dashboard / Projects / Sites / Stock
// Requests — and aligned with the admin module's card-and-skeleton conventions.

// "10 Jun 2026" — en-GB, matching the rest of the dashboard.
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Date + time — for start/complete timestamps where the time of day matters.
export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Page header rendered as a surface card (mirrors the admin list pages), with an
// optional right-aligned action (e.g. the "Request stock" button).
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

// Honest placeholder for sections that depend on modules not built yet (inventory,
// reporting). Used both as a full-page Reports stand-in and inline on the dashboard.
export function ComingSoon({
  icon: Icon,
  title,
  body,
  compact,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] text-center ${
        compact ? "px-4 py-8" : "px-6 py-16"
      }`}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-10)] text-[var(--accent)]">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm font-bold text-[var(--ink)]">{title}</p>
      <p className="max-w-md text-xs text-[var(--muted)]">{body}</p>
      <span className="mt-1 rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
        Coming soon
      </span>
    </div>
  );
}

// A read-only data table inside a surface card — the shared shell for the portal's
// Projects / Sites / Stock Requests tables (header row + horizontal scroll).
export function TableCard({
  headers,
  minWidth = 640,
  children,
}: {
  headers: React.ReactNode[];
  minWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
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
}: {
  headers: React.ReactNode[];
  cells: string[];
  rows?: number;
  minWidth?: number;
}) {
  return (
    <TableCard headers={headers} minWidth={minWidth}>
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
