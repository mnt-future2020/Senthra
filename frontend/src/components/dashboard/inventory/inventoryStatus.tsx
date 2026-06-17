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

// UK date — DD/MM/YYYY (en-GB).
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB");
}

// UK date + time, for the ledger / movement timestamps.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB");
}

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
