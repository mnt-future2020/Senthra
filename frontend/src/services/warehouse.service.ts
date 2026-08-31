import { api } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import type { Warehouse, WarehouseManager, WarehouseStatus } from "@/types/warehouse";

// Typed wrappers around the backend /warehouses endpoints. Components call these
// instead of hitting api() with raw URLs.

export interface WarehouseListParams {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedWarehouses {
  warehouses: Warehouse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Create + update payload. Optional fields send "" to clear. Geolocation, code and the derived
// managers are never sent (server-owned; managers come from the user's assigned warehouses).
export interface WarehousePayload {
  name?: string;
  description?: string;
  typeId?: string;
  isDefault?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  operatingHours?: string;
  timezone?: string;
  notes?: string;
  status?: WarehouseStatus;
}

function qs(params: WarehouseListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.type) sp.set("type", params.type);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Stale-while-revalidate list cache, keyed by the query — returning to the list right
// after a mutation renders instantly instead of flashing a skeleton. Cleared on logout.
const listCache = new Map<string, PagedWarehouses>();
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
export const listCacheKey = (p: WarehouseListParams): string => qs(p);

export const getCachedWarehouses = (params: WarehouseListParams = {}): PagedWarehouses | undefined =>
  listCache.get(listCacheKey(params));

/**
 * The SAME filtered list as a CSV. Paging is dropped — an export is "everything matching what I'm
 * looking at", not the page on screen — and the server keeps the caller's warehouse scope, so a
 * scoped manager downloads their own sites and never the company's. `capped` flags a short file.
 */
export function exportWarehousesCsv(params: WarehouseListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/warehouses/export.csv${qs(withoutPaging(params))}`, "warehouses");
}

export function listWarehouses(params: WarehouseListParams = {}): Promise<PagedWarehouses> {
  return api<PagedWarehouses>(`/warehouses${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getWarehouse(idOrCode: string): Promise<Warehouse> {
  return api<{ warehouse: Warehouse }>(`/warehouses/${idOrCode}`).then((r) => r.warehouse);
}

export function createWarehouse(payload: WarehousePayload): Promise<Warehouse> {
  return api<{ warehouse: Warehouse }>("/warehouses", { method: "POST", body: payload }).then((r) => {
    listCache.clear();
    return r.warehouse;
  });
}

export function updateWarehouse(id: string, payload: WarehousePayload): Promise<Warehouse> {
  return api<{ warehouse: Warehouse }>(`/warehouses/${id}`, { method: "PATCH", body: payload }).then(
    (r) => {
      listCache.clear();
      return r.warehouse;
    },
  );
}

export function deleteWarehouse(id: string): Promise<void> {
  return api(`/warehouses/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// Active field engineers (canHoldStock roles) for the "assign an engineer" dropdowns on jobs.
export function listEngineerOptions(): Promise<WarehouseManager[]> {
  return api<{ engineers: WarehouseManager[] }>("/warehouses/engineer-options").then((r) => r.engineers);
}

// Lean active-warehouse options (id/code/name) for the user form's "Assigned Warehouses" picker.
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
export function listWarehouseOptions(): Promise<WarehouseOption[]> {
  return api<{ options: WarehouseOption[] }>("/warehouses/options").then((r) => r.options);
}
