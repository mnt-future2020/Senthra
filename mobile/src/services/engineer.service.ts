import { api, qs } from "../lib/api";
import type {
  CompleteJobPayload,
  CustomerHolding,
  EngineerOverview,
  EngineerStockItem,
  Job,
  MiscHeldItem,
  MovementPage,
  PagedJobs,
} from "../types";

// Typed wrappers around the engineer portal API (/engineer/*). Every call is scoped on the
// backend to the signed-in staff user — there is no engineer-id parameter to pass.

export function getOwnOverview(): Promise<EngineerOverview> {
  return api<{ overview: EngineerOverview }>("/engineer/overview").then((r) => r.overview);
}

export function getOwnStock(): Promise<EngineerStockItem[]> {
  return api<{ stock: EngineerStockItem[] }>("/engineer/stock").then((r) => r.stock);
}

export function getOwnCustomerStock(): Promise<CustomerHolding[]> {
  return api<{ customerStock: CustomerHolding[] }>("/engineer/customer-stock").then(
    (r) => r.customerStock ?? [],
  );
}

export function getOwnMiscStock(): Promise<MiscHeldItem[]> {
  return api<{ misc: MiscHeldItem[] }>("/engineer/misc-stock").then((r) => r.misc ?? []);
}

export interface OwnJobsParams {
  status?: string;
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export function getOwnJobs(params: OwnJobsParams = {}): Promise<PagedJobs> {
  return api<PagedJobs>(`/engineer/jobs${qs(params as Record<string, unknown>)}`);
}

export function getOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}`).then((r) => r.job);
}

export function acceptOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/accept`, { method: "POST" }).then((r) => r.job);
}

export function rejectOwnJob(id: string, reason?: string): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/reject`, {
    method: "POST",
    body: { reason: reason ?? "" },
  }).then((r) => r.job);
}

export function startOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/start`, { method: "POST" }).then((r) => r.job);
}

export function completeOwnJob(id: string, payload: CompleteJobPayload): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/complete`, { method: "POST", body: payload }).then(
    (r) => r.job,
  );
}

export interface OwnMovementsParams {
  cursor?: string | null;
  limit?: number;
  ownership?: string;
  type?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function getOwnMovements(params: OwnMovementsParams = {}): Promise<MovementPage> {
  return api<MovementPage>(`/engineer/movements${qs(params as Record<string, unknown>)}`);
}
