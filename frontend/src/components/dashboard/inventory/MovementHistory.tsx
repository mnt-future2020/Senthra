"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, Search } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { useAuth } from "@/hooks/useAuth";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDate } from "./inventoryStatus";

const PAGE_SIZE = 20;

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Movement</th><th className="px-4 py-3">Item</th><th className="px-4 py-3">From</th>
            <th className="px-4 py-3">To</th><th className="px-4 py-3">Quantity</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">By</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: 7 }).map((__, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>))}
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
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
        <button onClick={() => router.push("/dashboard/inventory")} className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to inventory
        </button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Stock movements</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">Every warehouse-to-warehouse transfer, most recent first.</p>
          </div>
          {can("inventory.move") && (
            <button onClick={() => router.push("/dashboard/inventory/move")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90">
              <ArrowLeftRight className="h-4 w-4" /> Move stock
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search TRF, item or warehouse…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
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
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Movement</th><th className="px-4 py-3">Item</th><th className="px-4 py-3">From</th>
                  <th className="px-4 py-3">To</th><th className="px-4 py-3 text-right">Quantity</th><th className="px-4 py-3">Date</th><th className="px-4 py-3">By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{t.code}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[var(--ink)]">{t.itemName}</div>
                      {t.sku && <div className="text-[11px] text-[var(--faint)]">{t.sku}</div>}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{t.fromWarehouseName}{t.fromWarehouseCode ? <span className="ml-1 text-[11px] text-[var(--faint)]">({t.fromWarehouseCode})</span> : null}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{t.toWarehouseName}{t.toWarehouseCode ? <span className="ml-1 text-[11px] text-[var(--faint)]">({t.toWarehouseCode})</span> : null}</td>
                    <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{t.quantity}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{formatDate(t.movementDate)}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{t.createdBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="shrink-0">
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="movements" onPage={setPage} />
        </div>
      )}
    </div>
  );
}
