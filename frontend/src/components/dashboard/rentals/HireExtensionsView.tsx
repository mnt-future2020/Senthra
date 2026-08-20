"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarPlus, Search } from "lucide-react";

import * as rentalService from "@/services/rental.service";
import { useAuth } from "@/hooks/useAuth";
import { useRentalHireStream } from "@/hooks/useRentalHireStream";
import { ExportButton } from "@/components/ui/ExportButton";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { CELL_ONE_LINE, colClass, tableMinWidth } from "@/components/ui/tableLayout";
import { inputCls } from "@/components/ui/styles";
import { PoCodeLink } from "@/components/dashboard/purchase-orders/PoCodeLink";
import { formatMoney } from "@/components/dashboard/purchase-orders/poStatus";
import type { HireExtensionRow } from "@/types/rental";

// ── The extension register ────────────────────────────────────────────────────────────────────
//
// Every extension agreed in a period, one row each.
//
// A hire line carries `extensionCharge` — a RUNNING TOTAL. Extend a hire three times for £275, £300
// and £150 and it reads £725: true, and unanswerable. It carries no dates and no events, only their
// sum, so "how much extension did we agree in July" could not be asked at all — and an extension is
// money committed after the order was sent, which makes it exactly the kind of number a finance
// period has to be able to see on its own.
//
// The audit log has always held each one. An activity trail is not a register: it cannot be filtered
// to a period, joined to a hire and totalled, and nobody reconciling an invoice would think to open
// it. So each extension is now a record of its own, written in the same transaction that moves the
// total it explains.

const PAGE_SIZE = 20;

// Agreed · Order · Supplier · Item · Moved to · Days · Charge. The item and supplier names are the
// long values; the rate detail steps aside first on a narrow screen.
const TABLE_MIN_WIDTH = tableMinWidth(["normal", "normal", "wide", "wide", "normal", "narrow", "normal"]);

