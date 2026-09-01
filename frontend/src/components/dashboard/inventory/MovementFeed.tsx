"use client";

import * as React from "react";
import { Download, Loader2, ScrollText } from "lucide-react";

import * as svc from "@/services/stockPosition.service";
import type { MovementFilters } from "@/services/stockPosition.service";
import { listWarehouses } from "@/services/warehouse.service";
import { listCustomers } from "@/services/customer.service";
import { listIrmItems } from "@/services/irm.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { Select, type SelectOption } from "@/components/ui/Select";
import { FilterPopover } from "@/components/ui/FilterPopover";
import type { Movement, MovementPage } from "@/types/stock-position";
import { OwnerTag, TableSkeletonRows } from "./hubUi";

// The reusable Stock Movement History feed — a cursor-paginated, filterable table over the unified
// stock ledger. Admin and engineer surfaces both render this; they differ only in the `fetcher`
// (company-wide vs. own-scoped) and which filters are shown (`scope`). Admin additionally gets entity
// lookup pickers (item / warehouse / engineer / customer) and CSV export of the filtered set.

export type MovementFetcher = (
  params: MovementFilters & { cursor?: string | null; limit?: number },
) => Promise<MovementPage>;

const TYPE_OPTIONS: SelectOption[] = [
  { value: "", label: "All types" },
  { value: "goods_in", label: "Goods In" },
  { value: "goods_out", label: "Goods Out" },
  { value: "transfer_in", label: "Transfer In" },
  { value: "transfer_out", label: "Transfer Out" },
  { value: "manual_add", label: "Adjustment (add)" },
  { value: "manual_adjust", label: "Adjustment (remove)" },
  { value: "job_issue", label: "Job Issue" },
  { value: "job_return", label: "Job Return" },
  { value: "van_restock", label: "Field Restock" },
  { value: "van_return", label: "Field Return" },
  { value: "job_consume", label: "Consumed on Job" },
  { value: "job_lost", label: "Lost on Job" },
  { value: "write_off", label: "Marked Damaged" },
  { value: "restore", label: "Restored from Damaged" },
];

const OWNERSHIP_OPTIONS: SelectOption[] = [
  { value: "", label: "All ownership" },
  { value: "company", label: "Company" },
  { value: "customer", label: "Customer" },
];

const LOCATION_OPTIONS: SelectOption[] = [
  { value: "", label: "All locations" },
  { value: "warehouse", label: "Warehouse" },
  { value: "engineer", label: "Engineer van" },
  { value: "damaged", label: "Damaged" },
];

const PAGE = 25;
const dateCls =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--ink)] outline-none transition-all focus:border-[var(--accent)]";

interface OptionLists {
  warehouses: SelectOption[];
  customers: SelectOption[];
  engineers: SelectOption[];
  items: SelectOption[];
}

// `lockedWarehouse` is the feed's fixed scope, not a user choice, so it must NOT count as an active
// filter — otherwise "Clear filters" is permanently visible on a scoped feed and appears to offer
// something it can't do.
//
// One count, used for both the Filters badge and whether a Clear is offered. Two separate definitions
// of "is anything on?" would eventually disagree, and the badge is the only thing stopping a narrowed
// ledger from reading as a short one.
function activeFilterCount(f: MovementFilters, lockedWarehouse?: string): number {
  const warehouseChosenByUser = Boolean(f.warehouse) && f.warehouse !== lockedWarehouse;
  return [
    f.ownership, f.location, f.type, f.dateFrom, f.dateTo, f.irmItem, f.engineer, f.customer,
  ].filter(Boolean).length + (warehouseChosenByUser ? 1 : 0);
}

