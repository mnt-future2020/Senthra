"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Search } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import type { PagedOwnJobs } from "@/services/engineer.service";
import { useJobSocket } from "@/hooks/useJobSocket";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { EmptyState, fmtDate, JobStatusChip, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";

// Engineer Portal — My assigned jobs. Filtered + PAGED like every other list (an engineer's job
// history grows unbounded, so the list never fetches it all). Filters live in the URL
// (?status, ?sort, ?q, ?page) so they survive a refresh — same approach as the Transfers page.
// A live socket refetch keeps the current page fresh when a planner assigns a new job.
const HEADERS = ["Job no.", "Name", "Customer", "Due date", "Status"];
const SKELETON_CELLS = ["h-3 w-24", "h-3 w-44", "h-3 w-36", "h-3 w-20", "h-5 w-20 rounded-full"];

// Statuses an engineer's job can be in (never draft — assignment happens at/after creation).
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "assigned", label: "Assigned" },
  { value: "accepted", label: "Accepted" },
  { value: "in_progress", label: "In progress" },
  // "Overdue" is not a stored status — the backend derives it (active job, completion date passed).
  { value: "overdue", label: "Overdue" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

export function EngineerJobs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const sortOldest = searchParams.get("sort") === "oldest"; // default: newest first (matches every other list)
  const search = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedOwnJobs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  // The text box keeps its own immediate value; the debounced result is written to ?q.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/engineer/jobs?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  // Debounce the search box into ?q.
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await engineerService.getOwnJobs({
          status: status || undefined,
          q: search || undefined,
          sort: sortOldest ? "oldest" : undefined,
          page,
          pageSize: 20,
        });
        if (active) {
          setPaged(r);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your jobs.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [status, sortOldest, search, page, refreshKey]);

  // Live updates: a newly-assigned job (job:new) refreshes the current page without a manual reload.
  const reload = React.useCallback(() => setRefreshKey((k) => k + 1), []);
  useJobSocket(reload);

  const jobs = paged?.jobs ?? [];
  const filtered = !!(search || status);

  return (
    <div className="flex h-full flex-col gap-6">
      {/* Toolbar — search + status filter + sort (same pattern as the Transfers page) */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative w-full sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search job no., name or customer…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <Select
          size="sm"
          value={status}
          onChange={(v) => patchParams({ status: v || null }, true)}
          options={STATUS_OPTIONS}
          ariaLabel="Status filter"
        />
        <Select
          size="sm"
          value={sortOldest ? "oldest" : "newest"}
          onChange={(v) => patchParams({ sort: v === "oldest" ? "oldest" : null }, true)}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          ariaLabel="Sort order"
        />
      </div>

      {loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={640} fill />
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</div>
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={filtered ? "No matching jobs" : "No jobs assigned"}
          hint={filtered ? "Try a different search or status filter." : "Jobs assigned to you will appear here."}
        />
      ) : (
        <>
          <TableCard
            headers={HEADERS}
            minWidth={640}
            fill
            footer={
              <Pagination
                embedded
                page={paged?.page ?? 1}
                totalPages={paged?.totalPages ?? 1}
                total={paged?.total ?? 0}
                label="jobs"
                onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
              />
            }
          >
            {jobs.map((j) => (
              <tr
                key={j.id}
                onClick={() => router.push(`/dashboard/engineer/jobs/${j.id}`)}
                className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
              >
                <td className="cell-y px-4 font-mono text-xs text-[var(--accent)]">{j.jobNumber}</td>
                <td className="cell-y px-4 font-semibold text-[var(--ink)]">{j.name}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{j.customerName ?? "—"}</td>
                {/* The same marker the office list carries, from the same server-derived flag — the
                    engineer could already FILTER to Overdue but had no way to see which of these rows
                    were, which is the office list's old problem repeated on the surface where the
                    work actually happens. */}
                <td className={`cell-y px-4 ${j.overdue ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {fmtDate(j.completionDate)}
                    {j.overdue && j.daysLate != null && (
                      <span
                        title={`Due ${fmtDate(j.completionDate)} — still open`}
                        className="whitespace-nowrap rounded-full bg-[var(--neg)]/12 px-1.5 py-0.5 text-[10px] font-bold text-[var(--neg)]"
                      >
                        {j.daysLate}d late
                      </span>
                    )}
                  </span>
                </td>
                <td className="cell-y px-4">
                  <JobStatusChip value={j.status} />
                </td>
              </tr>
            ))}
          </TableCard>
        </>
      )}
    </div>
  );
}
