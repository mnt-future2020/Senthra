// Typed wrappers around the backend /inventory aggregation endpoints.
// Components call these, never api()/axios directly.

import { api, apiFile } from "@/lib/api";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import type { InventorySummary, MovementPage, PagedPositions, StockPosition } from "@/types/stock-position";

// ── Customer Stock Transfer ───────────────────────────────────────────────────

export interface CustomerTransferPayload {
  toWarehouseId: string;
  quantity: number;
  notes?: string;
}

export function transferCustomerStock(
  entryId: string,
  payload: CustomerTransferPayload,
): Promise<void> {
  return api(`/stock-entries/${entryId}/transfer`, { method: "POST", body: payload });
}

// ── Damaged Stock Restore ─────────────────────────────────────────────────────

export interface RestoreDamagedPayload {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId?: string;
  customerStockEntryId?: string;
  quantity: number;
  notes: string;
}

export function restoreDamaged(payload: RestoreDamagedPayload): Promise<void> {
  return api("/goods-management/damaged/restore", { method: "POST", body: payload });
}

export interface PositionParams {
  ownership?: string;
  location?: string;
  warehouse?: string;
  category?: string;
  search?: string;
  status?: string;
  customer?: string;
  page?: number;
  pageSize?: number;
}

function qs(p: Record<string, unknown>): string {
  return Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function listPositions(params: PositionParams = {}): Promise<PagedPositions> {
  const s = qs(params as Record<string, unknown>);
  return api<PagedPositions>(`/inventory/positions${s ? `?${s}` : ""}`);
}

// The CSV endpoint returns a file, not JSON, so it bypasses api() and makes a direct
// authenticated blob request — mirrors inventory.service.exportInventoryCsv.
export async function exportPositionsCsv(
  params: PositionParams = {},
): Promise<{ capped: boolean }> {
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  void _page;
  void _pageSize;
  const s = qs(filters as Record<string, unknown>);
  const { blob, headers } = await apiFile(
    `/inventory/positions/export.csv${s ? `?${s}` : ""}`,
  );
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(
    headers["content-disposition"] ?? null,
    `stock-positions-${date}.csv`,
  );
  downloadBlob(blob, filename);
  // The positions export streams ALL matching rows — the backend only reports a row count
  // (X-Inventory-Export-Count), never a cap. So this export is never truncated. (The movements/
  // inventory exports DO cap and send an X-*-Export-Capped header — see exportMovementsCsv.)
  return { capped: false };
}

export function getSummary(): Promise<InventorySummary> {
  return api<InventorySummary>("/inventory/summary");
}

// Stock Movement History — the unified, cursor-paginated company-wide ledger.
export interface MovementFilters {
  dateFrom?: string;
  dateTo?: string;
  irmItem?: string;
  warehouse?: string;
  engineer?: string;
  customer?: string;
  ownership?: string;
  location?: string;
  type?: string;
  sourceType?: string;
}

export function listMovements(
  params: MovementFilters & { cursor?: string | null; limit?: number } = {},
): Promise<MovementPage> {
  const s = qs(params as Record<string, unknown>);
  return api<MovementPage>(`/inventory/movements${s ? `?${s}` : ""}`);
}

// Download the SAME filtered movement history as CSV — apiFile() rather than api() for a blob body,
// keeping the shared client's silent refresh-on-401 (mirrors exportPositionsCsv). RBAC is enforced
// server-side (inventory.history + inventory.export).
export async function exportMovementsCsv(params: MovementFilters = {}): Promise<{ capped: boolean }> {
  const s = qs(params as Record<string, unknown>);
  const { blob, headers } = await apiFile(`/inventory/movements/export.csv${s ? `?${s}` : ""}`);
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(headers["content-disposition"] ?? null, `stock-movements-${date}.csv`);
  downloadBlob(blob, filename);
  return { capped: String(headers["x-movement-export-capped"] ?? "") === "true" };
}

// ── Item-level detail endpoints (Task 17) ────────────────────────────────────────────────────────

/** All StockPosition rows for a specific IRM item across every pool/location. */
export function getItemDistribution(irmItemId: string): Promise<StockPosition[]> {
  return api<StockPosition[]>(`/inventory/items/${irmItemId}/distribution`);
}

export interface ItemHolders {
  engineers: Array<{ engineerId: string; locationLabel: string; quantity: number; lastMovementAt: string }>;
  customers: Array<{ customerId: string | null; customerName: string | null; locationLabel: string; quantity: number; lastMovementAt: string }>;
}

/** Engineers and customers currently holding this IRM item. */
export function getItemHolders(irmItemId: string): Promise<ItemHolders> {
  return api<ItemHolders>(`/inventory/items/${irmItemId}/holders`);
}

export interface ItemJob {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
  customerName: string | null;
  assignedEngineerEmail: string | null;
  createdAt: string;
  kitLines: Array<{ id: string; qty: number; warehouseName: string | null }>;
}

/** Jobs that reference this IRM item in their kit. */
export function getItemJobs(irmItemId: string): Promise<ItemJob[]> {
  return api<ItemJob[]>(`/inventory/items/${irmItemId}/jobs`);
}

// ── Engineer lens ──────────────────────────────────────────────────────────────

export interface EngineerOverviewRow {
  engineerId: string;
  name: string;
  email: string | null;
  itemsHeld: number;
  totalQty: number;
  activeJobs: number;
}

export interface EngineerHeldItem {
  itemCode: string;
  itemName: string;
  ownership: "company" | "customer";
  customerName: string | null;
  quantity: number;
}

export interface EngineerJobRow {
  id: string;
  jobNumber: string;
  name: string;
  status: string;
  customerName: string | null;
}

export interface EngineerInventoryDetail {
  holdings: EngineerHeldItem[];
  jobs: EngineerJobRow[];
}

/** Every active field engineer with a roll-up of holdings + active jobs. */
export function listEngineerInventory(): Promise<EngineerOverviewRow[]> {
  return api<EngineerOverviewRow[]>("/inventory/engineers");
}

/** One engineer's current holdings and active jobs. */
export function getEngineerInventory(engineerId: string): Promise<EngineerInventoryDetail> {
  return api<EngineerInventoryDetail>(`/inventory/engineers/${engineerId}`);
}
