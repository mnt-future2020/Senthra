"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, Search } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { useAuth } from "@/hooks/useAuth";
import { toolbarActionsCls, toolbarPrimaryBtn } from "@/components/ui/styles";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate } from "./inventoryStatus";

import { CELL_ONE_LINE, colClass, colClassAt, tableMinWidth, type ColPriority } from "@/components/ui/tableLayout";

const PAGE_SIZE = 20;

// Movement · Item · From · To · Quantity · Date · By.
// Locations and item names are the long values, and `min-w-[860px]` across seven columns left them
// ~123px each.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "wide", "normal", "normal", "narrow", "normal", "normal"]);

// One array drives BOTH rows below, which is the rule colClass exists to enforce: a placeholder cell
// that stays visible while its header is hidden shifts every cell after it.
const SKELETON_COLS: ColPriority[] = ["always", "always", "always", "always", "always", "always", "lg"];

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="cell-y px-4">Movement</th><th className="cell-y px-4">Item</th><th className="cell-y px-4">From</th>
            <th className="cell-y px-4">To</th><th className="cell-y px-4">Quantity</th><th className="cell-y px-4">Date</th><th className={`cell-y px-4 ${colClass("lg")}`}>By</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: 7 }).map((__, j) => (<td key={j} className={`cell-y px-4 ${colClassAt(SKELETON_COLS, j)}`}><Skeleton className="h-3 w-16" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MovementHistory() {
  const router = useRouter();
  const { can } = useAuth();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<inventoryService.PagedTransfers | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  React.useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const res = await inventoryService.listTransfers({ search: debounced || undefined, page, pageSize: PAGE_SIZE });
        if (active) { setData(res); setError(null); }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load movement history.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [debounced, page]);

  const rows = data?.transfers ?? [];
  const showSkeleton = loading && rows.length === 0;
  const isFiltered = Boolean(debounced);

  return (
    <div className="stack flex h-full flex-col">
      <button onClick={() => router.push("/dashboard/inventory")} className="flex items-center gap-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to inventory
      </button>
      <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search TRF, item or warehouse…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>

        {/* The page's action, at the right-hand end of the search row rather than in the top bar —
            up there it sat against the browser's own chrome, a screen's width from the list. The row
            gains `sm:flex-row` for this; it held only the search box before. */}
        {can("inventory.move") && (
          <div className={`${toolbarActionsCls} sm:ml-auto`}>
            <button onClick={() => router.push("/dashboard/inventory/move")} className={toolbarPrimaryBtn}>
              <ArrowLeftRight className="h-3.5 w-3.5" /> Move stock
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <TableSkeleton />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center p-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center">
            <ArrowLeftRight className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No movements match" : "No stock movements yet"}</p>
          </div>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`}>
            <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Movement</th><th className="cell-y px-4">Item</th><th className="cell-y px-4">From</th>
                  <th className="cell-y px-4">To</th><th className="cell-y px-4 text-right">Quantity</th><th className="cell-y px-4">Date</th><th className={`cell-y px-4 ${colClass("lg")}`}>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{t.code}</td>
                    <td className="cell-y px-4">
                      <div className="font-semibold text-[var(--ink)]">{t.itemName}</div>
                      {t.sku && <div className="text-[11px] text-[var(--faint)]">{t.sku}</div>}
                    </td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={t.fromWarehouseName ?? undefined}>{t.fromWarehouseName}{t.fromWarehouseCode ? <span className="ml-1 text-[11px] text-[var(--faint)]">({t.fromWarehouseCode})</span> : null}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={t.toWarehouseName ?? undefined}>{t.toWarehouseName}{t.toWarehouseCode ? <span className="ml-1 text-[11px] text-[var(--faint)]">({t.toWarehouseCode})</span> : null}</td>
                    <td className="cell-y px-4 text-right font-semibold text-[var(--ink)]">{t.quantity}</td>
                    <td className="cell-y px-4 text-[var(--muted)]">{formatDate(t.movementDate)}</td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")}`}>{t.createdBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
            <Pagination embedded page={data.page} totalPages={data.totalPages} total={data.total} label="movements" onPage={setPage} />
        )}
      </div>
    </div>
  );
}
