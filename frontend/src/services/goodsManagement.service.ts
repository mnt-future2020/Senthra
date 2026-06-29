import { api } from "@/lib/api";
import type {
  ScanMatch,
  QueuePage,
  QueueStatusFilter,
  JobGoodsDetail,
  PublicMovement,
  DamagedRow,
  OverdueRow,
  PostMovementPayload,
  CloseReconcilePayload,
  CloseReconcileResult,
  ListDamagedParams,
  DemandEntry,
  WarehouseDemandRow,
} from "@/types/goodsManagement";

// Typed wrappers around the backend /goods-management endpoints (scan-driven job-scoped issue,
// return, reconcile). Components call these — never api() directly. No price/cost fields on any response type.
// Engineer portal additions (startOwnJob, completeOwnJob, getOwnCustomerStock) live in engineer.service.ts.

// ── Scan-lookup ──────────────────────────────────────────────────────────────

/** Resolve a barcode / item code to a kit-line match for the given job + direction. */
export function scanLookup(
  jobId: string,
  direction: "issue" | "return",
  code: string,
  warehouseId: string,
): Promise<ScanMatch> {
  return api<{ match: ScanMatch }>("/goods-management/scan-lookup", {
    method: "POST",
    body: { jobId, warehouseId, direction, code },
  }).then((r) => r.match);
}

// ── Queue (warehouse-side, server-filtered + paginated) ───────────────────────

export interface GetQueueParams {
  warehouseId: string;
  status?: QueueStatusFilter; // defaults to "active" server-side
  search?: string;
  page?: number;
  pageSize?: number;
}

/** One page of the Goods Management queue for a warehouse (filtered by status + search). */
export function getQueue(params: GetQueueParams): Promise<QueuePage> {
  const q = new URLSearchParams({ warehouseId: params.warehouseId });
  if (params.status) q.set("status", params.status);
  if (params.search?.trim()) q.set("search", params.search.trim());
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  return api<QueuePage>(`/goods-management/queue?${q.toString()}`);
}

// ── Per-job goods detail ──────────────────────────────────────────────────────

/** Full goods detail for a single job: summary + all movements + kit-line tallies. */
export function getJobGoods(jobId: string): Promise<JobGoodsDetail> {
  return api<JobGoodsDetail>(`/goods-management/jobs/${jobId}`);
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

// ── Damage-photo upload ───────────────────────────────────────────────────────

/**
 * Upload a damage photo data URI to the backend (which relays it to Cloudinary).
 * Returns the resulting hosted URL — store this in the movement line's damagePhotoUrl field.
 */
export function uploadDamagePhoto(dataUri: string): Promise<string> {
  return api<{ url: string }>("/goods-management/damage-photo", {
    method: "POST",
    body: { image: dataUri },
  }).then((r) => r.url);
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

/**
 * Open demand across active jobs (planned-but-not-issued), per item+warehouse. The job form uses it
 * to show TRUE free stock (available − demand elsewhere). excludeJobId drops the job being edited.
 */
export function getJobsDemand(excludeJobId?: string): Promise<DemandEntry[]> {
  const qs = excludeJobId ? `?excludeJobId=${excludeJobId}` : "";
  return api<{ demand: DemandEntry[] }>(`/goods-management/demand${qs}`).then((r) => r.demand);
}

/** Demand board for one warehouse: each item's current stock vs total planned, shortfalls first. */
export function getWarehouseDemand(warehouseId: string): Promise<WarehouseDemandRow[]> {
  return api<{ rows: WarehouseDemandRow[] }>(`/goods-management/warehouses/${warehouseId}/demand`).then((r) => r.rows);
}

