"use client";

import * as React from "react";
import { Boxes, Package } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { EmptyState, fmtDate, PortalHeader, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
import type { EngineerStockItem } from "@/types/engineer";
import type { CustomerHolding } from "@/types/goodsManagement";
import type { Msg } from "@/components/ui/types";
import { useGoodsSocket } from "@/hooks/useGoodsSocket";

// Engineer Portal — My Stock (IRM + customer consignment).
const HEADERS = ["Item", "Code", "On hand", "Last updated"];
const SKELETON_CELLS = ["h-3 w-44", "h-3 w-20", "h-3 w-14", "h-3 w-20"];
const CUSTOMER_HEADERS = ["Item", "Customer", "On hand"];

export function EngineerInventory() {
  const [stock, setStock] = React.useState<EngineerStockItem[]>([]);
  // Best-effort "last updated" per item, derived FRONTEND-ONLY from the engineer's existing recent
  // stock-ledger activity (/engineer/overview). Items without a recent ledger entry show "—". No
  // backend change — this only surfaces timestamps that already exist.
  const [lastUpdated, setLastUpdated] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [customerStock, setCustomerStock] = React.useState<CustomerHolding[]>([]);
  const [customerLoading, setCustomerLoading] = React.useState(true);
  const [customerMsg, setCustomerMsg] = React.useState<Msg>(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  // Live-refresh stock whenever a goods event fires (issue / return / reconcile).
  useGoodsSocket(React.useCallback(() => setReloadTick((t) => t + 1), []));

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
      // Map each item to its most recent ledger movement (activity is newest-first → first wins).
      // Best-effort: never blocks the stock list, and missing entries fall back to "—".
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

  // Fetch customer-consignment stock held by this engineer (separate endpoint, non-blocking).
  React.useEffect(() => {
    let active = true;
    engineerService
      .getOwnCustomerStock()
      .then((list) => {
        if (active) setCustomerStock(list);
      })
      .catch((err) => {
        if (active)
          setCustomerMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load customer stock." });
      })
      .finally(() => {
        if (active) setCustomerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadTick]);

  if (loading) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Stock" subtitle="IRM stock and customer consignment currently assigned to you." />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={520} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ── IRM stock section ──────────────────────────────────────────────── */}
      <div className="space-y-4">
        <PortalHeader title="Stock" subtitle="IRM stock and customer consignment currently assigned to you." />
        {msg && <Notice msg={msg} />}

        {msg?.type === "error" ? null : stock.length === 0 ? (
          <EmptyState icon={Boxes} title="No IRM stock on hand" hint="Stock dispatched to you from a warehouse will appear here." />
        ) : (
          <TableCard headers={HEADERS} minWidth={520}>
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

      {/* ── Customer consignment stock section ────────────────────────────── */}
      <div className="space-y-4">
        <div className="border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xs" style={{ borderRadius: "var(--radius)" }}>
          <h2 className="text-sm font-extrabold text-[var(--ink)]">Customer stock you&apos;re holding</h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">Consignment items issued from a job — return these when the job is complete.</p>
        </div>

        {customerMsg && <Notice msg={customerMsg} />}

        {customerLoading ? (
          <TableCardSkeleton headers={CUSTOMER_HEADERS} cells={["h-3 w-44", "h-3 w-28", "h-3 w-12"]} minWidth={400} />
        ) : customerMsg?.type === "error" ? null : customerStock.length === 0 ? (
          <EmptyState icon={Package} title="No customer stock held" hint="Customer consignment items issued to you for a job will appear here." />
        ) : (
          <TableCard headers={CUSTOMER_HEADERS} minWidth={400}>
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
    </div>
  );
}
