"use client";

import * as React from "react";

import { Skeleton } from "@/components/ui/Skeleton";
import type { Ownership, StockPositionStatus } from "@/types/stock-position";

/**
 * In this business, company-owned stock is the IRM catalogue, so we label the owner "IRM"
 * (which staff recognise) rather than the abstract "Company". Customer-owned stays "Customer".
 */
export function ownerLabel(o: Ownership): string {
  return o === "company" ? "IRM" : "Customer";
}

export function OwnerTag({ ownership }: { ownership: Ownership }) {
  const isIrm = ownership === "company";
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
        isIrm ? "bg-[var(--surface-2)] text-[var(--muted)]" : "bg-[var(--accent-10)] text-[var(--accent)]"
      }`}
    >
      {ownerLabel(ownership)}
    </span>
  );
}

const STATUS_STYLE: Record<StockPositionStatus, { label: string; cls: string }> = {
  in_stock: { label: "In stock", cls: "text-[var(--pos)] bg-emerald-500/10" },
  low_stock: { label: "Low stock", cls: "text-[var(--warn)] bg-amber-500/10" },
  out_of_stock: { label: "Out of stock", cls: "text-[var(--neg)] bg-red-500/10" },
  on_van: { label: "On van", cls: "text-[var(--accent)] bg-[var(--accent-10)]" },
  damaged: { label: "Damaged", cls: "text-[var(--neg)] bg-red-500/10" },
  overdue: { label: "Overdue", cls: "text-[var(--warn)] bg-amber-500/10" },
};

export function PositionStatusBadge({ status }: { status: StockPositionStatus }) {
  const s = STATUS_STYLE[status] ?? {
    label: status.replace(/_/g, " "),
    cls: "text-[var(--muted)] bg-[var(--surface-2)]",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${s.cls}`}>
      {s.label}
    </span>
  );
}

/** Skeleton rows that match the live table's padding — the app-wide loading convention. */
export function TableSkeletonRows({ cols, rows = 8 }: { cols: number; rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-[var(--border)] last:border-0">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="cell-y px-4">
              <Skeleton className="h-3 w-16" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}
