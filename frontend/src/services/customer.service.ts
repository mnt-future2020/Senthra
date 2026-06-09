import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type {
  CatalogueItem,
  Customer,
  CustomerProject,
  CustomerSelfProfile,
  CustomerSite,
  CustomerStatus,
  CustomerStock,
  CustomerSummary,
} from "@/types/customer";

// Typed wrappers around the backend /customers (admin) + /customer (portal)
// endpoints. Components call these instead of hitting api() with raw URLs.

// ============================================================================
// Admin / PM surface — /customers
// ============================================================================

export interface CustomerListParams {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedCustomers {
  customers: CustomerSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CreateCustomerPayload {
  name: string;
  email: string;
  contactPerson?: string;
  phone?: string;
  status?: CustomerStatus;
}

export type UpdateCustomerPayload = Partial<CreateCustomerPayload>;

export interface CreateCustomerResult {
  customer: CustomerSummary;
  temporaryPassword: string;
}

export interface CatalogueItemPayload {
  name: string;
  sku: string;
  category: string;
  attributes?: Record<string, string>;
}

export interface SitePayload {
  name: string;
  postcode?: string;
}

function qs(params: CustomerListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Stale-while-revalidate list cache, keyed by the query — returning to the list
// (e.g. right after creating a customer) renders instantly instead of flashing a
// skeleton. Cleared on logout.
const listCache = new Map<string, PagedCustomers>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: CustomerListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.sort ?? ""}`;

export const getCachedCustomers = (params: CustomerListParams = {}): PagedCustomers | undefined =>
  listCache.get(listCacheKey(params));

export function listCustomers(params: CustomerListParams = {}): Promise<PagedCustomers> {
  return api<PagedCustomers>(`/customers${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getCustomer(idOrCode: string): Promise<Customer> {
  return api<{ customer: Customer }>(`/customers/${idOrCode}`).then((r) => r.customer);
}

// Any mutation invalidates the cached list pages, so a remount (e.g. returning to
// the list after a delete) doesn't seed from a stale snapshot that still shows the
// old/removed row before the background refetch lands.
export function createCustomer(payload: CreateCustomerPayload): Promise<CreateCustomerResult> {
  return api<CreateCustomerResult>("/customers", { method: "POST", body: payload }).then((r) => {
    listCache.clear();
    return r;
  });
}

export function updateCustomer(id: string, payload: UpdateCustomerPayload): Promise<CustomerSummary> {
  return api<{ customer: CustomerSummary }>(`/customers/${id}`, {
    method: "PUT",
    body: payload,
  }).then((r) => {
    listCache.clear();
    return r.customer;
  });
}

export function deleteCustomer(id: string): Promise<void> {
  return api(`/customers/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

export function resendInvite(id: string): Promise<{ temporaryPassword: string }> {
  return api<{ temporaryPassword: string }>(`/customers/${id}/resend-invite`, { method: "POST" });
}

// --- nested: projects ---
export function addProject(customerId: string, name: string): Promise<CustomerProject> {
  return api<{ project: CustomerProject }>(`/customers/${customerId}/projects`, {
    method: "POST",
    body: { name },
  }).then((r) => r.project);
}

export function updateProject(
  customerId: string,
  projectId: string,
  name: string,
): Promise<CustomerProject> {
  return api<{ project: CustomerProject }>(`/customers/${customerId}/projects/${projectId}`, {
    method: "PUT",
    body: { name },
  }).then((r) => r.project);
}

export function deleteProject(customerId: string, projectId: string): Promise<void> {
  return api(`/customers/${customerId}/projects/${projectId}`, { method: "DELETE" }).then(
    () => undefined,
  );
}

// --- nested: catalogue ---
export function addCatalogueItem(
  customerId: string,
  payload: CatalogueItemPayload,
): Promise<CatalogueItem> {
  return api<{ item: CatalogueItem }>(`/customers/${customerId}/catalogue`, {
    method: "POST",
    body: payload,
  }).then((r) => r.item);
}

export function updateCatalogueItem(
  customerId: string,
  itemId: string,
  payload: CatalogueItemPayload,
): Promise<CatalogueItem> {
  return api<{ item: CatalogueItem }>(`/customers/${customerId}/catalogue/${itemId}`, {
    method: "PUT",
    body: payload,
  }).then((r) => r.item);
}

export function deleteCatalogueItem(customerId: string, itemId: string): Promise<void> {
  return api(`/customers/${customerId}/catalogue/${itemId}`, { method: "DELETE" }).then(
    () => undefined,
  );
}

// --- nested: sites ---
export function addSite(customerId: string, payload: SitePayload): Promise<CustomerSite> {
  return api<{ site: CustomerSite }>(`/customers/${customerId}/sites`, {
    method: "POST",
    body: payload,
  }).then((r) => r.site);
}

export function updateSite(
  customerId: string,
  siteId: string,
  payload: SitePayload,
): Promise<CustomerSite> {
  return api<{ site: CustomerSite }>(`/customers/${customerId}/sites/${siteId}`, {
    method: "PUT",
    body: payload,
  }).then((r) => r.site);
}

export function deleteSite(customerId: string, siteId: string): Promise<void> {
  return api(`/customers/${customerId}/sites/${siteId}`, { method: "DELETE" }).then(
    () => undefined,
  );
}

// ============================================================================
// Customer-facing portal surface — /customer (read-only, own data only)
// ============================================================================

export function getOwnProfile(): Promise<CustomerSelfProfile> {
  return api<{ profile: CustomerSelfProfile }>("/customer/me").then((r) => r.profile);
}

export function getOwnCatalogue(): Promise<CatalogueItem[]> {
  return api<{ catalogue: CatalogueItem[] }>("/customer/catalogue").then((r) => r.catalogue);
}

export function getOwnStock(): Promise<CustomerStock> {
  return api<{ stock: CustomerStock }>("/customer/stock").then((r) => r.stock);
}
