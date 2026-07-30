import { api, apiFile } from "@/lib/api";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import { registerClientCache } from "@/lib/clientCache";
import type { Availability, InventoryBalance, InventoryDetail, InventoryTransaction, PurchaseHistoryRow, StockTransfer } from "@/types/inventory";

// Typed wrappers around the backend /inventory endpoints (read + warehouse→warehouse transfer).
// Components call these, never api()/axios directly.

export interface InventoryListParams {
  search?: string;
  warehouse?: string;
  irmItem?: string; // exact item id — list only that item's per-warehouse balances
  category?: string;
  status?: string; // in_stock | low_stock | out_of_stock
  page?: number;
  pageSize?: number;
}

export interface PagedInventory {
  inventory: InventoryBalance[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalValuePence: number;
  totalValue: number;
}

export interface TransferListParams {
  search?: string;
  irmItem?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
}

export interface PagedTransfers {
  transfers: StockTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PagedTransactions {
  transactions: InventoryTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// The transfer form payload. Quantity is sent as the raw input string; the server coerces + validates.
export interface TransferPayload {
  irmItemId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number | string;
  movementDate: string;
  referenceNumber?: string;
  description?: string;
  internalNotes?: string;
}

function listQs(params: InventoryListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.irmItem) sp.set("irmItem", params.irmItem);
  if (params.category) sp.set("category", params.category);
  if (params.status) sp.set("status", params.status);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function transferQs(params: TransferListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.irmItem) sp.set("irmItem", params.irmItem);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Stale-while-revalidate list cache (mirrors the other modules) — returning to the list renders
// instantly instead of flashing a skeleton. Cleared on logout and after a transfer mutates stock.
const listCache = new Map<string, PagedInventory>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: InventoryListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.warehouse ?? ""}|${p.category ?? ""}|${p.status ?? ""}`;

export const getCachedInventory = (params: InventoryListParams = {}): PagedInventory | undefined => listCache.get(listCacheKey(params));

// Every mutation in THIS module clears the cache inline (see listInventory's callers below). Damage
// reporting is the exception: it changes on-hand balances but lives in goodsManagement.service, so
// it has no reach into this module's private cache. Without clearing it, moving stock to damaged
// would leave the old on-hand figure rendering from cache on the next visit to the list.
export const clearInventoryListCache = (): void => listCache.clear();

export function listInventory(params: InventoryListParams = {}): Promise<PagedInventory> {
  return api<PagedInventory>(`/inventory${listQs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getInventory(id: string): Promise<InventoryDetail> {
  return api<{ inventory: InventoryDetail }>(`/inventory/${id}`).then((r) => r.inventory);
}

export function listInventoryTransactions(id: string, page = 1, pageSize = 20): Promise<PagedTransactions> {
  return api<PagedTransactions>(`/inventory/${id}/transactions?page=${page}&pageSize=${pageSize}`);
}

export function listPurchaseHistory(id: string): Promise<PurchaseHistoryRow[]> {
  return api<{ purchases: PurchaseHistoryRow[] }>(`/inventory/${id}/purchases`).then((r) => r.purchases);
}

export function getAvailability(irmItemId: string, warehouseId: string): Promise<Availability> {
  return api<Availability>(`/inventory/availability?irmItem=${irmItemId}&warehouse=${warehouseId}`);
}

// Per-warehouse balances for a single IRM item — feeds the job kit picker so its warehouse dropdown
// only offers warehouses that actually hold the item. Uncached + bypasses the list cache (a small,
// selection-time lookup whose key would otherwise collide with the inventory-list cache).
export function listItemWarehouseStock(irmItemId: string): Promise<InventoryBalance[]> {
  if (!irmItemId) return Promise.resolve([]);
  return api<PagedInventory>(`/inventory${listQs({ irmItem: irmItemId, pageSize: 200 })}`).then((r) => r.inventory);
}

// ── Reorder workbench ─────────────────────────────────────────────────────────
// Netted per-item×warehouse buy suggestions. Server-computed and server-scoped; uncached so the
// "Last calculated" timestamp is always honest.
export type ReorderReason = "negative_stock" | "out_of_stock" | "below_reorder" | "planned_demand";
export interface ReorderSuggestion {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  categoryId: string | null;
  categoryName: string | null;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  openPrf: number;
  plannedDemand: number; // active jobs' planned-but-unissued kit qty drawing from this warehouse
  projected: number;
  reorderLevel: number | null;
  target: number;
  packSize: number | null;
  suggestedQty: number;
  reason: ReorderReason;
  covered: boolean;
  critical: boolean;
  unitCostPence: number;
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  primarySupplier: { id: string; name: string; status: string; leadTimeDays: number | null } | null;
}
export interface ReorderSuggestionsResult {
  suggestions: ReorderSuggestion[];
  calculatedAt: string;
}
export function getReorderSuggestions(): Promise<ReorderSuggestionsResult> {
  return api<ReorderSuggestionsResult>("/inventory/reorder-suggestions");
}

export function listTransfers(params: TransferListParams = {}): Promise<PagedTransfers> {
  return api<PagedTransfers>(`/inventory/transfers${transferQs(params)}`);
}

export function createTransfer(payload: TransferPayload): Promise<StockTransfer> {
  return api<{ transfer: StockTransfer }>("/inventory/transfers", { method: "POST", body: payload }).then((r) => {
    listCache.clear(); // a transfer changes on-hand balances at both warehouses
    return r.transfer;
  });
}

// Manual stock add (existing / opening / legacy stock). Reasons mirror the backend enum.
export type StockAdjustmentReason = "opening_balance" | "legacy_stock" | "found" | "other";

export interface AddStockPayload {
  irmItemId: string;
  warehouseId: string;
  quantity: number | string;
  movementDate: string;
  reason: StockAdjustmentReason;
  referenceNumber?: string;
  notes?: string;
}

export interface StockAdjustment {
  id: string;
  code: string;
  warehouseId: string;
  warehouseName: string;
  irmItemId: string;
  itemName: string;
  quantity: number;
  balanceAfter: number;
  reason: string;
  movementDate: string;
  referenceNumber: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function addStock(payload: AddStockPayload): Promise<StockAdjustment> {
  return api<{ adjustment: StockAdjustment }>("/inventory/add-stock", { method: "POST", body: payload }).then((r) => {
    listCache.clear(); // a manual add changes the warehouse on-hand balance
    return r.adjustment;
  });
}

// Downward stock correction (shrinkage / miscount). Mirrors addStock pattern.
//
// `damage_correction` is GONE, matching STOCK_ADJUST_DOWN_REASONS on the server: damage now has one
// door, the warehouse damage report, which requires a photo and a reason and credits the damaged
// pool. Leaving the value in this union would let a caller typecheck its way into a payload the
// server rejects — and quietly re-open the second door this list was narrowed to close. Historical
// adjustments still carry the old string; nothing reads them through this type.
export type AdjustStockReason = "shrinkage" | "miscount" | "other";

export interface AdjustStockPayload {
  irmItemId: string;
  warehouseId: string;
  quantity: number; // units to REMOVE (must be > 0)
  movementDate: string;
  reason: AdjustStockReason;
  referenceNumber?: string;
  notes?: string;
}

export function adjustStock(payload: AdjustStockPayload): Promise<StockAdjustment> {
  return api<{ adjustment: StockAdjustment }>("/inventory/adjust", { method: "POST", body: payload }).then((r) => {
    listCache.clear(); // adjustment changes the on-hand balance
    return r.adjustment;
  });
}

// The CSV endpoint returns a file, not JSON, so it uses apiFile() rather than api() — same client, so
// the silent refresh-on-401 still applies (mirrors the audit export). Returns whether the export was
// capped by the server; that flag rides on a header the API must expose via CORS.
export async function exportInventoryCsv(params: InventoryListParams = {}): Promise<{ capped: boolean }> {
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  void _page;
  void _pageSize;
  const { blob, headers } = await apiFile(`/inventory/export.csv${listQs(filters)}`);
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(headers["content-disposition"] ?? null, `inventory-${date}.csv`);
  downloadBlob(blob, filename);
  return { capped: String(headers["x-inventory-export-capped"] ?? "") === "true" };
}
