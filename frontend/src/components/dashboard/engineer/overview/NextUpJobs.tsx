import Link from "next/link";
import { CheckCircle2, ChevronRight, Lock } from "lucide-react";

import { fmtDate } from "@/components/dashboard/portal/portalUi";
import { JobStatusChip } from "@/components/dashboard/jobs/jobStatus";
import type { EngineerOverviewJob } from "@/types/engineer";

// The engineer's active jobs, soonest due first. Each row is a Link (not a button) so it supports
// middle-click / open-in-new-tab and keyboard navigation.
// Uses UTC day boundaries to match the backend `overdue` count (engineer.service.getOwnOverview), so a
// row's "Overdue" label can never disagree with the dashboard KPI near midnight / off-UTC.
const isPast = (iso: string | null): boolean => {
  if (!iso) return false;
  const due = Date.parse(iso);
  if (Number.isNaN(due)) return false;
  const now = new Date();
  return due < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

export function NextUpJobs({ jobs, canJobs }: { jobs: EngineerOverviewJob[]; canJobs: boolean }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 lg:col-span-2">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-extrabold text-[var(--ink)]">Next up</h2>
          <p className="text-[11px] text-[var(--muted)]">Your active jobs, soonest due first.</p>
        </div>
        {canJobs && (
          <Link href="/dashboard/engineer/jobs" className="text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
            All jobs →
          </Link>
        )}
      </div>
      {!canJobs ? (
        // Honest copy: without jobs.view we can't claim "no active jobs" (the data is simply gated, not
        // empty). Rendered rather than hidden so the dashboard's 2/3-width layout stays intact.
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <Lock className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">Jobs aren&apos;t part of your access</p>
          <p className="text-xs text-[var(--muted)]">Ask an administrator if you should be able to see your assigned jobs here.</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <CheckCircle2 className="h-7 w-7 text-[var(--pos)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No active jobs</p>
          <p className="text-xs text-[var(--muted)]">New assignments will appear here the moment they land.</p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-2)]">
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job }: { job: EngineerOverviewJob }) {
  const overdue = isPast(job.completionDate);
  const urgent = job.priority === "urgent" || job.priority === "high";
  return (
    <li>
      <Link href={`/dashboard/engineer/jobs/${job.id}`} className="group flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-[var(--surface-2)]/60">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold text-[var(--muted)]">{job.jobNumber}</span>
            <JobStatusChip status={job.status} />
            {urgent && (
              <span className="rounded-full bg-[var(--neg)]/12 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--neg)]">
                {job.priority}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold text-[var(--ink)]">{job.name}</p>
          {job.customerName && <p className="truncate text-[11px] text-[var(--faint)]">{job.customerName}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-xs font-bold ${overdue ? "text-[var(--neg)]" : "text-[var(--muted)]"}`}>
            {job.completionDate ? `${overdue ? "Overdue · " : "Due "}${fmtDate(job.completionDate)}` : "No due date"}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}
