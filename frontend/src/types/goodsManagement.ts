// Goods Management types — mirror the backend public DTOs for the job-scoped scan flow.
// direction: issue (WM scan-out) | return (WM scan-in) | consume (engineer-declared at Complete).
// source: irm | customer. condition: good | damaged. Code prefix GM-####.
// IMPORTANT: no price/cost fields on customer-owned or damaged types.

// ── Enums / union types ──────────────────────────────────────────────────────

export type MovementDirection = "issue" | "return" | "consume";
export type LineSource = "irm" | "customer" | "misc"; // misc = free-text kit line (no stock/barcode)
export type LineCondition = "good" | "damaged";

export type GoodsStatus =
  | "not_issued"
  | "partially_issued"
  | "issued"
  | "awaiting_return"
  | "reconciled";

/**
 * A single KIT LINE's status — a richer vocabulary than the job-level `GoodsStatus` above, which is
 * why the two are separate types rather than one shared union. A line can be individually `returned`
 * or `used` while the job as a whole is still `awaiting_return`, so collapsing them into one union
 * would let a job-level value be assigned where only a line status is meaningful (and vice versa).
 */
export type GoodsLineStatus = GoodsStatus | "returned" | "used";

// ── Scan-lookup result ────────────────────────────────────────────────────────

export interface ScanMatch {
  source: LineSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string;
  itemName: string;
  uom?: string | null;
  plannedQty: number;
  alreadyIssued: number;
  remainingIssuable: number;
  // Qty the engineer still holds for this line (issued − used − already-returned) — the cap for returns.
  heldByEngineer: number;
  available: number; // current warehouse stock available (net of reserved)
}

// ── Movement lines ────────────────────────────────────────────────────────────

export interface PublicMovementLine {
  source: LineSource;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  qty: number;
  condition: LineCondition;
}

// ── Movement (issue / return / consume) ──────────────────────────────────────

export interface PublicMovement {
  id: string;
  code: string; // GM-####
  jobId: string;
  direction: MovementDirection;
  status: "draft" | "posted";
  engineerId: string;
  engineerName: string;
  warehouseId: string | null;
  lines: PublicMovementLine[];
}

// ── Job stock summary ─────────────────────────────────────────────────────────

export interface JobStockSummary {
  id: string;
  jobId: string;
  goodsStatus: GoodsStatus;
  workSummary: string | null;
  lastMovementAt: string | null;
}

// ── Cross-job demand ──────────────────────────────────────────────────────────

// Open demand = stock active jobs have planned but not yet issued (per item+warehouse / entry).
export interface DemandEntry {
  irmItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  itemName: string;
  warehouseName: string | null;
  demand: number;
}

// One row of a warehouse demand board: current stock vs total planned across jobs.
export interface WarehouseDemandRow {
  source: "irm" | "customer";
  itemName: string;
  inStock: number;
  planned: number;
  free: number; // inStock − planned (negative ⇒ short)
}

// ── Queue row (planned vs issued vs available per kit line) ───────────────────

export interface QueueKitLine {
  id: string; // kit line id
  lineType: "irm" | "customer_stock" | "misc";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  /**
   * The string that resolves this line in the goods scan box, or null when the line isn't scannable
   * (a misc line, or a customer entry with no barcode). Resolved SERVER-side to mirror scanLookup —
   * never guessed here, because a code the scan then rejects is worse than offering none.
   */
  scanCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  plannedQty: number;
  issuedQty: number; // GROSS issued (total sent out, before returns)
  usedQty: number; // consumed/used on site
  returnedQty: number; // returned to the warehouse
  engineerHeld: number; // engineer's real current holding of this item (caps what can be returned)
  available: number; // current net warehouse availability
  // Still-out units of this line that came from a van and so may be RETURNED at any warehouse (no
  // warehouse released them). > 0 keeps the line actionable away from its nominal home instead of
  // greyed out. For a MIXED line this is just the van portion; 0 for a plain warehouse-issued line.
  vanReturnableQty: number;
  // Total units handed over from a van — lets the queue show a merged line's source split
  // ("N from stock · M from van"). Warehouse-issued part = issuedQty − vanIssuedQty.
  vanIssuedQty: number;
}

