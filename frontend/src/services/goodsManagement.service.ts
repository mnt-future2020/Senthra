import { api, LONG_WRITE_TIMEOUT } from "@/lib/api";
import type {
  ScanMatch,
  QueuePage,
  QueueStatusFilter,
  QueueSort,
  JobGoodsDetail,
  PublicMovement,
  DamagedRow,
  DamagedHistory,
  ReportDamagePayload,
  ReportDamageResult,
  OverdueGroupsResult,
  OverduePage,
  PostMovementPayload,
  CloseReconcilePayload,
  CloseReconcileResult,
  ListDamagedParams,
  DamagedCounts,
  DamagedListResult,
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
  /**
   * Window ("YYYY-MM-DD") on the job's last goods activity. For a reconciled job that timestamp IS the
   * close-out, which is what makes the Closed view answerable instead of an ever-growing scroll. The
   * server drops an unparseable value (no filter) rather than erroring.
   */
  activityFrom?: string;
  activityTo?: string;
  /**
   * Due window on the JOB's completion date — "what has to go out today". Deliberately a different
   * field from activityFrom/To above: activity is when stock last MOVED, so a job raised for today
   * with nothing issued has none, and an activity window would hide exactly the work being asked
   * about. Resolved against the SERVER's clock, so every manager sees the same "today".
   */
  due?: "overdue" | "today" | "week";
  /** Inclusive calendar days ("YYYY-MM-DD"). The SERVER resolves which day that is, in the
   *  company timezone — the browser clock never decides a boundary here. */
  dueFrom?: string;
  dueTo?: string;
  /** The job's ASSIGNED engineer — the person kit is handed to or chased from. */
  engineerId?: string;
  customerId?: string;
  siteId?: string;
  /** Row order; defaults to "newest" server-side. Applied across the whole result, not just the page. */
  sort?: QueueSort;
  page?: number;
  pageSize?: number;
}

/** One page of the Goods Management queue for a warehouse (filtered by status, search + date window). */
export function getQueue(params: GetQueueParams): Promise<QueuePage> {
  const q = new URLSearchParams({ warehouseId: params.warehouseId });
  if (params.status) q.set("status", params.status);
  if (params.search?.trim()) q.set("search", params.search.trim());
  if (params.activityFrom) q.set("activityFrom", params.activityFrom);
  if (params.activityTo) q.set("activityTo", params.activityTo);
  if (params.due) q.set("due", params.due);
  if (params.dueFrom) q.set("dueFrom", params.dueFrom);
  if (params.dueTo) q.set("dueTo", params.dueTo);
  if (params.engineerId) q.set("engineerId", params.engineerId);
  if (params.customerId) q.set("customerId", params.customerId);
  if (params.siteId) q.set("siteId", params.siteId);
  if (params.sort) q.set("sort", params.sort);
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
    // Every scanned line moves stock, updates a balance and writes a ledger row inside ONE
    // transaction — see LONG_WRITE_TIMEOUT.
    timeout: LONG_WRITE_TIMEOUT,
  }).then((r) => r.movement);
}

// ── Return (WM scan-in) ───────────────────────────────────────────────────────

/** Post a return movement — good lines credit the warehouse; damaged lines credit the damaged pool. */
export function postReturn(jobId: string, payload: Omit<PostMovementPayload, "direction">): Promise<PublicMovement> {
  return api<{ movement: PublicMovement }>(`/goods-management/jobs/${jobId}/return`, {
    method: "POST",
    body: { ...payload, direction: "return" } satisfies PostMovementPayload,
    timeout: LONG_WRITE_TIMEOUT, // as postIssue above
  }).then((r) => r.movement);
}

// ── Close & reconcile ─────────────────────────────────────────────────────────

/**
 * Reconcile a job's stock. If `writeOffLost` is true, any unaccounted units are written off.
 *
 * Returns the updated summary, the unaccounted items (empty when fully balanced) AND the hired kit
 * still out. SUCCESS IS NOT PROOF THE JOB CLOSED: a hire is the provider's equipment and is never
 * written off as our loss, so it never reaches `unaccounted` — it holds the job at `awaiting_return`
 * instead, and `rentalOutstanding` is the only thing that says so. Check it before reporting success.
 */
/**
 * Close & reconcile a job. Called with no payload it PREVIEWS: anything the engineer still holds comes
 * back as `unaccounted` and the job stays open. Call it again with `writeOffLost` (plus a reason, which
 * the server requires) to book those units as lost — that reconciles and LOCKS the job.
 */
export function closeReconcile(jobId: string, writeOff?: CloseReconcilePayload): Promise<CloseReconcileResult> {
  return api<CloseReconcileResult>(`/goods-management/jobs/${jobId}/close`, {
    method: "POST",
    body: writeOff ?? {},
    // Walks every kit line on the job and, with writeOffLost, books each unaccounted unit — see
    // LONG_WRITE_TIMEOUT. This one LOCKS the job, so a timeout the user reads as failure (and
    // retries) is the worst possible outcome.
    timeout: LONG_WRITE_TIMEOUT,
  });
}

// ── Damaged pool reads ────────────────────────────────────────────────────────

/**
 * List damaged-stock rows. Pass either warehouseId (warehouse tab) or customerId (customer page).
 * No price/cost fields are returned by the backend.
 */
