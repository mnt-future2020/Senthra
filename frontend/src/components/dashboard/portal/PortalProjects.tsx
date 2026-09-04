"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderKanban, Search } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { compactListToolbarCls, toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import type { PagedCustomerProjects } from "@/services/customer.service";
import type { Msg } from "@/components/ui/types";

import {
  EmptyState,
  fmtDate,
  StatusChip,
  TableCard,
  TableCardSkeleton,
} from "./portalUi";

const HEADERS = ["Code", "Project", "Type", "Start", "End", "Status"];
const SKELETON_CELLS = ["h-3 w-16", "h-3 w-40", "h-3 w-20", "h-3 w-20", "h-3 w-20", "h-5 w-20 rounded-full"];

// Customer portal — Projects (read-only). Server-paged with a search box; filters live in the URL
// (?q, ?sort, ?page) so they survive a refresh — the same pattern as every other list.
export function PortalProjects() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const sortOldest = searchParams.get("sort") === "oldest"; // default: newest first
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedCustomerProjects | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  const [searchInput, setSearchInput] = React.useState(search);
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
      router.replace(`/dashboard/portal/projects?${params.toString()}`, { scroll: false });
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
        const r = await customerService.getOwnProjects({
          q: search || undefined,
          sort: sortOldest ? "oldest" : undefined,
          page,
          pageSize: 20,
        });
        if (active) {
          setPaged(r);
          setMsg(null);
        }
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your projects." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [search, sortOldest, page]);

  const projects = paged?.projects ?? [];
  const filtered = !!search;

  if (loading && paged === null) {
    return (
      <div className="stack flex h-full flex-col">
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={680} fill />
      </div>
    );
  }

  return (
    <div className="stack flex h-full flex-col">
      {msg && <Notice msg={msg} />}

      {/* Toolbar — search + sort */}
      <div className={compactListToolbarCls}>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name or code…"
            aria-label="Search your projects"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          {/* Clears the SEARCH, not the sort — same rule as every other portal list: Clear undoes
              what is HIDING rows, and a sort order hides nothing. That's also why it appears only
              when there's a search: a Clear button next to an unfiltered list does nothing. */}
          {filtered && (
            <button type="button" onClick={() => patchParams({ q: null }, true)} className={toolbarBtn}>
              Clear
            </button>
          )}
        </div>
      </div>

      {msg?.type === "error" ? null : loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={680} fill />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={filtered ? "No matching projects" : "No projects yet"}
          hint={filtered ? "Try a different search." : "When your account team sets up a project, it'll appear here."}
        />
      ) : (
        <>
          <TableCard
            headers={HEADERS}
            minWidth={680}
            fill
            footer={
              <Pagination
                embedded
                page={paged?.page ?? 1}
                totalPages={paged?.totalPages ?? 1}
                total={paged?.total ?? 0}
                label="projects"
                onPage={(p) => patchParams({ page: p > 1 ? String(p) : null })}
              />
            }
          >
            {projects.map((p) => (
              <tr key={p.id} className="border-b border-[var(--border)] align-top last:border-0">
                <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{p.code ?? "—"}</td>
                <td className="cell-y px-4">
                  <div className="font-semibold text-[var(--ink)]">{p.name}</div>
                  {p.description && (
                    <div className="mt-0.5 max-w-md text-[11px] text-[var(--muted)]">
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="cell-y px-4 text-[var(--muted)]">{p.type ?? "—"}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{fmtDate(p.startDate)}</td>
                <td className="cell-y px-4 text-[var(--muted)]">{fmtDate(p.endDate)}</td>
                <td className="cell-y px-4">
                  <StatusChip value={p.status} />
                </td>
              </tr>
            ))}
          </TableCard>
        </>
      )}
    </div>
  );
}
