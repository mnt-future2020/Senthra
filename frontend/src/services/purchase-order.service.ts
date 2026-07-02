import { api, apiBlob } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import { downloadBlob } from "@/lib/download";
import type { PoPriority, PurchaseOrder } from "@/types/purchase-order";

// Typed wrappers around the backend /purchase-orders endpoints (CRUD + workflow + attachments).

// One PO row on the IRM item detail "Purchase Orders" tab (compact, read-only).
export interface ItemPurchaseRow {
  id: string;
  code: string;
  status: string;
  priority: PoPriority;
  supplierName: string | null;
  warehouseName: string | null;
  orderedQty: number;
  receivedQty: number;
  createdAt: string;
}

// POs that reference a given IRM item (newest first). Used by the IRM item detail PO tab.
export function listPurchaseOrdersForItem(irmItemId: string): Promise<ItemPurchaseRow[]> {
  return api<{ purchases: ItemPurchaseRow[] }>(`/purchase-orders/items/${irmItemId}`).then((r) => r.purchases);
}

export interface PoListParams {
  search?: string;
  status?: string;
  // Several statuses in one query (sent + partially_received for the Expected-deliveries
  // worklist). Serialized comma-separated; takes precedence over `status` on the backend.
  statuses?: string[];
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

// One line on the multi-warehouse split payload — like PoLinePayload but carrying its own
// destination warehouse. The backend groups by warehouse and creates one PO per group.
export interface SplitPoLinePayload extends PoLinePayload {
  warehouseId: string;
}

// Create-only payload (no PATCH variant), so the fields the backend's createPurchaseOrdersSplitSchema
// requires are required here too — keeps the FE/BE contract in lockstep and catches a missing
// supplier/date/line at compile time instead of as a 400.
export interface PurchaseOrderSplitPayload {
  supplierId: string;
  orderDate: string;
  expectedDeliveryDate: string;
  referenceNumber?: string;
  description?: string;
  priority?: PoPriority;
  deliveryAddress?: string;
  deliveryInstructions?: string;
  internalNotes?: string;
  supplierNotes?: string;
  items: SplitPoLinePayload[];
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
  if (params.statuses?.length) sp.set("statuses", params.statuses.join(","));
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
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${(p.statuses ?? []).join(",")}|${p.priority ?? ""}|${p.supplier ?? ""}|${p.warehouse ?? ""}|${p.sort ?? ""}`;

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

// Download the generated PO document (PDF) — the same document emailed to the supplier.
export async function downloadPurchaseOrderPdf(idOrCode: string, filename: string): Promise<void> {
  const blob = await apiBlob(`/purchase-orders/${idOrCode}/pdf`);
  downloadBlob(blob, filename);
}

const mutate = (p: Promise<{ purchaseOrder: PurchaseOrder }>): Promise<PurchaseOrder> =>
  p.then((r) => {
    listCache.clear();
    return r.purchaseOrder;
  });

export function createPurchaseOrder(payload: PurchaseOrderPayload): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>("/purchase-orders", { method: "POST", body: payload }));
}

// Multi-warehouse auto-split create: one purchasing operation → N single-warehouse POs (one per
// warehouse group). Returns every PO created.
export function createPurchaseOrdersSplit(payload: PurchaseOrderSplitPayload): Promise<PurchaseOrder[]> {
  return api<{ purchaseOrders: PurchaseOrder[] }>("/purchase-orders/split", { method: "POST", body: payload }).then((r) => {
    listCache.clear();
    return r.purchaseOrders;
  });
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
