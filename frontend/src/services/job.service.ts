import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import { downloadCsv, withoutPaging } from "@/lib/csvExport";
import { registerClientCache } from "@/lib/clientCache";
import { portalQs, type PortalListParams } from "@/services/customer.service";
import type { Job, JobSummary, PortalJob, PortalJobDetail } from "@/types/job";

// Typed wrappers around the backend /jobs endpoints (office CRUD + assign/cancel). The
// create/assign flow snapshots the engineer and emits a realtime "job:new" to them.

export interface JobListParams {
  search?: string;
  status?: string;
  customer?: string;
  engineer?: string;
  project?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export interface PagedJobs {
  jobs: JobSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// One kit-list line in a job payload.
export interface JobKitLinePayload {
  lineType: "customer_stock" | "irm" | "misc";
  itemName: string;
  seCode?: string;
  description?: string;
  customerStockEntryId?: string;
  irmItemId?: string;
  warehouseId?: string; // irm: pickup warehouse (customer_stock derives it server-side from the entry)
  qty: number | string;
  notes?: string;
}

export interface JobPayload {
  name?: string;
  customerRef?: string;
  schemeNo?: string;
  jobType?: string;
  technology?: string;
  customerId?: string;
  projectId?: string;
  siteId?: string;
  siteName?: string;
  trsArea?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  floor?: string;
  suite?: string;
  rack?: string;
  shelf?: string;
  completionDate?: string;
  priority?: string;
  assignedEngineerId?: string;
  supplierId?: string;
  installerType?: string;
  plannerName?: string;
  plannerPhone?: string;
  notes?: string;
  attachments?: string[];
  kitLines?: JobKitLinePayload[];
}

function qs(params: JobListParams): string {
  const sp = new URLSearchParams();
  if (params.search) sp.set("search", params.search);
  if (params.status) sp.set("status", params.status);
  if (params.customer) sp.set("customer", params.customer);
  if (params.engineer) sp.set("engineer", params.engineer);
  if (params.project) sp.set("project", params.project);
  if (params.sort) sp.set("sort", params.sort);
  if (params.page) sp.set("page", String(params.page));
  if (params.pageSize) sp.set("pageSize", String(params.pageSize));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const listCache = new Map<string, PagedJobs>();
registerClientCache(() => listCache.clear());
const listCacheKey = (p: JobListParams): string =>
  `${p.page ?? 1}|${p.pageSize ?? ""}|${p.search ?? ""}|${p.status ?? ""}|${p.customer ?? ""}|${p.engineer ?? ""}|${p.project ?? ""}|${p.sort ?? ""}`;

export const getCachedJobs = (params: JobListParams = {}): PagedJobs | undefined => listCache.get(listCacheKey(params));

/**
 * The SAME filtered list as a CSV. Paging is dropped — an export is "everything matching what I'm
 * looking at", not the page on screen. `capped` is true when the server stopped short.
 */
export function exportJobsCsv(params: JobListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/jobs/export.csv${qs(withoutPaging(params))}`, "jobs");
}

export function listJobs(params: JobListParams = {}): Promise<PagedJobs> {
  return api<PagedJobs>(`/jobs${qs(params)}`).then((r) => {
    listCache.set(listCacheKey(params), r);
    return r;
  });
}

export function getJob(idOrCode: string): Promise<Job> {
  return api<{ job: Job }>(`/jobs/${idOrCode}`).then((r) => r.job);
}

const mutate = (p: Promise<{ job: Job }>): Promise<Job> =>
  p.then((r) => {
    listCache.clear();
    return r.job;
  });

export function createJob(payload: JobPayload): Promise<Job> {
  return mutate(api<{ job: Job }>("/jobs", { method: "POST", body: payload, timeout: LONG_WRITE_TIMEOUT }));
}
export function updateJob(id: string, payload: JobPayload): Promise<Job> {
  return mutate(api<{ job: Job }>(`/jobs/${id}`, { method: "PATCH", body: payload, timeout: LONG_WRITE_TIMEOUT }));
}
export function deleteJob(id: string): Promise<void> {
  return api(`/jobs/${id}`, { method: "DELETE" }).then(() => {
    listCache.clear();
  });
}

// --- workflow transitions ---------------------------------------------------
const action = (id: string, name: string, body?: unknown): Promise<Job> =>
  mutate(api<{ job: Job }>(`/jobs/${id}/${name}`, { method: "POST", body: body ?? {} }));

export const assignJob = (id: string, engineerId: string) => action(id, "assign", { engineerId });
export const cancelJob = (id: string, reason?: string) => action(id, "cancel", { reason: reason ?? "" });

export function uploadJobAttachment(dataUrl: string, fileName?: string): Promise<string> {
  return api<{ url: string }>("/jobs/attachment", {
    method: "POST",
    body: { data: dataUrl, ...(fileName ? { fileName } : {}) },
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.url);
}

// --- customer portal --------------------------------------------------------
// A separate endpoint, a separate type, and NOT part of `listCache` above: that cache is keyed by
// the office list's filters and cleared by office mutations, neither of which applies to a customer
// — who cannot mutate a job at all, and must never be served a page another session cached.
export type PagedPortalJobs = {
  jobs: PortalJob[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

/** The signed-in customer's own jobs. Scoped server-side from the session cookie — there is no
 *  customer id to pass, and passing one would not widen it. */
export function getOwnJobs(params: PortalListParams = {}): Promise<PagedPortalJobs> {
  return api<PagedPortalJobs>(`/customer/jobs${portalQs(params)}`);
}

/**
 * The customer's own jobs as a CSV, honouring the list's filters. Paging is dropped — an export is
 * "everything matching what I'm looking at", not the page on screen. Scoped server-side from the
 * session cookie, like every other portal read.
 */
export function exportOwnJobsCsv(params: PortalListParams = {}): Promise<{ capped: boolean }> {
  return downloadCsv(`/customer/jobs/export.csv${portalQs(withoutPaging(params))}`, "my-jobs");
}

/** One of the customer's own jobs. 404s for anything outside their company — see getJobForCustomer. */
export function getOwnJob(id: string): Promise<PortalJobDetail> {
  return api<{ job: PortalJobDetail }>(`/customer/jobs/${id}`).then((r) => r.job);
}
