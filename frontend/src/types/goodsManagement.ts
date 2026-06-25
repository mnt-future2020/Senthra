// Goods Management types — mirror the backend public DTOs for the job-scoped scan flow.
// direction: issue (WM scan-out) | return (WM scan-in) | consume (engineer-declared at Complete).
// source: irm | customer. condition: good | damaged. Code prefix GM-####.
// IMPORTANT: no price/cost fields on customer-owned or damaged types.

// ── Enums / union types ──────────────────────────────────────────────────────

export type MovementDirection = "issue" | "return" | "consume";
export type LineSource = "irm" | "customer";
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

// ── Queue row (planned vs issued vs available per kit line) ───────────────────

export interface QueueKitLine {
  id: string; // kit line id
  lineType: "irm" | "customer_stock" | "misc";
  itemName: string;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  plannedQty: number;
  issuedQty: number;
  available: number; // current net warehouse availability
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
  warehouseName?: string | null;
  ownerType: "company" | "customer";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  customerId: string | null;
  itemName: string;
  quantity: number;
  updatedAt: string;
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
