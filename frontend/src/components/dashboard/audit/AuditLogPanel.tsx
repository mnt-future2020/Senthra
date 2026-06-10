"use client";

import * as React from "react";
import { Download, ScrollText, Search } from "lucide-react";

import * as auditService from "@/services/audit.service";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import type { AuditEntry, AuditFacets, PagedAuditLogs } from "@/types/audit";
import { AuditEntryDrawer } from "./AuditEntryDrawer";
import {
  actionLabel,
  actionTone,
  TONE_CLASSES,
  relativeTime,
  absoluteTime,
  humanizeType,
} from "./auditDisplay";

const PAGE_SIZE = 25;

const EMPTY_FACETS: AuditFacets = { actions: [], actorTypes: [], targetTypes: [] };

const selectCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]";

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>
              <td className="px-4 py-3"><Skeleton className="h-5 w-40 rounded-full" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-32" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-28" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditLogPanel() {
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [action, setAction] = React.useState("");
  const [actorType, setActorType] = React.useState("");
  const [targetType, setTargetType] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [page, setPage] = React.useState(1);

  const [facets, setFacets] = React.useState<AuditFacets>(EMPTY_FACETS);
  const [data, setData] = React.useState<PagedAuditLogs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<AuditEntry | null>(null);
  const [exporting, setExporting] = React.useState(false);

  // Debounce the search box.
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load the distinct filter values once (actions / actor types / target types).
  React.useEffect(() => {
    auditService.listAuditFacets().then(setFacets).catch(() => setFacets(EMPTY_FACETS));
  }, []);

  const filters = React.useMemo(
    () => ({
      search: debounced || undefined,
      action: action || undefined,
      actorType: actorType || undefined,
      targetType: targetType || undefined,
      from: from || undefined,
      to: to || undefined,
    }),
    [debounced, action, actorType, targetType, from, to],
  );

  // Re-fetch on any query change.
  React.useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await auditService.listAuditLogs({ ...filters, page, pageSize: PAGE_SIZE });
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load the audit log.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [filters, page]);

  const entries = data?.entries ?? [];
  const showSkeleton = loading && entries.length === 0;
  const isFiltered = Boolean(debounced || action || actorType || targetType || from || to);
  const total = data?.total ?? 0;

  const clearFilters = () => {
    setSearch("");
    setDebounced("");
    setAction("");
    setActorType("");
    setTargetType("");
    setFrom("");
    setTo("");
    setPage(1);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const { capped } = await auditService.exportAuditCsv(filters);
      pushToast(
        capped
          ? "Exported the first 50,000 rows — narrow the filters for a smaller export."
          : "Audit log exported.",
        capped ? "alert" : "success",
      );
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Export failed.", "alert");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header + export */}
      <div
        className="flex flex-col gap-3 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Audit Log</h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Every change made in the system, newest first.
          </p>
        </div>
        <button
          onClick={doExport}
          disabled={exporting || total === 0}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-xs font-extrabold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:items-center lg:flex-wrap">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search actor, target or action…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>
        <select
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          className={selectCls}
          title="Action"
        >
          <option value="">All actions</option>
          {facets.actions.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
        <select
          value={targetType}
          onChange={(e) => {
            setTargetType(e.target.value);
            setPage(1);
          }}
          className={selectCls}
          title="Type"
        >
          <option value="">All types</option>
          {facets.targetTypes.map((t) => (
            <option key={t} value={t}>
              {humanizeType(t)}
            </option>
          ))}
        </select>
        <select
          value={actorType}
          onChange={(e) => {
            setActorType(e.target.value);
            setPage(1);
          }}
          className={selectCls}
          title="Actor type"
        >
          <option value="">All actors</option>
          {facets.actorTypes.map((t) => (
            <option key={t} value={t}>
              {humanizeType(t)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className={selectCls}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--muted)]">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className={selectCls}
          />
        </label>
        {isFiltered && (
          <button
            onClick={clearFilters}
            className="text-xs font-bold text-[var(--accent)] hover:opacity-80 lg:ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <TableSkeleton />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ScrollText className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">
              {isFiltered ? "No entries match these filters" : "No audit entries yet"}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e)}
                    className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 text-[var(--muted)]" title={absoluteTime(e.createdAt)}>
                      {relativeTime(e.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}
                      >
                        {actionLabel(e.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[var(--ink)]">{e.actorEmail ?? "—"}</span>
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-[var(--faint)]">
                        {e.actorType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {e.targetType ? (
                        <>
                          <span className="font-semibold text-[var(--ink)]">{e.targetType}</span>
                          {e.targetLabel ? `: ${e.targetLabel}` : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          label="entries"
          onPage={setPage}
        />
      )}

      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
