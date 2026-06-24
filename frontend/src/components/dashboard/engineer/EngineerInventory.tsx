"use client";

import * as React from "react";
import { Boxes } from "lucide-react";

import * as engineerService from "@/services/engineer.service";
import { Notice } from "@/components/ui/Notice";
import { EmptyState, fmtDate, PortalHeader, TableCard, TableCardSkeleton } from "@/components/dashboard/portal/portalUi";
import type { EngineerStockItem } from "@/types/engineer";
import type { Msg } from "@/components/ui/types";

// Engineer Portal — My IRM Stock (read-only). Phase 1 shows only the engineer's held IRM stock;
// customer stock held by engineers is a later phase.
const HEADERS = ["Item", "Code", "On hand", "Last updated"];
const SKELETON_CELLS = ["h-3 w-44", "h-3 w-20", "h-3 w-14", "h-3 w-20"];

export function EngineerInventory() {
  const [stock, setStock] = React.useState<EngineerStockItem[]>([]);
  // Best-effort "last updated" per item, derived FRONTEND-ONLY from the engineer's existing recent
  // stock-ledger activity (/engineer/overview). Items without a recent ledger entry show "—". No
  // backend change — this only surfaces timestamps that already exist.
  const [lastUpdated, setLastUpdated] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

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
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <PortalHeader title="Stock" subtitle="IRM stock currently assigned to you." />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} minWidth={520} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PortalHeader title="Stock" subtitle="IRM stock currently assigned to you." />
      {msg && <Notice msg={msg} />}

      {msg?.type === "error" ? null : stock.length === 0 ? (
        <EmptyState icon={Boxes} title="No stock on hand" hint="Stock dispatched to you from a warehouse will appear here." />
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
  );
}
