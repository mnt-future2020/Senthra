// Mirror of backend StockPosition, InventorySummary, Movement DTOs.
// Field names must stay in sync with aggregation.service.ts output.

export type Ownership = "company" | "customer";
export type LocationType = "warehouse" | "engineer" | "customer_site" | "damaged" | "transit";
export type StockPositionStatus =
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "on_van"
  | "damaged"
  | "overdue";

export interface PositionFlags {
  highValue?: boolean;
  serialized?: boolean;
  overdue?: boolean;
  daysOut?: number;
}

export interface StockPosition {
  id: string;
  itemId: string;
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

export interface InventorySummary {
  company: { units: number; valuePence: number; value: number };
  customer: { units: number; customersHolding: number };
  engineer: { units: number; engineersHolding: number; overdue: number };
  damaged: { units: number; thisMonthUnits: number };
}

// One leg of the unified Stock Ledger (mirror of backend movement.ts → Movement).
export interface Movement {
  id: string;
  date: string;
  type: string;
  label: string;
  ownership: "company" | "customer";
  locationType: "warehouse" | "engineer" | "damaged";
  locationId: string | null;
  locationLabel: string;
  itemKind: "irm" | "customer_stock";
  itemId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  quantityDelta: number;
  balanceAfter: number | null;
  fromLabel: string | null;
  toLabel: string | null;
  reference: string | null;
  sourceType: string;
  sourceId: string;
  engineerId: string | null;
  customerId: string | null;
  customerName: string | null;
  actor: string | null;
  notes: string | null;
}

// Cursor-paginated movement page (keyset, not offset — there is no total).
export interface MovementPage {
  movements: Movement[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PagedPositions {
  positions: StockPosition[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

