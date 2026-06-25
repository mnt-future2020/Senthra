import { api } from "@/lib/api";
import type { EngineerOverview, EngineerStockItem } from "@/types/engineer";
import type { Job } from "@/types/job";
import type { CustomerHolding, CompleteJobPayload } from "@/types/goodsManagement";

// Typed wrappers around the engineer portal API (/engineer/*). Every call is scoped on the backend
// to the signed-in staff user — there is no engineer-id parameter to pass.

export function getOwnOverview(): Promise<EngineerOverview> {
  return api<{ overview: EngineerOverview }>("/engineer/overview").then((r) => r.overview);
}

export function getOwnStock(): Promise<EngineerStockItem[]> {
  return api<{ stock: EngineerStockItem[] }>("/engineer/stock").then((r) => r.stock);
}

// Jobs assigned to the signed-in engineer. The :id below is the JOB id (a resource the engineer
// owns) — the engineer's own id is resolved server-side from the principal, never passed here.

export function getOwnJobs(): Promise<Job[]> {
  return api<{ jobs: Job[] }>("/engineer/jobs").then((r) => r.jobs);
}

export function getOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>("/engineer/jobs/" + id).then((r) => r.job);
}

export function acceptOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>("/engineer/jobs/" + id + "/accept", { method: "POST" }).then((r) => r.job);
}

export function rejectOwnJob(id: string, reason?: string): Promise<Job> {
  return api<{ job: Job }>("/engineer/jobs/" + id + "/reject", { method: "POST", body: { reason: reason ?? "" } }).then((r) => r.job);
}

/**
 * Mark an accepted job as in-progress (Start work).
 * The engineer's own id is resolved server-side from the session.
 */
export function startOwnJob(id: string): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/start`, { method: "POST" }).then((r) => r.job);
}

/**
 * Mark an in-progress job as completed, declaring used quantities and an optional work summary.
 * Creates a `consume` movement draining the engineer's holdings by the declared amounts.
 */
export function completeOwnJob(id: string, payload: CompleteJobPayload): Promise<Job> {
  return api<{ job: Job }>(`/engineer/jobs/${id}/complete`, { method: "POST", body: payload }).then((r) => r.job);
}

/**
 * Return the signed-in engineer's held customer stock (consignment items issued from a job).
 * No price/cost fields — only item/qty/customer label.
 */
export function getOwnCustomerStock(): Promise<CustomerHolding[]> {
  return api<{ customerStock: CustomerHolding[] }>("/engineer/customer-stock").then((r) => r.customerStock ?? []);
}
