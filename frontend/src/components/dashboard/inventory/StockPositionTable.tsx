"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, Download, Loader2, Search } from "lucide-react";

import * as svc from "@/services/stockPosition.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listIrmCategories } from "@/services/irm-category.service";
import { listCustomers } from "@/services/customer.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import type { PagedPositions, StockPosition } from "@/types/stock-position";
import { OwnerTag, PositionStatusBadge, TableSkeletonRows } from "./hubUi";
import { formatDate } from "./inventoryStatus";

type Col =
  | "item"
  | "sku"
  | "ownership"
  | "location"
  | "customer"
  | "engineer"
  | "warehouse"
  | "qty"
  | "available"
  | "value"
  | "status"
  | "lastMovement";

const COL_LABELS: Record<Col, string> = {
  item: "Item",
  sku: "SKU",
  ownership: "Owner",
  location: "Location",
  customer: "Customer",
  engineer: "Engineer",
  warehouse: "Warehouse",
  qty: "Qty",
  available: "Available",
  value: "Value",
  status: "Status",
  lastMovement: "Last movement",
};

const RIGHT: Set<Col> = new Set(["qty", "available", "value"]);

const OWNERSHIP_OPTIONS = [
  { value: "", label: "All owners" },
  { value: "company", label: "Company (IRM)" },
  { value: "customer", label: "Customer" },
];

const LOCATION_OPTIONS = [
  { value: "", label: "All locations" },
  { value: "warehouse", label: "Warehouse" },
  { value: "engineer", label: "Engineer" },
  { value: "damaged", label: "Damaged" },
];

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "in_stock", label: "In stock" },
  { value: "low_stock", label: "Low stock" },
  { value: "out_of_stock", label: "Out of stock" },
  { value: "on_van", label: "On van" },
  { value: "damaged", label: "Damaged" },
  { value: "overdue", label: "Overdue" },
];

type FilterKey = "owner" | "location" | "warehouse" | "category" | "status" | "customer";

interface StockPositionTableProps {
  columns: Col[];
  fixedFilters?: svc.PositionParams;
  /** Which optional filter controls to show in the filter bar. */
  filters?: FilterKey[];
  /** Whether to show the Export CSV button (gated by inventory.export permission). */
  exportable?: boolean;
  /** Empty-state copy tuned per lens. */
  emptyText?: string;
  /** Optional per-row action rendered as a trailing cell. */
  rowAction?: (row: StockPosition) => React.ReactNode;
}

function cellValue(r: StockPosition, c: Col): React.ReactNode {
  switch (c) {
    case "item":
      return (
        <div className="min-w-0">
          <div className="truncate font-semibold text-[var(--ink)]">{r.itemName}</div>
          {r.itemCode ? (
            <div className="font-mono text-[11px] text-[var(--faint)]">{r.itemCode}</div>
          ) : null}
        </div>
      );
    case "sku":
      return <span className="text-[var(--muted)]">{r.sku ?? "—"}</span>;
    case "ownership":
      return <OwnerTag ownership={r.ownership} />;
    case "location":
      return <span className="text-[var(--muted)]">{r.locationLabel}</span>;
    case "customer":
      return <span className="text-[var(--muted)]">{r.customerName ?? "—"}</span>;
    case "engineer":
      return (
        <span className="text-[var(--muted)]">
          {r.locationType === "engineer" ? r.locationLabel.replace(/^Eng:\s*/, "") : "—"}
        </span>
      );
    case "warehouse":
      return (
        <span className="text-[var(--muted)]">
          {r.locationType === "warehouse" || r.locationType === "damaged" ? r.locationLabel : "—"}
        </span>
      );
    case "qty":
      return <span className="font-semibold text-[var(--ink)]">{r.quantity.toLocaleString()}</span>;
    case "available":
      return <span className="font-semibold text-[var(--ink)]">{r.available.toLocaleString()}</span>;
    case "value":
      return (
        <span className="text-[var(--muted)]">
          {r.value == null ? "—" : `£${r.value.toLocaleString()}`}
        </span>
      );
    case "status":
      return <PositionStatusBadge status={r.status} />;
    case "lastMovement":
      return (
        <span className="text-[var(--muted)]">{formatDate(r.lastMovementAt)}</span>
      );
    default:
      return null;
  }
}

