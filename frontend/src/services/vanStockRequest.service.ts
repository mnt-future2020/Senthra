import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import type { JobKitWarehouse } from "@/types/job";

// Typed wrapper around the non-job Van Stock Request API. Engineers raise restocks/returns and
// cancel their own; warehouse reviewers approve/decline, scan-fulfil, close short, create walk-ins.

export type VanStockRequestType = "restock" | "return";
export type VanStockRequestStatus = "pending" | "approved" | "partially_fulfilled" | "fulfilled" | "declined" | "cancelled";
// Two levels on purpose — "high" was retired 2026-08-20. The server normalises the legacy rows that
// still hold it (readPriority in van-stock-request.validation.ts), so nothing here ever sees a third
// value; the option list rendered by every composer lives in van-requests/vanRequestUi.
export type VanStockPriority = "normal" | "urgent";

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
  // Per-line close-short — the source warehouse writing off what it can't supply. Distinct from the
  // request-level closeShort* fields, which predate close-short being per warehouse.
  closedShortQty: number | null;
  closedShortBy: string | null;
  closedShortNote: string | null;
  closedShortAt: string | null;
  // Cancelled by the ENGINEER (cancel remaining). Separate from closedShort*, which is the WAREHOUSE
  // saying it can't supply — same effect on the maths, different actor and different story.
  cancelledQty: number | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
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
  // RESTOCK only: the warehouse this line is collected from. The engineer picks it per item against
  // that warehouse's live free stock; the server stores it as the line's sourceWarehouseId, which is
  // what routes the request to each warehouse's queue. Omitted on a return (one destination).
  warehouseId?: string;
}

export interface CreateVanStockRequestPayload {
  type: VanStockRequestType;
  reason: string;
  notes?: string;
  priority?: VanStockPriority;
  attachments?: string[];
  preferredWarehouseId?: string; // never sent on a restock — DERIVED server-side from the lines
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

// Engineer restock composer: catalogue search annotated with each item's TOTAL on-hand across active
// warehouses. Items out of stock everywhere (quantityOnHand 0) come back too — the composer shows them
// disabled/"out of stock" rather than hiding them — so the engineer can't raise a request for stock no
// warehouse holds (which would only fail at scan-out) yet still sees the item exists.
export function searchRequestableItems(q: string): Promise<WalkInItemOption[]> {
  return api<{ items: WalkInItemOption[] }>(`/van-stock-requests/requestable-item-search?q=${encodeURIComponent(q)}`).then((r) => r.items);
}

// Walk-in composer search: catalogue hits annotated with THIS warehouse's live on-hand + reorder level,
// so the counter only picks stock the shelf can actually issue (and sees when an issue dips reorder).
export interface WalkInItemOption extends VanStockItemOption {
  quantityOnHand: number;
  reorderLevel: number | null;
}
export function searchWalkInItems(warehouseId: string, q: string): Promise<WalkInItemOption[]> {
  return api<{ items: WalkInItemOption[] }>(`/van-stock-requests/warehouse-item-search?warehouseId=${encodeURIComponent(warehouseId)}&q=${encodeURIComponent(q)}`).then((r) => r.items);
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

// warehouseId = the warehouse tab the decline is happening in. Only ITS lines are refused — a
// warehouse never speaks for stock it doesn't hold, and the request is marked declined only once
// every line has been answered and none survived.
export function declineVanStockRequest(id: string, warehouseId: string, decisionNote: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/decline`, { method: "POST", body: { warehouseId, decisionNote } }).then((r) => r.request);
}

// warehouseId = the warehouse tab the scan/post is happening in. The backend enforces every line is
// sourced to it, so a line is only ever issued from the warehouse it belongs to — even for an admin.
export function vanStockScanLookup(requestId: string, warehouseId: string, code: string): Promise<ScanLookupResult> {
  return api<{ result: ScanLookupResult }>("/van-stock-requests/scan-lookup", { method: "POST", body: { requestId, warehouseId, code } }).then((r) => r.result);
}

export function fulfilVanStockRequest(id: string, warehouseId: string, entries: FulfilEntryPayload[]): Promise<VanStockRequest> {
  // Posts EVERY scanned entry in one transaction — see LONG_WRITE_TIMEOUT.
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/fulfil`, { method: "POST", body: { warehouseId, entries }, timeout: LONG_WRITE_TIMEOUT }).then((r) => r.request);
}

// warehouseId = the warehouse tab being closed short from; the backend writes off only THAT warehouse's
// outstanding lines (even for an admin), consistent with the scan/fulfil per-tab scoping.
export function closeVanStockShort(id: string, warehouseId: string, note: string): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>(`/van-stock-requests/${id}/close-short`, { method: "POST", body: { warehouseId, note } }).then((r) => r.request);
}

export function createVanStockWalkIn(payload: { engineerId: string; warehouseId: string; reason: string; priority?: VanStockPriority; notes?: string; lines: VanStockLinePayload[] }): Promise<VanStockRequest> {
  return api<{ request: VanStockRequest }>("/van-stock-requests/walk-in", { method: "POST", body: payload }).then((r) => r.request);
}

