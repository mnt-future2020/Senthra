import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type { IrmItem, IrmOwner, IrmStatus } from "@/types/irm";

// Typed wrappers around the backend /irm-items endpoints.

export interface IrmListParams {
  search?: string;
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
  barcode?: string;
  qrCode?: string;
  suppliers?: IrmSupplierRowPayload[];
  baseUnit?: string;
  packSize?: number | string;
  conversionRatio?: number | string;
  minimumStock?: number | string;
  reorderLevel?: number | string;
  reorderQuantity?: number | string;
  maximumStock?: number | string;
  safetyStock?: number | string;
  criticalLevel?: number | string;
  standardCost?: number | string;
  currency?: string;
  vatRatePercent?: number | string;
  trackInventory?: boolean;
  trackSerialNumbers?: boolean;
  trackBatchNumbers?: boolean;
  allowNegativeStock?: boolean;
  ownerUserId?: string;
  notes?: string;
}

function qs(params: IrmListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
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
const listCacheKey = (p: IrmListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.type ?? ""}|${p.category ?? ""}|${p.supplier ?? ""}|${p.sort ?? ""}`;

export const getCachedIrmItems = (params: IrmListParams = {}): PagedIrmItems | undefined =>
  listCache.get(listCacheKey(params));

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

// Active staff users for the owner dropdown.
export function listOwnerOptions(): Promise<IrmOwner[]> {
  return api<{ owners: IrmOwner[] }>("/irm-items/owner-options").then((r) => r.owners);
}
