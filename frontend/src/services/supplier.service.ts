import { api } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import type { Supplier, SupplierStatus } from "@/types/supplier";

// Typed wrappers around the backend /suppliers endpoints. Components call these
// instead of hitting api() with raw URLs.

export interface SupplierListParams {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedSuppliers {
  suppliers: Supplier[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Create + update payload. Optional fields send "" to clear. `code` is never sent
// (server-owned).
export interface SupplierPayload {
  name?: string;
  legalName?: string;
  description?: string;
  typeId?: string;
  status?: SupplierStatus;
  contactPerson?: string;
  contactJobTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  companyRegistrationNumber?: string;
  vatNumber?: string;
  website?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  paymentTerms?: string;
  customPaymentTerms?: string;
  currency?: string;
  leadTimeDays?: number | string;
  notes?: string;
}

function qs(params: SupplierListParams): string {
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
const listCache = new Map<string, PagedSuppliers>();
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
export const listCacheKey = (p: SupplierListParams): string => qs(p);

export const getCachedSuppliers = (params: SupplierListParams = {}): PagedSuppliers | undefined =>
  listCache.get(listCacheKey(params));

/**
 * The SAME filtered list as a CSV. Paging is dropped — an export is "everything matching what I'm
 * looking at", not the page on screen. `capped` is true when the server stopped short.
 */
export function exportSuppliersCsv(params: SupplierListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/suppliers/export.csv${qs(withoutPaging(params))}`, "suppliers");
}

export function listSuppliers(params: SupplierListParams = {}): Promise<PagedSuppliers> {
  return api<PagedSuppliers>(`/suppliers${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getSupplier(idOrCode: string): Promise<Supplier> {
  return api<{ supplier: Supplier }>(`/suppliers/${idOrCode}`).then((r) => r.supplier);
}

export function createSupplier(payload: SupplierPayload): Promise<Supplier> {
  return api<{ supplier: Supplier }>("/suppliers", { method: "POST", body: payload }).then((r) => {
    listCache.clear();
    return r.supplier;
  });
}

export function updateSupplier(id: string, payload: SupplierPayload): Promise<Supplier> {
  return api<{ supplier: Supplier }>(`/suppliers/${id}`, { method: "PATCH", body: payload }).then(
    (r) => {
      listCache.clear();
      return r.supplier;
    },
  );
}

export function deleteSupplier(id: string): Promise<void> {
  return api(`/suppliers/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

