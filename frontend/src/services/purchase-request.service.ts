import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import type { PurchaseRequest } from "@/types/purchase-request";
import type { RentalLinePayload } from "@/components/dashboard/purchase-requests/rentalLineRows";

// Typed wrappers around the backend /purchase-requests endpoints (CRUD + workflow + attachments).
// The PRF is the quotation step before a Purchase Order — Convert generates the PO.

export interface PrfListParams {
  search?: string;
  status?: string;
  // Several statuses in one query. Serialized comma-separated; takes precedence over `status`
  // on the backend.
  statuses?: string[];
  supplier?: string;
  warehouse?: string;
  job?: string;
  /** Inclusive calendar days ("YYYY-MM-DD"), as the user picked them. The SERVER decides which
   *  day that is for a timestamp column, in the company timezone. */
  requiredFrom?: string;
  requiredTo?: string;
  validFrom?: string;
  validTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedPurchaseRequests {
  purchaseRequests: PurchaseRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One line on the create/update payload (QUOTED unit price in PENCE; the form converts £ → pence).
export interface PrfLinePayload {
  irmItemId: string;
  quantity: number | string;
  unitPricePence: number | string;
  vatRate?: number | string;
  notes?: string;
}

export interface PurchaseRequestPayload {
  supplierId?: string;
  warehouseId?: string;
  // null = explicitly clear on edit (an omitted key is "leave unchanged").
  jobId?: string | null;
  projectRef?: string;
  quoteReference?: string;
  quoteDate?: string | null;
  quoteValidUntil?: string | null;
  // No `| null`: unlike the other dates this one can't be cleared once set (it becomes the PO's
  // expected delivery date), so the server rejects null. Omit the key to leave it unchanged.
  requiredByDate?: string;
  justification?: string;
  notes?: string;
  deliveryTerms?: string | null;
  paymentTerms?: string | null;
  items?: PrfLinePayload[];
  // Sending either array replaces BOTH server-side, so the header totals always see the complete
  // set — omit one and it is re-derived from what is stored.
  rentalItems?: RentalLinePayload[];
}

export interface PrfAttachmentPayload {
  label?: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  data: string; // data URI
}

// Convert result — the PRF (now `converted`) plus the generated PO to navigate to.
export interface PrfConvertResult {
  purchaseRequest: PurchaseRequest;
  purchaseOrderId: string;
  purchaseOrderCode: string;
}

function qs(params: PrfListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.statuses?.length) sp.set("statuses", params.statuses.join(","));
  if (params.supplier) sp.set("supplier", params.supplier);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.job) sp.set("job", params.job);
  if (params.requiredFrom) sp.set("requiredFrom", params.requiredFrom);
  if (params.requiredTo) sp.set("requiredTo", params.requiredTo);
  if (params.validFrom) sp.set("validFrom", params.validFrom);
  if (params.validTo) sp.set("validTo", params.validTo);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedPurchaseRequests>();
registerClientCache(() => listCache.clear());
/**
 * Cache identity = the QUERY STRING actually sent.
 *
 * A hand-written key is a SECOND copy of the parameter list, kept in step with the serialiser by
 * memory — and memory failed: Goods In sent `receivedFrom`/`receivedTo` and keyed neither, so a
 * date-filtered read and an unfiltered one hashed identically and overwrote each other's page.
 *
 * Deriving the key from the serialiser removes the second list entirely: a parameter that affects
 * the response is in the key BECAUSE it is in the request, so the two can never drift again.
 * `URLSearchParams` preserves insertion order and the serialiser sets keys in a fixed order, so
 * equivalent filters always produce byte-identical keys.
 */
export const listCacheKey = (p: PrfListParams): string => qs(p);

export const getCachedPurchaseRequests = (params: PrfListParams = {}): PagedPurchaseRequests | undefined =>
  listCache.get(listCacheKey(params));

/**
 * The SAME filtered list as a CSV. Paging is dropped — an export is "everything matching what I'm
 * looking at", not the page on screen — and the server applies the identical filters and warehouse
 * scope. `capped` is true when it stopped short of the full set.
 */
/**
 * The same requests, ONE ROW PER LINE. Carries the PO code, so this file joins the PO line export
 * in a spreadsheet: what was requested versus what was actually ordered, and at what price.
 */
export function exportPurchaseRequestLinesCsv(params: PrfListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-requests/export-lines.csv${qs(withoutPaging(params))}`, "purchase-request-lines");
}

export function exportPurchaseRequestsCsv(params: PrfListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-requests/export.csv${qs(withoutPaging(params))}`, "purchase-requests");
}

