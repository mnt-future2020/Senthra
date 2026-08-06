import { api, LONG_WRITE_TIMEOUT, apiFile } from "@/lib/api";
import { downloadBlob, filenameFromDisposition } from "@/lib/download";
import { registerClientCache } from "@/lib/clientCache";
import type {
  BulkSiteResult,
  Customer,
  CustomerOverview,
  CustomerProject,
  CustomerSelfProfile,
  CustomerSite,
  CustomerStatus,
  CustomerStock,
  CustomerStockEntry,
  CustomerSummary,
  CustomerUser,
  PendingStockItem,
  PortalStockEntry,
  PortalStockRequest,
  ProjectStatus,
  StockRequest,
  StockRequestStatus,
  WarehouseAssignment,
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

export interface SitePayload {
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
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
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => {
    listCache.clear();
    return r;
  });
}

export function updateCustomer(id: string, payload: UpdateCustomerPayload): Promise<CustomerSummary> {
  return api<{ customer: CustomerSummary }>(`/customers/${id}`, {
    method: "PUT",
    body: payload,
    timeout: LONG_WRITE_TIMEOUT,
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

// ADMIN paged children for the detail tabs — the detail payload no longer carries the full
// sets (sites can be bulk-imported in the thousands). Same paged shapes as the portal lists.
export function listCustomerSites(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerSites> {
  return api<PagedCustomerSites>(`/customers/${customerId}/sites${portalQs(params)}`);
}
export function listCustomerProjects(customerId: string, params: PortalListParams = {}): Promise<PagedCustomerProjects> {
  return api<PagedCustomerProjects>(`/customers/${customerId}/projects${portalQs(params)}`);
}
// Lean dedupe-key source for the site-import preview (name + postcode only).
export function getCustomerSiteKeys(customerId: string): Promise<{ name: string; postcode: string | null }[]> {
  return api<{ keys: { name: string; postcode: string | null }[] }>(`/customers/${customerId}/site-keys`).then((r) => r.keys);
}

// One row in a bulk import: the site payload plus its original 1-based sheet row number,
// which the server echoes back in `failed`/`skipped` notes so they point at the user's file.
export type SiteImportRow = SitePayload & { rowNumber: number };

// Bulk-import sites for a customer. Sends ONE batch (≤500 rows); the caller chunks larger
// sheets and aggregates. `fileName` is metadata for the server audit trail.
export function bulkAddSites(
  customerId: string,
  sites: SiteImportRow[],
  fileName?: string,
): Promise<BulkSiteResult> {
  return api<BulkSiteResult>(`/customers/${customerId}/sites/bulk`, {
    method: "POST",
    body: { sites, fileName },
  });
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
  reason?: string;
  notes?: string;
  // When topping up an existing received stock line, the id of that line. The backend
  // derives the item name from it and adds to its quantity instead of duplicating it.
  linkedStockEntryId?: string;
}

// Admin creates a submission on behalf of a customer (e.g. taken over the phone).
export interface AdminStockRequestPayload {
  name: string;
  quantity: number;
  requestedByName?: string;
  notes?: string;
  linkedStockEntryId?: string;
}

export function createStockRequestForCustomer(
  customerId: string,
  payload: AdminStockRequestPayload,
): Promise<StockRequest> {
  return api<{ request: StockRequest }>(`/customers/${customerId}/stock-requests`, {
    method: "POST",
    body: payload,
  }).then((r) => r.request);
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

// PM edits the free-text item name + approves in one step.
export interface EditApprovePayload {
  editedName: string;
  catalogueItemId?: string;
  note?: string;
}

export function editAndApproveStockRequest(
  customerId: string,
  requestId: string,
  payload: EditApprovePayload,
): Promise<StockRequest> {
  return api<{ request: StockRequest }>(
    `/customers/${customerId}/stock-requests/${requestId}/edit-approve`,
    { method: "POST", body: payload },
  ).then((r) => r.request);
}

// PM assigns warehouses to an approved request (total must match quantity).
export interface AssignWarehousesPayload {
  assignments: Array<{ warehouseId: string; quantity: number }>;
}

export function assignStockRequestWarehouses(
  customerId: string,
  requestId: string,
  payload: AssignWarehousesPayload,
): Promise<StockRequest> {
  return api<{ request: StockRequest }>(
    `/customers/${customerId}/stock-requests/${requestId}/assign`,
    { method: "POST", body: payload },
  ).then((r) => r.request);
}

// View warehouse assignments for a specific stock request.
export function listStockRequestAssignments(
  customerId: string,
  requestId: string,
): Promise<WarehouseAssignment[]> {
  return api<{ assignments: WarehouseAssignment[] }>(
    `/customers/${customerId}/stock-requests/${requestId}/assignments`,
  ).then((r) => r.assignments);
}

// Warehouse manager receives stock against an assignment.
export interface ReceiveStockPayload {
  receivedQuantity: number;
  notes?: string;
}

export interface ReceiveStockResult {
  assignment: WarehouseAssignment;
  stockEntryId: string;
  // "draft" = the entry still needs product details (category + barcode) before it can go active.
  // "active" = this receipt topped up an entry the warehouse manager already completed.
  stockEntryStatus: "draft" | "active";
}

export function receiveStockAssignment(
  assignmentId: string,
  payload: ReceiveStockPayload,
): Promise<ReceiveStockResult> {
  return api<ReceiveStockResult>(
    `/stock-assignments/${assignmentId}/receive`,
    { method: "POST", body: payload },
  );
}

/**
 * Close a delivery whose outstanding balance will never arrive (customer shipped short, lost in
 * transit, order rescoped). Terminal — the assignment leaves the warehouse's Incoming queue and
 * can't be received into afterwards. `reason` is required and lands in the audit trail.
 */
export function closeStockAssignmentShort(
  assignmentId: string,
  reason: string,
): Promise<WarehouseAssignment> {
  return api<{ assignment: WarehouseAssignment }>(
    `/stock-assignments/${assignmentId}/close-short`,
    { method: "POST", body: { reason } },
  ).then((r) => r.assignment);
}

// Pending customer stock items for a warehouse (the incoming queue).
export function getPendingStockForWarehouse(warehouseId: string): Promise<PendingStockItem[]> {
  return api<{ items: PendingStockItem[] }>(
    `/warehouses/${warehouseId}/pending-stock`,
  ).then((r) => r.items);
}

// --- customer stock entries (product details after warehouse receive) ---------

export function getStockEntry(entryId: string): Promise<CustomerStockEntry> {
  return api<{ entry: CustomerStockEntry }>(`/stock-entries/${entryId}`).then((r) => r.entry);
}

export interface StockEntryUpdatePayload {
  itemName: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  uom?: string;
  serialized?: boolean;
  serialNumber?: string;
  highValue?: boolean;
  attributes?: Record<string, string>;
}

export function updateStockEntry(
  entryId: string,
  payload: StockEntryUpdatePayload,
): Promise<CustomerStockEntry> {
  return api<{ entry: CustomerStockEntry }>(`/stock-entries/${entryId}`, {
    method: "PUT",
    body: payload,
  }).then((r) => r.entry);
}

export function deleteStockEntry(entryId: string): Promise<void> {
  return api(`/stock-entries/${entryId}`, { method: "DELETE" }).then(() => undefined);
}

export function generateStockEntryBarcode(entryId: string): Promise<CustomerStockEntry> {
  return api<{ entry: CustomerStockEntry }>(`/stock-entries/${entryId}/generate-barcode`, {
    method: "POST",
  }).then((r) => r.entry);
}

export interface DirectStockEntryPayload {
  warehouseId: string;
  itemName: string;
  sku?: string;
  categoryId?: string;
  description?: string;
  uom?: string;
  quantity: number;
  serialized?: boolean;
  serialNumber?: string;
  highValue?: boolean;
  thresholdQty?: number;
  attributes?: Record<string, string>;
}

export function createDirectStockEntry(
  customerId: string,
  payload: DirectStockEntryPayload,
): Promise<CustomerStockEntry> {
  return api<{ entry: CustomerStockEntry }>(`/customers/${customerId}/stock-entries`, {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((r) => r.entry);
}

export function listCustomerStockEntries(
  customerId: string,
  status?: string,
): Promise<CustomerStockEntry[]> {
  const q = status ? `?status=${status}` : "";
  return api<{ entries: CustomerStockEntry[] }>(
    `/customers/${customerId}/stock-entries${q}`,
  ).then((r) => r.entries);
}

export function listWarehouseStockEntries(
  warehouseId: string,
  status?: string,
): Promise<CustomerStockEntry[]> {
  const q = status ? `?status=${status}` : "";
  return api<{ entries: CustomerStockEntry[] }>(
    `/warehouses/${warehouseId}/stock-entries${q}`,
  ).then((r) => r.entries);
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

// Shared paged-list params + query-string helper for the portal lists (?q, ?status, ?sort, ?page).
export interface PortalListParams {
  q?: string;
  status?: string;
  sort?: string;
  /** Stock lists only — narrows to one warehouse, by id so a rename can't break a saved link. */
  warehouseId?: string;
  page?: number;
  pageSize?: number;
}
interface Paged {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
const portalQs = (p: PortalListParams): string => {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.status) qs.set("status", p.status);
  if (p.sort) qs.set("sort", p.sort);
  if (p.warehouseId) qs.set("warehouseId", p.warehouseId);
  if (p.page) qs.set("page", String(p.page));
  if (p.pageSize) qs.set("pageSize", String(p.pageSize));
  return qs.size ? `?${qs.toString()}` : "";
};

export type PagedCustomerProjects = Paged & { projects: CustomerProject[] };
export function getOwnProjects(params: PortalListParams = {}): Promise<PagedCustomerProjects> {
  return api<PagedCustomerProjects>(`/customer/projects${portalQs(params)}`);
}

export type PagedCustomerSites = Paged & { sites: CustomerSite[] };
export function getOwnSites(params: PortalListParams = {}): Promise<PagedCustomerSites> {
  return api<PagedCustomerSites>(`/customer/sites${portalQs(params)}`);
}

export function getOwnStock(): Promise<CustomerStock> {
  return api<{ stock: CustomerStock }>("/customer/stock").then((r) => r.stock);
}

// PortalStockEntry, not CustomerStockEntry — this endpoint is the customer's own view and the
// server sends the narrower row (no staff email, none of the dead tracking columns).
export type PagedStockEntries = Paged & { entries: PortalStockEntry[] };
export function getOwnStockEntries(params: PortalListParams = {}): Promise<PagedStockEntries> {
  return api<PagedStockEntries>(`/customer/stock-entries${portalQs(params)}`);
}

/**
 * Download the customer's stock as CSV, honouring the list's filters. Paging is dropped — the export
 * is "everything matching what I'm looking at", not the page on screen. Same contract as the audit and
 * inventory exports. `capped` is true when the server hit its row limit.
 */
export async function exportOwnStockCsv(params: PortalListParams = {}): Promise<{ capped: boolean }> {
  return portalCsv("/customer/stock-entries/export.csv", params, "my-stock");
}

/** The same, for the customer's submissions — one row per warehouse leg. */
export async function exportOwnStockRequestsCsv(params: PortalListParams = {}): Promise<{ capped: boolean }> {
  return portalCsv("/customer/stock-requests/export.csv", params, "my-submissions");
}

// Shared by both: strip paging, fetch as a blob, hand the browser a download. Uses `apiFile` rather
// than `api()` because that wrapper parses JSON, and rather than raw axios because `apiFile` keeps the
// silent-refresh interceptor — otherwise an export fired just after the access token expired would
// fail outright instead of refreshing and replaying. Cookies still scope the response to this customer.
async function portalCsv(
  path: string,
  params: PortalListParams,
  fallbackName: string,
): Promise<{ capped: boolean }> {
  const { page: _page, pageSize: _pageSize, ...filters } = params;
  void _page;
  void _pageSize;
  const { blob, headers } = await apiFile(`${path}${portalQs(filters)}`);
  const date = new Date().toISOString().slice(0, 10);
  const filename = filenameFromDisposition(
    headers["content-disposition"] ?? null,
    `${fallbackName}-${date}.csv`,
  );
  downloadBlob(blob, filename);
  // Reads as false unless `X-Export-Capped` is in the API's CORS exposedHeaders — the browser hides
  // an unexposed header on a cross-origin response, which would silently pass a truncated export off
  // as complete.
  return { capped: String(headers["x-export-capped"] ?? "") === "true" };
}

/**
 * The warehouses actually holding this customer's stock — the option list for My Stock's warehouse
 * filter. Fetched once, independently of the list, so the options don't shrink as the customer filters.
 */
export function getOwnStockWarehouses(): Promise<{ id: string; name: string; code: string }[]> {
  return api<{ warehouses: { id: string; name: string; code: string }[] }>(
    "/customer/stock-warehouses",
  ).then((r) => r.warehouses);
}

// PortalStockRequest, not StockRequest — the portal endpoints return the customer-safe subset (no
// staff emails, no internal warehouse notes). Typing it that way here is what stops a portal
// component reaching for a field the server has deliberately stopped sending.
export type PagedStockRequests = Paged & { requests: PortalStockRequest[] };
export function getOwnStockRequests(params: PortalListParams = {}): Promise<PagedStockRequests> {
  return api<PagedStockRequests>(`/customer/stock-requests${portalQs(params)}`);
}

export function submitStockRequest(payload: StockRequestPayload): Promise<PortalStockRequest> {
  return api<{ request: PortalStockRequest }>("/customer/stock-requests", {
    method: "POST",
    body: payload,
  }).then((r) => r.request);
}
