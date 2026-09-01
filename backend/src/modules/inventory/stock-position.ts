export type Ownership = "company" | "customer";
export type LocationType = "warehouse" | "engineer" | "customer_site" | "damaged" | "transit";
export type StockPositionStatus =
  | "in_stock" | "low_stock" | "out_of_stock" | "on_van" | "damaged" | "overdue";

/**
 * The DERIVED status filter value: "at or below the reorder level", i.e. `low_stock` OR
 * `out_of_stock` in one filter.
 *
 * It exists because that union is what "low stock" MEANS everywhere else in the product — the
 * dashboard KPI counts it, `positionStatus` produces it as two values only because a shelf at zero
 * deserves its own badge, and no single stored status covers both. Without it the Low Stock card
 * counted N and opened a list of the low rows only, silently dropping the most severe ones.
 */
export const BELOW_REORDER = "below_reorder";

/** A status a caller may filter by: a real position status, or the derived union above. */
export type PositionStatusFilter = StockPositionStatus | typeof BELOW_REORDER;

/** The statuses `below_reorder` stands for — at or below the reorder level, empty shelves included. */
const BELOW_REORDER_STATUSES: readonly StockPositionStatus[] = ["low_stock", "out_of_stock"];

/** Does this row's status satisfy the requested filter (real value or the derived union)? */
export function matchesStatusFilter(status: StockPositionStatus, filter: PositionStatusFilter): boolean {
  return filter === BELOW_REORDER ? BELOW_REORDER_STATUSES.includes(status) : status === filter;
}

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
    flags: {},
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
  /** A real status, or the derived `below_reorder` union — see PositionStatusFilter. */
  status?: PositionStatusFilter;
  customerId?: string;
  /**
   * WHICH ENGINEER is holding it — free text over an engineer's name/email, matched exactly as the
   * engineer lens's own search box matches it.
   *
   * ENGINEER-SCOPED BY DEFINITION, and named so you cannot miss it. A warehouse shelf, a customer
   * site and a damage pool have no engineer, so "held by an engineer called Kansha" is false for
   * every one of their rows and they are excluded — a narrowing, never a widening. Setting this
   * together with `locationType: "warehouse"` is a contradictory query and correctly returns
   * nothing; it is not rejected, because a filter that returns an empty set is honest and a 400
   * would break a caller who merely over-specified.
   *
   * This replaced a `holderSearch`/`holdingOnly` pair. `holdingOnly` ("only engineers who hold
   * something") is a property of the engineer ROSTER, not of a position, and on this filter it was
   * provably a no-op that nonetheless dragged the location scope with it: an engineer's `itemsHeld`
   * counts exactly the engineer-balance and customer-holding rows that BECOME their positions, so
   * an engineer it excluded had no position rows to exclude. It now lives only on EngineerLensParams,
   * where it means something. See the aggregation service's resolveEngineerIds.
   *
   * Resolved to `engineerIds` before it reaches `filterPositions`, because a name lives on the User
   * record and this function is pure.
   */
  engineerSearch?: string;
  /**
   * The RESOLVED engineer ids. Internal — set by the service from `engineerSearch`, never read from
   * the query string, so a caller cannot name an engineer the lens's own search would not match.
   *
   * An EMPTY array means "the search matched nobody" and correctly yields no rows; `undefined` means
   * no engineer filter at all. Collapsing the two would turn a search with no matches into an
   * unfiltered export — the precise widening this whole audit is about.
   */
  engineerIds?: string[];
}

export function filterPositions(rows: StockPosition[], f: PositionFilters): StockPosition[] {
  const q = f.search?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.ownership && r.ownership !== f.ownership) return false;
    if (f.locationType && r.locationType !== f.locationType) return false;
    if (f.warehouseId && r.locationId !== f.warehouseId) return false;
    if (f.categoryName && r.categoryName !== f.categoryName) return false;
    if (f.status && !matchesStatusFilter(r.status, f.status)) return false;
    if (f.customerId && r.customerId !== f.customerId) return false;
    // Engineer narrowing, and it is engineer-scoped BY DEFINITION rather than by side effect: a row
    // not held by an engineer cannot be held by the engineer you named. Excluded rather than passed
    // through — "these engineers" must not also return everything held everywhere else. See
    // PositionFilters.engineerSearch for why this is the whole contract now.
    if (f.engineerIds && !(r.locationType === "engineer" && f.engineerIds.includes(r.locationId))) return false;
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