export interface QueueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  engineerId: string | null;
  engineerName: string | null;
  /**
   * The JOB's own lifecycle status, distinct from `goodsStatus` below. The queue reaches past
   * `completed` to `cancelled` so a cancelled job's kit can still be scanned back in, and that is the
   * one status where the panel's Issue half must not be offered — see scanDirections.
   */
  status: string;
  goodsStatus: GoodsStatus;
  /** When the job was raised — the age anchor for a job that has never had a goods movement. */
  createdAt: string;
  /**
   * The job's TARGET completion date (the planner's deadline), `null` when none was set — it is an
   * optional field on the job. This is what the queue's due filter matches, so the row shows it.
   */
  completionDate: string | null;
  /**
   * How that date reads today, decided by the SERVER in the company timezone. Never re-derive it from
   * the browser clock: a client in another day would badge a row differently from the filter that
   * selected it. `null` = no completion date set.
   */
  dueState: "past_due" | "today" | "upcoming" | null;
  /**
   * Last goods movement, `null` if nothing has ever moved. For a RECONCILED job this is effectively
   * its close-out date — the Closed view shows it, so the date filter narrows on something visible.
   */
  lastActivityAt: string | null;
  kitLines: QueueKitLine[];
}

// One page of the warehouse Goods Management queue (server-side filtered + paginated).
export interface QueuePage {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /**
   * The configured overdue window (Settings → Operations). Colour the "Waiting Nd" badge against THIS,
   * never a local constant — it's the same number the Overdue tab and the Inventory Hub count with.
   */
  overdueAfterDays: number;
}

// Queue status filter. "active" = everything still needing work (all but reconciled); "reconciled"
// backs the read-only Closed view; the others target one exact stage.
export type QueueStatusFilter =
  | "active"
  | "not_issued"
  | "partially_issued"
  | "issued"
  | "awaiting_return"
  | "reconciled";

// Queue ordering. "newest" = job raised most recently first (the historical default); "activity_asc" =
// least-recently-touched first, which is the only thing that surfaces neglected work; "activity_desc" =
// most-recently-touched first, the sane default for Closed.
export type QueueSort = "newest" | "activity_asc" | "activity_desc";

// ── Per-job goods detail ──────────────────────────────────────────────────────

export interface JobGoodsDetail {
  job: {
    id: string;
    jobNumber: string;
    name: string;
    assignedEngineerId: string | null;
    assignedEngineerName: string | null;
    status: string;
  };
  summary: JobStockSummary | null;
  movements: PublicMovement[];
}

// ── Damaged stock ─────────────────────────────────────────────────────────────
// No price/cost — customer-owned items expose item/qty/location only.

export interface DamagedRow {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  customerId: string | null;
  itemName: string;
  quantity: number;
  updatedAt: string;
  // The LATEST report's reason/photo only — a damaged row is an aggregate, so an item damaged more
  // than once shows the most recent evidence next to the running total. Every earlier report's own
  // reason and photo come from the history drill-down below.
  reason: string | null;
  photoUrl: string | null;
}

// ── Report damage on stock already in a warehouse ─────────────────────────────

export interface ReportDamagePayload {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  quantity: number;
  reason: string; // required — the damaged pool exists to hold evidence
  damagePhotoUrl: string; // required, same as a damaged return line
  notes?: string;
}

export interface ReportDamageResult {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  quantityDamaged: number;
  damagedBalanceAfter: number;
  usableBalanceAfter: number;
}

// ── Damaged history (drill-down behind one damaged row) ───────────────────────

