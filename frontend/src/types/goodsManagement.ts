// Goods Management types — mirror the backend public DTOs for the job-scoped scan flow.
// direction: issue (WM scan-out) | return (WM scan-in) | consume (engineer-declared at Complete).
// source: irm | customer. condition: good | damaged. Code prefix GM-####.
// IMPORTANT: no price/cost fields on customer-owned or damaged types.

// ── Enums / union types ──────────────────────────────────────────────────────

export type MovementDirection = "issue" | "return" | "consume";
export type LineSource = "irm" | "customer" | "rental" | "misc"; // misc = free-text kit line (no stock/barcode)
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

/** One hire a scan touches, and this hire's share of the units the scan may move. */
export interface ScanHire {
  purchaseOrderRentalLineId: string;
  poCode: string | null;
  hireEndDate: string | null;
  overdue: boolean;
  /**
   * ISSUE: units to take off this hire. RETURN: units that may go back on it. Either way the cap for
   * a movement line naming this hire, already spent server-side against what the KIT LINE needs or
   * owes — so the entries sum to at most that, and every card staged from them will post.
   */
  qty: number;
  /**
   * ISSUE only: this hire's own issuable stock, which is a different number from `qty` — a hire
   * holding 4 against a line that needs 3 lends 3 and still HAS 4. This is what the card prints as
   * "Available"; using `qty` there would show the depot's stock shrinking to whatever this job asked
   * for.
   */
  available?: number;
}

export interface ScanMatch {
  source: LineSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  rentalItemId?: string;
  /**
   * For a rental: WHICH HIRE the scan resolved to, chosen server-side (soonest deadline first) and
   * echoed back on post, so the units committed are the ones this preview showed.
   */
  purchaseOrderRentalLineId?: string;
  /** The hire's human context — which order it sits on and when it has to go back. */
  hire?: { poCode: string | null; hireEndDate: string | null; itemName: string; overdue: boolean } | null;
  /**
   * RENTALS ONLY — every hire this scan touches, earliest deadline first, the bound one (`hire` above)
   * at the head. Absent on every non-rental source.
   *
   * A movement line names ONE hire, and reporting only the bound one made the rest invisible. Coming
   * back, a kit line reading "issued 2" offered "Held: 1" and the second unit surfaced only if somebody
   * thought to scan again after posting. Going out, a line for 12 spread over four orders took four
   * scan→type→Post cycles, each capped at a number the warehouse discovered by being refused.
   *
   * The panel stages a card per entry, so one scan covers the whole line either way.
   */
  hires?: ScanHire[];
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
  /**
   * The evidence captured at the moment the damage was seen.
   *
   * The return scan REQUIRES both before it accepts a damaged unit, and until now no read shape carried
   * either — so the photograph worth most on the day it was taken could never be looked at again. A
   * `condition: "damaged"` with nothing behind it is a claim; with the picture and the words it is a
   * record, and a supplier dispute turns on which of the two you have.
   *
   * Null on every good line, and on a damaged line recorded before this was captured.
   */
  damagePhotoUrl: string | null;
  damageReason: string | null;
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
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  itemName: string;
  warehouseName: string | null;
  demand: number;
}

// One row of a warehouse demand board: current stock vs total planned across jobs.
export interface WarehouseDemandRow {
  // Hired items appear here too. They were previously mislabelled `customer` with inStock 0, which
  // sorted every live hire to the top of the board as a shortfall that did not exist.
  source: "irm" | "customer" | "rental";
  itemName: string;
  inStock: number;
  planned: number;
  free: number; // inStock − planned (negative ⇒ short)
}

// ── Queue row (planned vs issued vs available per kit line) ───────────────────

