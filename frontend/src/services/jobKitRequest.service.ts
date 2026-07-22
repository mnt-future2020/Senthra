import { api } from "@/lib/api";

// Typed wrapper around the FE→PM additional-kit request API. Field engineers raise + cancel their own
// requests; PMs/planners review the queue and approve (grow kit + open fulfilment) or decline.

export type KitRequestStatus = "pending" | "approved" | "declined" | "cancelled";
export type KitRequestSource = "irm" | "customer_stock" | "misc";
// "mixed" is a RESULT, never a choice: it's what the server records when the PM sourced different
// lines from different places. The picker itself works per line (see LineSourcePayload).
export type FulfillmentMode = "warehouse_issue" | "engineer_transfer" | "mixed";
export type LineSourceType = "warehouse" | "engineer";

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
  // customer_stock lines: the warehouse the entry is stored in (read-only pickup location on approve).
  // Null for irm/misc, and on responses that don't drive the approve modal.
  warehouseName: string | null;
  warehouseCode: string | null;
  // Where this line was sourced, set on approve. Null while pending/declined, and on requests
  // approved before per-line sourcing shipped (fall back to the request's fulfillmentMode).
  sourceType: LineSourceType | null;
  sourceWarehouseId: string | null;
  sourceEngineerId: string | null;
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

// One line's chosen source. Warehouse lines carry a warehouseId (IRM only — customer stock is issued
// from where it's stored); engineer lines carry the van it comes from.
export interface LineSourcePayload {
  requestLineId: string;
  sourceType: LineSourceType;
  warehouseId?: string;
  engineerId?: string;
}

export interface ApproveKitRequestPayload {
  // Preferred: a source per line. Fully describes the fulfilment on its own.
  lineSources?: LineSourcePayload[];
  // Legacy request-level shorthand, still accepted by the API. "mixed" is a server-produced RESULT
  // only, never a valid input, so it's excluded here to match the backend approve schema's enum.
  fulfillmentMode?: "warehouse_issue" | "engineer_transfer";
  lineWarehouses?: KitLineWarehouse[];
  fromEngineerId?: string;
  decisionNote?: string;
}

export interface EligibleHolder {
  engineerId: string;
  name: string;
}

// Van options for ONE request line — only engineers holding enough of THAT line, so the PM can
// never pick a short source. An empty list just means no van has it; the warehouse still can.
export interface LineHolders {
  requestLineId: string;
  holders: (EligibleHolder & { available: number })[];
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

// Van options PER LINE — powers the per-line source picker in the approve modal.
export function kitLineHolders(id: string): Promise<LineHolders[]> {
  return api<{ lines: LineHolders[] }>(`/job-kit-requests/${id}/line-holders`).then((r) => r.lines);
}

// ── Item search (for the FE request composer's "add item" search-select) ───────────────────────
// Two sources, discriminated by `source`: the company IRM catalogue, and — when a jobId is passed —
// the job's own customer's active, in-stock consignment entries (one option per CustomerStockEntry).

export interface KitItemIrmOption {
  source: "irm";
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}
export interface KitItemCustomerStockOption {
  source: "customer_stock";
  customerStockEntryId: string;
  name: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  warehouseName: string;
  warehouseCode: string | null;
  serialNumber: string | null;
}
export type KitItemOption = KitItemIrmOption | KitItemCustomerStockOption;

// jobId scopes the customer-stock half to that job's customer; omit it for IRM-only search.
export function searchKitItems(q: string, jobId?: string): Promise<KitItemOption[]> {
  const query = `q=${encodeURIComponent(q)}${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ""}`;
  return api<{ items: KitItemOption[] }>(`/job-kit-requests/item-search?${query}`).then((r) => r.items);
}

export function approveKitRequest(id: string, payload: ApproveKitRequestPayload): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/approve`, { method: "POST", body: payload }).then((r) => r.request);
}

export function declineKitRequest(id: string, decisionNote?: string): Promise<KitRequest> {
  return api<{ request: KitRequest }>(`/job-kit-requests/${id}/decline`, { method: "POST", body: { decisionNote } }).then((r) => r.request);
}
