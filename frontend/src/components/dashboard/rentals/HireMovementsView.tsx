"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftRight, Rows3, Search } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { ExportButton } from "@/components/ui/ExportButton";
import { FilterPopover } from "@/components/ui/FilterPopover";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { inputCls } from "@/components/ui/styles";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import { legOf } from "./hireMovementLeg";
import type { ReceiptDirection, RentalReceipt } from "@/types/rental";

// ── The hire movement register ────────────────────────────────────────────────────────────────
//
// Every physical movement of hired equipment, across every order: what arrived, what went back, what
// broke in between. The counterpart of the Goods In register, for the records a GRN deliberately
// never writes.
//
// It exists because every other rental surface is LIVE-only, and correctly so — the warehouse pane
// shows what is on site, the On hire list shows what is out, an item's page shows where it is now. So
// a hire that ended left all three at once, and its notes survived only inside the movement panel of
// an order somebody had to already know the number of. "Every collection in July", the question a
// supplier's invoice actually asks, could not be asked at all.
//
// Reversed notes are IN this list by default, and marked. A movement that was corrected is still a
// fact about the period; hiding it is how a reconciliation quietly stops matching the order page it
// was checked against. The filter that drops them is for the reader who is about to SUM the columns.

const PAGE_SIZE = 20;

// Note · Movement · Date · Order · Supplier · Warehouse · Items · Units. Supplier and warehouse names
// are the long values; Items and Units step aside first on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "narrow", "normal", "normal", "wide", "wide", "wide", "narrow"]);

const DIRECTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All movements" },
  { value: "in", label: "Delivered to us" },
  { value: "out", label: "Returned to supplier" },
  { value: "damage", label: "Damage reported" },
];

const shortDate = (iso: string) =>
  // UTC: a movement date is a calendar day stored as UTC midnight, and formatting it in any zone
  // behind UTC shows the day before.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** Units moved and units damaged on one note — summed off its own lines, as the export does. */
function totalsOf(r: RentalReceipt): { moved: number; damaged: number } {
  return r.lines.reduce(
    (acc, l) => ({ moved: acc.moved + l.receivedQuantity, damaged: acc.damaged + l.damagedQuantity }),
    { moved: 0, damaged: 0 },
  );
}

