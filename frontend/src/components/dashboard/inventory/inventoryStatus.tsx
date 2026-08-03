import type { InventoryStatus } from "@/types/inventory";

// Shared presentation helpers for the inventory module — status badge, UK date, money.

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

const INVENTORY_STATUS_CLASSES: Record<InventoryStatus, string> = {
  in_stock: "bg-emerald-500/12 text-emerald-600",
  low_stock: "bg-amber-500/12 text-amber-600",
  out_of_stock: "bg-rose-500/12 text-rose-600",
};

export function InventoryStatusBadge({ status }: { status: InventoryStatus }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold ${INVENTORY_STATUS_CLASSES[status] ?? INVENTORY_STATUS_CLASSES.in_stock}`}>
      {INVENTORY_STATUS_LABELS[status] ?? status}
    </span>
  );
}

// Re-exported so this module's importers keep the same entry point. Both local copies had drifted:
// `formatDate` rendered 03/08/2026 against the DD Mon YYYY that Settings → Company promises, and
// `formatDateTime` used a bare toLocaleString, which appends seconds to every ledger row. See
// lib/formatDate.ts.
export { formatDate, formatDateTime } from "@/lib/formatDate";

// Money in the row's currency (value is already in major units / pounds).
export function formatMoney(value: number, currency = "GBP"): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

// A signed quantity delta for the ledger (+5 / −3), using a real minus sign.
export function formatDelta(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

// Humanise a ledger transaction type ("transfer_in" → "Transfer in").
export function formatTxnType(type: string): string {
  const label = type.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
