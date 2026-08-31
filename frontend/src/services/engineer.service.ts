import { api } from "@/lib/api";
import type { EngineerOverview, EngineerStockItem } from "@/types/engineer";
import type { Job } from "@/types/job";
import type { CustomerHolding, CompleteJobPayload } from "@/types/goodsManagement";
import type { MovementPage } from "@/types/stock-position";
import type { MovementFilters } from "@/services/stockPosition.service";

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

export interface OwnJobsParams {
  /** Inclusive calendar days on the DUE date. The SERVER resolves which day that is. */
  dueFrom?: string;
  dueTo?: string;
  status?: string;
  q?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}
export interface PagedOwnJobs {
  jobs: Job[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export function getOwnJobs(params: OwnJobsParams = {}): Promise<PagedOwnJobs> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.q) qs.set("q", params.q);
  if (params.sort) qs.set("sort", params.sort);
  if (params.dueFrom) qs.set("dueFrom", params.dueFrom);
  if (params.dueTo) qs.set("dueTo", params.dueTo);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return api<PagedOwnJobs>(`/engineer/jobs${suffix}`);
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

export interface MiscHeldItem {
  itemName: string;
  quantityOnHand: number;
}

/** Misc items issued to the engineer (free-text kit lines, no barcode/stock) — summed by item name. */
export function getOwnMiscStock(): Promise<MiscHeldItem[]> {
  return api<{ misc: MiscHeldItem[] }>("/engineer/misc-stock").then((r) => r.misc ?? []);
}

/**
 * HIRED kit the engineer is currently carrying, soonest deadline first.
 *
 * The one pool on this portal that isn't ours. Everything else an engineer holds either gets used up
 * or goes back at leisure; a hire bills by the day and belongs to a third party, so the only real
 * question is when it has to go back — which is why `dueInDays` and `overdue` are computed on the
 * SERVER (company timezone) rather than derived here from the date.
 *
 * No PO code and no money: the purchase order is the office's handle on a hire, not the engineer's.
 */
export interface RentalHolding {
  id: string;
  rentalItemId: string | null;
  itemName: string;
  quantityOnHand: number;
  hireEndDate: string | null;
  /** Whole days until the deadline. Negative ⇒ already overdue. Null ⇒ no deadline on record. */
  dueInDays: number | null;
  overdue: boolean;
}

export function getOwnRentals(): Promise<RentalHolding[]> {
  return api<{ rentals: RentalHolding[] }>("/engineer/rentals").then((r) => r.rentals ?? []);
}

// The engineer's OWN stock movement history — the unified ledger, hard-scoped server-side to this
// engineer's van (company + customer consignment). Cursor-paginated; same shape as the admin feed.
export function getOwnMovements(
  params: MovementFilters & { cursor?: string | null; limit?: number } = {},
): Promise<MovementPage> {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return api<MovementPage>(`/engineer/movements${s ? `?${s}` : ""}`);
}
