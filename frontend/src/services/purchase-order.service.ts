import { api, apiBlob } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
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
  // Several statuses in one query (e.g. sent + supplier_accepted + partially_received for the
  // Expected-deliveries worklist). Serialized comma-separated; takes precedence over `status`
  // on the backend.
  statuses?: string[];
  priority?: string;
  supplier?: string;
  warehouse?: string;
  // Assigned PM filter — "me" resolves to the signed-in user server-side (the PM's
  // "Awaiting my action" worklist, combined with status=pm_review).
  pm?: string;
  job?: string;
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
  // null = explicitly clear on edit (an omitted key is "leave unchanged").
  jobId?: string | null;
  projectRef?: string;
  deliveryAddress?: string;
  deliveryInstructions?: string;
  deliveryTerms?: string | null;
  paymentTerms?: string | null;
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
  // null = explicitly clear on edit (an omitted key is "leave unchanged").
  jobId?: string | null;
  projectRef?: string;
  deliveryAddress?: string;
  deliveryInstructions?: string;
  deliveryTerms?: string | null;
  paymentTerms?: string | null;
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
  if (params.pm) sp.set("pm", params.pm);
  if (params.job) sp.set("job", params.job);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedPurchaseOrders>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: PoListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${(p.statuses ?? []).join(",")}|${p.priority ?? ""}|${p.supplier ?? ""}|${p.warehouse ?? ""}|${p.pm ?? ""}|${p.job ?? ""}|${p.sort ?? ""}`;

export const getCachedPurchaseOrders = (params: PoListParams = {}): PagedPurchaseOrders | undefined =>
  listCache.get(listCacheKey(params));

export function listPurchaseOrders(params: PoListParams = {}): Promise<PagedPurchaseOrders> {
  return api<PagedPurchaseOrders>(`/purchase-orders${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

/**
 * The SAME filtered list as a CSV. Paging is dropped — the export is "everything matching what I'm
 * looking at", not the page on screen — and the server applies the identical filters, warehouse
 * scope included. `capped` is true when it stopped short of the full set.
 */
/**
 * The same orders, ONE ROW PER LINE — the spend report. Header fields repeat on every row so the
 * file pivots (spend by item, unit-price trend, supplier comparison) without being filled down.
 */
export function exportPurchaseOrderLinesCsv(params: PoListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-orders/export-lines.csv${qs(withoutPaging(params))}`, "purchase-order-lines");
}

export function exportPurchaseOrdersCsv(params: PoListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/purchase-orders/export.csv${qs(withoutPaging(params))}`, "purchase-orders");
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
// Approve returns { purchaseOrder, divertedToReview }: divertedToReview=true means a PRF-born draft
// had diverged from its PRF and was routed into the review queue (pending_approval) instead of being
// approved outright — the caller messages that case differently.
export interface ApproveResult {
  purchaseOrder: PurchaseOrder;
  divertedToReview: boolean;
}
export function approvePurchaseOrder(id: string): Promise<ApproveResult> {
  return api<ApproveResult>(`/purchase-orders/${id}/approve`, { method: "POST", body: {} }).then((r) => {
    listCache.clear();
    return r;
  });
}
export const rejectPurchaseOrder = (id: string, reason: string) => action(id, "reject", { reason });
export const sendPurchaseOrder = (id: string) => action(id, "send");
// Cancellation reason is MANDATORY (audited; referenced by the supplier cancellation email).
export const cancelPurchaseOrder = (id: string, reason: string) => action(id, "cancel", { reason });
export const closePurchaseOrder = (id: string) => action(id, "close");

// --- PM routing (approved → pm_review; re-assign while in pm_review) ---------
export const assignPmPurchaseOrder = (id: string, pmUserId: string) => action(id, "assign-pm", { pmUserId });

// Eligible PMs for the Route-to-PM picker. The endpoint still returns `suggestedUserId` (it derives
// one from a linked job), but POs are no longer job-linked in the UI, so the picker ignores it and
// the caller always chooses explicitly — hence no jobId is sent.
export interface PmCandidate {
  id: string;
  name: string;
  email: string;
}
export function listPmCandidates(): Promise<{ candidates: PmCandidate[]; suggestedUserId: string | null }> {
  return api<{ candidates: PmCandidate[]; suggestedUserId: string | null }>("/purchase-orders/pm-candidates");
}

// --- supplier acceptance (sent → supplier_accepted) ---------------------------
export interface SupplierAcceptancePayload {
  acceptedDate?: string;
  // Required by the backend: accepting an order means committing to a delivery date. Revisable
  // afterwards via updateConfirmedDeliveryDate.
  confirmedDeliveryDate: string;
  supplierAckReference?: string;
  notes?: string;
}
export const recordSupplierAcceptance = (id: string, payload: SupplierAcceptancePayload) => action(id, "accept", payload);

// Revise the confirmed delivery date on an accepted order (audited with prev/new/reason).
export function updateConfirmedDeliveryDate(id: string, confirmedDeliveryDate: string, reason?: string): Promise<PurchaseOrder> {
  return mutate(
    api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/delivery-date`, {
      method: "PATCH",
      body: { confirmedDeliveryDate, reason: reason || undefined },
    }),
  );
}

// --- supplier procurement summary (the supplier detail "Procurement" tab) ----
export interface SupplierProcurementSummary {
  purchaseOrders: {
    total: number;
    byStatus: Record<string, number>;
    outstanding: number; // issued, not yet fully received
    open: number; // any non-terminal, not-yet-fully-received order
    cancelled: number;
    spendPence: number; // fully_received + closed orders only
    spend: number;
  };
  purchaseRequests: { total: number };
}
export function getSupplierProcurementSummary(supplierId: string): Promise<SupplierProcurementSummary> {
  return api<{ summary: SupplierProcurementSummary }>(`/purchase-orders/suppliers/${supplierId}/summary`).then((r) => r.summary);
}

// --- attachments ------------------------------------------------------------
export function addAttachment(id: string, payload: PoAttachmentPayload): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/attachments`, { method: "POST", body: payload }));
}
export function removeAttachment(id: string, attachmentId: string): Promise<PurchaseOrder> {
  return mutate(api<{ purchaseOrder: PurchaseOrder }>(`/purchase-orders/${id}/attachments/${attachmentId}`, { method: "DELETE" }));
}
