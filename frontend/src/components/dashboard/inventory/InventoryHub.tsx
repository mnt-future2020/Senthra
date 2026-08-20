"use client";

import * as React from "react";
import { MinusCircle, X } from "lucide-react";

import { InventoryView } from "./InventoryView";
import { MovementsTable } from "./MovementsTable";
import { StockPositionTable } from "./StockPositionTable";
import { EngineersOverview } from "./EngineersOverview";
import { ReorderWorkbench } from "./ReorderWorkbench";
import { SummaryCards } from "./SummaryCards";
import { AdjustStockForm } from "./AdjustStockForm";
import { CustomerTransferForm } from "./CustomerTransferForm";
import { RestoreDamagedDialog } from "./RestoreDamagedDialog";
import { IrmPanel, IRM_TABS, type IrmTab } from "@/components/dashboard/irm/IrmPanel";
import { RentalPanel, RENTAL_TABS, type RentalTab } from "@/components/dashboard/rentals/RentalPanel";
import { TabCount } from "@/components/dashboard/shell/TabCount";
import { AttentionBar } from "@/components/dashboard/shell/AttentionBar";
import { ArrowRight, RotateCcw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import type { StockPosition } from "@/types/stock-position";

type Lens = "all" | "company" | "rental" | "customer" | "engineer" | "damaged" | "movements" | "reorder";
type IrmSubTab = "stock" | "catalogue";

// `attention` = a key from the backend attention catalog. Present only where the tab IS a work queue
// (Reorder). The other lenses are reference views — a count on them would be a metric, not a backlog.
// `perm` is present only where a lens needs MORE than inventory.view. Rentals is the first such
// lens: without this a holder of inventory.view saw a tab that answered 403 and offered no
// sub-tabs to escape from.
const TABS: { id: Lens; label: string; attention?: string; perm?: string }[] = [
  { id: "all", label: "All Inventory" },
  { id: "company", label: "IRM" },
  // Rentals sits beside IRM rather than in the sidebar: to a user these are two catalogues of the
  // same kind, so they are reached the same way. Hired equipment is still NOT stock — it never
  // enters Goods In and never becomes a balance — which is why it is its own lens, not a filter.
  { id: "rental", label: "Rentals", attention: "rentals.overdue", perm: "rentals.view" },
  { id: "customer", label: "Customer" },
  { id: "engineer", label: "Engineer" },
  { id: "damaged", label: "Damaged" },
  { id: "movements", label: "Movements" },
  { id: "reorder", label: "Reorder", attention: "inv.reorder" },
];

// A form that takes over the content area, with its own header + close + scroll.
function FormPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-auto">
      <div
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-[var(--ink)]">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-all hover:text-[var(--ink)]"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const actionBtn =
  "flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--ink)] transition-all hover:border-[var(--accent)]";

export function InventoryHub() {
  const { can } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // The active lens lives in ?tab= so it survives a refresh and is restored on back-navigation
  // (e.g. returning from an item detail) — same pattern as the Warehouses / IRM modules.
  const tabParam = searchParams.get("tab");
  const visibleLenses = TABS.filter((t) => !t.perm || can(t.perm));
  // Clamped to a lens this actor may actually see, so a stale bookmark or a link from someone with
  // wider rights lands on a real view rather than a permission error.
  const lens: Lens = visibleLenses.some((t) => t.id === tabParam) ? (tabParam as Lens) : "all";

  // The IRM sub-views also live in the URL so they survive a refresh (like the lens ?tab=): the
  // "In stock" vs "Catalogue" toggle is ?irm=, and the Catalogue/Types/Categories sub-tab is ?cat=.
  const irmSubTab: IrmSubTab = searchParams.get("irm") === "catalogue" ? "catalogue" : "stock";

  // Rentals sub-tabs, same shape as the IRM catalogue's: the active one lives in ?rental= so a
  // refresh — and the deadline badges' deep link — land on the tab they name.
  const visibleRentalTabs = RENTAL_TABS.filter((t) => can(t.perm));
  const rentalParam = searchParams.get("rental");
  const rentalActive: RentalTab = visibleRentalTabs.some((t) => t.id === rentalParam)
    ? (rentalParam as RentalTab)
    : (visibleRentalTabs[0]?.id ?? "catalogue");

  // IRM Catalogue sub-tabs the user can see, and the effective active one (from ?cat=, clamped to a visible tab).
  const visibleIrmTabs = IRM_TABS.filter((t) => can(t.perm));
  const catParam = searchParams.get("cat");
  const irmCatActive: IrmTab = visibleIrmTabs.some((t) => t.id === catParam)
    ? (catParam as IrmTab)
    : (visibleIrmTabs[0]?.id ?? "catalogue");

  // Switching an IRM sub-view writes the nav into the URL and clears the per-view filters
  // (?q/?status/?sort/?page) so the next view starts on a clean slate — same "fresh on nav" behaviour
  // as the module panels. The lens (?tab=company) is always preserved.
  const setIrmSubTab = (v: IrmSubTab) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "company");
    if (v === "catalogue") params.set("irm", "catalogue");
    else params.delete("irm");
    for (const k of ["q", "status", "sort", "page", "cat"]) params.delete(k);
    router.replace(`/dashboard/inventory?${params.toString()}`, { scroll: false });
  };
  const setIrmCatTab = (v: IrmTab) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "company");
    params.set("irm", "catalogue");
    params.set("cat", v);
    for (const k of ["q", "status", "sort", "page"]) params.delete(k);
    router.replace(`/dashboard/inventory?${params.toString()}`, { scroll: false });
  };
  const setRentalTab = (v: RentalTab) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "rental");
    params.set("rental", v);
    // Fresh on nav, matching setIrmCatTab: ?status belongs to On hire and would silently filter the
    // catalogue by a value it does not understand — and ?dir / the date period belong to Movements.
    for (const k of ["q", "status", "sort", "page", "category", "dir", "from", "to", "live"]) params.delete(k);
    router.replace(`/dashboard/inventory?${params.toString()}`, { scroll: false });
  };

  const [showAdjust, setShowAdjust] = React.useState(false);
  const [transferRow, setTransferRow] = React.useState<StockPosition | null>(null);
  const [restoreRow, setRestoreRow] = React.useState<StockPosition | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const triggerRefresh = React.useCallback(() => setRefreshKey((k) => k + 1), []);
  useGoodsSocket(triggerRefresh);

  // Reset any open form when switching lens so a form never lingers on the wrong tab, then write the
  // lens into the URL (replace, so tab switches don't stack history entries).
  const switchLens = (l: Lens) => {
    setShowAdjust(false);
    setTransferRow(null);
    setRestoreRow(null);
    router.replace(`/dashboard/inventory?tab=${l}`, { scroll: false });
  };

  const formOpen =
    (lens === "company" && showAdjust) ||
    (lens === "customer" && Boolean(transferRow)) ||
    (lens === "damaged" && Boolean(restoreRow));

  return (
    <div className="stack flex h-full flex-col">
      {/* Collapsible here specifically: this page is laid out full-height with an internally-
          scrolling table, so the header is pinned and costs its height on every screen. On a 1024px
          laptop that matters — five stacked bands (this, the summary, the lens tabs, the sub-tabs and
          the filter row) sit above the data. */}
      <SummaryCards key={`cards-${refreshKey}`} active={lens} onSelect={switchLens} />

      {/* Lens tabs, with the sidebar-badge breakdown riding the same row.
          Both chips open the Reorder tab — "Items to reorder" is that tab, and "Critical stock" is
          that tab pre-filtered to its urgent slice — so this is where they belong, and on a row that
          already exists they cost no vertical space. They previously sat in a block of their own
          above, paying the layout's 20px flex gap on top of their own height. */}
      {/* The tabs SCROLL sideways rather than wrapping. Eight lenses plus their badges no longer fit
          one line on a 1024px laptop, and wrapping spent a second ~38px band — on the page that is
          already five bands deep — to show one stray tab. Same treatment the IRM detail page's tab
          strip gets. Horizontal scrolling is the cheap direction here: the vertical axis is the one
          rows are counted in. */}
      <div className="flex shrink-0 items-end gap-2 border-b border-[var(--border)]">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {visibleLenses.map((t) => (
            <button
              key={t.id}
              onClick={() => switchLens(t.id)}
              className={`shrink-0 border-b-2 px-3.5 py-2 text-sm transition-colors ${
                lens === t.id
                  ? "border-[var(--accent)] font-semibold text-[var(--ink)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {t.label}
              {t.attention ? <TabCount attentionKey={t.attention} /> : null}
            </button>
          ))}
        </div>
        {/* Outside the scroller: these are the page's alerts, and scrolling them out of sight is the
            one thing they must never do. */}
        <AttentionBar nav="/dashboard/inventory" className="flex shrink-0 flex-wrap items-center gap-1.5 pb-1.5" />
      </div>

      {/* IRM lens action bar — toggle on the left; Adjust (In stock) or catalogue sub-tabs (Catalogue) on the right */}
      {!formOpen && lens === "company" && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
            {(["stock", "catalogue"] as IrmSubTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setIrmSubTab(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                  irmSubTab === t ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {t === "stock" ? "In stock" : "IRM Catalogue"}
              </button>
            ))}
          </div>

          {irmSubTab === "stock"
            ? can("inventory.adjust") && (
                <button type="button" onClick={() => setShowAdjust(true)} className={actionBtn}>
                  <MinusCircle className="h-4 w-4" /> Adjust stock
                </button>
              )
            : visibleIrmTabs.length > 1 && (
                <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
                  {visibleIrmTabs.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setIrmCatTab(t.id)}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                        irmCatActive === t.id ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
                      }`}
                    >
                      <t.icon className="h-4 w-4" />
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
        </div>
      )}
      {/* Rentals lens action bar — the module's own tabs, rendered by the host like IRM's. */}
      {!formOpen && lens === "rental" && visibleRentalTabs.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
            {visibleRentalTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setRentalTab(t.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                  rentalActive === t.id ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Content area — a single full-height region; the table scrolls inside it */}
      <div className="min-h-0 flex-1">
        {lens === "company" && showAdjust ? (
          <FormPanel title="Adjust stock — downward correction" onClose={() => setShowAdjust(false)}>
            <AdjustStockForm
              onDone={() => {
                setShowAdjust(false);
                triggerRefresh();
              }}
            />
          </FormPanel>
        ) : lens === "customer" && transferRow ? (
          <FormPanel title="Transfer customer stock" onClose={() => setTransferRow(null)}>
            <CustomerTransferForm
              row={transferRow}
              onDone={() => {
                setTransferRow(null);
                triggerRefresh();
              }}
            />
          </FormPanel>
        ) : lens === "damaged" && restoreRow ? (
          <FormPanel title="Restore damaged stock" onClose={() => setRestoreRow(null)}>
            <RestoreDamagedDialog
              row={restoreRow}
              onDone={() => {
                setRestoreRow(null);
                triggerRefresh();
              }}
            />
          </FormPanel>
        ) : lens === "all" ? (
          <StockPositionTable
            key={`all-${refreshKey}`}
            columns={["item", "sku", "ownership", "location", "qty", "available", "value", "status", "lastMovement"]}
            filters={["owner", "location", "warehouse", "category", "status"]}
            exportable
            emptyText="No stock recorded yet."
          />
        ) : lens === "company" ? (
          irmSubTab === "catalogue" ? (
            <React.Suspense fallback={null}>
              <IrmPanel key={`catalogue-${refreshKey}`} embedded tab={irmCatActive} />
            </React.Suspense>
          ) : (
            <div className="h-full">
              {/* Bounded, NOT scrolling: InventoryView scrolls its own table body and keeps its
                  filter row fixed (the inline-scroll contract the other lenses use). An
                  overflow-auto here would scroll the whole component instead, carrying the search
                  and filters off-screen with the rows. */}
              <InventoryView key={`company-${refreshKey}`} embedded />
            </div>
          )
        ) : lens === "rental" ? (
          <React.Suspense fallback={null}>
            <RentalPanel key={`rental-${refreshKey}`} embedded tab={rentalActive} />
          </React.Suspense>
        ) : lens === "customer" ? (
          <StockPositionTable
            key={`customer-${refreshKey}`}
            fixedFilters={{ ownership: "customer", location: "warehouse" }}
            columns={["item", "sku", "customer", "warehouse", "qty", "status", "lastMovement"]}
            filters={["warehouse", "customer", "status"]}
            exportable
            emptyText="No customer consignment in stock."
            rowAction={
              can("customer_stock.create")
                ? (row) => (
                    <button type="button" onClick={() => setTransferRow(row)} className={actionBtn}>
                      <ArrowRight className="h-3.5 w-3.5" /> Transfer
                    </button>
                  )
                : undefined
            }
          />
        ) : lens === "reorder" ? (
          // Deliberately NOT keyed on refreshKey: a goods-socket event would remount the workbench
          // and wipe the user's in-progress selection. Freshness is handled by its own Refresh
          // button + the server-side revalidation at generate time (stale rows are skipped/capped).
          <ReorderWorkbench />
        ) : lens === "engineer" ? (
          <EngineersOverview key={`engineer-${refreshKey}`} />
        ) : lens === "damaged" ? (
          <StockPositionTable
            key={`damaged-${refreshKey}`}
            fixedFilters={{ location: "damaged" }}
            columns={["item", "ownership", "warehouse", "qty", "lastMovement"]}
            filters={["warehouse", "owner"]}
            exportable
            emptyText="No damaged stock."
            rowAction={
              can("goods_management.reconcile")
                ? (row) => (
                    <button type="button" onClick={() => setRestoreRow(row)} className={actionBtn}>
                      <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </button>
                  )
                : undefined
            }
          />
        ) : (
          <MovementsTable key={`movements-${refreshKey}`} />
        )}
      </div>
    </div>
  );
}