function FilterBar({
  scope,
  value,
  onChange,
  onClear,
  lists,
  canExport,
  exporting,
  onExport,
  lockedWarehouse,
}: {
  scope: "admin" | "engineer";
  value: MovementFilters;
  onChange: (next: MovementFilters) => void;
  onClear: () => void;
  lists: OptionLists;
  canExport: boolean;
  exporting: boolean;
  onExport: () => void;
  lockedWarehouse?: string;
}) {
  const set = (patch: Partial<MovementFilters>) => onChange({ ...value, ...patch });
  const active = activeFilterCount(value, lockedWarehouse);
  return (
    /* Seven pickers, two dates and an export used to sit on one row: at 1024px that wrapped onto a
       second line — ~46px of a full-height page, on top of a filter card that was already the tallest
       band above the ledger. The DATE RANGE stays out here because it is the axis a ledger is actually
       read along; everything else is set once and left, so it folds behind one trigger that carries the
       active count. The same component and the same reasoning as the stock positions table. */
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
        From
        <input type="date" aria-label="From date" className={dateCls} value={value.dateFrom ?? ""} onChange={(e) => set({ dateFrom: e.target.value || undefined })} />
      </label>
      <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
        To
        <input type="date" aria-label="To date" className={dateCls} value={value.dateTo ?? ""} onChange={(e) => set({ dateTo: e.target.value || undefined })} />
      </label>

      {/* Clearing resets to the LOCK, not to nothing — see the caller. The dates count towards the
          badge and are cleared by it too: they are filters, and a badge that ignored them would call a
          date-narrowed ledger unfiltered. */}
      <FilterPopover activeCount={active} onClear={onClear}>
        {scope === "admin" && (
          <>
            <Select size="sm" ariaLabel="Filter by item" value={value.irmItem ?? ""} onChange={(v) => set({ irmItem: v || undefined })} options={[{ value: "", label: "All items" }, ...lists.items]} />
            {/* Both hidden when the feed is locked to one warehouse. The warehouse picker would let the
                user navigate out of the page they're on; the LOCATION picker is worse than redundant —
                "Warehouse" is already implied, and picking "Engineer van" asks the server for the
                intersection of engineer-held and warehouse-held movements, which is always empty. */}
            {!lockedWarehouse && (
              <Select size="sm" ariaLabel="Filter by warehouse" value={value.warehouse ?? ""} onChange={(v) => set({ warehouse: v || undefined })} options={[{ value: "", label: "All warehouses" }, ...lists.warehouses]} />
            )}
            <Select size="sm" ariaLabel="Filter by engineer" value={value.engineer ?? ""} onChange={(v) => set({ engineer: v || undefined })} options={[{ value: "", label: "All engineers" }, ...lists.engineers]} />
            <Select size="sm" ariaLabel="Filter by customer" value={value.customer ?? ""} onChange={(v) => set({ customer: v || undefined })} options={[{ value: "", label: "All customers" }, ...lists.customers]} />
          </>
        )}
        <Select size="sm" ariaLabel="Filter by ownership" value={value.ownership ?? ""} onChange={(v) => set({ ownership: v || undefined })} options={OWNERSHIP_OPTIONS} />
        {scope === "admin" && !lockedWarehouse && (
          <Select size="sm" ariaLabel="Filter by location" value={value.location ?? ""} onChange={(v) => set({ location: v || undefined })} options={LOCATION_OPTIONS} />
        )}
        <Select size="sm" ariaLabel="Filter by movement type" value={value.type ?? ""} onChange={(v) => set({ type: v || undefined })} options={TYPE_OPTIONS} />
      </FilterPopover>

      {canExport && (
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          title="Export the filtered movement history to CSV"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export CSV
        </button>
      )}
    </div>
  );
}

import { CELL_ONE_LINE, tableMinWidth } from "@/components/ui/tableLayout";

const HEADERS = ["Date", "Type", "Item", "Owner", "Location", "Qty", "Balance", "Reference", "Actor"];

// Item, Location and Reference are the values that run long; the flat `min-w-[980px]` across nine
// columns left them ~109px each.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "normal", "wide", "narrow", "wide", "narrow", "narrow", "normal", "normal"]);

function Row({ m }: { m: Movement }) {
  return (
    <tr className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--surface-2)]">
      <td className="whitespace-nowrap cell-y px-4 text-[var(--muted)]">{new Date(m.date).toLocaleString()}</td>
      <td className="cell-y px-4">
        {/* nowrap: the auto layout had squeezed this column to 93px, so a two-word type ("Job Return",
            "Marked Damaged") broke inside the pill and made EVERY row 65px — the badge, not the item
            name, was the tallest thing in the row. The column's declared budget already allows for the
            longest label; this stops the browser spending the difference on height instead. */}
        <span className="whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]">{m.label}</span>
      </td>
      {/* Name and code on ONE line, and the name TRUNCATES.
          Rows here measured 47px, 59px and 79px at 1024px — three heights in one feed. Two separate
          causes: the code sat on a second line, and the name had no truncate, so a long item name
          wrapped on top of that. Inline fixes the first; `truncate` (with the full name on `title`)
          fixes the second. A ledger is read by scanning down a column, and rows of three different
          heights are the thing that makes that hard. */}
      <td className="cell-y px-4">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate font-semibold text-[var(--ink)]" title={m.itemName}>{m.itemName}</span>
          {(m.itemCode || m.sku) && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--faint)]">{m.itemCode || m.sku}</span>
          )}
        </div>
      </td>
      <td className="cell-y px-4"><OwnerTag ownership={m.ownership} /></td>
      {/* Truncate, don't wrap. With the item cell now one line the auto layout handed this column
          less width, and "Damaged — London Logistics Hub" answered by wrapping to three lines — an
          85px row. Row height is the one cost paid per row, so the long-text columns each carry their
          own ceiling and put the full value on `title`, exactly as the stock positions table does. */}
      <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={m.locationLabel || undefined}>{m.locationLabel || "—"}</td>
      <td className={`cell-y px-4 text-right font-semibold ${m.quantityDelta < 0 ? "text-[var(--neg)]" : "text-[var(--pos)]"}`}>
        {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
      </td>
      <td className="cell-y px-4 text-right text-[var(--muted)]">{m.balanceAfter ?? "—"}</td>
      <td className="cell-y whitespace-nowrap px-4 font-mono text-[11px] text-[var(--muted)]">{m.reference ?? "—"}</td>
      <td className={`cell-y px-4 text-[var(--muted)] ${CELL_ONE_LINE}`} title={m.actor ?? undefined}>{m.actor ?? "—"}</td>
    </tr>
  );
}

