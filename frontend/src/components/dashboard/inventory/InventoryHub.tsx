"use client";

import * as React from "react";
import { MinusCircle, X } from "lucide-react";

import { ListPageHeader } from "@/components/ui/ListPageHeader";
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
import { ArrowRight, RotateCcw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";
import type { StockPosition } from "@/types/stock-position";

type Lens = "all" | "company" | "customer" | "engineer" | "damaged" | "movements" | "reorder";
type IrmSubTab = "stock" | "catalogue";

const TABS: { id: Lens; label: string }[] = [
  { id: "all", label: "All Inventory" },
  { id: "company", label: "IRM" },
  { id: "customer", label: "Customer" },
  { id: "engineer", label: "Engineer" },
  { id: "damaged", label: "Damaged" },
  { id: "movements", label: "Movements" },
  { id: "reorder", label: "Reorder" },
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
  const lens: Lens = TABS.some((t) => t.id === tabParam) ? (tabParam as Lens) : "all";

  // The IRM sub-views also live in the URL so they survive a refresh (like the lens ?tab=): the
  // "In stock" vs "Catalogue" toggle is ?irm=, and the Catalogue/Types/Categories sub-tab is ?cat=.
  const irmSubTab: IrmSubTab = searchParams.get("irm") === "catalogue" ? "catalogue" : "stock";

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
    <div className="flex h-full flex-col gap-4">
      <ListPageHeader title="Inventory Hub" subtitle="Everything the business is accountable for — by ownership and current location." />

      <SummaryCards key={`cards-${refreshKey}`} active={lens} onSelect={switchLens} />

      {/* Lens tabs */}
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => switchLens(t.id)}
            className={`-mb-px border-b-2 px-3.5 py-2 text-sm transition-colors ${
              lens === t.id
                ? "border-[var(--accent)] font-semibold text-[var(--ink)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {t.label}
          </button>
        ))}
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
            <div className="h-full overflow-auto">
              <InventoryView key={`company-${refreshKey}`} embedded />
            </div>
          )
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
