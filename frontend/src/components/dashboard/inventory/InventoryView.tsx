"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Boxes, Download, Loader2, Search } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmCategories } from "@/services/irm-category.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { INVENTORY_STATUS_LABELS, InventoryStatusBadge, formatDate, formatMoney } from "./inventoryStatus";
import type { InventoryStatus } from "@/types/inventory";

const PAGE_SIZE = 20;
const selectCls = "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] outline-none focus:border-[var(--accent)]";

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Item</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Warehouse</th>
            <th className="px-4 py-3">Category</th><th className="px-4 py-3">On hand</th><th className="px-4 py-3">Reserved</th>
            <th className="px-4 py-3">Available</th><th className="px-4 py-3">Value</th><th className="px-4 py-3">Last movement</th><th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {Array.from({ length: 10 }).map((__, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-16" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InventoryView() {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [warehouse, setWarehouse] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [status, setStatus] = React.useState<"" | InventoryStatus>("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(() => inventoryService.getCachedInventory({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>([]);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Filter option lists (active warehouses + IRM categories), loaded once.
  React.useEffect(() => {
    let active = true;
    listWarehouses({ status: "active", pageSize: 100 }).then((r) => active && setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))), () => {});
    listIrmCategories().then((cs) => active && setCategories(cs.map((c) => ({ id: c.id, name: c.name }))), () => {});
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    let active = true;
    (async () => {
      const params = { search: debounced || undefined, warehouse: warehouse || undefined, category: category || undefined, status: status || undefined, page, pageSize: PAGE_SIZE };
      const cached = inventoryService.getCachedInventory(params);
      if (active && cached) setData(cached);
      setLoading(true);
      try {
        const res = await inventoryService.listInventory(params);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load inventory.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [debounced, warehouse, category, status, page]);

  const rows = data?.inventory ?? [];
  const showSkeleton = loading && rows.length === 0;
  const isFiltered = Boolean(debounced) || Boolean(warehouse) || Boolean(category) || Boolean(status);

  const onExport = async () => {
    setExporting(true);
    try {
      const { capped } = await inventoryService.exportInventoryCsv({ search: debounced || undefined, warehouse: warehouse || undefined, category: category || undefined, status: status || undefined });
      pushToast(capped ? "Export ready (truncated to the first 50,000 rows)." : "Inventory exported.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Export failed.", "alert");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="shrink-0 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
        <h2 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">Warehouse Inventory</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">Live on-hand stock per item and warehouse. Move stock between warehouses or open a record for its full movement history.</p>
      </div>

      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search item or SKU…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        <select value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setPage(1); }} className={selectCls} aria-label="Filter by warehouse">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name} ({w.code})</option>))}
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={selectCls} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value as "" | InventoryStatus); setPage(1); }} className={selectCls} aria-label="Filter by stock status">
          <option value="">All statuses</option>
          {(Object.keys(INVENTORY_STATUS_LABELS) as InventoryStatus[]).map((s) => (<option key={s} value={s}>{INVENTORY_STATUS_LABELS[s]}</option>))}
        </select>
        <div className="flex items-center gap-2 lg:ml-auto">
          {can("inventory.export") && (
            <button onClick={onExport} disabled={exporting || rows.length === 0} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60" title="Export the filtered list to CSV">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export CSV
            </button>
          )}
          {can("inventory.move") && (
            <button onClick={() => router.push("/dashboard/inventory/move")} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90">
              <ArrowLeftRight className="h-4 w-4" /> Move stock
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {showSkeleton ? (
          <TableSkeleton />
        ) : error ? (
          <p className="py-16 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Boxes className="h-7 w-7 text-[var(--faint)]" />
            <p className="text-sm font-semibold text-[var(--ink)]">{isFiltered ? "No inventory matches" : "No inventory yet"}</p>
            {!isFiltered && <p className="text-xs text-[var(--muted)]">Stock appears here once a goods receipt is completed.</p>}
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[1040px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-4 py-3">Item</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Warehouse</th>
                    <th className="px-4 py-3">Category</th><th className="px-4 py-3 text-right">On hand</th><th className="px-4 py-3 text-right">Reserved</th>
                    <th className="px-4 py-3 text-right">Available</th><th className="px-4 py-3 text-right">Value</th><th className="px-4 py-3">Last movement</th><th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => router.push(`/dashboard/inventory/${r.id}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[var(--ink)]">{r.itemName}</div>
                        <div className="font-mono text-[11px] text-[var(--faint)]">{r.itemCode}</div>
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.sku ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.warehouseName}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.categoryName ?? "—"}</td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{r.onHand}{r.baseUnit ? <span className="ml-1 text-[11px] font-normal text-[var(--faint)]">{r.baseUnit}</span> : null}</td>
                      <td className="px-4 py-3 text-right text-[var(--muted)]">{r.reserved}</td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{r.available}</td>
                      <td className="px-4 py-3 text-right text-[var(--muted)]">{formatMoney(r.value, r.currency)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{formatDate(r.lastMovementAt)}</td>
                      <td className="px-4 py-3"><InventoryStatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && (
              <div className="flex shrink-0 flex-wrap justify-end gap-x-8 gap-y-1 border-t border-[var(--border)] p-4 text-sm">
                <span className="text-[var(--muted)]">Total stock value (this view) <strong className="text-[var(--ink)]">{formatMoney(data.totalValue)}</strong></span>
              </div>
            )}
          </>
        )}
      </div>

      {data && data.total > 0 && (
        <div className="shrink-0">
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="records" onPage={setPage} />
        </div>
      )}
    </div>
  );
}