const EMPTY_LISTS: OptionLists = { warehouses: [], customers: [], engineers: [], items: [] };

export function MovementFeed({
  fetcher,
  scope,
  lockedWarehouse,
}: {
  fetcher: MovementFetcher;
  scope: "admin" | "engineer";
  /**
   * Pins the feed to one warehouse — for a warehouse's own Transactions tab. Held INSIDE `filters`
   * rather than applied separately by the fetcher, so the one value drives the query, the CSV export
   * and the filter bar alike. Applying it only in the fetcher would let the visible filter state and
   * the request disagree, which is exactly the bug that shape invites.
   */
  lockedWarehouse?: string;
}) {
  const { can } = useAuth();
  const { pushToast } = useDashboard();

  const [filters, setFilters] = React.useState<MovementFilters>(
    lockedWarehouse ? { warehouse: lockedWarehouse } : {},
  );
  const [rows, setRows] = React.useState<Movement[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lists, setLists] = React.useState<OptionLists>(EMPTY_LISTS);
  const reqId = React.useRef(0);

  // Admin lookup option lists — loaded once. Bounded entities (warehouse/customer/engineer) load fully;
  // items load the active catalogue (capped) sorted by code for the picker.
  React.useEffect(() => {
    if (scope !== "admin") return;
    let active = true;
    void (async () => {
      const [wh, cust, eng, items] = await Promise.all([
        listWarehouses({ status: "active", pageSize: 200 }).then((r) => r.warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))).catch(() => []),
        listCustomers({ pageSize: 200 }).then((r) => r.customers.map((c) => ({ value: c.id, label: c.name }))).catch(() => []),
        svc.listEngineerOptions().then((r) => r.map((e) => ({ value: e.engineerId, label: e.name }))).catch(() => []),
        listIrmItems({ status: "active", pageSize: 200 }).then((r) =>
          r.items
            .map((i) => ({ value: i.id, label: i.code ? `${i.code} — ${i.name}` : i.name }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ).catch(() => []),
      ]);
      if (active) setLists({ warehouses: wh, customers: cust, engineers: eng, items });
    })();
    return () => { active = false; };
  }, [scope]);

  // (Re)load page 1 whenever filters change. A request token discards superseded responses.
  React.useEffect(() => {
    const myId = ++reqId.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetcher({ ...filters, limit: PAGE });
        if (myId !== reqId.current) return;
        setRows(res.movements);
        setCursor(res.nextCursor);
        setHasMore(res.hasMore);
      } catch (e) {
        if (myId !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Could not load movements.");
        setRows([]);
        setCursor(null);
        setHasMore(false);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    })();
  }, [fetcher, filters]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const myId = reqId.current; // a filter change bumps it and aborts this append
    setLoadingMore(true);
    try {
      const res = await fetcher({ ...filters, cursor, limit: PAGE });
      if (myId !== reqId.current) return;
      setRows((prev) => [...prev, ...res.movements]);
      setCursor(res.nextCursor);
      setHasMore(res.hasMore);
    } catch {
      /* keep what we have; the user can retry */
    } finally {
      if (myId === reqId.current) setLoadingMore(false);
    }
  };

  const onExport = async () => {
    setExporting(true);
    try {
      const { capped } = await svc.exportMovementsCsv(filters);
      pushToast(capped ? "Exported the most recent 50,000 movements (export capped)." : "Movement history exported.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Export failed.", "alert");
    } finally {
      setExporting(false);
    }
  };

  const canExport = scope === "admin" && can("inventory.history") && can("inventory.export");
  const showSkeleton = loading && rows.length === 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <FilterBar
        scope={scope}
        value={filters}
        onChange={setFilters}
        // Clears back to the LOCK, not to nothing. Resetting to `{}` on a warehouse-scoped feed would
        // silently widen it to every warehouse in the company while the page still claims to be about
        // this one.
        onClear={() => setFilters(lockedWarehouse ? { warehouse: lockedWarehouse } : {})}
        lists={lists}
        canExport={canExport}
        exporting={exporting}
        onExport={() => void onExport()}
        lockedWarehouse={lockedWarehouse}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-sm" style={{ minWidth: TABLE_MIN_WIDTH }}>
            <thead className="sticky top-0 z-10 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                {HEADERS.map((h) => (
                  <th key={h} className={`cell-y px-4 ${h === "Qty" || h === "Balance" ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            {showSkeleton ? (
              <TableSkeletonRows cols={HEADERS.length} />
            ) : (
              <tbody>
                {rows.map((m) => <Row key={m.id} m={m} />)}
                {!showSkeleton && rows.length === 0 && (
                  <tr>
                    <td colSpan={HEADERS.length} className="px-4 py-16">
                      <div className="flex flex-col items-center justify-center gap-2 text-center">
                        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
                        <p className="text-sm font-semibold text-[var(--ink)]">{error ?? "No movements match these filters."}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            )}
          </table>
        </div>

        {hasMore && (
          <div className="shrink-0 border-t border-[var(--border)] p-3 text-center">
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)] disabled:opacity-60"
            >
              {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
