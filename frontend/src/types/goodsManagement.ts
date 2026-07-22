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
  goodsStatus: GoodsStatus;
  kitLines: QueueKitLine[];
}

// One page of the warehouse Goods Management queue (server-side filtered + paginated).
export interface QueuePage {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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
  reason: string | null;
  photoUrl: string | null;
}

// ── Overdue holdings ──────────────────────────────────────────────────────────

export interface OverdueRow {
  jobId: string;
  jobNumber: string;
  engineerName: string | null;
  issuedAt: string; // when the issue movement was posted
  daysOut: number;
  goodsStatus: GoodsStatus;
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

export interface CloseReconcilePayload {
  writeOffLost?: boolean;
}

export interface CloseReconcileResult {
  summary: JobStockSummary;
  unaccounted: { itemName: string; qty: number }[];
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