export function HireMovementsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  // Every filter lives in the URL, so a period survives a refresh and can be sent to somebody else —
  // which is most of what a register is for.
  const search = searchParams.get("q") ?? "";
  const direction = searchParams.get("dir") ?? "all";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const liveOnly = searchParams.get("live") === "1";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seed the box when ?q changes outside typing (browser back/forward). Adjusted during render
  // rather than in an effect — the React-recommended pattern, and no cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [rows, setRows] = React.useState<RentalReceipt[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  const patch = React.useCallback(
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

  React.useEffect(() => {
    const t = setTimeout(() => {
      // Only patch when the box actually diverges from the URL, so a deep-linked ?page survives
      // mount and browser back/forward (patch defaults to resetPage, which would drop it).
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  // ONE definition of the filters, shared by the list (which adds the page) and both exports (which
  // must not). Two copies is how a download quietly stops matching the screen it was taken from.
  const filters = React.useMemo(
    () => ({
      search: search || undefined,
      direction: direction === "all" ? undefined : (direction as ReceiptDirection),
      from: from || undefined,
      to: to || undefined,
      liveOnly: liveOnly || undefined,
    }),
    [search, direction, from, to, liveOnly],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await rentalService.listHireMovements({ ...filters, page, pageSize: PAGE_SIZE });
        if (cancelled) return;
        setRows(res.receipts);
        setTotal(res.total);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load hire movements.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, reloadKey]);

  // A movement recorded anywhere — the receive, return and damage forms, or a reversal on an order
  // page — refetches this list. A register showing yesterday's set is worse than one that is empty.
  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  const canViewPo = can("purchase_orders.view");
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isFiltered = Boolean(search || from || to || liveOnly) || direction !== "all";

  return (
    <div className="stack flex h-full flex-col">
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        {/* One row of controls, no heading block — the same shape as the Catalogue tab beside it and
            the IRM list beyond that. The title restated the "Movements" pill directly above it, and
            the blurb beside it was the actual layout bug: the exports and their five filters are
            shrink-0, so from `sm` up the text column took whatever was left. At 1024px that was
            about ninety pixels, and one sentence became ten lines of a band that is already the
            tallest thing above the ledger. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
            {/* The ASSET TAG is what makes this box worth having on a bad day: every other field
                here names a movement, and FT-9 names the tester somebody is arguing about. Whole
                tag, any case — see the repository's own note for why it cannot be a substring. */}
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search note, order, supplier, delivery note or asset tag…"
              className={`${inputCls} pl-9`}
            />
          </div>
          {/* The reporting PERIOD stays OUT here, on the date the equipment moved — not on when the
              note was typed. It is the axis a ledger is actually read along, which is the same reason
              the stock movement feed keeps its dates outside its own popover. Two plain date inputs
              rather than a preset list: an accounting period is whatever the finance calendar says it
              is, and every preset would be a guess at it. */}
          <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]">
            From
            <input type="date" value={from} onChange={(e) => patch({ from: e.target.value || null })} className={`${inputCls} w-auto py-1.5`} />
          </label>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]">
            To
            <input type="date" value={to} onChange={(e) => patch({ to: e.target.value || null })} className={`${inputCls} w-auto py-1.5`} />
          </label>

          {/* The two set-once filters fold away behind a count, the same bargain the stock feed makes:
              the row keeps what people touch, and a hidden filter is still legible as ON because the
              trigger says how many are. Without that count a reversed-hiding ledger just looks short. */}
          <FilterPopover
            activeCount={(direction === "all" ? 0 : 1) + (liveOnly ? 1 : 0)}
            onClear={() => patch({ dir: null, live: null })}
          >
            <Select
              size="sm"
              value={direction}
              onChange={(v) => patch({ dir: v === "all" ? null : v })}
              options={DIRECTIONS}
              ariaLabel="Filter by movement"
            />
            {/* Off by default, and phrased as the narrowing it is. A reversed note is part of the
                period's history; it is only in the way when somebody is about to add the columns up. */}
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]">
              <input type="checkbox" checked={liveOnly} onChange={(e) => patch({ live: e.target.checked ? "1" : null })} className="accent-[var(--accent)]" />
              Hide reversed
            </label>
          </FilterPopover>

          {can("rentals.export") && (
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <ExportButton
                label="Export"
                onExport={() => rentalService.exportHireMovementsCsv(filters)}
                disabled={rows.length === 0}
                title="Export the filtered movements — one row per note"
              />
              {/* One row per ITEM, with the supplier's asset tags. At the end of a hire the argument
                  is always about a specific unit, and the item never appears in a header row. */}
              <ExportButton
                label="Export lines"
                icon={Rows3}
                onExport={() => rentalService.exportHireMovementLinesCsv(filters)}
                disabled={rows.length === 0}
                title="Export every movement LINE — item, units, damage and asset tags"
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xs">
        {/* Error BEFORE the skeleton: a failed load that keeps showing placeholder bars reads as a
            slow page, and the reader waits instead of retrying. */}
        {error ? (
          <p className="p-6 text-center text-xs text-[var(--neg)]">{error}</p>
        ) : loading && rows.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <ArrowLeftRight className="h-8 w-8 text-[var(--faint)]" />
            <p className="text-xs text-[var(--muted)]">
              {isFiltered
                ? "No movements match these filters."
                : "No hire movements recorded yet. One appears here as soon as hired equipment is booked in, handed back or reported damaged."}
            </p>
          </div>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`}>
            <table className="w-full text-left text-xs" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="cell-y px-4">Note</th>
                  <th className="cell-y px-4">Movement</th>
                  <th className="cell-y px-4">Date</th>
                  <th className="cell-y px-4">Order</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Supplier</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Warehouse</th>
                  <th className={`cell-y px-4 ${colClass("xl")}`}>Items</th>
                  <th className="cell-y px-4 text-right">Units</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const leg = legOf(r.direction);
                  const t = totalsOf(r);
                  // A note with no order code snapshot cannot lead anywhere — the row simply stays inert.
                  const href = canViewPo && r.poCode ? `/dashboard/purchase-orders/${r.poCode}` : null;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => href && router.push(href)}
                      // Clickable only for somebody who can open the order it leads to. A warehouse
                      // user records these movements and may hold no purchase-order rights at all —
                      // a row that navigates them into a 403 is worse than one that does not move.
                      className={`border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-2)] ${href ? "cursor-pointer" : ""} ${r.reversedAt ? "opacity-70" : ""}`}
                    >
                      <td className="cell-y px-4 font-mono text-[11px] text-[var(--muted)]">
                        <span className={r.reversedAt ? "line-through" : ""}>{r.code}</span>
                        {/* Marked, never hidden — and marked HERE rather than in a column of its
                            own, because it qualifies the note itself and every number on the row. */}
                        {r.reversedAt && (
                          <span className="ml-1.5 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-[var(--muted)]" title={r.reversalReason ?? undefined}>
                            Reversed
                          </span>
                        )}
                      </td>
                      <td className="cell-y px-4">
                        {/* The leg in words. "HRN-0004" only reads as a return to somebody who
                            already knows the three prefixes. */}
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${leg.tone}`}>
                          {leg.label}
                        </span>
                      </td>
                      <td className="cell-y whitespace-nowrap px-4 text-[var(--muted)]">{shortDate(r.deliveryDate)}</td>
                      <td className="cell-y px-4">
                        {/* PoCodeLink stops its own propagation, so the link goes where it says
                            without also firing the row. */}
                        <PoCodeLink code={r.poCode ?? "—"} />
                      </td>
                      <td className={`cell-y px-4 text-[var(--ink)] ${colClass("lg")} ${CELL_ONE_LINE}`} title={r.supplierName ?? undefined}>
                        {r.supplierName ?? "—"}
                      </td>
                      <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")} ${CELL_ONE_LINE}`} title={r.warehouseName ?? undefined}>
                        {r.warehouseName ?? "—"}
                      </td>
                      <td className={`cell-y px-4 text-[var(--muted)] ${colClass("xl")} ${CELL_ONE_LINE}`} title={r.lines.map((l) => l.itemName).join(", ")}>
                        {r.lines.map((l) => l.itemName).join(", ") || "—"}
                      </td>
                      <td className="cell-y whitespace-nowrap px-4 text-right text-[var(--muted)]">
                        {/* A damage report moves nothing — its units ARE the damage, and printing a
                            0 beside them would read as a delivery that brought nothing. */}
                        {r.direction === "damage" ? (
                          <span className="font-bold text-[var(--warn,#d97706)]">{t.damaged} damaged</span>
                        ) : (
                          <>
                            <span className="font-semibold text-[var(--ink)]">{t.moved}</span>
                            {t.damaged > 0 && (
                              <span className="ml-1.5 text-[10px] font-bold text-[var(--neg)]" title={leg.quantityLabel}>
                                {t.damaged} damaged
                              </span>
                            )}
                          </>
                        )}
                        {/* WHAT WE ARE BEING CHARGED for that damage — the number a supplier's
                            invoice is checked against, so it belongs on the row and not only in the
                            export. A note with damaged units and nothing quoted yet says so instead
                            of showing £0.00, because only one of those two is somebody's job. */}
                        {r.direction !== "in" && !r.reversedAt && t.damaged > 0 && (
                          <div
                            className={`text-[10px] font-bold ${r.damageChargeTotal == null ? "text-[var(--faint)]" : "text-[var(--warn,#d97706)]"}`}
                            title={r.damageChargeRef ? `Their ref ${r.damageChargeRef}` : undefined}
                          >
                            {r.damageChargeTotal == null ? "charge not known" : `${formatMoney(r.damageChargeTotal)} charged`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!error && total > 0 && (
          <Pagination
            embedded
            page={Math.min(page, totalPages)}
            totalPages={totalPages}
            total={total}
            label="movements"
            onPage={(p) => patch({ page: p > 1 ? String(p) : null }, false)}
          />
        )}
      </div>
    </div>
  );
}