export interface QueueKitLine {
  id: string; // kit line id
  lineType: "irm" | "customer_stock" | "rental" | "misc";
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
  /**
   * Who owns the damaged units — and `rental` is not a third pool, it is a third SOURCE.
   *
   * Company and customer rows come from `DamagedStockBalance`, the pool of stock WE hold and can write
   * off or restore. A rental row is built from the hire's own custody records instead, because a hire
   * is the provider's equipment: its damage is a charge they will raise, not our shrinkage, and
   * writing it into that pool would count one fault twice — once against us and once on their invoice.
   *
   * They are listed TOGETHER because separating them on screen was the actual failure: a manager
   * looking for the tester an engineer brought back broken opened this tab, saw only owned stock, and
   * concluded nothing was wrong. Two sources, one list, one column saying which.
   */
  ownerType: "company" | "customer" | "rental";
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
  /**
   * RENTAL rows only — where it happened and which order settles it.
   *
   * Undefined on an owned row. A hire's damage is chased on its purchase order rather than restored to
   * usable, so the row needs somewhere to send you; and the job and engineer are the two facts a
   * conversation with the provider turns on.
   */
  poCode?: string | null;
  jobNumber?: string | null;
  engineerName?: string | null;
  /** `damage` or `loss`. Owned rows are always damage — nothing else reaches that pool. */
  exitKind?: "damage" | "loss";
  /** The hire line this row came off — what its History drill-down is keyed on. */
  hireLineId?: string;
  /**
   * How many individual reports the quantity is made of — rental rows only.
   *
   * The owned rows opposite are balances too, but theirs come from a ledger that already knows its own
   * depth; this one is rolled up here, so the count says out loud that History has more than one thing
   * in it rather than leaving a "3" looking like a single report of three units.
   */
  reportCount?: number;
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

/**
 * Where ONE rental damage/loss event now stands — RENTAL entries only.
 *
 * A hire carries two independent dimensions (`custodyState`: where the units are; `settlementState`:
 * where the money is), and a reader of the history needs the resolved answer rather than the pair.
 * `active` is the only value that still counts toward the row's current damaged quantity — see
 * `countsAsCurrentDamage`.
 *
 * Owned (company/customer) entries never carry this: the owned pool has no settlement lifecycle, and
 * its `type` (write_off | restore) already says everything there is to say about an entry.
 */
export type RentalDamageStatus =
  | "active" // still damaged/lost here, and still owed an answer — the only status that counts
  | "charged" // settled on a provider note
  | "no_charge" // dismissed — looked at, nothing owed
  | "withdrawn" // the report itself was taken back; it never happened of record
  | "returned" // handed back to the provider damaged
  | "recovered"; // a declared loss turned up and was booked back in

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
  /**
   * RENTAL entries only — undefined on owned ones, exactly as `DamagedRow`'s rental context fields are.
   *
   * Money lives here and ONLY here. The owned damaged pool is our own write-off with nobody to bill, so
   * it has no charge to report and must never be given one; a hire is the provider's equipment and its
   * damage is a charge they raise. Both are read back through this one modal, so the difference has to
   * be carried by optional fields rather than by a second type.
   */
  status?: RentalDamageStatus;
  /**
   * Whether this event still counts toward the row's current damaged quantity.
   *
   * Set from the same predicate the damaged LIST is built with, so `balanceAfter` on the newest entry
   * can never contradict the quantity on the card above it. Undefined on owned entries, whose
   * `balanceAfter` comes from the ledger's own stored running balance.
   */
  countsToTotal?: boolean;
  /** The provider charge settled against this event, in POUNDS. Null when the note carries no figure yet. */
  settledCharge?: number | null;
  /** The note that charge lives on (HDM-#### / HLS-####) — what an accountant looks it up by. */
  settledByCode?: string | null;
}

export interface DamagedHistory {
  warehouseId: string;
  ownerType: "company" | "customer" | "rental";
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
// The same overdue selection folded per warehouse and per engineer — the dashboard card's drill-down.
// Bounded by ENTITY count, never by job count, so a backlog of hundreds is still a handful of rows.
export interface OverdueGroup {
  /** warehouseId / engineerId. `unassigned` for a legacy issue with no warehouse recorded. */
  id: string;
  label: string;
  /** Warehouse code — what the deep link addresses. Null for engineers, and for `unassigned`, which
   *  is why a row with no code renders as plain text rather than a link that goes nowhere. */
  code: string | null;
  count: number;
  oldestDaysOut: number;
}

export interface OverdueGroupsResult {
  /** The Settings window the selection ran with — print this, never a hardcoded number. */
  days: number;
  /** Identical to the Overview card's count for the same actor: one selection, two reads. */
  total: number;
  byWarehouse: OverdueGroup[];
  byEngineer: OverdueGroup[];
}

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
  rentalItemId?: string;
  purchaseOrderRentalLineId?: string;
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
  /**
   * Hired kit still out with the engineer. Non-empty ⇒ THE JOB DID NOT CLOSE.
   *
   * A hire is never written off as lost here — it is the provider's equipment, not our shrinkage — so it
   * never appears in `unaccounted` and the request succeeds whatever else it wrote. What it does do is
   * hold the job at `awaiting_return`, because `reconciled` LOCKS the job against further scans and the
   * only way that tester can come home is the return scan the lock would forbid.
   *
   * Every caller must check this BEFORE reporting success. A response with an empty `unaccounted` is not
   * proof the job closed, and treating it as such put a green "Job reconciled" toast on screen and sent
   * the operator back to a queue where the job was still sitting open.
   */
  rentalOutstanding: {
    itemName: string;
    itemCode: string | null;
    qty: number;
    /**
     * The exact hires these units sit on — what turns the message into an action.
     *
     * Empty when the outstanding units cannot be traced to a hire (a movement line written before hire
     * ids existed). The row is still listed then, just without a Declare lost button: showing it with
     * no action beats hiding kit that is genuinely still out.
     */
    /** This job's own engineer — who a loss would be declared against. Null on a job with none assigned. */
    engineerId: string | null;
    engineerName: string | null;
    hires: { purchaseOrderRentalLineId: string; purchaseOrderId: string; poCode: string | null; qty: number }[];
  }[];
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
  /**
   * "company" | "customer" — which owned pool. Applied SERVER-side, after the warehouse scope, and
   * validated strictly there: an unknown value is rejected rather than silently ignored.
   *
   * Hired kit is not in this pool at all: it comes from the custody-exit endpoint and the screen
   * merges the two. No date filter here — see the service's DamagedFilters for why.
   */
  ownerType?: "company" | "customer";
  /** Item name, latest reason, or warehouse. */
  search?: string;
  /**
   * Ask for the COUNTS without the rows — what the screen wants while the reader is looking at the
   * HIRE pool, whose rows come from a different endpoint but whose switcher still has to show what
   * the owned pools hold.
   */
  countsOnly?: boolean;
}

/** Per-pool totals for the searched, scoped set — computed BEFORE `ownerType` narrows the rows. */
export interface DamagedCounts {
  company: number;
  customer: number;
}

export interface DamagedListResult {
  rows: DamagedRow[];
  counts: DamagedCounts;
}
