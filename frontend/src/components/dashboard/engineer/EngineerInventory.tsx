"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes, History, Package, Wrench } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import type { MiscHeldItem } from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { EmptyState, fmtDate, PortalHeader, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
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

// The engineer movement feed is hard-scoped to the signed-in engineer on the backend.
const ownMovementsFetcher: MovementFetcher = (params) => engineerService.getOwnMovements(params);

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
  // Best-effort "last updated" per IRM item, derived FRONTEND-ONLY from the engineer's recent
  // stock-ledger activity (/engineer/overview). Items without a recent entry show "—".
  const [lastUpdated, setLastUpdated] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  const [customerStock, setCustomerStock] = React.useState<CustomerHolding[]>([]);
  const [customerLoading, setCustomerLoading] = React.useState(true);
  const [customerMsg, setCustomerMsg] = React.useState<Msg>(null);

  const [misc, setMisc] = React.useState<MiscHeldItem[]>([]);
  const [miscLoading, setMiscLoading] = React.useState(true);
  const [miscMsg, setMiscMsg] = React.useState<Msg>(null);

  const [reloadTick, setReloadTick] = React.useState(0);

  // Live-refresh on any goods event (issue / return / reconcile).
  useGoodsSocket(React.useCallback(() => setReloadTick((t) => t + 1), []));

  // IRM stock + last-updated.
  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await engineerService.getOwnStock();
        if (active) setStock(list);
      } catch (err) {
        if (active) {
          setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your stock." });
          setLoading(false);
        }
        return;
      }
      try {
        const overview = await engineerService.getOwnOverview();
        if (active) {
          const map: Record<string, string> = {};
          for (const a of overview.recentActivity) if (!map[a.itemCode]) map[a.itemCode] = a.createdAt;
          setLastUpdated(map);
        }
      } catch {
        // ignore — timestamps fall back to "—"
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [reloadTick]);

  // Customer consignment held.
  React.useEffect(() => {
    let active = true;
    engineerService
      .getOwnCustomerStock()
      .then((list) => active && setCustomerStock(list))
      .catch((err) => active && setCustomerMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load customer stock." }))
      .finally(() => active && setCustomerLoading(false));
    return () => {
      active = false;
    };
  }, [reloadTick]);

  // Misc items issued (free-text, no stock balance).
  React.useEffect(() => {
    let active = true;
    engineerService
      .getOwnMiscStock()
      .then((list) => active && setMisc(list))
      .catch((err) => active && setMiscMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load misc items." }))
      .finally(() => active && setMiscLoading(false));
    return () => {
      active = false;
    };
  }, [reloadTick]);

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
          ) : msg?.type === "error" ? null : stock.length === 0 ? (
            <EmptyState icon={Boxes} title="No IRM stock on hand" hint="Stock dispatched to you from a warehouse will appear here." />
          ) : (
            <TableCard headers={IRM_HEADERS} minWidth={520} fill>
              {stock.map((s) => (
                <tr key={s.irmItemId} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{s.itemName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{s.itemCode}</td>
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">
                    {s.quantityOnHand}
                    {s.baseUnit ? ` ${s.baseUnit}` : ""}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{fmtDate(lastUpdated[s.itemCode] ?? null)}</td>
                </tr>
              ))}
            </TableCard>
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
          ) : customerMsg?.type === "error" ? null : customerStock.length === 0 ? (
            <EmptyState icon={Package} title="No customer stock held" hint="Customer consignment items issued to you for a job will appear here." />
          ) : (
            <TableCard headers={CUSTOMER_HEADERS} minWidth={400} fill>
              {customerStock.map((h) => (
                <tr key={h.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{h.itemName}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{h.customerName ?? "—"}</td>
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">{h.quantityOnHand}</td>
                </tr>
              ))}
            </TableCard>
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
          ) : miscMsg?.type === "error" ? null : misc.length === 0 ? (
            <EmptyState icon={Wrench} title="No misc items" hint="Misc kit items issued to you for a job will appear here." />
          ) : (
            <TableCard headers={MISC_HEADERS} minWidth={320} fill>
              {misc.map((m, i) => (
                <tr key={`${m.itemName}-${i}`} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{m.itemName}</td>
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">{m.quantityOnHand}</td>
                </tr>
              ))}
            </TableCard>
          )}
        </div>
      )}
    </div>
  );
}
