// Typed wrappers around the backend /inventory aggregation endpoints.
// Components call these, never api()/axios directly.

import { api } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
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
  // Reads the real header rather than assuming. This used to hard-code `capped: false` on the
  // grounds that the positions endpoint "streams ALL matching rows and never caps" — which was true
  // until it was given the same EXPORT_MAX ceiling every other export has. An assumption about
  // another layer's behaviour, baked into a return value, survives the day that behaviour changes
  // and turns into the exact failure the flag exists to prevent: a truncated file reported complete.
  const s = qs(withoutPaging(params) as Record<string, unknown>);
  return downloadCsv(`/inventory/positions/export.csv${s ? `?${s}` : ""}`, "stock-positions");
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
  return downloadCsv(`/inventory/movements/export.csv${s ? `?${s}` : ""}`, "stock-movements");
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
export interface EngineerLensParams {
  /** Engineer name or email. */
  search?: string;
  /** Only engineers actually holding something. */
  holding?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PagedEngineerOverview {
  rows: EngineerOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The engineer lens — filtered, counted and PAGED at the server.
 *
 * It used to return a bare array of EVERY engineer with no way to narrow it and no ceiling. The
 * response is an object now; `listEngineerOptions` below is the shape the pickers want.
 */
export function listEngineerInventoryPaged(params: EngineerLensParams = {}): Promise<PagedEngineerOverview> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.holding) q.set("holding", "1");
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  return api<PagedEngineerOverview>(`/inventory/engineers${q.size ? `?${q}` : ""}`);
}

/** One engineer as a filter OPTION — an id and a name; the roll-up numbers belong to the lens. */
export interface EngineerOption {
  engineerId: string;
  name: string;
  email: string;
}

/**
 * The COMPLETE field-engineer roster, for filter pickers.
 *
 * Its own endpoint, not a page of the lens. Briefly this was `listEngineerInventoryPaged({ pageSize:
 * 100 })`, which silently made every engineer picker in the app "the first 100 engineers" — and the
 * server clamps pageSize to 100, so there was no way to ask for more. An option list that omits
 * people without saying so is worse than a slow one: the missing engineer simply cannot be picked.
 */
export function listEngineerOptions(): Promise<EngineerOption[]> {
  return api<{ engineers: EngineerOption[] }>("/inventory/engineer-options").then((r) => r.engineers);
}

/** One engineer's current holdings and active jobs. */
export function getEngineerInventory(engineerId: string): Promise<EngineerInventoryDetail> {
  return api<EngineerInventoryDetail>(`/inventory/engineers/${engineerId}`);
}
