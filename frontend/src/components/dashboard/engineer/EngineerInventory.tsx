"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, CalendarClock, History, Package, Search, Wrench } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import type { MiscHeldItem, RentalHolding } from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { formatCalendarDay } from "@/lib/formatDate";
import { dueLabel } from "./hireDeadline";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { EmptyState, fmtDate, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
import { PortalSearch, SortHeader, usePortalTable } from "@/components/dashboard/portal/portalTable";
import { MovementFeed, type MovementFetcher } from "@/components/dashboard/inventory/MovementFeed";
import type { EngineerStockItem } from "@/types/engineer";
import type { CustomerHolding } from "@/types/goodsManagement";
import type { Msg } from "@/components/ui/types";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";

// Engineer Portal — My Stock, split into sub-tabs: Company (IRM) / Customer / Misc / Movements.
type Section = "irm" | "customer" | "rental" | "misc" | "movements";

const IRM_HEADERS = ["Item", "Code", "On hand", "Last updated"];
const IRM_SKELETON = ["h-3 w-44", "h-3 w-20", "h-3 w-14", "h-3 w-20"];
const CUSTOMER_HEADERS = ["Item", "Customer", "On hand"];
const MISC_HEADERS = ["Item", "On hand"];
const RENTAL_HEADERS = ["Item", "Holding", "Return by"];

const SECTIONS: { key: Section; label: string; icon: React.ElementType }[] = [
  { key: "irm", label: "Company (IRM)", icon: Boxes },
  { key: "customer", label: "Customer", icon: Package },
  { key: "rental", label: "Hired", icon: CalendarClock },
  { key: "misc", label: "Misc", icon: Wrench },
  { key: "movements", label: "Movements", icon: History },
];

const PAGE_SIZE = 15;

// Sort key for a hire with no deadline on record — past any real date, but FINITE. See the `due`
// comparator below: Infinity - Infinity is NaN, and a comparator that returns NaN leaves the sort
// order undefined.
const UNDATED = Number.MAX_SAFE_INTEGER;

// Parse for sort — an ISO date string to a comparable epoch (null/invalid sort last when descending).
const dateVal = (iso: string | null): number => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

// The engineer movement feed is hard-scoped to the signed-in engineer on the backend.
const ownMovementsFetcher: MovementFetcher = (params) => engineerService.getOwnMovements(params);

// Shown when a search / filter is active but matches nothing (the source list itself is non-empty).
// Reuses the same EmptyState treatment as the empty-source states, wrapped to fill the flex-1 slot the
// table would occupy — so "nothing to show" looks identical whichever way you arrived at it.
function NoMatches() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EmptyState icon={Search} title="No items match your search" hint="Try a different search or clear the filter." />
    </div>
  );
}

// ── Company (IRM) held stock — searchable by item/code, sortable, paginated (all client-side) ──
function IrmStockPanel({ stock }: { stock: EngineerStockItem[] }) {
  const t = usePortalTable(stock, {
    searchText: (s) => `${s.itemName} ${s.itemCode}`,
    comparators: {
      item: (a, b) => a.itemName.localeCompare(b.itemName),
      qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
      updated: (a, b) => dateVal(a.lastMovedAt) - dateVal(b.lastMovedAt),
    },
    initialSort: { key: "updated", dir: "desc" },
    pageSize: PAGE_SIZE,
  });

  const headers: React.ReactNode[] = [
    <SortHeader key="item" label="Item" sortKey="item" sort={t.sort} onSort={t.toggleSort} />,
    "Code",
    <SortHeader key="qty" label="On hand" sortKey="qty" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="updated" label="Last updated" sortKey="updated" sort={t.sort} onSort={t.toggleSort} />,
  ];

  return (
    <>
      <PortalSearch value={t.query} onChange={t.setQuery} placeholder="Search item or code…" />
      {t.noMatches ? (
        <NoMatches />
      ) : (
        <TableCard
          headers={headers}
          minWidth={520}
          fill
          footer={t.total > 0 ? <Pagination embedded page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} /> : null}
        >
          {t.rows.map((s) => (
            <tr key={s.irmItemId} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4 font-semibold text-[var(--ink)]">{s.itemName}</td>
              <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{s.itemCode}</td>
              <td className="cell-y px-4 font-bold text-[var(--ink)]">
                {s.quantityOnHand}
                {s.baseUnit ? ` ${s.baseUnit}` : ""}
              </td>
              <td className="cell-y px-4 text-[var(--muted)]">{fmtDate(s.lastMovedAt)}</td>
            </tr>
          ))}
        </TableCard>
      )}
    </>
  );
}

