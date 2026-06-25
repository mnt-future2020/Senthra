"use client";

// DamagedStockView — renders damaged-stock rows for either a warehouse or a customer.
// Pass exactly one of warehouseId or customerId. No price/cost fields are displayed.

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import * as gmService from "@/services/goodsManagement.service";
import type { DamagedRow } from "@/types/goodsManagement";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function DamagedStockView({
  warehouseId,
  customerId,
}: {
  warehouseId?: string;
  customerId?: string;
}) {
  const [rows, setRows] = React.useState<DamagedRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    gmService
      .listDamaged({ warehouseId, customerId })
      .then((data) => {
        if (!active) return;
        setError(null);
        setRows(data);
      })
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Could not load damaged stock.",
        );
      });
    return () => {
      active = false;
    };
  }, [warehouseId, customerId]);

  if (error) {
    return (
      <p className="py-8 text-center text-sm font-semibold text-[var(--neg)]">
        {error}
      </p>
    );
  }

  if (rows === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-[var(--muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading damaged stock…</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-14 text-center">
        <AlertTriangle className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">
          No damaged stock
        </p>
        <p className="text-xs text-[var(--muted)]">
          Damaged items returned from engineers will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm" style={{ minWidth: 600 }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            <th className="px-4 py-3">Item</th>
            <th className="px-4 py-3">Owner</th>
            {warehouseId ? null : (
              <th className="px-4 py-3">Warehouse</th>
            )}
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3">Last updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-[var(--border)] align-middle last:border-0"
            >
              <td className="px-4 py-3 font-semibold text-[var(--ink)]">
                {row.itemName}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    row.ownerType === "company"
                      ? "bg-[var(--accent)]/12 text-[var(--accent)]"
                      : "bg-indigo-500/12 text-indigo-600"
                  }`}
                >
                  {row.ownerType === "company" ? "Company (IRM)" : "Customer"}
                </span>
              </td>
              {warehouseId ? null : (
                <td className="px-4 py-3 text-xs text-[var(--muted)]">
                  {row.warehouseName ?? "—"}
                </td>
              )}
              <td className="px-4 py-3 text-right font-bold text-[var(--neg)]">
                {row.quantity}
              </td>
              <td className="px-4 py-3 text-xs text-[var(--muted)]">
                {fmtDate(row.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
