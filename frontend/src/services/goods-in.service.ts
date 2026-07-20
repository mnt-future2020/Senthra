import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { GoodsReceipt } from "@/types/goods-in";

// Typed wrappers around the backend /goods-in endpoints (CRUD + complete/cancel + attachments).

export interface GrnListParams {
  search?: string;
  status?: string;
  warehouse?: string;
  purchaseOrder?: string;
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
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedGoodsReceipts>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: GrnListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.warehouse ?? ""}|${p.purchaseOrder ?? ""}|${p.sort ?? ""}`;

export const getCachedGoodsReceipts = (params: GrnListParams = {}): PagedGoodsReceipts | undefined => listCache.get(listCacheKey(params));

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
const action = (id: string, name: string, body?: unknown): Promise<GoodsReceipt> =>
  mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/${name}`, { method: "POST", body: body ?? {} }));

export const completeGoodsReceipt = (id: string) => action(id, "complete");
export const cancelGoodsReceipt = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });

// --- attachments ------------------------------------------------------------
export function addAttachment(id: string, payload: GrnAttachmentPayload): Promise<GoodsReceipt> {
  return mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/attachments`, { method: "POST", body: payload }));
}
export function removeAttachment(id: string, attachmentId: string): Promise<GoodsReceipt> {
  return mutate(api<{ goodsReceipt: GoodsReceipt }>(`/goods-in/${id}/attachments/${attachmentId}`, { method: "DELETE" }));
}