// ── Customer consignment held — searchable, filterable by customer, sortable, paginated ──
function CustomerStockPanel({ holdings }: { holdings: CustomerHolding[] }) {
  const [customer, setCustomer] = React.useState("");

  // Customer dropdown options, from the distinct customers actually present in the holdings.
  const customerOptions = React.useMemo(() => {
    const names = [...new Set(holdings.map((h) => h.customerName).filter((n): n is string => Boolean(n)))].sort((a, b) =>
      a.localeCompare(b),
    );
    return [{ value: "", label: "All customers" }, ...names.map((n) => ({ value: n, label: n }))];
  }, [holdings]);

  // Reconcile a stale selection after a live refetch drops that customer's holdings — otherwise the
  // filter would strand the view on an un-clearable "no matches" (the dropdown itself can hide). Clearing
  // state during render is the React-recommended pattern; `activeCustomer` is the value used THIS render.
  const activeCustomer = customerOptions.some((o) => o.value === customer) ? customer : "";
  if (activeCustomer !== customer) setCustomer("");

  const t = usePortalTable(holdings, {
    searchText: (h) => `${h.itemName} ${h.customerName ?? ""}`,
    comparators: {
      item: (a, b) => a.itemName.localeCompare(b.itemName),
      customer: (a, b) => (a.customerName ?? "").localeCompare(b.customerName ?? ""),
      qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
    },
    initialSort: { key: "item", dir: "asc" },
    filter: activeCustomer ? (h) => (h.customerName ?? "") === activeCustomer : undefined,
    filterToken: activeCustomer,
    pageSize: PAGE_SIZE,
  });

  const headers: React.ReactNode[] = [
    <SortHeader key="item" label="Item" sortKey="item" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="customer" label="Customer" sortKey="customer" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="qty" label="On hand" sortKey="qty" sort={t.sort} onSort={t.toggleSort} />,
  ];

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
        <PortalSearch value={t.query} onChange={t.setQuery} placeholder="Search item or customer…" />
        {(customerOptions.length > 2 || activeCustomer !== "") && (
          <Select size="sm" value={activeCustomer} onChange={setCustomer} options={customerOptions} ariaLabel="Filter by customer" />
        )}
      </div>
      {t.noMatches ? (
        <NoMatches />
      ) : (
        <TableCard
          headers={headers}
          minWidth={400}
          fill
          footer={t.total > 0 ? <Pagination embedded page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} /> : null}
        >
          {t.rows.map((h) => (
            <tr key={h.id} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4 font-semibold text-[var(--ink)]">{h.itemName}</td>
              <td className="cell-y px-4 text-[var(--muted)]">{h.customerName ?? "—"}</td>
              <td className="cell-y px-4 font-bold text-[var(--ink)]">{h.quantityOnHand}</td>
            </tr>
          ))}
        </TableCard>
      )}
    </>
  );
}