export interface DamagedHistoryEntry {
  id: string;
  date: string;
  type: "write_off" | "restore";
  quantityDelta: number; // + damaged reported, − restored to usable
  balanceAfter: number;
  reason: string;
  notes: string | null;
  photoUrl: string | null;
  sourceType: string;
  sourceCode: string | null;
  actor: string | null;
}

export interface DamagedHistory {
  warehouseId: string;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  quantity: number;
  entries: DamagedHistoryEntry[];
  truncated: boolean; // true = older entries exist beyond the ones returned
}

// ── Overdue holdings ──────────────────────────────────────────────────────────

// One page of overdue rows. Paged and searched SERVER-side: this list is not guaranteed small — a busy
// operation can have hundreds of jobs overdue at once — and `total` counts the searched set, so the
// pager never offers a page that isn't there.
export interface OverduePage {
  days: number;
  rows: OverdueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OverdueRow {
  jobId: string;
  jobNumber: string;
  engineerName: string | null;
  issuedAt: string; // when the issue movement was posted
  daysOut: number;
  goodsStatus: GoodsStatus;
  /** The JOB's own status — a cancelled job's stock can only come back or be written off. */
  status: string;
  movementId: string;
  movementCode: string;
}

// ── Engineer customer-stock holding ──────────────────────────────────────────
// No price/cost — only item/qty/customer label.

export interface CustomerHolding {
  id: string;
  customerStockEntryId: string;
  engineerId: string;
  customerId: string | null;
  customerName: string | null;
  itemName: string;
  quantityOnHand: number;
  updatedAt: string;
}

// ── Payloads sent to the backend ─────────────────────────────────────────────

export interface MovementLinePayload {
  source: LineSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string;
  qty: number;
  condition?: LineCondition;
  scannedCode?: string;
  damagePhotoUrl?: string;
  damageReason?: string;
  notes?: string;
}

export interface PostMovementPayload {
  direction: "issue" | "return";
  warehouseId: string; // the warehouse the WM is issuing/receiving FROM
  notes?: string;
  lines: MovementLinePayload[];
}

// Why stock is being booked as lost. Mirrors WRITE_OFF_REASONS in goods-management.validation.ts —
// the server rejects anything outside this list, and requires a reason whenever writeOffLost is true.
export const WRITE_OFF_REASONS = [
  { value: "not_returned", label: "Not returned after repeated requests" },
  { value: "lost_in_transit", label: "Lost in transit" },
  { value: "engineer_left", label: "Engineer left the company" },
  { value: "site_theft", label: "Theft on site" },
  { value: "other", label: "Other (describe below)" },
] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]["value"];

export interface CloseReconcilePayload {
  writeOffLost?: boolean;
  /** Required by the server whenever `writeOffLost` is true. */
  writeOffReason?: WriteOffReason;
  /** Required by the server when the reason is "other". */
  writeOffNotes?: string;
  /**
   * Sent ONLY by the Overdue tab — its "the engineer isn't coming back" escape hatch.
   *
   * Both that tab and the everyday scan panel post to the same endpoint. The server relaxes its
   * "engineer must have completed the job first" rule only for requests carrying this, so the scan
   * panel can't reconcile (or write off) a job someone is still working. It is a routing marker, not
   * an override: the server still checks the job's stock against the configured overdue window.
   */
  fromOverdue?: boolean;
}

export interface CloseReconcileResult {
  summary: JobStockSummary;
  /** `itemCode` is the catalogue code — `itemName` is a kit-line snapshot and is not reliably unique. */
  unaccounted: { itemName: string; itemCode: string | null; qty: number }[];
}

export interface UsedLinePayload {
  source: LineSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string; // the exact kit line used — disambiguates an item issued from >1 warehouse
  qty: number;
}

export interface CompleteJobPayload {
  workSummary?: string;
  usedLines: UsedLinePayload[];
}

// ── Query-param shapes ────────────────────────────────────────────────────────

export interface ListDamagedParams {
  warehouseId?: string;
  customerId?: string;
}
