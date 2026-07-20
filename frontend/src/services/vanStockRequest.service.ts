import { api } from "@/lib/api";
import type { JobKitWarehouse } from "@/types/job";

// Typed wrapper around the non-job Van Stock Request API. Engineers raise restocks/returns and
// cancel their own; warehouse reviewers approve/decline, scan-fulfil, close short, create walk-ins.

export type VanStockRequestType = "restock" | "return";
export type VanStockRequestStatus = "pending" | "approved" | "partially_fulfilled" | "fulfilled" | "declined" | "cancelled";
export type VanStockPriority = "normal" | "high" | "urgent";

export interface VanStockLine {
  id: string;
  irmItemId: string;
  itemName: string;
  code: string | null; // IRM item code (e.g. IRM-0002) — shown + click-to-copy
  sku: string | null;
  uom: string | null;
  requestedQty: number;
  approvedQty: number | null;
  fulfilledQty: number;
  remainingQty: number;
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  // Live address of the line's source warehouse — null until approve sets it. Typed as the job kit's
  // warehouse shape so the engineer's pickup modal is literally the same component in both flows.
  sourceWarehouse: JobKitWarehouse | null;
  isMine: boolean; // server-computed: this line's source is in the reading actor's warehouse scope
}

export interface VanStockFulfilmentLine {
  id: string;
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: "good" | "damaged";
  damagePhotoUrl: string | null;
  damageReason: string | null;
  scannedCode: string | null;
}

export interface VanStockFulfilment {
  id: string;
  sequence: number;
  performedBy: string;
  postedAt: string;
  lines: VanStockFulfilmentLine[];
}

export interface VanStockRequest {
  id: string;
  code: string;
  type: VanStockRequestType;
  status: VanStockRequestStatus;
  priority: VanStockPriority;
  createdVia: "engineer_request" | "walk_in";
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId: string | null;
  preferredWarehouseName: string | null;
  preferredWarehouseCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  lastFulfilledAt: string | null;
  completionType: "complete" | "closed_short" | "cancelled_remaining" | null;
  closedShortBy: string | null;
  closedShortAt: string | null;
  closeShortNote: string | null;
  cancelledAt: string | null;
  stale: boolean;
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: { warehouseIds: string[]; lines: number; linesDone: number; qty: number; qtyFulfilled: number; allMineDone: boolean } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: VanStockLine[];
  fulfilments: VanStockFulfilment[];
}

export interface PagedVanStockRequests {
  requests: VanStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VanStockLinePayload {
  irmItemId: string;
  itemName: string;
  qty: number;
}

export interface CreateVanStockRequestPayload {
  type: VanStockRequestType;
  reason: string;
  notes?: string;
  priority?: VanStockPriority;
  attachments?: string[];
  preferredWarehouseId?: string; // restock — REQUIRED there (routes the request to that warehouse's queue)
  warehouseId?: string; // return — final
  lines: VanStockLinePayload[];
}

export interface FulfilEntryPayload {
  lineId: string;
  qty: number;
  condition: "good" | "damaged";
  damagePhotoUrl?: string;
  damageReason?: string;
  scannedCode: string; // required — every entry must come from a scan (server enforces this too)
}

export interface ScanLookupResult {
  irmItemId: string;
  lineId: string;
  itemName: string;
  uom: string | null;
  remainingQty: number;
  available: number | null;
}

export interface VanStockItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}

export interface HoldingOption {
  irmItemId: string;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
}

export interface WarehouseLite {
  id: string;
  name: string;
  code: string | null;
}

export interface ListParams {
  status?: string;
  type?: string;
  priority?: string;
  // engineer_request | walk_in — a walk-in never went through review, so both sides filter on it.
  createdVia?: string;
  search?: string;
  sort?: "oldest" | "newest";
  // Reviewer list only: narrow to one warehouse's queue (final warehouse, or pending preferring it).
  warehouseId?: string;
  page?: number;
  pageSize?: number;
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ── Engineer self-service ─────────────────────────────────────────────────────

export function createVanStockRequest(payload: CreateVanStockRequestPayload): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests", { method: "POST", body: payload }).then((r) => r.request);
}