// ── Misc (free-text) items — searchable by name, sortable, paginated ──
function MiscStockPanel({ misc }: { misc: MiscHeldItem[] }) {
  const t = usePortalTable(misc, {
    searchText: (m) => m.itemName,
    comparators: {
      item: (a, b) => a.itemName.localeCompare(b.itemName),
      qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
    },
    initialSort: { key: "item", dir: "asc" },
    pageSize: PAGE_SIZE,
  });

  const headers: React.ReactNode[] = [
    <SortHeader key="item" label="Item" sortKey="item" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="qty" label="On hand" sortKey="qty" sort={t.sort} onSort={t.toggleSort} />,
  ];

  return (
    <>
      <PortalSearch value={t.query} onChange={t.setQuery} placeholder="Search item…" />
      {t.noMatches ? (
        <NoMatches />
      ) : (
        <TableCard
          headers={headers}
          minWidth={320}
          fill
          footer={t.total > 0 ? <Pagination embedded page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} /> : null}
        >
          {t.rows.map((m) => (
            <tr key={m.itemName} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4 font-semibold text-[var(--ink)]">{m.itemName}</td>
              <td className="cell-y px-4 font-bold text-[var(--ink)]">{m.quantityOnHand}</td>
            </tr>
          ))}
        </TableCard>
      )}
    </>
  );
}

// ── Hired kit held by the engineer — sorted by DEADLINE, not by name ──────────────────────────
//
// The only pool on this page that isn't ours. IRM and misc are company stock, consignment belongs to
// a customer we are already working for; a hire belongs to an outside provider, bills every day it is
// out, and has to be physically back at its depot before they collect it. So the default sort is the
// deadline and the leading column is the date — the opposite of every other panel here, on purpose.
//
// `dueInDays` / `overdue` come from the SERVER, resolved in the company timezone. Never recompute
// them from `hireEndDate` in the browser: a device in another zone, or with a wrong clock, would
// disagree with the warehouse about which day it is, on the one figure that exists to name a day.
// The wording itself lives in ./hireDeadline.ts so it can be unit-tested without a DOM.

function RentalHoldingsPanel({ rentals }: { rentals: RentalHolding[] }) {
  const t = usePortalTable(rentals, {
    searchText: (r) => r.itemName,
    comparators: {
      item: (a, b) => a.itemName.localeCompare(b.itemName),
      qty: (a, b) => a.quantityOnHand - b.quantityOnHand,
      // Undated hires sort last in the DEFAULT (ascending) order, which is the one that matters: an
      // unknown deadline is not an urgent one, and letting it lead would push a genuinely overdue
      // hire off the top. usePortalTable negates the comparator for "desc", so they lead there —
      // the same direction-dependence every other null-tolerant comparator on this page has.
      //
      // A large FINITE sentinel, not Infinity: two undated rows would otherwise give Infinity −
      // Infinity = NaN, and a comparator returning NaN makes the sort order undefined.
      due: (a, b) => (a.hireEndDate ? dateVal(a.hireEndDate) : UNDATED) - (b.hireEndDate ? dateVal(b.hireEndDate) : UNDATED),
    },
    initialSort: { key: "due", dir: "asc" },
    pageSize: PAGE_SIZE,
  });

  const headers: React.ReactNode[] = [
    <SortHeader key="item" label="Item" sortKey="item" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="qty" label="Holding" sortKey="qty" sort={t.sort} onSort={t.toggleSort} />,
    <SortHeader key="due" label="Return by" sortKey="due" sort={t.sort} onSort={t.toggleSort} />,
  ];

  const overdue = rentals.filter((r) => r.overdue).length;

  return (
    <>
      {overdue > 0 && (
        <div className="mb-3">
          <Notice
            msg={{
              // "warn", not "error": by this file's own rule (noticeTone.ts) red is for broken or
              // blocked, and nothing here is blocked — the engineer can still do everything. It is a
              // real cost leaking, so it earns a banner, but it is an advisory to act on.
              type: "warn",
              text:
                `${overdue} hired item${overdue === 1 ? " is" : "s are"} past the return date. ` +
                `Hired kit keeps costing while it's out and has to go back to the provider — take ${overdue === 1 ? "it" : "them"} to the warehouse.`,
            }}
            size="sm"
          />
        </div>
      )}
      <PortalSearch value={t.query} onChange={t.setQuery} placeholder="Search item…" />
      {t.noMatches ? (
        <NoMatches />
      ) : (
        <TableCard
          headers={headers}
          minWidth={460}
          fill
          footer={t.total > 0 ? <Pagination embedded page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} /> : null}
        >
          {t.rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
              <td className="cell-y px-4 font-semibold text-[var(--ink)]">{r.itemName}</td>
              <td className="cell-y px-4 font-bold text-[var(--ink)]">{r.quantityOnHand}</td>
              <td className="cell-y px-4">
                <span className={`font-semibold ${r.overdue ? "text-[var(--neg)]" : "text-[var(--ink)]"}`}>
                  {r.hireEndDate ? formatCalendarDay(r.hireEndDate) : "—"}
                </span>
                <span className={`block text-xs ${r.overdue ? "font-semibold text-[var(--neg)]" : "text-[var(--muted)]"}`}>
                  {dueLabel(r)}
                </span>
              </td>
            </tr>
          ))}
        </TableCard>
      )}
    </>
  );
}

