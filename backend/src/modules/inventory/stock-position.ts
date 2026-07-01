export type Ownership = "company" | "customer";
export type LocationType = "warehouse" | "engineer" | "customer_site" | "damaged" | "transit";
export type StockPositionStatus =
  | "in_stock" | "low_stock" | "out_of_stock" | "on_van" | "damaged" | "overdue";

export interface PositionFlags {
  highValue?: boolean;
  serialized?: boolean;
  overdue?: boolean;
  daysOut?: number;
}

export interface StockPosition {
  id: string;                 // synthetic stable key
  itemId: string;             // irmItemId or customerStockEntryId
  itemKind: "irm" | "customer_stock";
  itemCode: string;
  itemName: string;
  sku: string | null;
  categoryName: string | null;
  ownership: Ownership;
  customerId: string | null;
  customerName: string | null;
  locationType: LocationType;
  locationId: string;
  locationLabel: string;
  quantity: number;
  reserved: number;
  available: number;
  unitCostPence: number | null;
  valuePence: number | null;
  value: number | null;
  currency: string;
  status: StockPositionStatus;
  flags: PositionFlags;
  lastMovementAt: string;
  inventoryBalanceId: string | null;
}

const CURRENCY = "GBP";
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

export function positionStatus(onHand: number, reorderLevel: number | null): "in_stock" | "low_stock" | "out_of_stock" {
  if (onHand <= 0) return "out_of_stock";
  if (reorderLevel != null && onHand <= reorderLevel) return "low_stock";
  return "in_stock";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromInventoryBalance(row: any): StockPosition {
  const onHand = row.quantityOnHand ?? 0;
  const reserved = row.quantityReserved ?? 0;
  const unitCostPence = row.irmItem?.standardCostPence ?? 0;
  return {
    id: `company:warehouse:${row.warehouseId}:irm:${row.irmItemId}`,
    itemId: row.irmItemId,
    itemKind: "irm",
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: row.irmItem?.sku ?? null,
    categoryName: row.irmItem?.irmCategory?.name ?? null,
    ownership: "company",
    customerId: null,
    customerName: null,
    locationType: "warehouse",
    locationId: row.warehouseId,
    locationLabel: row.warehouse?.name ?? "",
    quantity: onHand,
    reserved,
    available: onHand - reserved,
    unitCostPence,
    valuePence: onHand * unitCostPence,
    value: (onHand * unitCostPence) / 100,
    currency: CURRENCY,
    status: positionStatus(onHand, row.irmItem?.reorderLevel ?? null),
    flags: { serialized: !!row.irmItem?.trackSerialNumbers },
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: row.id,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromEngineerBalance(row: any, engineerName: string): StockPosition {
  const qty = row.quantityOnHand ?? 0;
  return {
    id: `company:engineer:${row.engineerId}:irm:${row.irmItemId}`,
    itemId: row.irmItemId,
    itemKind: "irm",
    itemCode: row.irmItem?.code ?? "",
    itemName: row.irmItem?.name ?? "",
    sku: null,
    categoryName: null,
    ownership: "company",
    customerId: null,
    customerName: null,
    locationType: "engineer",
    locationId: row.engineerId,
    locationLabel: `Eng: ${engineerName}`,
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "on_van",
    flags: {},
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromCustomerStockEntry(entry: any): StockPosition {
  const qty = entry.quantity ?? 0;
  return {
    id: `customer:warehouse:${entry.warehouseId}:cse:${entry.id}`,
    itemId: entry.id,
    itemKind: "customer_stock",
    itemCode: entry.barcode ?? entry.sku ?? "",
    itemName: entry.itemName,
    sku: entry.sku ?? null,
    categoryName: entry.category?.name ?? null,
    ownership: "customer",
    customerId: entry.customerId,
    customerName: entry.customer?.name ?? null,
    locationType: "warehouse",
    locationId: entry.warehouseId,
    locationLabel: entry.warehouse?.name ?? "",
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: positionStatus(qty, entry.thresholdQty ?? null),
    flags: { highValue: !!entry.highValue, serialized: !!entry.serialized },
    lastMovementAt: iso(entry.updatedAt),
    inventoryBalanceId: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromEngineerCustomerHolding(h: any): StockPosition {
  const qty = h.quantityOnHand ?? 0;
  return {
    id: `customer:engineer:${h.engineerId}:cse:${h.customerStockEntryId}`,
    itemId: h.customerStockEntryId,
    itemKind: "customer_stock",
    itemCode: "",
    itemName: h.itemName,
    sku: null,
    categoryName: null,
    ownership: "customer",
    customerId: h.customerId ?? null,
    customerName: h.customerName ?? null,
    locationType: "engineer",
    locationId: h.engineerId,
    locationLabel: "Engineer",
    quantity: qty,
    reserved: 0,
    available: qty,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "on_van",
    flags: {},
    lastMovementAt: iso(h.updatedAt ?? h.createdAt),
    inventoryBalanceId: null,
  };
}

export interface PositionFilters {
  ownership?: Ownership;
  locationType?: LocationType;
  warehouseId?: string;     // matches locationId when locationType is warehouse/damaged
  categoryName?: string;
  search?: string;          // item name / sku / code
  status?: StockPositionStatus;
  customerId?: string;
}

export function filterPositions(rows: StockPosition[], f: PositionFilters): StockPosition[] {
  const q = f.search?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.ownership && r.ownership !== f.ownership) return false;
    if (f.locationType && r.locationType !== f.locationType) return false;
    if (f.warehouseId && r.locationId !== f.warehouseId) return false;
    if (f.categoryName && r.categoryName !== f.categoryName) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.customerId && r.customerId !== f.customerId) return false;
    if (q) {
      const hay = `${r.itemName} ${r.sku ?? ""} ${r.itemCode}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortPositions(rows: StockPosition[]): StockPosition[] {
  return [...rows].sort((a, b) =>
    a.itemName.localeCompare(b.itemName) || a.locationLabel.localeCompare(b.locationLabel));
}

export function paginate<T>(rows: T[], page = 1, pageSize = 25) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), total, page: p, pageSize, totalPages };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromDamagedBalance(row: any): StockPosition {
  const qty = row.quantity ?? 0;
  const isCompany = row.ownerType === "company";
  return {
    id: `${row.ownerType}:damaged:${row.warehouseId}:${row.irmItemId ?? row.customerStockEntryId}`,
    itemId: row.irmItemId ?? row.customerStockEntryId ?? "",
    itemKind: isCompany ? "irm" : "customer_stock",
    itemCode: "",
    itemName: row.itemName,
    sku: null,
    categoryName: null,
    ownership: isCompany ? "company" : "customer",
    customerId: row.customerId ?? null,
    customerName: null,
    locationType: "damaged",
    locationId: row.warehouseId,
    locationLabel: `Damaged — ${row.warehouse?.name ?? ""}`.trim(),
    quantity: qty,
    reserved: 0,
    available: 0,
    unitCostPence: null,
    valuePence: null,
    value: null,
    currency: CURRENCY,
    status: "damaged",
    flags: {},
    lastMovementAt: iso(row.updatedAt),
    inventoryBalanceId: null,
  };
}
