import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import type { GoodsReceipt } from "@/types/goods-in";

// Typed wrappers around the backend /goods-in endpoints (CRUD + complete/cancel + attachments).

export interface GrnListParams {
  search?: string;
  status?: string;
  warehouse?: string;
  purchaseOrder?: string;
  /** Narrows to one supplier's receipts — the supplier detail page's Goods In tab. */
  supplier?: string;
  /** Inclusive calendar days ("YYYY-MM-DD"), as the user picked them. The SERVER decides which
   *  day that is for a timestamp column, in the company timezone. */
  receivedFrom?: string;
  receivedTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedGoodsReceipts {
  goodsReceipts: GoodsReceipt[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One received line. Serial numbers are plain strings; batches carry an optional expiry.
// Send received + ACCEPTED (what passed QC); the server derives damaged = received − accepted.
// `acceptedQuantity` is required — omitting it is a validation error server-side, never a
// silent "nothing accepted".
export interface GrnLinePayload {
  purchaseOrderItemId: string;
  receivedQuantity: number | string;
  acceptedQuantity: number | string;
  notes?: string;
  serials?: string[];
  batches?: { batchNumber: string; expiryDate?: string; quantity: number | string }[];
}

export interface GoodsReceiptPayload {
  purchaseOrderId?: string;
  receivedDate?: string;
  referenceNumber?: string;
  carrier?: string;
  deliveryNoteNumber?: string;
  vehicleRegistration?: string;
  description?: string;
  qualityStatus?: string;
  qualityNotes?: string;
  internalNotes?: string;
  items?: GrnLinePayload[];
}

export interface GrnAttachmentPayload {
  label?: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  data: string; // data URI
}

function qs(params: GrnListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.purchaseOrder) sp.set("purchaseOrder", params.purchaseOrder);
  if (params.supplier) sp.set("supplier", params.supplier);
  if (params.receivedFrom) sp.set("receivedFrom", params.receivedFrom);
  if (params.receivedTo) sp.set("receivedTo", params.receivedTo);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedGoodsReceipts>();
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
export const listCacheKey = (p: GrnListParams): string => qs(p);

export const getCachedGoodsReceipts = (params: GrnListParams = {}): PagedGoodsReceipts | undefined => listCache.get(listCacheKey(params));

/**
 * The SAME filtered register as a CSV. Paging is dropped — an export is "everything matching what
 * I'm looking at", not the page on screen — and the server keeps the caller's warehouse scope.
 * `capped` is true when it stopped short of the full set.
 */
/**
 * The same receipts, ONE ROW PER LINE — the supplier-quality report. Which item was short or
 * damaged, on which order, from which supplier: none of that is answerable from a header row.
 */
export function exportGoodsReceiptLinesCsv(params: GrnListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/goods-in/export-lines.csv${qs(withoutPaging(params))}`, "goods-in-lines");
}

export function exportGoodsReceiptsCsv(params: GrnListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/goods-in/export.csv${qs(withoutPaging(params))}`, "goods-in");
}

export function listGoodsReceipts(params: GrnListParams = {}): Promise<PagedGoodsReceipts> {
  return api<PagedGoodsReceipts>(`/goods-in${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getGoodsReceipt(idOrCode: string): Promise<GoodsReceipt> {
  return api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${idOrCode}`).then((r) => r.goodsReceipt);
}

const mutate = (p: Promise<{ goodsReceipt: GoodsReceipt }>): Promise<GoodsReceipt> =>
  p.then((r) => {
    listCache.clear();
    return r.goodsReceipt;
  });

export function createGoodsReceipt(payload: GoodsReceiptPayload): Promise<GoodsReceipt> {
  return mutate(api<{ goodsReceipt: GoodsReceipt }>("/goods-in", { method: "POST", body: payload }));
}
export function updateGoodsReceipt(id: string, payload: GoodsReceiptPayload): Promise<GoodsReceipt> {
  return mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}`, { method: "PATCH", body: payload }));
}
export function deleteGoodsReceipt(id: string): Promise<void> {
  return api(`/goods-in/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// --- workflow transitions ---------------------------------------------------
// `complete` posts EVERY received line into inventory in one transaction, so the whole family gets
// the long timeout rather than only that one — see LONG_WRITE_TIMEOUT. `cancel` can't run long, but
// splitting the helper to save 40s on a failure nobody is waiting through isn't worth the branch.
const action = (id: string, name: string, body?: unknown): Promise<GoodsReceipt> =>
  mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/${name}`, { method: "POST", body: body ?? {}, timeout: LONG_WRITE_TIMEOUT }));

export const completeGoodsReceipt = (id: string) => action(id, "complete");
export const cancelGoodsReceipt = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });

// --- attachments ------------------------------------------------------------
export function addAttachment(id: string, payload: GrnAttachmentPayload): Promise<GoodsReceipt> {
  // Cloudinary relay — see LONG_WRITE_TIMEOUT (matches the PRF attachment upload).
  return mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/attachments`, { method: "POST", body: payload, timeout: LONG_WRITE_TIMEOUT }));
}
export function removeAttachment(id: string, attachmentId: string): Promise<GoodsReceipt> {
  return mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/attachments/${attachmentId}`, { method: "DELETE" }));
}
