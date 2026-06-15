import { api } from "@/lib/api";
import { registerClientCache } from "@/lib/clientCache";
import type {
  CatalogueItem,
  Customer,
  CustomerOverview,
  CustomerProject,
  CustomerSelfProfile,
  CustomerSite,
  CustomerStatus,
  CustomerStock,
  CustomerSummary,
  CustomerUser,
  ProjectStatus,
  StockRequest,
  StockRequestStatus,
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

// Optional company / contact / address fields shared by create + update. `logo`
// is a data URI uploaded to Cloudinary by the backend.
export interface CustomerFieldsPayload {
  legalName?: string;
  registrationNumber?: string;
  industry?: string;
  website?: string;
  notes?: string;
  contactPerson?: string;
  contactJobTitle?: string;
  phone?: string;
  altPhone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  status?: CustomerStatus;
  logo?: string;
}

export interface CreateCustomerPayload extends CustomerFieldsPayload {
  name: string;
  email: string;
}

export interface UpdateCustomerPayload extends CustomerFieldsPayload {
  name?: string;
  email?: string;
  removeLogo?: boolean;
}

export interface CreateCustomerResult {
  customer: CustomerSummary;
  temporaryPassword: string;
}

export interface ProjectPayload {
  name: string;
  type?: string;
  startDate?: string; // ISO date (yyyy-mm-dd) or ""
  endDate?: string;
  status?: ProjectStatus;
  description?: string;
}

export interface CatalogueItemPayload {
  name: string;
  sku: string;
  categoryId: string;
  description?: string;
  uom?: string;
  serialized?: boolean;
  barcodeRequired?: boolean;
  highValue?: boolean;
  thresholdQty?: number;
  status?: CustomerStatus;
  attributes?: Record<string, string>;
}

export interface SitePayload {
  name: string;
  addressLine?: string;
  postcode?: string;
  contactPerson?: string;
  contactNumber?: string;
  status?: CustomerStatus;
}

export interface CustomerUserPayload {
  fullName: string;
  email: string;
  phone?: string;
  designation?: string;
  status?: CustomerStatus;
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
// A longer timeout covers the Cloudinary logo upload (when a logo is included).
export function createCustomer(payload: CreateCustomerPayload): Promise<CreateCustomerResult> {
  return api<CreateCustomerResult>("/customers", {
    method: "POST",
    body: payload,
    timeout: 60_000,
  }).then((r) => {
    listCache.clear();
    return r;
  });
}

export function updateCustomer(id: string, payload: UpdateCustomerPayload): Promise<CustomerSummary> {
  return api<{ customer: CustomerSummary }>(`/customers/${id}`, {
    method: "PUT",
    body: payload,
    timeout: 60_000,
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

// Resends the company's PRIMARY portal user a fresh temp password.
export function resendInvite(id: string): Promise<{ temporaryPassword: string; email: string }> {
  return api<{ temporaryPassword: string; email: string }>(`/customers/${id}/resend-invite`, {
    method: "POST",
  });
}

// --- nested: projects ---
export function addProject(customerId: string, payload: ProjectPayload): Promise<CustomerProject> {
  return api<{ project: CustomerProject }>(`/customers/${customerId}/projects`, {
    method: "POST",
    body: payload,
  }).then((r) => r.project);
}

export function updateProject(
  customerId: string,
  projectId: string,
  payload: ProjectPayload,
): Promise<CustomerProject> {
  return api<{ project: CustomerProject }>(`/customers/${customerId}/projects/${projectId}`, {
    method: "PUT",
    body: payload,
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

// --- nested: customer users ---
// Every customer user is a login account — creating one returns its one-time
// temporary password (shown once), alongside the new user.
export interface CustomerUserInviteResult {
  user: CustomerUser;
  temporaryPassword: string;
}

export function addCustomerUser(
  customerId: string,
  payload: CustomerUserPayload,
): Promise<CustomerUserInviteResult> {
  return api<CustomerUserInviteResult>(`/customers/${customerId}/users`, {
    method: "POST",
    body: payload,
  });
}

export function updateCustomerUser(
  customerId: string,
  userId: string,
  payload: CustomerUserPayload,
): Promise<CustomerUser> {
  return api<{ user: CustomerUser }>(`/customers/${customerId}/users/${userId}`, {
    method: "PUT",
    body: payload,
  }).then((r) => r.user);
}

// Re-issue a single user's login invite (fresh temp password + email).
export function resendCustomerUserInvite(
  customerId: string,
  userId: string,
): Promise<{ temporaryPassword: string; email: string }> {
  return api<{ temporaryPassword: string; email: string }>(
    `/customers/${customerId}/users/${userId}/resend-invite`,
    { method: "POST" },
  );
}

// Admin-initiated password reset: the backend emails the customer a secure link to
// set their OWN new password. Returns only the email (no password is exposed).
export function sendCustomerUserResetLink(
  customerId: string,
  userId: string,
): Promise<{ email: string }> {
  return api<{ email: string }>(
    `/customers/${customerId}/users/${userId}/send-reset-link`,
    { method: "POST" },
  );
}

// --- nested: stock requests (admin review queue) ---
export interface StockRequestPayload {
  name: string;
  quantity: number;
  reason: string;
  notes?: string;
}

export function listStockRequests(
  customerId: string,
  status?: StockRequestStatus,
): Promise<StockRequest[]> {
  const q = status ? `?status=${status}` : "";
  return api<{ requests: StockRequest[] }>(`/customers/${customerId}/stock-requests${q}`).then(
    (r) => r.requests,
  );
}

// Approve → status move only (records the reviewer + optional response note). It
// never creates a catalogue item or inventory record.
export function approveStockRequest(
  customerId: string,
  requestId: string,
  note?: string,
): Promise<StockRequest> {
  return api<{ request: StockRequest }>(
    `/customers/${customerId}/stock-requests/${requestId}/approve`,
    { method: "POST", body: { note } },
  ).then((r) => r.request);
}

export function rejectStockRequest(
  customerId: string,
  requestId: string,
  note?: string,
): Promise<StockRequest> {
  return api<{ request: StockRequest }>(
    `/customers/${customerId}/stock-requests/${requestId}/reject`,
    { method: "POST", body: { note } },
  ).then((r) => r.request);
}

// ============================================================================
// Customer-facing portal surface — /customer (own data only; the one write is a
// stock REQUEST, which only queues a review).
// ============================================================================

export function getOwnProfile(): Promise<CustomerSelfProfile> {
  return api<{ profile: CustomerSelfProfile }>("/customer/me").then((r) => r.profile);
}

export function getOwnOverview(): Promise<CustomerOverview> {
  return api<{ overview: CustomerOverview }>("/customer/overview").then((r) => r.overview);
}

export function getOwnProjects(): Promise<CustomerProject[]> {
  return api<{ projects: CustomerProject[] }>("/customer/projects").then((r) => r.projects);
}

export function getOwnSites(): Promise<CustomerSite[]> {
  return api<{ sites: CustomerSite[] }>("/customer/sites").then((r) => r.sites);
}

export function getOwnCatalogue(): Promise<CatalogueItem[]> {
  return api<{ catalogue: CatalogueItem[] }>("/customer/catalogue").then((r) => r.catalogue);
}

export function getOwnStock(): Promise<CustomerStock> {
  return api<{ stock: CustomerStock }>("/customer/stock").then((r) => r.stock);
}

export function getOwnStockRequests(): Promise<StockRequest[]> {
  return api<{ requests: StockRequest[] }>("/customer/stock-requests").then((r) => r.requests);
}

export function submitStockRequest(payload: StockRequestPayload): Promise<StockRequest> {
  return api<{ request: StockRequest }>("/customer/stock-requests", {
    method: "POST",
    body: payload,
  }).then((r) => r.request);
}