export function EngineerInventory() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Derive section from the URL; default to "irm".
  const section = (searchParams.get("section") as Section | null) ?? "irm";

  // Patch URL params without clobbering other query params in any host page.
  const patch = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const [stock, setStock] = React.useState<EngineerStockItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  const [customerStock, setCustomerStock] = React.useState<CustomerHolding[]>([]);
  const [customerLoading, setCustomerLoading] = React.useState(true);
  const [customerMsg, setCustomerMsg] = React.useState<Msg>(null);

  const [misc, setMisc] = React.useState<MiscHeldItem[]>([]);
  const [miscLoading, setMiscLoading] = React.useState(true);
  const [miscMsg, setMiscMsg] = React.useState<Msg>(null);

  const [rentals, setRentals] = React.useState<RentalHolding[]>([]);
  const [rentalLoading, setRentalLoading] = React.useState(true);
  const [rentalMsg, setRentalMsg] = React.useState<Msg>(null);

  const [reloadTick, setReloadTick] = React.useState(0);

  // Live-refresh on any goods event (issue / return / reconcile). Only the ACTIVE tab refetches
  // (each effect early-returns unless its section is showing), so a goods event never fans out into
  // fetches for tabs the engineer isn't looking at.
  useGoodsSocket(React.useCallback(() => setReloadTick((t) => t + 1), []));

  // Company (IRM) held stock — fetched only while its tab is active. Each balance carries its own
  // lastMovedAt (the "Last updated" column), so no second /overview round-trip is needed.
  React.useEffect(() => {
    if (section !== "irm") return;
    let active = true;
    // No synchronous setLoading(true): the state starts true (first open shows the skeleton) and
    // socket-driven refetches refresh silently over the existing rows.
    engineerService
      .getOwnStock()
      .then((list) => active && (setStock(list), setMsg(null)))
      .catch((err) => active && setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your stock." }))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [section, reloadTick]);

  // Customer consignment held — fetched only while its tab is active.
  React.useEffect(() => {
    if (section !== "customer") return;
    let active = true;
    engineerService
      .getOwnCustomerStock()
      .then((list) => active && (setCustomerStock(list), setCustomerMsg(null)))
      .catch((err) => active && setCustomerMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load customer stock." }))
      .finally(() => active && setCustomerLoading(false));
    return () => {
      active = false;
    };
  }, [section, reloadTick]);

  // Hired kit held — fetched only while its tab is active, like the rest.
  React.useEffect(() => {
    if (section !== "rental") return;
    let active = true;
    engineerService
      .getOwnRentals()
      .then((list) => active && (setRentals(list), setRentalMsg(null)))
      .catch((err) => active && setRentalMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load hired kit." }))
      .finally(() => active && setRentalLoading(false));
    return () => {
      active = false;
    };
  }, [section, reloadTick]);

  // Misc items issued (free-text, no stock balance) — fetched only while its tab is active.
  React.useEffect(() => {
    if (section !== "misc") return;
    let active = true;
    engineerService
      .getOwnMiscStock()
      .then((list) => active && (setMisc(list), setMiscMsg(null)))
      .catch((err) => active && setMiscMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load misc items." }))
      .finally(() => active && setMiscLoading(false));
    return () => {
      active = false;
    };
  }, [section, reloadTick]);

  return (
    <div className="stack flex h-full flex-col">
      {/* Sub-tabs */}
      <div className="flex shrink-0 items-center gap-2">
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => patch({ section: key !== "irm" ? key : null })}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
              section === key
                ? "bg-[var(--accent)] text-white"
                : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Company (IRM) */}
      {section === "irm" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {msg && <Notice msg={msg} />}
          {loading ? (
            <TableCardSkeleton headers={IRM_HEADERS} cells={IRM_SKELETON} minWidth={520} fill />
          ) : msg?.type === "error" && stock.length === 0 ? null : stock.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <EmptyState icon={Boxes} title="No IRM stock on hand" hint="Stock dispatched to you from a warehouse will appear here." />
            </div>
          ) : (
            <IrmStockPanel stock={stock} />
          )}
        </div>
      )}

      {/* Customer consignment */}
      {section === "customer" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-xs text-[var(--muted)]">Consignment items issued from a job — return these when the job is complete.</p>
          {customerMsg && <Notice msg={customerMsg} />}
          {customerLoading ? (
            <TableCardSkeleton headers={CUSTOMER_HEADERS} cells={["h-3 w-44", "h-3 w-28", "h-3 w-12"]} minWidth={400} fill />
          ) : customerMsg?.type === "error" && customerStock.length === 0 ? null : customerStock.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <EmptyState icon={Package} title="No customer stock held" hint="Customer consignment items issued to you for a job will appear here." />
            </div>
          ) : (
            <CustomerStockPanel holdings={customerStock} />
          )}
        </div>
      )}

      {/* Hired kit — equipment on hire that has to go back to the warehouse before its deadline */}
      {section === "rental" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-xs text-[var(--muted)]">
            Equipment we&apos;re renting, not stock we own. Take it back to the warehouse by its return date so it can go
            to the provider — if you still need one past that date, ask the warehouse to extend the hire.
          </p>
          {rentalMsg && <Notice msg={rentalMsg} />}
          {rentalLoading ? (
            <TableCardSkeleton headers={RENTAL_HEADERS} cells={["h-3 w-44", "h-3 w-12", "h-3 w-28"]} minWidth={460} fill />
          ) : rentalMsg?.type === "error" && rentals.length === 0 ? null : rentals.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <EmptyState icon={CalendarClock} title="No hired kit with you" hint="Rental equipment issued to you for a job will appear here, with its return date." />
            </div>
          ) : (
            <RentalHoldingsPanel rentals={rentals} />
          )}
        </div>
      )}

      {/* Movements — the engineer's own stock movement history (van company + customer consignment) */}
      {section === "movements" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-xs text-[var(--muted)]">Every movement of stock in and out of your van — dispatches, transfers, job issues, returns and consumption. Newest first.</p>
          <div className="min-h-0 flex-1">
            <MovementFeed fetcher={ownMovementsFetcher} scope="engineer" />
          </div>
        </div>
      )}

      {/* Misc */}
      {section === "misc" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="shrink-0 text-xs text-[var(--muted)]">Free-text items handed to you on a job (no barcode / not stock-tracked).</p>
          {miscMsg && <Notice msg={miscMsg} />}
          {miscLoading ? (
            <TableCardSkeleton headers={MISC_HEADERS} cells={["h-3 w-44", "h-3 w-12"]} minWidth={320} fill />
          ) : miscMsg?.type === "error" && misc.length === 0 ? null : misc.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <EmptyState icon={Wrench} title="No misc items" hint="Misc kit items issued to you for a job will appear here." />
            </div>
          ) : (
            <MiscStockPanel misc={misc} />
          )}
        </div>
      )}
    </div>
  );
}