export function listDamaged(params: ListDamagedParams = {}): Promise<DamagedListResult> {
  const sp = new URLSearchParams();
  if (params.countsOnly) sp.set("countsOnly", "1");
  if (params.warehouseId) sp.set("warehouseId", params.warehouseId);
  if (params.customerId) sp.set("customerId", params.customerId);
  if (params.ownerType) sp.set("ownerType", params.ownerType);
  if (params.search) sp.set("search", params.search);
  const qs = sp.toString();
  return api<{ damaged: DamagedRow[]; counts: DamagedCounts }>(
    `/goods-management/damaged${qs ? `?${qs}` : ""}`,
  ).then((r) => ({ rows: r.damaged, counts: r.counts }));
}

/**
 * Every damage report + restore behind ONE damaged row, newest first — each with its OWN reason and
 * photo. The list row can only carry the latest of each (the balance it comes from stores a quantity
 * and nothing else), so this is the only way to reach the evidence captured on earlier reports.
 *
 * Addressed by the row's natural key, not its id: pass the SAME ownerType/irmItemId/
 * customerStockEntryId the row carries. The backend rejects a company row sent without an irmItemId
 * (and a customer row without a customerStockEntryId) rather than answering for the wrong balance.
 */
export function getDamagedHistory(row: {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
}): Promise<DamagedHistory> {
  const sp = new URLSearchParams({ warehouseId: row.warehouseId, ownerType: row.ownerType });
  if (row.ownerType === "company" && row.irmItemId) sp.set("irmItemId", row.irmItemId);
  if (row.ownerType === "customer" && row.customerStockEntryId) {
    sp.set("customerStockEntryId", row.customerStockEntryId);
  }
  return api<DamagedHistory>(`/goods-management/damaged/history?${sp.toString()}`);
}

/**
 * Move units of stock already sitting in a warehouse into the damaged pool — the third writer,
 * alongside a job return and a van return. Reason and photo are both mandatory server-side, so
 * upload the photo first (uploadDamagePhoto) and pass the hosted URL it returns.
 *
 * Pass the SAME owner socket the row carries: `irmItemId` for company stock, `customerStockEntryId`
 * for customer consignment. The backend nulls the other one regardless, since a damaged balance is
 * keyed with exactly one of them set.
 */
export function reportDamage(payload: ReportDamagePayload): Promise<ReportDamageResult> {
  return api<ReportDamageResult>("/goods-management/damaged/report", { method: "POST", body: payload });
}

// ── Damage-photo upload ───────────────────────────────────────────────────────


// ── Overdue holdings ──────────────────────────────────────────────────────────

/**
 * List overdue-holding rows: issue movements older than `days` (default 14) whose job's stock
 * has not yet been reconciled. Used in the GoodsManagementTab overdue section.
 */
/**
 * Overdue holdings, plus the window they were selected with.
 *
 * There is no `days` argument by design: the window is set once in Settings → Operations and applies
 * everywhere, so a screen cannot quietly ask for a different definition of "overdue". The response
 * echoes the window the server used — print that, never a hardcoded number, or the page starts lying
 * the moment an admin changes the setting.
 */
export function listOverdue(params: {
  /** Scopes to one warehouse's issues — the tab is per-warehouse. Omit for the company-wide read. */
  warehouseId?: string;
  /** Job number, job name or engineer name. */
  search?: string;
  /** The engineer still HOLDING the kit — the issue movement's engineer, not the job's assignee. */
  engineerId?: string;
  /** Inclusive calendar days on when the kit was ISSUED. Server-resolved in company time. */
  issuedFrom?: string;
  issuedTo?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<OverduePage> {
  const q = new URLSearchParams();
  if (params.warehouseId) q.set("warehouseId", params.warehouseId);
  if (params.search?.trim()) q.set("search", params.search.trim());
  if (params.engineerId) q.set("engineerId", params.engineerId);
  if (params.issuedFrom) q.set("issuedFrom", params.issuedFrom);
  if (params.issuedTo) q.set("issuedTo", params.issuedTo);
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  const qs = q.toString();
  return api<OverduePage>(`/goods-management/overdue${qs ? `?${qs}` : ""}`);
}

/**
 * The SAME overdue selection, folded per warehouse and per engineer — what the Overview's "Overdue
 * Holdings" card opens.
 *
 * That card is a company-wide number and the work is done inside one warehouse's Goods tab, so there
 * is no single list behind it; this is the fan-out that makes it openable. `total` here is the card's
 * own count (one selection, two reads), and the response reports the Settings window it ran with.
 */
export function listOverdueGroups(params: {
  warehouseId?: string;
  search?: string;
  engineerId?: string;
  issuedFrom?: string;
  issuedTo?: string;
} = {}): Promise<OverdueGroupsResult> {
  const q = new URLSearchParams();
  if (params.warehouseId) q.set("warehouseId", params.warehouseId);
  if (params.search?.trim()) q.set("search", params.search.trim());
  if (params.engineerId) q.set("engineerId", params.engineerId);
  if (params.issuedFrom) q.set("issuedFrom", params.issuedFrom);
  if (params.issuedTo) q.set("issuedTo", params.issuedTo);
  const qs = q.toString();
  return api<OverdueGroupsResult>(`/goods-management/overdue/groups${qs ? `?${qs}` : ""}`);
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

