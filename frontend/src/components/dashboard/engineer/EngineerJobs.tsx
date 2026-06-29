"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { useJobSocket } from "@/hooks/useJobSocket";
import { Notice } from "@/components/ui/Notice";
import { EmptyState, fmtDate, JobStatusChip, PortalHeader, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
import type { Job } from "@/types/job";
import type { Msg } from "@/components/ui/types";

// Engineer Portal — My assigned jobs (read-only list). Each row links to the job detail page where
// the engineer can review the kit list and accept the job. A live socket refetch keeps the list
// current when a planner assigns a new job (job:new) or another action lands (job:accepted).
const HEADERS = ["Job no.", "Name", "Customer", "Due date", "Status"];
const SKELETON_CELLS = ["h-3 w-24", "h-3 w-44", "h-3 w-36", "h-3 w-20", "h-5 w-20 rounded-full"];

export function EngineerJobs() {
  const router = useRouter();
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  // A component-level latest-request guard: refetch can be invoked from the mount effect AND the
  // socket callback, so a per-call closure can't enforce ordering. seqRef keeps only the newest
  // response; mountedRef drops anything that resolves after unmount.
  const seqRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = React.useCallback(() => {
    const myseq = ++seqRef.current;
    const apply = () => mountedRef.current && seqRef.current === myseq;
    void (async () => {
      try {
        const list = await engineerService.getOwnJobs();
        if (apply()) {
          setJobs(list);
          setMsg(null);
        }
      } catch (err) {
        if (apply()) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your jobs." });
      } finally {
        if (apply()) setLoading(false);
      }
    })();
  }, []);

  React.useEffect(() => refetch(), [refetch]);

  // Live updates: a newly-assigned job (job:new) appears without a manual refresh.
  useJobSocket(() => refetch());

  if (loading) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Jobs" subtitle="Your assigned jobs." />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={640} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalHeader title="Jobs" subtitle="Your assigned jobs." />
      {msg && <Notice msg={msg} />}

      {msg?.type === "error" ? null : jobs.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No jobs assigned" hint="Jobs assigned to you will appear here." />
      ) : (
        <TableCard headers={HEADERS} minWidth={640}>
          {jobs.map((j) => (
            <tr
              key={j.id}
              onClick={() => router.push(`/dashboard/engineer/jobs/${j.id}`)}
              className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
            >
              <td className="px-4 py-3 font-mono text-xs text-[var(--accent)]">{j.jobNumber}</td>
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{j.name}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{j.customerName ?? "—"}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(j.completionDate)}</td>
              <td className="px-4 py-3">
                <JobStatusChip value={j.status} />
              </td>
            </tr>
          ))}
        </TableCard>
      )}
    </div>
  );
}
