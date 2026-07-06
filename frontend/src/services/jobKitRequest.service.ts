import { api } from "@/lib/api";

// Typed wrapper around the FE→PM additional-kit request API. Field engineers raise + cancel their own
// requests; PMs/planners review the queue and approve (grow kit + open fulfilment) or decline.

export type KitRequestStatus = "pending" | "approved" | "declined" | "cancelled";
export type KitRequestSource = "irm" | "customer_stock" | "misc";
export type FulfillmentMode = "warehouse_issue" | "engineer_transfer";

export interface KitRequestLine {
  id: string;
  source: KitRequestSource;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  jobKitLineId: string | null;
}

export interface KitRequest {
  id: string;
  code: string;
  status: KitRequestStatus;
  jobId: string;
  jobNumber: string;
  requestedByEngineerId: string;
  requestedByEngineerName: string;
  requestedByEngineerEmail: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  fulfillmentMode: FulfillmentMode | null;
  transferId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: KitRequestLine[];
}

export interface PagedKitRequests {
  requests: KitRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface KitRequestLinePayload {
  source: KitRequestSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
  qty: number;
}

export interface CreateKitRequestPayload {
  jobId: string;
  reason: string;
  notes?: string;
  attachments?: string[];
  lines: KitRequestLinePayload[];
}

export interface KitLineWarehouse {
  requestLineId: string;
  warehouseId: string;
}

export interface ApproveKitRequestPayload {
  fulfillmentMode: FulfillmentMode;
  // warehouse_issue mode: a pickup warehouse per IRM request line.
  lineWarehouses?: KitLineWarehouse[];
  // engineer_transfer mode: the source engineer.
  fromEngineerId?: string;
  decisionNote?: string;
}

export interface EligibleHolder {
  engineerId: string;
  name: string;
}

export interface ListParams {
  status?: string;
  jobId?: string;
  search?: string;
  sort?: "oldest" | "newest";
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

export function createKitRequest(payload: CreateKitRequestPayload): Promise<KitRequest> {
  return api<{ request: KitRequest }>("/job-kit-requests", { method: "POST", body: payload }).then((r) => r.request);
}

export function listMyKitRequests(params: ListParams = {}): Promise<PagedKitRequests> {
  return api<PagedKitRequests>(`/job-kit-requests/mine${qs(params as Record<string, unknown>)}`);
}

export function cancelKitRequest(id: string): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/cancel`, { method: "POST" }).then((r) => r.request);
}

// ── PM / planner review ───────────────────────────────────────────────────────

export function listKitRequests(params: ListParams = {}): Promise<PagedKitRequests> {
  return api<PagedKitRequests>(`/job-kit-requests${qs(params as Record<string, unknown>)}`);
}

export function getKitRequest(id: string): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}`).then((r) => r.request);
}

export function pendingKitRequestCount(jobId?: string): Promise<number> {
  return api<{ count: number }>(`/job-kit-requests/pending-count${qs({ jobId })}`).then((r) => r.count);
}

// Engineers who hold ALL of a request's stock-tracked items (transfer source picker).
export function eligibleKitHolders(id: string): Promise<EligibleHolder[]> {
  return api<{ holders: EligibleHolder[] }>(`/job-kit-requests/${id}/eligible-holders`).then((r) => r.holders);
}

// ── IRM catalogue search (for the FE request composer's "add item" search-select) ──────────────

export interface KitItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}

export function searchKitItems(q: string): Promise<KitItemOption[]> {
  return api<{ items: KitItemOption[] }>(`/job-kit-requests/item-search?q=${encodeURIComponent(q)}`).then((r) => r.items);
}

export function approveKitRequest(id: string, payload: ApproveKitRequestPayload): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/approve`, { method: "POST", body: payload }).then((r) => r.request);
}

export function declineKitRequest(id: string, decisionNote?: string): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/decline`, { method: "POST", body: { decisionNote } }).then((r) => r.request);
}
