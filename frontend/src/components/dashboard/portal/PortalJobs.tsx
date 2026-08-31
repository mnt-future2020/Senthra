"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardCheck, Search } from "lucide-react";

import * as jobService from "@/services/job.service";
import { ExportButton } from "@/components/ui/ExportButton";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { DateRangeFilter } from "@/components/ui/DateRangeFilter";
import { SitePicker, siteOptionLabel } from "@/components/ui/SitePicker";
import { toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import type { PagedPortalJobs } from "@/services/job.service";
import type { JobType } from "@/types/job";
import type { Msg } from "@/components/ui/types";

// The office's own label map, not a portal copy of it — a job type renamed there is renamed here.
import { JOB_TYPE_LABELS } from "@/components/dashboard/jobs/jobStatus";
import {
  clickableRowCls,
  EmptyState,
  fmtDate,
  JOB_STAGE_OPTIONS,
  JobStageChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";

const HEADERS = ["Job", "Name", "Site", "Engineer", "Status", "Due"];
const SKELETON_CELLS = ["h-3 w-24", "h-3 w-40", "h-3 w-32", "h-3 w-24", "h-5 w-24 rounded-full", "h-3 w-20"];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  // Pseudo-stage resolved on the SERVER (see FILTERABLE_STATUSES) — scheduled + in progress. The
  // dashboard's Active-jobs card links here with it, so the number there and the row count here are
  // derived from one definition and can't drift apart.
  { value: "active", label: "Active" },
  ...JOB_STAGE_OPTIONS,
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  // Ascending — the next job due, first. The office list sorts the other way (it reviews a finished
  // period); a customer is looking forward.
  { value: "due", label: "Due date" },
];

// Customer portal — Jobs. The customer's own installation / survey / maintenance work, read-only.
// Server-paged (job history grows without bound); the filters live in the URL (?q, ?status, ?sort,
// ?page) so a refresh, the back button and a pasted link all land on the same view — the same
// pattern as Projects, Sites and My Stock.
//
// A row opens a detail PAGE, not a modal. The portal's other drill-downs (a stock entry) are modals
// because there is no page to open — but a job already has one for the office and the engineer, and
// the three surfaces should not disagree about what opening a job means.
//
// Scoping is entirely server-side: /customer/jobs reads the customer id from the session cookie, so
// there is no id in this file to get wrong, and none to tamper with in the URL.
export function PortalJobs() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? "";
  const sort = searchParams.get("sort") ?? "newest";
  // The DUE date, and one of the customer's OWN sites. Both are resolved server-side against the
  // SESSION's customer — the site id is never a scope, only a narrowing within their own jobs.
  const dueFrom = searchParams.get("dueFrom") ?? "";
  const dueTo = searchParams.get("dueTo") ?? "";
  const site = searchParams.get("site") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedPortalJobs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  const [searchInput, setSearchInput] = React.useState(search);
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  // The picked site's label — a search result is not a complete set, so a selected id cannot be
  // looked up in the options afterwards.
  const [siteLabel, setSiteLabel] = React.useState<string | null>(null);
  const searchSites = React.useCallback((term: string) => jobService.searchOwnJobSites(term).then((r) => r.sites), []);

  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = false) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`/dashboard/portal/jobs?${params.toString()}`, { scroll: false });
    },
    [router],
  );

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
        const r = await jobService.getOwnJobs({
          q: search || undefined,
          status: status || undefined,
          dueFrom: dueFrom || undefined,
          dueTo: dueTo || undefined,
          site: site || undefined,
          // "newest" is the server's default; sending it would only make the URL noisier.
          sort: sort !== "newest" ? sort : undefined,
          page,
          pageSize: 20,
        });
        if (active) {
          setPaged(r);
          setMsg(null);
        }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your jobs." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [search, status, sort, dueFrom, dueTo, site, page]);

  const jobs = paged?.jobs ?? [];
  // Only what HIDES rows counts as filtering — the sort order hides nothing, so it isn't part of
  // this and isn't what Clear clears. Same rule as every other portal list.
  const filtered = !!search || !!status;

  // No header-card placeholder: this page has no header card. The top bar already names it "Jobs",
  // and a skeleton for a card that never arrives makes the page jump as it settles.
  if (loading && paged === null) {
    return (
      <div className="stack flex h-full flex-col">
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={860} fill />
      </div>
    );
  }

  return (
    <div className="stack flex h-full flex-col">
      {msg && <Notice msg={msg} />}

      {/* Toolbar — search + status + sort */}
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search job, name, reference or site…"
            aria-label="Search your jobs"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            value={status}
            onChange={(v) => patchParams({ status: v || null }, true)}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
          />
          <Select
            size="sm"
            value={sort}
            onChange={(v) => patchParams({ sort: v === "newest" ? null : v }, true)}
            options={SORT_OPTIONS}
            ariaLabel="Sort order"
          />
          {/* Sites belong to this company and can number in the thousands after an import, so this is
              a SEARCH. The endpoint behind it is session-scoped: it can only ever return their own. */}
          <SitePicker
            value={site}
            selectedLabel={siteLabel}
            search={searchSites}
            onChange={(id, option) => {
              setSiteLabel(option ? siteOptionLabel(option) : null);
              patchParams({ site: id || null }, true);
            }}
          />
          <FilterPopover
            activeCount={dueFrom || dueTo ? 1 : 0}
            onClear={() => patchParams({ dueFrom: null, dueTo: null }, true)}
          >
            <DateRangeFilter
              label="Due date"
              showLabel
              from={dueFrom}
              to={dueTo}
              onChange={({ from, to }) => patchParams({ dueFrom: from || null, dueTo: to || null }, true)}
            />
          </FilterPopover>
          {filtered && (
            <button type="button" onClick={() => patchParams({ q: null, status: null }, true)} className={toolbarBtn}>
              Clear
            </button>
          )}
          {/* Carries the CURRENT filters, like My Stock and Stock Submissions next door — this page
              was the one portal list without a download, which made the portal inconsistent about
              whether a customer can take their own data away. */}
          <ExportButton
            onExport={() =>
              // EVERY filter on the row — an export that quietly holds more than the screen it was
              // taken from gives no sign of it.
              jobService.exportOwnJobsCsv({
                q: search || undefined,
                status: status || undefined,
                dueFrom: dueFrom || undefined,
                dueTo: dueTo || undefined,
                site: site || undefined,
                sort: sort !== "newest" ? sort : undefined,
              })
            }
            disabled={jobs.length === 0}
            title="Export your jobs to CSV"
          />
        </div>
      </div>

      {msg?.type === "error" ? null : loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={860} fill />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={filtered ? "No matching jobs" : "No jobs yet"}
          hint={
            filtered
              ? "Try a different search, or clear the filters."
              : "When your account team books work for you, it'll appear here."
          }
        />
      ) : (
        <>
          <TableCard
            headers={HEADERS}
            minWidth={860}
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
              // Opens the job's detail page. Keyboard-reachable and announced as a button, so the
              // drill-down isn't mouse-only — a <tr> with an onClick is invisible to a keyboard.
              <tr
                key={j.id}
                onClick={() => router.push(`/dashboard/portal/jobs/${j.id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    router.push(`/dashboard/portal/jobs/${j.id}`);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`View details for job ${j.jobNumber}, ${j.name}`}
                className={clickableRowCls}
              >
                <td className="cell-y px-4 align-top font-mono text-xs text-[var(--muted)]">{j.jobNumber}</td>
                <td className="cell-y px-4 align-top">
                  <div className="font-semibold text-[var(--ink)]">{j.name}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                    {JOB_TYPE_LABELS[j.jobType as JobType] ?? j.jobType}
                    {/* Their own reference, right under our job number — it is how they will
                        recognise the row, and the column is theirs to search on. */}
                    {j.customerRef && <span className="ml-1.5">· Ref {j.customerRef}</span>}
                  </div>
                </td>
                <td className="cell-y px-4 align-top">
                  <div className="text-[var(--ink)]">{j.siteName ?? "—"}</div>
                  {(j.city || j.postcode) && (
                    <div className="mt-0.5 text-[11px] text-[var(--muted)]">
                      {[j.city, j.postcode].filter(Boolean).join(", ")}
                    </div>
                  )}
                </td>
                <td className="cell-y px-4 align-top text-[var(--muted)]">{j.engineerName ?? "—"}</td>
                <td className="cell-y px-4 align-top">
                  <JobStageChip value={j.stage} />
                </td>
                {/* A red date when the job is past due and still live — the same server-derived flag
                    the office and engineer lists mark, so all three agree about this customer's job.
                    No "Nd late" chip here, unlike the internal lists: the customer has the date and
                    can count, and a running total on their own job reads as an accusation rather than
                    a status. Not hiding it either — a due date shown as though nothing were wrong is
                    the version they would be right to object to. */}
                <td
                  className={`cell-y px-4 align-top ${j.overdue ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}
                  title={j.overdue ? "Past the planned completion date" : undefined}
                >
                  {j.completionDate ? fmtDate(j.completionDate) : "—"}
                </td>
              </tr>
            ))}
          </TableCard>
        </>
      )}
    </div>
  );
}
