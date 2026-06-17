// Warehouse Inventory types — mirror the backend Public* DTOs. The module is READ + TRANSFER only.
// Quantities are integers; `value`/`valuePence` are read-only (onHand × IRM standard cost).

export type InventoryStatus = "in_stock" | "low_stock" | "out_of_stock";

// One on-hand balance row (item × warehouse) for the inventory list.
export interface InventoryBalance {
  id: string;
  irmItemId: string;
  warehouseId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  categoryName: string | null;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number | null;
  unitCostPence: number;
  valuePence: number;
  value: number; // pounds (valuePence / 100)
  currency: string;
  status: InventoryStatus;
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  lastMovementAt: string;
}

// Balance detail adds the read-only incoming (open-PO remaining) + outgoing (reserved) figures.
export interface InventoryDetail extends InventoryBalance {
  incoming: number;
  outgoing: number;
}

// One immutable ledger entry (Transaction History tab).
export interface InventoryTransaction {
  id: string;
  date: string;
  type: string; // goods_in | transfer_in | transfer_out | ...
  quantityDelta: number;
  balanceAfter: number;
  warehouseName: string;
  reference: string | null;
  notes: string | null;
  createdBy: string | null;
}

// One received row for the Purchase History tab (read-only, from Goods In).
export interface PurchaseHistoryRow {
  grnCode: string;
  poCode: string | null;
  supplierName: string | null;
  receivedQuantity: number;
  receivedDate: string;
}

// A warehouse → warehouse stock movement record.
export interface StockTransfer {
  id: string;
  code: string; // TRF-0001
  irmItemId: string;
  itemName: string;
  sku: string | null;
  fromWarehouseId: string;
  fromWarehouseName: string;
  fromWarehouseCode: string | null;
  toWarehouseId: string;
  toWarehouseName: string;
  toWarehouseCode: string | null;
  quantity: number;
  movementDate: string;
  status: string;
  referenceNumber: string | null;
  description: string | null;
  internalNotes: string | null;
  createdBy: string | null;
  createdAt: string;
}

// Live availability for the transfer form (onHand − reserved at a given item × warehouse).
export interface Availability {
  irmItemId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  available: number;
}
