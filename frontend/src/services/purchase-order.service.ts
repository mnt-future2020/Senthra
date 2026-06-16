import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { PoPriority, PurchaseOrder } from "@/types/purchase-order";

// Typed wrappers around the backend /purchase-orders endpoints (CRUD + workflow + attachments).

export interface PoListParams {
  search?: string;
  status?: string;
  priority?: string;
  supplier?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedPurchaseOrders {
  purchaseOrders: PurchaseOrder[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One line on the create/update payload (unit price in PENCE; the form converts £ → pence).
export interface PoLinePayload {
  irmItemId: string;
  quantity: number | string;
  unitPricePence: number | string;
  vatRate?: number | string;
  notes?: string;
}

export interface PurchaseOrderPayload {
  supplierId?: string;
  warehouseId?: string;
  orderDate?: string;
  expectedDeliveryDate?: string;
  referenceNumber?: string;
  description?: string;
  priority?: PoPriority;
  deliveryAddress?: string;
  deliveryInstructions?: string;
  internalNotes?: string;
  supplierNotes?: string;
  items?: PoLinePayload[];
}

export interface PoAttachmentPayload {
  label?: string;
  fileName: string;
  fileType: string;
  fileSizeBytes: number;
  data: string; // data URI
}

function qs(params: PoListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.priority) sp.set("priority", params.priority);
  if (params.supplier) sp.set("supplier", params.supplier);
  if (params.warehouse) sp.set("warehouse", params.warehouse);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedPurchaseOrders>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: PoListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.priority ?? ""}|${p.supplier ?? ""}|${p.warehouse ?? ""}|${p.sort ?? ""}`;

export const getCachedPurchaseOrders = (params: PoListParams = {}): PagedPurchaseOrders | undefined =>
  listCache.get(listCacheKey(params));

export function listPurchaseOrders(params: PoListParams = {}): Promise<PagedPurchaseOrders> {
  return api<PagedPurchaseOrders>(`/purchase-orders${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getPurchaseOrder(idOrCode: string): Promise<PurchaseOrder> {
  return api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${idOrCode}`).then((r) => r.purchaseOrder);
}

const mutate = (p: Promise<{ purchaseOrder: PurchaseOrder }>): Promise<PurchaseOrder> =>
  p.then((r) => {
    listCache.clear();
    return r.purchaseOrder;
  });

export function createPurchaseOrder(payload: PurchaseOrderPayload): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>("/purchase-orders", { method: "POST", body: payload }));
}
export function updatePurchaseOrder(id: string, payload: PurchaseOrderPayload): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}`, { method: "PATCH", body: payload }));
}
export function deletePurchaseOrder(id: string): Promise<void> {
  return api(`/purchase-orders/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// --- workflow transitions ---------------------------------------------------
const action = (id: string, name: string, body?: unknown): Promise<PurchaseOrder> =>
  mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/${name}`, { method: "POST", body: body ?? {} }));

export const submitPurchaseOrder = (id: string) => action(id, "submit");
export const approvePurchaseOrder = (id: string) => action(id, "approve");
export const rejectPurchaseOrder = (id: string, reason: string) => action(id, "reject", { reason });
export const sendPurchaseOrder = (id: string) => action(id, "send");
export const cancelPurchaseOrder = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });
export const closePurchaseOrder = (id: string) => action(id, "close");

// --- attachments ------------------------------------------------------------
export function addAttachment(id: string, payload: PoAttachmentPayload): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/attachments`, { method: "POST", body: payload }));
}
export function removeAttachment(id: string, attachmentId: string): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/attachments/${attachmentId}`, { method: "DELETE" }));
}
