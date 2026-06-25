import { api } from "@/lib/api";
import type {
  ScanMatch,
  QueueRow,
  JobGoodsDetail,
  PublicMovement,
  DamagedRow,
  OverdueRow,
  CustomerHolding,
  PostMovementPayload,
  CloseReconcilePayload,
  CloseReconcileResult,
  CompleteJobPayload,
} from "@/types/goodsManagement";
import type { Job } from "@/types/job";

// Typed wrappers around the backend /goods-management endpoints (scan-driven job-scoped issue,
// return, reconcile) and the engineer portal additions (start/complete/customer stock).
// Components call these — never api() directly. No price/cost fields on any response type.

// ── Scan-lookup ──────────────────────────────────────────────────────────────

/** Resolve a barcode / item code to a kit-line match for the given job + direction. */
export function scanLookup(
  jobId: string,
  direction: "issue" | "return",
  code: string,
): Promise<ScanMatch> {
  return api<{ match: ScanMatch }>("/goods-management/scan-lookup", {
    method: "POST",
    body: { jobId, direction, code },
  }).then((r) => r.match);
}

// ── Queue (warehouse-side list of active jobs) ────────────────────────────────

/** All jobs in the active goods-management queue visible to the current user's warehouse scope. */
export function getQueue(): Promise<QueueRow[]> {
  return api<{ queue: QueueRow[] }>("/goods-management/queue").then((r) => r.queue);
}

// ── Per-job goods detail ──────────────────────────────────────────────────────

/** Full goods detail for a single job: summary + all movements + kit-line tallies. */
export function getJobGoods(jobId: string): Promise<JobGoodsDetail> {
  return api<{ goods: JobGoodsDetail }>(`/goods-management/jobs/${jobId}`).then((r) => r.goods);
}

// ── Issue (WM scan-out) ───────────────────────────────────────────────────────

/** Post an issue movement — decrements the warehouse, credits the engineer. */
export function postIssue(jobId: string, payload: Omit<PostMovementPayload, "direction">): Promise<PublicMovement> {
  return api<{ movement: PublicMovement }>(`/goods-management/jobs/${jobId}/issue`, {
    method: "POST",
    body: { ...payload, direction: "issue" } satisfies PostMovementPayload,
  }).then((r) => r.movement);
}

// ── Return (WM scan-in) ───────────────────────────────────────────────────────

/** Post a return movement — good lines credit the warehouse; damaged lines credit the damaged pool. */
export function postReturn(jobId: string, payload: Omit<PostMovementPayload, "direction">): Promise<PublicMovement> {
  return api<{ movement: PublicMovement }>(`/goods-management/jobs/${jobId}/return`, {
    method: "POST",
    body: { ...payload, direction: "return" } satisfies PostMovementPayload,
  }).then((r) => r.movement);
}

// ── Close & reconcile ─────────────────────────────────────────────────────────

/**
 * Reconcile a job's stock. If `writeOffLost` is true, any unaccounted units are written off.
 * Returns the updated summary and an array of unaccounted items (empty when fully balanced).
 */
export function closeReconcile(jobId: string, writeOffLost?: boolean): Promise<CloseReconcileResult> {
  const body: CloseReconcilePayload = writeOffLost != null ? { writeOffLost } : {};
  return api<CloseReconcileResult>(`/goods-management/jobs/${jobId}/close`, {
    method: "POST",
    body,
  });
}

// ── Damaged pool reads ────────────────────────────────────────────────────────

export interface ListDamagedParams {
  warehouseId?: string;
  customerId?: string;
}

/**
 * List damaged-stock rows. Pass either warehouseId (warehouse tab) or customerId (customer page).
 * No price/cost fields are returned by the backend.
 */
export function listDamaged(params: ListDamagedParams = {}): Promise<DamagedRow[]> {
  const sp = new URLSearchParams();
  if (params.warehouseId) sp.set("warehouseId", params.warehouseId);
  if (params.customerId) sp.set("customerId", params.customerId);
  const qs = sp.toString();
  return api<{ damaged: DamagedRow[] }>(`/goods-management/damaged${qs ? `?${qs}` : ""}`).then((r) => r.damaged);
}

// ── Overdue holdings ──────────────────────────────────────────────────────────

/**
 * List overdue-holding rows: issue movements older than `days` (default 14) whose job's stock
 * has not yet been reconciled. Used in the GoodsManagementTab overdue section.
 */
export function listOverdue(days?: number): Promise<OverdueRow[]> {
  const qs = days != null ? `?days=${days}` : "";
  return api<{ overdue: OverdueRow[] }>(`/goods-management/overdue${qs}`).then((r) => r.overdue);
}

// ── Engineer additions (added to engineer.service.ts namespace here for convenience) ────

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
  return api<{ stock: CustomerHolding[] }>("/engineer/customer-stock").then((r) => r.stock);
}
