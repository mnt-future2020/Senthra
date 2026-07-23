"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, History, Package, Search, Wrench } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import type { MiscHeldItem } from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { EmptyState, fmtDate, PortalHeader, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
import { PortalSearch, SortHeader, usePortalTable } from "@/components/dashboard/portal/portalTable";
import { MovementFeed, type MovementFetcher } from "@/components/dashboard/inventory/MovementFeed";
import type { EngineerStockItem } from "@/types/engineer";
import type { CustomerHolding } from "@/types/goodsManagement";
import type { Msg } from "@/components/ui/types";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";

// Engineer Portal — My Stock, split into sub-tabs: Company (IRM) / Customer / Misc / Movements.
type Section = "irm" | "customer" | "misc" | "movements";

const IRM_HEADERS = ["Item", "Code", "On hand", "Last updated"];
const IRM_SKELETON = ["h-3 w-44", "h-3 w-20", "h-3 w-14", "h-3 w-20"];
const CUSTOMER_HEADERS = ["Item", "Customer", "On hand"];
const MISC_HEADERS = ["Item", "On hand"];

const SECTIONS: { key: Section; label: string; icon: React.ElementType }[] = [
  { key: "irm", label: "Company (IRM)", icon: Boxes },
  { key: "customer", label: "Customer", icon: Package },
  { key: "misc", label: "Misc", icon: Wrench },
  { key: "movements", label: "Movements", icon: History },
];

const PAGE_SIZE = 15;

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
        <TableCard headers={headers} minWidth={520} fill>
          {t.rows.map((s) => (
            <tr key={s.irmItemId} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{s.itemName}</td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{s.itemCode}</td>
              <td className="px-4 py-3 font-bold text-[var(--ink)]">
                {s.quantityOnHand}
                {s.baseUnit ? ` ${s.baseUnit}` : ""}
              </td>
              <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(s.lastMovedAt)}</td>
            </tr>
          ))}
        </TableCard>
      )}
      {t.total > 0 && (
        <div className="shrink-0">
          <Pagination page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} />
        </div>
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
        <TableCard headers={headers} minWidth={400} fill>
          {t.rows.map((h) => (
            <tr key={h.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{h.itemName}</td>
              <td className="px-4 py-3 text-[var(--muted)]">{h.customerName ?? "—"}</td>
              <td className="px-4 py-3 font-bold text-[var(--ink)]">{h.quantityOnHand}</td>
            </tr>
          ))}
        </TableCard>
      )}
      {t.total > 0 && (
        <div className="shrink-0">
          <Pagination page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} />
        </div>
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
        <TableCard headers={headers} minWidth={320} fill>
          {t.rows.map((m) => (
            <tr key={m.itemName} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{m.itemName}</td>
              <td className="px-4 py-3 font-bold text-[var(--ink)]">{m.quantityOnHand}</td>
            </tr>
          ))}
        </TableCard>
      )}
      {t.total > 0 && (
        <div className="shrink-0">
          <Pagination page={t.page} totalPages={t.totalPages} total={t.total} label="items" onPage={t.setPage} />
        </div>
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
    <div className="flex h-full flex-col gap-5">
      <PortalHeader title="Stock" subtitle="Company (IRM), customer consignment and misc items currently assigned to you." />

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