export function listMyVanStockRequests(params: ListParams = {}): Promise<PagedVanStockRequests> {
  return api<PagedVanStockRequests>(`/van-stock-requests/mine${qs(params as Record<string, unknown>)}`);
}

export function myOpenLineItems(type: VanStockRequestType): Promise<Array<{ irmItemId: string; code: string }>> {
  return api<{ items: Array<{ irmItemId: string; code: string }> }>(`/van-stock-requests/mine/open-lines${qs({ type })}`).then((r) => r.items);
}

export function myHoldings(): Promise<HoldingOption[]> {
  return api<{ holdings: HoldingOption[] }>("/van-stock-requests/my-holdings").then((r) => r.holdings);
}

export function searchVanStockItems(q: string): Promise<VanStockItemOption[]> {
  return api<{ items: VanStockItemOption[] }>(`/van-stock-requests/item-search?q=${encodeURIComponent(q)}`).then((r) => r.items);
}

export function listWarehousesLite(): Promise<WarehouseLite[]> {
  return api<{ warehouses: WarehouseLite[] }>("/van-stock-requests/warehouses-lite").then((r) => r.warehouses);
}

// Per-warehouse on-hand for the composer's cart items (advisory — never blocks submission).
export interface WarehouseAvailability {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  items: Array<{ irmItemId: string; quantityOnHand: number }>;
}
export function getVanStockAvailability(irmItemIds: string[]): Promise<WarehouseAvailability[]> {
  if (irmItemIds.length === 0) return Promise.resolve([]);
  return api<{ warehouses: WarehouseAvailability[] }>(`/van-stock-requests/availability?irmItemIds=${encodeURIComponent(irmItemIds.join(","))}`).then((r) => r.warehouses);
}

export function uploadVanStockAttachment(image: string): Promise<string> {
  return api<{ url: string }>("/van-stock-requests/attachments", { method: "POST", body: { image } }).then((r) => r.url);
}

export function cancelVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel`, { method: "POST" }).then((r) => r.request);
}

export function cancelVanStockRemaining(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/cancel-remaining`, { method: "POST" }).then((r) => r.request);
}

// ── Reviewer ──────────────────────────────────────────────────────────────────

export function listVanStockRequests(params: ListParams = {}): Promise<PagedVanStockRequests> {
  return api<PagedVanStockRequests>(`/van-stock-requests${qs(params as Record<string, unknown>)}`);
}

export function getVanStockRequest(id: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}`).then((r) => r.request);
}

export function pendingVanStockCount(): Promise<number> {
  return api<{ count: number }>("/van-stock-requests/pending-count").then((r) => r.count);
}

export function approveVanStockRequest(
  id: string,
  payload: { warehouseId: string; lineApprovals?: Array<{ lineId: string; approvedQty: number; sourceWarehouseId?: string }>; decisionNote?: string },
): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/approve`, { method: "POST", body: payload }).then((r) => r.request);
}

export function declineVanStockRequest(id: string, decisionNote: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/decline`, { method: "POST", body: { decisionNote } }).then((r) => r.request);
}

export function vanStockScanLookup(requestId: string, code: string): Promise<ScanLookupResult> {
  return api<{ result: ScanLookupResult }>("/van-stock-requests/scan-lookup", { method: "POST", body: { requestId, code } }).then((r) => r.result);
}

export function fulfilVanStockRequest(id: string, entries: FulfilEntryPayload[]): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/fulfil`, { method: "POST", body: { entries } }).then((r) => r.request);
}

export function closeVanStockShort(id: string, note: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/close-short`, { method: "POST", body: { note } }).then((r) => r.request);
}

export function createVanStockWalkIn(payload: { engineerId: string; warehouseId: string; reason: string; priority?: VanStockPriority; notes?: string; lines: VanStockLinePayload[] }): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests/walk-in", { method: "POST", body: payload }).then((r) => r.request);
}

export function uploadVanStockDamagePhoto(image: string): Promise<string> {
  return api<{ url: string }>("/van-stock-requests/damage-photo", { method: "POST", body: { image } }).then((r) => r.url);
}