export function listPurchaseRequests(params: PrfListParams = {}): Promise<PagedPurchaseRequests> {
  return api<PagedPurchaseRequests>(`/purchase-requests${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getPurchaseRequest(idOrCode: string): Promise<PurchaseRequest> {
  return api<{ purchaseRequest: PurchaseRequest }>(`/purchase-requests/${idOrCode}`).then((r) => r.purchaseRequest);
}

const mutate = (p: Promise<{ purchaseRequest: PurchaseRequest }>): Promise<PurchaseRequest> =>
  p.then((r) => {
    listCache.clear();
    return r.purchaseRequest;
  });

export function createPurchaseRequest(payload: PurchaseRequestPayload): Promise<PurchaseRequest> {
  return mutate(api<{ purchaseRequest: PurchaseRequest }>("/purchase-requests", { method: "POST", body: payload }));
}
export function updatePurchaseRequest(id: string, payload: PurchaseRequestPayload): Promise<PurchaseRequest> {
  return mutate(api<{ purchaseRequest: PurchaseRequest }>(`/purchase-requests/${id}`, { method: "PATCH", body: payload }));
}
export function deletePurchaseRequest(id: string): Promise<void> {
  return api(`/purchase-requests/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// --- workflow transitions ---------------------------------------------------
const action = (id: string, name: string, body?: unknown): Promise<PurchaseRequest> =>
  mutate(api<{ purchaseRequest: PurchaseRequest }>(`/purchase-requests/${id}/${name}`, { method: "POST", body: body ?? {} }));

export const submitPurchaseRequest = (id: string) => action(id, "submit");
export const approvePurchaseRequest = (id: string) => action(id, "approve");
export const rejectPurchaseRequest = (id: string, reason: string) => action(id, "reject", { reason });
// Reopen-for-revision (approved → draft) — the reason is mandatory and audited.
export const reopenPurchaseRequest = (id: string, reason: string) => action(id, "reopen", { reason });
export const cancelPurchaseRequest = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });

// Generate the Purchase Order from a finance-approved PRF (one per PRF, forever).
export function convertPurchaseRequest(id: string): Promise<PrfConvertResult> {
  return api<PrfConvertResult>(`/purchase-requests/${id}/convert`, { method: "POST", body: {} }).then((r) => {
    listCache.clear();
    return r;
  });
}

// Duplicate a converted PRF as a prefilled draft revision (the price-revision workflow).
export const duplicatePurchaseRequest = (id: string) => action(id, "duplicate");

// --- Reorder-workbench generation -------------------------------------------
// The server revalidates every row against LIVE suggestions before creating anything, so the result
// reports what was actually created, what was skipped (stale/covered) and any capped quantities.
export interface ReorderGenerateRow {
  irmItemId: string;
  warehouseId: string;
  supplierId: string;
  quantity: number;
  itemName?: string; // display echo — labels a skipped row in the result
  warehouseName?: string;
}
export interface GenerateReorderResult {
  created: { id: string; code: string; supplierName: string; warehouseName: string; lineCount: number; totalPence: number }[];
  skipped: { irmItemId: string; itemName: string; warehouseName: string; reason: string }[];
  adjusted: { irmItemId: string; itemName: string; warehouseName: string; requestedQty: number; finalQty: number }[];
}
export function generateReorderPrfs(rows: ReorderGenerateRow[], requiredByDate?: string): Promise<GenerateReorderResult> {
  return api<GenerateReorderResult>("/purchase-requests/generate-reorder", {
    method: "POST",
    body: { rows, ...(requiredByDate ? { requiredByDate } : {}) },
  }).then((r) => {
    listCache.clear(); // new draft PRFs exist — any cached PRF list is stale
    return r;
  });
}

// --- attachments ------------------------------------------------------------
// A longer timeout than the 20s default: the request base64-uploads the file to Cloudinary
// server-side, a network round-trip that can legitimately take longer than a plain JSON call.
// Aliased to the shared value so every upload in the app waits the same amount — see
// LONG_WRITE_TIMEOUT for the full reasoning.
const ATTACHMENT_TIMEOUT_MS = LONG_WRITE_TIMEOUT;
export function addAttachment(id: string, payload: PrfAttachmentPayload): Promise<PurchaseRequest> {
  return mutate(
    api<{ purchaseRequest: PurchaseRequest }>(`/purchase-requests/${id}/attachments`, {
      method: "POST",
      body: payload,
      timeout: ATTACHMENT_TIMEOUT_MS,
    }),
  );
}
export function removeAttachment(id: string, attachmentId: string): Promise<PurchaseRequest> {
  return mutate(api<{ purchaseRequest: PurchaseRequest }>(`/purchase-requests/${id}/attachments/${attachmentId}`, { method: "DELETE" }));
}