const shortDate = (iso: string) =>
  // UTC on the hire dates: a hire date is a calendar day stored as UTC midnight, and formatting it in
  // any zone behind UTC shows the day before. `agreedAt` is a real timestamp and reads the same way
  // to within a few hours, so one formatter serves both rather than two that disagree by a day.
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function HireExtensionsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();

  // In the URL, so a period survives a refresh and can be sent to somebody else — which is most of
  // what a register is for.
  const search = searchParams.get("q") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [searchInput, setSearchInput] = React.useState(search);
  // Re-seeded during render rather than in an effect when ?q changes outside typing (browser
  // back/forward) — the React-recommended pattern, and no cascading re-render.
  const [prevSearch, setPrevSearch] = React.useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setSearchInput(search);
  }

  const [rows, setRows] = React.useState<HireExtensionRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [pageCharge, setPageCharge] = React.useState(0);
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
      // Only when the box actually diverges from the URL, so a deep-linked ?page survives mount and
      // browser back/forward (patch defaults to resetPage, which would drop it).
      if (searchInput.trim() !== search) patch({ q: searchInput.trim() || null });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, search, patch]);

  // ONE definition, shared by the list (which adds the page) and the export (which must not). Two
  // copies is how a download quietly stops matching the screen it was taken from.
  const filters = React.useMemo(
    () => ({ search: search || undefined, from: from || undefined, to: to || undefined }),
    [search, from, to],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await rentalService.listHireExtensions({ ...filters, page, pageSize: PAGE_SIZE });
        if (cancelled) return;
        setRows(res.extensions);
        setTotal(res.total);
        setPageCharge(res.totalCharge);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load hire extensions.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, reloadKey]);

  // An extension agreed on an order page while this is open. Same signal every rental surface uses.
  useRentalHireStream(React.useCallback(() => setReloadKey((k) => k + 1), []));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isFiltered = Boolean(search || from || to);

  return (
    <div className="stack flex h-full flex-col">
      <div className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs">
        {/* One row of controls, no heading block — the Extensions pill directly above already names
            the list, and a title beside these filters cost a whole second band. Same shape as the
            Catalogue tab and the IRM list it sits beside. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search order, supplier or item…"
              className={`${inputCls} pl-9`}
            />
          </div>
          {/* The period is on when the extension was AGREED, which is the date a finance month means
              — not the hire dates it moved, which usually fall in a different one entirely. */}
          <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]">
            Agreed from
            <input type="date" value={from} onChange={(e) => patch({ from: e.target.value || null })} className={`${inputCls} w-auto py-1.5`} />
          </label>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold text-[var(--muted)]">
            To
            <input type="date" value={to} onChange={(e) => patch({ to: e.target.value || null })} className={`${inputCls} w-auto py-1.5`} />
          </label>
          {/* THIS page's total, and it says so. A figure quietly summing rows the reader cannot see
              is the kind of number that gets copied into a report — the export carries the period. */}
          {rows.length > 0 && (
            <span className="text-[11px] font-semibold text-[var(--muted)] sm:ml-auto">
              This page: <span className="font-extrabold text-[var(--ink)]">{formatMoney(pageCharge)}</span>
            </span>
          )}
          {can("rentals.export") && (
            /* No `ml-auto` of its own: the page total above already claims the right edge, and a
               second one would split the row in two when the total is hidden on an empty page. */
            <div className={rows.length > 0 ? "" : "sm:ml-auto"}>
              <ExportButton
                label="Export"
                onExport={() => rentalService.exportHireExtensionsCsv(filters)}
                disabled={rows.length === 0}
                title="Export the extensions in this period — what the rate said, and what was agreed"
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
            <CalendarPlus className="h-8 w-8 text-[var(--faint)]" />
            <p className="text-xs text-[var(--muted)]">
              {isFiltered
                ? "No extensions were agreed in this period."
                : "No hire has been extended yet. Each one appears here as soon as it is agreed, on the On hire tab or the order itself."}
            </p>
          </div>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto transition-opacity ${loading ? "pointer-events-none opacity-60" : ""}`}>
            <table className="w-full text-left text-xs" style={{ minWidth: TABLE_MIN_WIDTH }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface-2)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="cell-y px-4">Agreed</th>
                  <th className="cell-y px-4">Order</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Supplier</th>
                  <th className="cell-y px-4">Item</th>
                  <th className={`cell-y px-4 ${colClass("lg")}`}>Hire moved to</th>
                  <th className="cell-y px-4">Days</th>
                  <th className="cell-y px-4 text-right">Charge</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-2)]">
                    <td className="cell-y whitespace-nowrap px-4 text-[var(--muted)]">
                      {shortDate(e.agreedAt)}
                      {e.agreedBy && (
                        <div className={`text-[10px] text-[var(--faint)] ${CELL_ONE_LINE}`} title={e.agreedBy}>
                          {e.agreedBy}
                        </div>
                      )}
                    </td>
                    <td className="cell-y px-4">
                      <PoCodeLink code={e.purchaseOrderCode ?? "—"} />
                    </td>
                    <td className={`cell-y px-4 text-[var(--muted)] ${colClass("lg")} ${CELL_ONE_LINE}`} title={e.supplierName ?? undefined}>
                      {e.supplierName ?? "—"}
                    </td>
                    <td className={`cell-y px-4 text-[var(--ink)] ${CELL_ONE_LINE}`} title={e.itemName}>
                      {e.itemName}
                      {e.quantity > 1 && <span className="ml-1.5 text-[10px] text-[var(--faint)]">× {e.quantity}</span>}
                    </td>
                    {/* Where the deadline MOVED — the old date beside the new one, because an
                        extension is a change and one date cannot show a change. */}
                    <td className={`cell-y whitespace-nowrap px-4 text-[var(--muted)] ${colClass("lg")}`}>
                      {shortDate(e.previousEndDate)} → {shortDate(e.newEndDate)}
                    </td>
                    <td className="cell-y px-4 text-[var(--muted)]">+{e.addedDays}d</td>
                    <td className="cell-y whitespace-nowrap px-4 text-right">
                      <span className="font-semibold text-[var(--ink)]">{formatMoney(e.charge)}</span>
                      {/* What the rate said, when it was not what was agreed. The gap between the
                          two is the negotiation, and it is invisible from either figure alone. */}
                      {e.priceOverridden && e.calculatedCharge != null && (
                        <div className="text-[10px] text-[var(--faint)]">rate said {formatMoney(e.calculatedCharge)}</div>
                      )}
                    </td>
                  </tr>
                ))}
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
            label="extensions"
            onPage={(p) => patch({ page: p > 1 ? String(p) : null }, false)}
          />
        )}
      </div>
    </div>
  );
}
