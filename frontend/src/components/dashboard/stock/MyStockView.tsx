"use client";

import * as React from "react";
import { Boxes, Loader2 } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import {
  EmptyState,
  HeaderCardSkeleton,
  PortalHeader,
  TableCard,
  TableCardSkeleton,
} from "@/components/dashboard/portal/portalUi";
import type { CustomerStockEntry } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const HEADERS = ["Item", "Warehouse", "SKU", "Qty", "Barcode", "Status", "Received"];
const SKELETON_CELLS = ["h-3 w-32", "h-3 w-28", "h-3 w-16", "h-3 w-10", "h-3 w-20", "h-3 w-14", "h-3 w-20"];

export function MyStockView() {
  const [entries, setEntries] = React.useState<CustomerStockEntry[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    customerService
      .getOwnStockEntries()
      .then((data) => { if (active) setEntries(data); })
      .catch((err) => {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your stock." });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <HeaderCardSkeleton />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} />
      </div>
    );
  }

  if (msg?.type === "error") return <Notice msg={msg} />;

  return (
    <div className="space-y-6">
      <PortalHeader
        title="My Stock"
        subtitle="All your stock currently held across our warehouses."
      />

      {!entries || entries.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No stock entries yet"
          hint="Once your stock is received at a warehouse, it will appear here."
        />
      ) : (
        <TableCard headers={HEADERS} minWidth={750}>
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">{e.itemName}</td>
              <td className="px-4 py-3">
                <div className="text-[var(--ink)]">{e.warehouseName}</div>
                <div className="font-mono text-[11px] text-[var(--faint)]">{e.warehouseCode}</div>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.sku ?? "—"}</td>
              <td className="px-4 py-3 font-bold text-[var(--ink)]">{e.quantity}</td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "—"}</td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    e.status === "active"
                      ? "bg-[var(--pos)]/12 text-[var(--pos)]"
                      : "bg-amber-500/15 text-amber-600"
                  }`}
                >
                  {e.status}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
            </tr>
          ))}
        </TableCard>
      )}
    </div>
  );
}
