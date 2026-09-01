import { api } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import type { IrmItem, IrmStatus } from "@/types/irm";

// Typed wrappers around the backend /irm-items endpoints.

export interface IrmListParams {
  search?: string;
  /**
   * Resolve exactly these ids in ONE request — narrowing only, and the way to load an
   * already-selected item that the current search or first page does not contain. Server-side it is
   * ANDed with every other filter, so it can never widen what the caller is allowed to see.
   */
  ids?: string[];
  status?: string;
  type?: string;
  category?: string;
  supplier?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedIrmItems {
  items: IrmItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One supplier link in the create/update payload.
export interface IrmSupplierRowPayload {
  supplierId: string;
  isPrimary?: boolean;
  priority?: number | string;
  supplierSku?: string;
  leadTimeDays?: number | string;
}

// Create + update payload. Cost is sent in POUNDS (`standardCost`); the server stores pence.
export interface IrmItemPayload {
  name?: string;
  description?: string;
  brand?: string;
  manufacturer?: string;
  mpn?: string;
  typeId?: string;
  irmCategoryId?: string;
  status?: IrmStatus;
  sku?: string;
  suppliers?: IrmSupplierRowPayload[];
  baseUnit?: string;
  packSize?: number | string;
  reorderLevel?: number | string;
  maximumStock?: number | string;
  criticalLevel?: number | string;
  standardCost?: number | string;
  currency?: string;
  vatRatePercent?: number | string;
  trackInventory?: boolean;
  notes?: string;
}

function qs(params: IrmListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.ids?.length) sp.set("ids", params.ids.join(","));
  if (params.status) sp.set("status", params.status);
  if (params.type) sp.set("type", params.type);
  if (params.category) sp.set("category", params.category);
  if (params.supplier) sp.set("supplier", params.supplier);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedIrmItems>();
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
export const listCacheKey = (p: IrmListParams): string => qs(p);

export const getCachedIrmItems = (params: IrmListParams = {}): PagedIrmItems | undefined =>
  listCache.get(listCacheKey(params));

/**
 * The SAME filtered catalogue as a CSV. Paging is dropped — an export is "everything matching what
 * I'm looking at", not the page on screen. `capped` is true when the server stopped short.
 */
export function exportIrmItemsCsv(params: IrmListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/irm-items/export.csv${qs(withoutPaging(params))}`, "irm-catalogue");
}

export function listIrmItems(params: IrmListParams = {}): Promise<PagedIrmItems> {
  return api<PagedIrmItems>(`/irm-items${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getIrmItem(idOrCode: string): Promise<IrmItem> {
  return api<{ item: IrmItem }>(`/irm-items/${idOrCode}`).then((r) => r.item);
}

export function createIrmItem(payload: IrmItemPayload): Promise<IrmItem> {
  return api<{ item: IrmItem }>("/irm-items", { method: "POST", body: payload }).then((r) => {
    listCache.clear();
    return r.item;
  });
}

export function updateIrmItem(id: string, payload: IrmItemPayload): Promise<IrmItem> {
  return api<{ item: IrmItem }>(`/irm-items/${id}`, { method: "PATCH", body: payload }).then((r) => {
    listCache.clear();
    return r.item;
  });
}

export function deleteIrmItem(id: string): Promise<void> {
  return api(`/irm-items/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// Generate / regenerate the item's Code128 barcode image (server renders + stores it).
export function generateBarcode(id: string): Promise<IrmItem> {
  return api<{ item: IrmItem }>(`/irm-items/${id}/generate-barcode`, { method: "POST" }).then((r) => {
    listCache.clear();
    return r.item;
  });
}