/** Compute a row-level navigation href if applicable; otherwise null (row stays non-clickable). */
function rowHref(r: StockPosition): string | null {
  // Company row with an inventory balance — links to the inventory balance detail.
  if (r.inventoryBalanceId) return `/dashboard/inventory/${r.inventoryBalanceId}`;
  // Customer stock held at a warehouse — links to the customer stock entry detail.
  if (r.itemKind === "customer_stock" && r.locationType === "warehouse") {
    return `/dashboard/stock-entries/${r.itemId}`;
  }
  return null;
}

export function StockPositionTable({
  columns,
  fixedFilters = {},
  filters = [],
  exportable = false,
  emptyText = "No stock in this view.",
  rowAction,
}: StockPositionTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  // Filters derived from URL params — survive refresh.
  const ownerFilter = searchParams.get("owner") ?? "";
  const locationFilter = searchParams.get("location") ?? "";
  const warehouseFilter = searchParams.get("warehouse") ?? "";
  const categoryFilter = searchParams.get("category") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const customerFilter = searchParams.get("customer") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  // Local immediate value for the search box; debounced writes to ?q.
  const [searchInput, setSearchInput] = React.useState(searchParams.get("q") ?? "");

  const [data, setData] = React.useState<PagedPositions | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [exporting, setExporting] = React.useState(false);

  // Patch URL params, preserving the lens (?tab) and all other params. filter changes reset to page 1.
  const patch = React.useCallback((updates: Record<string, string | null>, resetPage = true) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) { if (v) params.set(k, v); else params.delete(k); }
    if (resetPage) params.delete("page");
    router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
  }, [router]);

  // Option lists — loaded once.
  const [warehouses, setWarehouses] = React.useState<{ value: string; label: string }[]>([]);
  const [categories, setCategories] = React.useState<{ value: string; label: string }[]>([]);
  const [customers, setCustomers] = React.useState<{ value: string; label: string }[]>([]);

  const showWarehouse = filters.includes("warehouse");
  const showOwner = filters.includes("owner");
  const showLocation = filters.includes("location");
  const showCategory = filters.includes("category");
  const showStatus = filters.includes("status");
  const showCustomer = filters.includes("customer");

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (showWarehouse) {
        try {
          const r = await listWarehouses({ status: "active", pageSize: 100 });
          if (active) {
            setWarehouses(
              r.warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })),
            );
          }
        } catch { /* silently skip */ }
      }
      if (showCategory) {
        try {
          const cs = await listIrmCategories();
          if (active) setCategories(cs.map((c) => ({ value: c.name, label: c.name })));
        } catch { /* silently skip */ }
      }
      if (showCustomer) {
        try {
          const r = await listCustomers({ pageSize: 100 });
          if (active) {
            setCustomers(r.customers.map((c) => ({ value: c.id, label: c.name })));
          }
        } catch { /* silently skip */ }
      }
    })();
    return () => { active = false; };
  }, [showWarehouse, showCategory, showCustomer]);

  // Debounce search input → write to ?q.
  const urlQ = searchParams.get("q") ?? "";
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== urlQ) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, urlQ, patch]);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusting state during
  // render (not via an effect) is the React-recommended pattern and avoids a cascading re-render.
  const [prevUrlQ, setPrevUrlQ] = React.useState(urlQ);
  if (prevUrlQ !== urlQ) {
    setPrevUrlQ(urlQ);
    setSearchInput(urlQ);
  }

  // Stringify fixedFilters so it can be an effect dependency without referential churn.
  const fixedKey = JSON.stringify(fixedFilters);

  // Active merged params (user filters + fixedFilters; fixedFilters always win).
  const activeParams = React.useMemo((): svc.PositionParams => {
    const fixed: svc.PositionParams = JSON.parse(fixedKey) as svc.PositionParams;
    return {
      ...(ownerFilter && !fixed.ownership ? { ownership: ownerFilter } : {}),
      ...(locationFilter && !fixed.location ? { location: locationFilter } : {}),
      ...(warehouseFilter && !fixed.warehouse ? { warehouse: warehouseFilter } : {}),
      ...(categoryFilter && !fixed.category ? { category: categoryFilter } : {}),
      ...(statusFilter && !fixed.status ? { status: statusFilter } : {}),
      ...(customerFilter && !fixed.customer ? { customer: customerFilter } : {}),
      ...fixed,
      search: urlQ || undefined,
    };
  }, [fixedKey, ownerFilter, locationFilter, warehouseFilter, categoryFilter, statusFilter, customerFilter, urlQ]);

  React.useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    void (async () => {
      setLoading(true);
      await new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); });
      if (!active) return;
      try {
        const r = await svc.listPositions({ ...activeParams, page, pageSize: 25 });
        if (active) {
          setData(r);
          setLoading(false);
        }
      } catch {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeParams, page]);

  const onExport = async () => {
    setExporting(true);
    try {
      await svc.exportPositionsCsv(activeParams);
      pushToast("Stock positions exported.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Export failed.", "alert");
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.positions ?? [];
  const showSkeleton = loading && rows.length === 0;
  const totalCols = columns.length + (rowAction ? 1 : 0);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Filter bar — shown when any filter or export is configured */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs lg:flex-row lg:flex-wrap lg:items-center">
        {/* Search always shown */}
        <div className="relative w-full lg:min-w-64 lg:max-w-xs lg:flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search item or SKU…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2.5 pl-9 pr-3 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]"
          />
        </div>

        {showOwner && (
          <Select
            size="sm"
            value={ownerFilter}
            onChange={(v) => patch({ owner: v || null })}
            options={OWNERSHIP_OPTIONS}
            ariaLabel="Filter by owner"
          />
        )}
        {showLocation && (
          <Select
            size="sm"
            value={locationFilter}
            onChange={(v) => patch({ location: v || null })}
            options={LOCATION_OPTIONS}
            ariaLabel="Filter by location"
          />
        )}
        {showWarehouse && (
          <Select
            size="sm"
            value={warehouseFilter}
            onChange={(v) => patch({ warehouse: v || null })}
            options={[{ value: "", label: "All warehouses" }, ...warehouses]}
            ariaLabel="Filter by warehouse"
          />
        )}
        {showCategory && (
          <Select
            size="sm"
            value={categoryFilter}
            onChange={(v) => patch({ category: v || null })}
            options={[{ value: "", label: "All categories" }, ...categories]}
            ariaLabel="Filter by category"
          />
        )}
        {showStatus && (
          <Select
            size="sm"
            value={statusFilter}
            onChange={(v) => patch({ status: v || null })}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
          />
        )}
        {showCustomer && (
          <Select
            size="sm"
            value={customerFilter}
            onChange={(v) => patch({ customer: v || null })}
            options={[{ value: "", label: "All customers" }, ...customers]}
            ariaLabel="Filter by customer"
          />
        )}

        {exportable && can("inventory.export") && (
          <div className="flex items-center gap-2 lg:ml-auto">
            <button
              onClick={onExport}
              disabled={exporting || rows.length === 0}
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
              title="Export the filtered list to CSV"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export CSV
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {columns.map((c) => (
                  <th key={c} className={`px-4 py-3 ${RIGHT.has(c) ? "text-right" : ""}`}>
                    {COL_LABELS[c]}
                  </th>
                ))}
                {rowAction ? <th className="px-4 py-3 text-right">Action</th> : null}
              </tr>
            </thead>
            {showSkeleton ? (
              <TableSkeletonRows cols={totalCols} />
            ) : (
              <tbody>
                {rows.map((r) => {
                  const href = rowHref(r);
                  return (
                    <tr
                      key={r.id}
                      className={`border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)] ${href ? "cursor-pointer" : ""}`}
                    >
                      {columns.map((c) => (
                        <td
                          key={c}
                          onClick={() => href && router.push(href)}
                          className={`px-4 py-3 ${RIGHT.has(c) ? "text-right" : ""}`}
                        >
                          {cellValue(r, c)}
                        </td>
                      ))}
                      {rowAction ? (
                        <td className="px-4 py-3 text-right">{rowAction(r)}</td>
                      ) : null}
                    </tr>
                  );
                })}
                {!showSkeleton && rows.length === 0 ? (
                  <tr>
                    <td colSpan={totalCols} className="px-4 py-16">
                      <div className="flex flex-col items-center justify-center gap-2 text-center">
                        <Boxes className="h-7 w-7 text-[var(--faint)]" />
                        <p className="text-sm font-semibold text-[var(--ink)]">{emptyText}</p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            )}
          </table>
        </div>
      </div>

      {data && data.total > 0 ? (
        <div className="shrink-0">
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            label="records"
            onPage={(n) => patch({ page: n > 1 ? String(n) : null }, false)}
          />
        </div>
      ) : null}
    </div>
  );
}
