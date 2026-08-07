"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, Boxes, Download, Loader2, PackagePlus, Search } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { listWarehouses, type PagedWarehouses } from "@/services/warehouse.service";
import { listIrmCategories } from "@/services/irm-category.service";
import type { IrmCategory } from "@/types/irm-category";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useReferenceData } from "@/hooks/useReferenceData";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { ghostBtn } from "@/components/ui/styles";
import { ReportDamageModal, type ReportDamageTarget } from "@/components/dashboard/goods-management/ReportDamageModal";
import { INVENTORY_STATUS_LABELS, InventoryStatusBadge, formatDate, formatMoney } from "./inventoryStatus";
import type { InventoryStatus } from "@/types/inventory";
import { CopyableCode } from "@/components/ui/CopyableCode";

const PAGE_SIZE = 20;

function TableSkeleton() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Item</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Warehouse</th>
            <th className="px-4 py-3">Category</th><th className="px-4 py-3">On hand</th><th className="px-4 py-3">Planned</th>
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

// `warehouseId` locks the view to one warehouse (hides the warehouse filter/column) and
// `embedded` tightens the layout for a host that supplies its own framing — used when this is
// rendered inside the Warehouse detail "IRM stock" tab. No props = the global inventory page.
export function InventoryView({ warehouseId, embedded }: { warehouseId?: string; embedded?: boolean } = {}) {
  const router = useRouter();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [warehouse, setWarehouse] = React.useState(warehouseId ?? "");
  const [category, setCategory] = React.useState("");
  const [status, setStatus] = React.useState<"" | InventoryStatus>("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(() => inventoryService.getCachedInventory({ pageSize: PAGE_SIZE }));
  const [loading, setLoading] = React.useState(!data);
  const [error, setError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [warehouses, setWarehouses] = React.useState<{ id: string; name: string; code: string }[]>([]);
  const [categories, setCategories] = React.useState<{ id: string; name: string }[]>([]);
  // "Report damage" — the row whose modal is open, plus a counter that forces a refetch once the
  // report lands (on-hand and available both drop).
  const [damageTarget, setDamageTarget] = React.useState<ReportDamageTarget | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  // Damage is reported from the warehouse you're looking at — `warehouseId` is set only when this is
  // embedded in a Warehouse detail page, and absent in the Inventory Hub, where this table spans
  // every warehouse. Reporting a physical event (a crushed box, with a photo) off a cross-warehouse
  // list is the wrong place for it, and a second entry point is a second set of guards to keep in
  // step — the customer-stock equivalent had already drifted (`quantity` vs `available`, and only one
  // of them checking the entry's status) within an hour of existing.
  const canReportDamage = can("inventory.adjust") && Boolean(warehouseId);

  // Keep the warehouse filter in sync when this component is reused for a DIFFERENT warehouse via
  // client-side navigation (e.g. moving between Warehouse detail pages without unmounting). The
  // `warehouse` state is seeded from the prop only at mount, so without this the previous
  // warehouse's inventory would render under the new warehouse's header. Adjusting state during
  // render (the React-recommended pattern for "reset state when a prop changes") avoids an extra
  // commit and a cascading-render lint error.
  const [prevWarehouseId, setPrevWarehouseId] = React.useState(warehouseId);
  if (warehouseId !== prevWarehouseId) {
    setPrevWarehouseId(warehouseId);
    setWarehouse(warehouseId ?? "");
    setPage(1);
  }

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Filter option lists (active warehouses + IRM categories), loaded once.
  useReferenceData(
    [
      // Warehouse filter is hidden when locked to one warehouse, so skip that fetch.
      ...(warehouseId
        ? []
        : [{ label: "warehouses", load: () => listWarehouses({ status: "active", pageSize: 100 }), onData: (r: PagedWarehouses) => setWarehouses(r.warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code }))) }]),
      { label: "categories", load: () => listIrmCategories(), onData: (cs: IrmCategory[]) => setCategories(cs.map((c) => ({ id: c.id, name: c.name }))) },
    ],
    [warehouseId],
  );

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
  }, [debounced, warehouse, category, status, page, reloadKey]);

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
    // Always the dashboard's INLINE-SCROLL contract (bounded parent → card takes the remaining
    // height, only the table body scrolls, sticky header row) — the same one StockPositionTable and
    // DamagedStockView use. `embedded` used to switch this off and let the host scroll the whole
    // component, which meant the search box and the warehouse/category/status filters scrolled away
    // with the rows: you'd lose the controls exactly when a long list makes you want them.
    <div className={`flex h-full flex-col ${embedded ? "gap-4" : "gap-5"}`}>
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative w-full lg:min-w-64 lg:max-w-xs lg:flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search item or SKU…" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]" />
        </div>
        {!warehouseId && (
          <Select size="sm" value={warehouse} onChange={(v) => { setWarehouse(v); setPage(1); }} options={[{ value: "", label: "All warehouses" }, ...warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))]} ariaLabel="Filter by warehouse" />
        )}
        <Select size="sm" value={category} onChange={(v) => { setCategory(v); setPage(1); }} options={[{ value: "", label: "All categories" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} ariaLabel="Filter by category" />
        <Select size="sm" value={status} onChange={(v) => { setStatus(v as "" | InventoryStatus); setPage(1); }} options={[{ value: "", label: "All statuses" }, ...(Object.keys(INVENTORY_STATUS_LABELS) as InventoryStatus[]).map((s) => ({ value: s, label: INVENTORY_STATUS_LABELS[s] }))]} ariaLabel="Filter by stock status" />
        {/* The three action labels collapse to icons below `xl`. At 1024px — a common laptop width,
            and the one this row visibly broke at — search + three selects + three labelled buttons
            don't fit, so the row wrapped to two lines and stole ~50px of table height permanently
            (this panel is full-height, so nothing scrolls that cost away). Each button keeps its
            `title` and gains an `aria-label`, so the icon-only state is still announced and hoverable
            rather than a bare glyph. */}
        <div className="flex items-center gap-2 lg:ml-auto">
          {can("inventory.export") && (
            <button onClick={onExport} disabled={exporting || rows.length === 0} aria-label="Export CSV" className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60" title="Export the filtered list to CSV">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} <span className="hidden xl:inline">Export CSV</span>
            </button>
          )}
          {can("inventory.adjust") && (
            <button aria-label="Add Stock" onClick={() => router.push(`/dashboard/inventory/add-stock${warehouseId ? `?warehouse=${warehouseId}` : ""}`)} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]" title="Add existing / opening stock into a warehouse">
              <PackagePlus className="h-4 w-4" /> <span className="hidden xl:inline">Add Stock</span>
            </button>
          )}
          {can("inventory.move") && (
            <button onClick={() => router.push("/dashboard/inventory/move")} aria-label="Move stock" title="Move stock between warehouses" className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90">
              <ArrowLeftRight className="h-4 w-4" /> <span className="hidden xl:inline">Move stock</span>
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
            {/* `relative` contains the "Actions" header's sr-only span: Tailwind's sr-only is
                position:absolute, so with no positioned ancestor it resolves against the initial
                containing block, escapes this scroll container at the table's full 1040px and drags
                the whole page into a horizontal scroll. See vanRequestUi.tsx. */}
            <div className="relative min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[1040px] text-left text-sm">
                {/* Sticky so the column headings stay readable once the body scrolls — the same
                    treatment StockPositionTable gives its header. */}
                <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                  <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                    <th className="px-4 py-3">Item</th><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Warehouse</th>
                    <th className="px-4 py-3">Category</th><th className="px-4 py-3 text-right">On hand</th><th className="px-4 py-3 text-right" title="Unissued quantity on active jobs' kit lines here">Planned</th>
                    <th className="px-4 py-3 text-right">Available</th><th className="px-4 py-3 text-right">Value</th><th className="px-4 py-3">Last movement</th><th className="px-4 py-3">Status</th>
                    {canReportDamage && <th className="px-4 py-3"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => router.push(`/dashboard/inventory/${r.id}`)} className="cursor-pointer border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[var(--ink)]">{r.itemName}</div>
                        {/* The CODE is the copy target here, not the name: this row navigates to the
                            item on click, so a copy button on the name would swallow the navigation
                            everyone already expects. CopyableCode stops propagation, so copying the
                            code doesn't open the item either. */}
                        <CopyableCode code={r.itemCode} className="text-[11px] text-[var(--faint)]" />
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.sku ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.warehouseName}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{r.categoryName ?? "—"}</td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{r.onHand}{r.baseUnit ? <span className="ml-1 text-[11px] font-normal text-[var(--faint)]">{r.baseUnit}</span> : null}</td>
                      {/* The DB `reserved` field is permanently 0 (schema: "FUTURE"), so a column bound to it
                        always read 0 while real commitments sat on the Demand board — two screens
                        disagreeing about one item. This shows the commitment that actually exists. */}
                      <td className="px-4 py-3 text-right text-[var(--muted)]">{r.plannedDemand}</td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{r.available}</td>
                      <td className="px-4 py-3 text-right text-[var(--muted)]">{formatMoney(r.value, r.currency)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{formatDate(r.lastMovementAt)}</td>
                      <td className="px-4 py-3"><InventoryStatusBadge status={r.status} /></td>
                      {canReportDamage && (
                        <td className="px-4 py-3">
                          <div className="flex justify-end">
                            <button
                              type="button"
                              // The whole ROW navigates to the item detail — without this the click
                              // would open the modal and then immediately route away from it.
                              onClick={(e) => {
                                e.stopPropagation();
                                setDamageTarget({
                                  warehouseId: r.warehouseId,
                                  ownerType: "company",
                                  irmItemId: r.irmItemId,
                                  customerStockEntryId: null,
                                  itemName: r.itemName,
                                  available: r.available,
                                });
                              }}
                              // Nothing to damage at zero on-hand, and the server would reject it.
                              disabled={r.available <= 0}
                              className={ghostBtn}
                              aria-label={`Report damage on ${r.itemName}`}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Damage
                            </button>
                          </div>
                        </td>
                      )}
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

      <ReportDamageModal
        target={damageTarget}
        onClose={() => setDamageTarget(null)}
        onReported={() => {
          // On-hand and available both dropped. Clear this module's stale-while-revalidate cache
          // (the mutation lives in goodsManagement.service and can't reach it) before refetching,
          // or the next render would serve the pre-damage figures straight back.
          inventoryService.clearInventoryListCache();
          setReloadKey((k) => k + 1);
        }}
      />
    </div>
  );
}
