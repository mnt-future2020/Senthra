"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, ClipboardList, MoreHorizontal, PackagePlus, Pencil, Plus, Search, Trash2 } from "lucide-react";

import * as jobService from "@/services/job.service";
import { listCustomers } from "@/services/customer.service";
import { listEngineerOptions } from "@/services/warehouse.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useJobSocket } from "@/hooks/useJobSocket";
import { subscribe } from "@/lib/socket";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { JOB_STATUS_LABELS, JOB_LINE_TYPE_LABELS, JobStatusChip, GoodsStatusChip, formatDate } from "./jobStatus";
import type { Job, JobStatus } from "@/types/job";

const PAGE_SIZE = 20;

function MenuItem({ icon: Icon, danger, onClick, children }: { icon: React.ElementType; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs font-bold transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none ${danger ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {children}
    </button>
  );
}

function RowActions({ job, canEdit, canDelete, onEdit, onDelete }: { job: Job; canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    setPos(spaceBelow < 140 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
    setOpen(true);
  };
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only draft/cancelled jobs can be deleted; edit is allowed broadly (the API enforces the rule).
  const deletable = job.status === "draft" || job.status === "cancelled";
  if ((!canEdit && !(canDelete && deletable))) return null;
  return (
    <div className="flex justify-end">
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (open) close(); else openMenu(); }} className="rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" aria-label="Actions" aria-haspopup="menu" aria-expanded={open}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[55]" onClick={close} />
          <div ref={menuRef} role="menu" className="anim-fade-in fixed z-[60] w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl" style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}>
            {canEdit && <MenuItem icon={Pencil} onClick={() => { close(); onEdit(); }}>Edit job</MenuItem>}
            {canDelete && deletable && <MenuItem icon={Trash2} danger onClick={() => { close(); onDelete(); }}>Delete job</MenuItem>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function TableSkeleton({ actions }: { actions: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Job</th><th className="px-4 py-3">Name</th><th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Engineer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Goods</th><th className="px-4 py-3">Due date</th>{actions && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: actions ? 8 : 7 }).map((__, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // ── URL-derived filter state ────────────────────────────────────────────────
  const search = searchParams.get("q") ?? "";
  const statusFilter = (searchParams.get("status") ?? "all") as "all" | JobStatus;
  const customer = searchParams.get("customer") ?? "";
  const engineer = searchParams.get("engineer") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local input box; debounce-writes to ?q.
  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [refreshKey, setRefreshKey] = React.useState(0);
  const [data, setData] = React.useState(() => jobService.getCachedJobs({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<{ open: boolean; job: Job | null }>({ open: false, job: null });
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set()); // jobs whose kit list is open
  const toggleExpand = (id: string) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [deleting, setDeleting] = React.useState(false);
  const [customers, setCustomers] = React.useState<{ id: string; name: string }[]>([]);
  const [engineers, setEngineers] = React.useState<{ id: string; name: string }[]>([]);

  // ── URL patch helper ────────────────────────────────────────────────────────
  // Preserves ALL existing params so hosting pages' ?tab etc. are never clobbered.
  const patchParams = React.useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      if (resetPage) params.delete("page");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const canEdit = can("jobs.edit");
  const canDelete = can("jobs.delete");
  const showActions = canEdit || canDelete;
  // Completed / cancelled jobs + reconciled goods are frozen — no edit (matches the backend lock).
  const jobEditable = (j: Job) => j.status !== "completed" && j.status !== "cancelled" && j.goodsStatus !== "reconciled";

  // Live-refresh the list when a job is created/assigned/accepted anywhere.
  useJobSocket(React.useCallback(() => setRefreshKey((k) => k + 1), []));
  // …and when a kit request is raised/approved/declined, so the per-row "N kit req" pending badge
  // updates live (the badge count comes from listJobs). Also fires on reconnect to recover missed events.
  React.useEffect(() => subscribe(["kit_request:updated"], () => setRefreshKey((k) => k + 1)), []);

  // Debounce the search box into ?q (reset page on change).
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== search) patchParams({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patchParams]);

  React.useEffect(() => {
    let active = true;
    listCustomers({ status: "active", pageSize: 200 }).then((r) => active && setCustomers(r.customers.map((c) => ({ id: c.id, name: c.name }))), () => {});
    listEngineerOptions().then((us) => active && setEngineers(us.map((u) => ({ id: u.id, name: u.name }))), () => {});
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { search: search || undefined, status: statusFilter === "all" ? undefined : statusFilter, customer: customer || undefined, engineer: engineer || undefined, page, pageSize: PAGE_SIZE };
      const cached = jobService.getCachedJobs(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await jobService.listJobs(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load jobs.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [search, statusFilter, customer, engineer, page, refreshKey]);

  const { rows, showSkeleton, isFiltered } = React.useMemo(() => {
    const r = data?.jobs ?? [];
    return {
      rows: r,
      showSkeleton: loading && r.length === 0,
      isFiltered: statusFilter !== "all" || Boolean(search) || Boolean(customer) || Boolean(engineer),
    };
  }, [data, loading, statusFilter, search, customer, engineer]);

  const onDelete = async () => {
    if (!confirm.job) return;
    setDeleting(true);
    try {
      await jobService.deleteJob(confirm.job.id);
      setConfirm({ open: false, job: null });
      pushToast("Job removed.", "success");
      if (rows.length === 1 && page > 1) patchParams({ page: String(page - 1) }, false);
      else setRefreshKey((k) => k + 1);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Delete failed.", "alert");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Jobs</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">Create and assign installation, survey and maintenance jobs. Assigning a job notifies the engineer in real time; they accept it from their portal.</p>
      </div>

      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search job, name, customer or engineer…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <Select size="sm" value={statusFilter} onChange={(v) => patchParams({ status: v === "all" ? null : v }, true)} options={[{ value: "all", label: "All statuses" }, ...(Object.keys(JOB_STATUS_LABELS) as JobStatus[]).map((s) => ({ value: s, label: JOB_STATUS_LABELS[s] }))]} ariaLabel="Filter by status" />
        <Select size="sm" value={customer} onChange={(v) => patchParams({ customer: v || null }, true)} options={[{ value: "", label: "All customers" }, ...customers.map((c) => ({ value: c.id, label: c.name }))]} ariaLabel="Filter by customer" />
        <Select size="sm" value={engineer} onChange={(v) => patchParams({ engineer: v || null }, true)} options={[{ value: "", label: "All engineers" }, ...engineers.map((u) => ({ value: u.id, label: u.name }))]} ariaLabel="Filter by engineer" />
        {can("jobs.create") && (
          <button onClick={() => router.push("/dashboard/jobs/new")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90 lg:ml-auto">
            <Plus className="h-4 w-4" /> New job
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <TableSkeleton actions={showActions} />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ClipboardList className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No jobs match" : "No jobs yet"}</p>
            {!isFiltered && can("jobs.create") && (
              <button onClick={() => router.push("/dashboard/jobs/new")} className="mt-1 text-xs font-bold text-[var(--accent)] hover:opacity-80">Create your first job</button>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Job</th><th className="px-4 py-3">Name</th><th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Engineer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Goods</th><th className="px-4 py-3">Due date</th>{showActions && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => {
                  const hasKit = (job.kitLines?.length ?? 0) > 0;
                  const isOpen = expanded.has(job.id);
                  const cols = 7 + (showActions ? 1 : 0);
                  return (
                  <React.Fragment key={job.id}>
                  <tr onClick={() => router.push(`/dashboard/jobs/${job.jobNumber}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {hasKit ? (
                          <button onClick={(e) => { e.stopPropagation(); toggleExpand(job.id); }} className="shrink-0 rounded p-0.5 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]" aria-label={isOpen ? "Hide kit list" : "Show kit list"} aria-expanded={isOpen}>
                            <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                          </button>
                        ) : <span className="inline-block w-5 shrink-0" />}
                        <span className="font-mono text-xs text-[var(--muted)]">{job.jobNumber}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate">{job.name}</span>
                        {(job.pendingKitRequestCount ?? 0) > 0 && (
                          <span
                            title={`${job.pendingKitRequestCount} pending kit request${job.pendingKitRequestCount > 1 ? "s" : ""} — open the job to review`}
                            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-amber-600"
                          >
                            <PackagePlus className="h-3 w-3" /> {job.pendingKitRequestCount} kit req
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{job.customerName ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{job.assignedEngineerName ?? "—"}</td>
                    <td className="px-4 py-3"><JobStatusChip status={job.status} /></td>
                    <td className="px-4 py-3">{hasKit ? <GoodsStatusChip status={job.goodsStatus} /> : <span className="text-[var(--faint)]">—</span>}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(job.completionDate)}</td>
                    {showActions && (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <RowActions job={job} canEdit={canEdit && jobEditable(job)} canDelete={canDelete} onEdit={() => router.push(`/dashboard/jobs/${job.jobNumber}/edit`)} onDelete={() => setConfirm({ open: true, job })} />
                      </td>
                    )}
                  </tr>
                  {isOpen && hasKit && (
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]/40">
                      <td colSpan={cols} className="px-4 pb-4 pt-1">
                        {/* What this engineer will come and collect — so the warehouse can prepare. */}
                        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-[var(--border)] text-[10px] font-bold uppercase tracking-wider text-[var(--faint)]">
                                <th className="px-3 py-2">Source</th><th className="px-3 py-2">Item</th><th className="px-3 py-2">Warehouse</th><th className="px-3 py-2 text-right">Planned</th>
                              </tr>
                            </thead>
                            <tbody>
                              {job.kitLines.map((l) => (
                                <tr key={l.id} className="border-b border-[var(--border)] last:border-0">
                                  <td className="px-3 py-2 text-[var(--muted)]">{JOB_LINE_TYPE_LABELS[l.lineType]}</td>
                                  <td className="px-3 py-2 font-semibold text-[var(--ink)]">{l.itemName}</td>
                                  <td className="px-3 py-2 text-[var(--muted)]">{l.warehouseName ?? (l.lineType === "misc" ? "—" : "—")}</td>
                                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--ink)]">{l.qty}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="shrink-0">
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="jobs" onPage={(p) => patchParams({ page: p > 1 ? String(p) : null }, false)} />
        </div>
      )}

      <ConfirmDialog open={confirm.open} title="Remove job?" message={<>This deletes job <strong className="text-[var(--ink)]">{confirm.job?.jobNumber}</strong>. Only draft or cancelled jobs can be deleted.</>} confirmLabel="Remove" danger busy={deleting} onConfirm={onDelete} onClose={() => setConfirm({ open: false, job: null })} />
    </div>
  );
}
