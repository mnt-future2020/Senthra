// Shared domain types for the Senthra Engineer app.
// These mirror the web frontend's types (frontend/src/types + service DTOs) — the backend
// serialises Dates to ISO strings and every optional column is `| null`.

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AdminPrincipal {
  type: "admin";
  id: string;
  email: string;
  name: string | null;
}

export interface UserPrincipal {
  type: "user";
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileImageUrl: string | null;
  signatureUrl: string | null;
  status: string;
  mustResetPassword: boolean;
  role: { id: string; key: string; name: string } | null;
  permissions: string[];
  isWarehouseScoped: boolean;
  assignedWarehouseIds: string[] | null;
}

export interface CustomerPrincipal {
  type: "customer";
  id: string;
  email: string;
  fullName?: string | null;
  customerId?: string;
  customerName?: string | null;
  mustResetPassword?: boolean;
  permissions?: string[];
}

export type Principal = AdminPrincipal | UserPrincipal | CustomerPrincipal;

// Own editable profile (GET/PUT /users/me) — the backend returns the full user;
// only the fields the account screen shows are typed here.
export interface MyProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  profileImageUrl: string | null;
  signatureUrl: string | null;
  role: { id: string; key: string; name: string } | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
}

export interface MyProfileUpdate {
  phone?: string;
  profileImage?: string; // data URI
  removeProfileImage?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current?: boolean;
}

// ── Engineer portal ───────────────────────────────────────────────────────────

export interface EngineerStockItem {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
  lastMovedAt: string | null; // last time this line moved (dispatch/return) — the balance's updatedAt
}

export interface EngineerActivity {
  id: string;
  type: string;
  label: string;
  itemCode: string;
  itemName: string;
  quantityDelta: number;
  balanceAfter: number;
  sourceCode: string | null;
  notes: string | null;
  createdAt: string;
}

// A slim job row for the dashboard's "next up" list.
export interface EngineerOverviewJob {
  id: string;
  jobNumber: string;
  name: string;
  customerName: string | null;
  completionDate: string | null;
  priority: string;
  status: string;
}

export interface EngineerOverview {
  stock: { lines: number; totalQuantity: number };
  customerStock: { lines: number; totalQuantity: number }; // held customer consignment
  misc: { lines: number; totalQuantity: number }; // held misc (free-text) items
  jobs: {
    toAccept: number;
    accepted: number;
    inProgress: number;
    overdue: number;
    dueThisWeek: number;
    next: EngineerOverviewJob[]; // active jobs, soonest due first
  };
  transfers: { incomingPending: number; toSign: number }; // incoming awaiting acceptance / delivered awaiting signature
  vanStock: { toCollect: number }; // approved/partially-fulfilled restocks waiting to be collected
  kitRequests: { pending: number }; // own kit requests awaiting a planner decision
  recentActivity: EngineerActivity[];
}

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

export interface MiscHeldItem {
  itemName: string;
  quantityOnHand: number;
}

// ── Unified stock movements (engineer-scoped ledger) ─────────────────────────

export interface Movement {
  id: string;
  date: string;
  type: string;
  label: string;
  ownership: "company" | "customer";
  locationType: "warehouse" | "engineer" | "damaged";
  locationId: string | null;
  locationLabel: string;
  itemKind: "irm" | "customer_stock";
  itemId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  quantityDelta: number;
  balanceAfter: number | null;
  fromLabel: string | null;
  toLabel: string | null;
  reference: string | null;
  sourceType: string;
  sourceId: string;
  engineerId: string | null;
  customerId: string | null;
  customerName: string | null;
  actor: string | null;
  notes: string | null;
}

export interface MovementPage {
  movements: Movement[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export type JobLineType = "customer_stock" | "irm" | "rental" | "misc";

export interface JobKitWarehouse {
  id: string;
  name: string;
  code: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  contactPhone: string | null;
}

export interface KitLineVanSource {
  transferCode: string;
  engineerName: string;
  engineerPhone: string | null; // snapshot from the transfer — null when the holder had no phone on file
  quantity: number;
  status: string; // pending | completed
}

export interface JobKitLine {
  id: string;
  lineType: JobLineType;
  seCode: string | null;
  itemName: string;
  description: string | null;
  customerStockEntryId: string | null;
  irmItemId: string | null;
  /**
   * The CATALOGUE item on a `rental` line, and the RNT-#### its label is printed from.
   *
   * Both are sent by /engineer/jobs/:id and were being silently dropped here — so a planned rental
   * line had no id to key on, which is why the kit-request composer could not offer one.
   */
  rentalItemId: string | null;
  rentalItemCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  warehouse: JobKitWarehouse | null;
  qty: number;
  notes: string | null;
  issued: number;
  used: number;
  returned: number;
  remaining: number;
  // When this HIRED kit has to be back at its warehouse, so the warehouse can return it to the
  // provider. RENTAL lines only, and only while units are still out — null on every other line type
  // and once the line is fully returned. ISO date.
  //
  // The one thing that makes a rental line unlike the rest of this list: an IRM item sitting in a van
  // costs nothing, a hire bills every day and belongs to somebody else.
  hireEndDate: string | null;
  // Resolved by the SERVER against the company timezone. Never recompute this from `hireEndDate` on
  // the device — a phone in another zone (or with a wrong clock) would disagree with the warehouse
  // about which day it is, on the one field whose whole job is naming a day.
  hireOverdue: boolean;
  vanSources: KitLineVanSource[];
}

export interface Job {
  id: string;
  jobNumber: string;
  customerRef: string | null;
  schemeNo: string | null;
  name: string;
  jobType: string;
  technology: string | null;
  customerId: string;
  customerName: string | null;
  projectId: string;
  projectName: string | null;
  siteId: string | null;
  siteName: string | null;
  trsArea: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  suite: string | null;
  rack: string | null;
  shelf: string | null;
  completionDate: string | null;
  /**
   * Past its due date and still active — SERVER-DERIVED, never recomputed here.
   *
   * "Today" is the start of today in the COMPANY's timezone (a Settings value), which this device
   * does not know. Deriving it from `new Date()` would mark a different set of rows than the "Jobs
   * overdue" card counted, for any engineer not sitting in that timezone — and a handset is far more
   * likely to be in the wrong one than an office browser. Populated on list reads; false on detail.
   */
  overdue: boolean;
  /** Whole days past due when `overdue`, else null. Server-derived for the same reason. */
  daysLate: number | null;
  priority: string;
  assignedEngineerId: string | null;
  assignedEngineerName: string | null;
  assignedEngineerEmail: string | null;
  supplierId: string | null;
  supplierName: string | null;
  installerType: string;
  status: string;
  goodsStatus: string;
  pendingKitRequestCount: number;
  plannerName: string | null;
  plannerPhone: string | null;
  notes: string | null;
  attachments: string[];
  kitLines: JobKitLine[];
  assignedAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedJobs {
  jobs: Job[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type LineSource = "irm" | "customer";

export interface UsedLinePayload {
  source: LineSource;
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string;
  qty: number;
}

export interface CompleteJobPayload {
  workSummary?: string;
  usedLines: UsedLinePayload[];
}

// ── Engineer transfers ────────────────────────────────────────────────────────

export type TransferStatus = "pending" | "completed" | "declined" | "cancelled";
export type TransferOwnership = "company" | "customer";

export interface TransferLine {
  id: string;
  ownership: TransferOwnership;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  quantity: number;
}

export interface EngineerTransfer {
  id: string;
  code: string;
  status: TransferStatus;
  fromEngineerId: string;
  fromEngineerName: string;
  fromEngineerEmail: string | null;
  fromEngineerPhone: string | null;
  toEngineerId: string;
  toEngineerName: string;
  toEngineerEmail: string | null;
  requestedByKind: "engineer" | "admin";
  reason: string;
  notes: string | null;
  jobId: string | null;
  customerId: string | null;
  attachments: string[];
  requireSignature: boolean;
  receiverSignatureUrl: string | null;
  acknowledgedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  declinedBy: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  overrideByAdmin: boolean;
  createdAt: string;
  lines: TransferLine[];
}

export interface PagedTransfers {
  transfers: EngineerTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TransferLinePayload {
  ownership: TransferOwnership;
  irmItemId?: string;
  customerStockEntryId?: string;
  quantity: number;
}

export interface CreateTransferPayload {
  fromEngineerId?: string;
  toEngineerId?: string;
  lines: TransferLinePayload[];
  reason: string;
  notes?: string;
  jobId?: string;
  customerId?: string;
  attachments?: string[];
}

export interface CompanyCandidate {
  irmItemId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}

export interface CustomerCandidate {
  customerStockEntryId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  barcode: string | null;
  uom: string | null;
  customerName: string | null;
  engineerId: string;
  engineerName: string;
  available: number;
}

// ── Van stock requests ────────────────────────────────────────────────────────

export type VanStockRequestType = "restock" | "return";
export type VanStockRequestStatus =
  | "pending"
  | "approved"
  | "partially_fulfilled"
  | "fulfilled"
  | "declined"
  | "cancelled";
// Two levels — "high" was retired 2026-08-20. The API normalises the older rows that still hold it,
// so a phone never receives a third value. Options list lives beside the composer that renders it.
export type VanStockPriority = "normal" | "urgent";

export interface VanStockLine {
  id: string;
  irmItemId: string;
  itemName: string;
  code: string | null;
  sku: string | null;
  uom: string | null;
  requestedQty: number;
  approvedQty: number | null;
  fulfilledQty: number;
  remainingQty: number;
  closedShortQty: number | null;
  cancelledQty: number | null;
  sourceWarehouseId: string | null;
  sourceWarehouseName: string | null;
  sourceWarehouseCode: string | null;
  sourceWarehouse: JobKitWarehouse | null;
  isMine: boolean;
}

export interface VanStockFulfilmentLine {
  id: string;
  lineId: string;
  irmItemId: string;
  itemName: string;
  qty: number;
  condition: "good" | "damaged";
  damagePhotoUrl: string | null;
  damageReason: string | null;
  scannedCode: string | null;
}

export interface VanStockFulfilment {
  id: string;
  sequence: number;
  performedBy: string;
  postedAt: string;
  lines: VanStockFulfilmentLine[];
}

export interface VanStockRequest {
  id: string;
  code: string;
  type: VanStockRequestType;
  status: VanStockRequestStatus;
  priority: VanStockPriority;
  createdVia: "engineer_request" | "walk_in";
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  preferredWarehouseId: string | null;
  preferredWarehouseName: string | null;
  preferredWarehouseCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  lastFulfilledAt: string | null;
  completionType: "complete" | "closed_short" | "cancelled_remaining" | null;
  closedShortBy: string | null;
  closedShortAt: string | null;
  closeShortNote: string | null;
  cancelledAt: string | null;
  stale: boolean;
  progress: { lines: number; linesDone: number; qty: number; qtyFulfilled: number };
  myProgress: {
    warehouseIds: string[];
    lines: number;
    linesDone: number;
    qty: number;
    qtyFulfilled: number;
    allMineDone: boolean;
  } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: VanStockLine[];
  fulfilments: VanStockFulfilment[];
}

export interface PagedVanStockRequests {
  requests: VanStockRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VanStockLinePayload {
  irmItemId: string;
  itemName: string;
  qty: number;
  // RESTOCK only: the warehouse this line is collected from. The engineer picks it per item against
  // that warehouse's live free stock; the server stores it as the line's sourceWarehouseId, which is
  // what routes the request to each warehouse's queue. Omitted on a return (one destination).
  warehouseId?: string;
}

export interface CreateVanStockRequestPayload {
  type: VanStockRequestType;
  reason: string;
  notes?: string;
  priority?: VanStockPriority;
  attachments?: string[];
  preferredWarehouseId?: string; // never sent on a restock — DERIVED server-side from the lines
  warehouseId?: string; // return — final warehouse
  lines: VanStockLinePayload[];
}

export interface VanStockItemOption {
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
}

export interface HoldingOption {
  irmItemId: string;
  code: string;
  name: string;
  uom: string | null;
  quantityOnHand: number;
}

export interface WarehouseLite {
  id: string;
  name: string;
  code: string | null;
}

// ── Job kit requests ──────────────────────────────────────────────────────────

export type KitRequestStatus = "pending" | "approved" | "declined" | "cancelled";
export type KitRequestSource = "irm" | "customer_stock" | "rental" | "misc";
export type FulfillmentMode = "warehouse_issue" | "engineer_transfer" | "mixed";

export interface KitRequestLine {
  id: string;
  source: KitRequestSource;
  irmItemId: string | null;
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  qty: number; // what the ENGINEER asked for — never rewritten
  // What the reviewer approved: null = in full (and every pre-trim row), 0 = the
  // line was EXCLUDED, N < qty = trimmed. Readers fall back to `qty` on null.
  approvedQty: number | null;
  jobKitLineId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  sourceType: "warehouse" | "engineer" | null;
  sourceWarehouseId: string | null;
  sourceEngineerId: string | null;
}

export interface KitRequest {
  id: string;
  code: string;
  status: KitRequestStatus;
  jobId: string;
  jobNumber: string;
  requestedByEngineerId: string;
  requestedByEngineerName: string;
  requestedByEngineerEmail: string | null;
  reason: string;
  notes: string | null;
  attachments: string[];
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  fulfillmentMode: FulfillmentMode | null;
  transferId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: KitRequestLine[];
}

export interface PagedKitRequests {
  requests: KitRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface KitRequestLinePayload {
  source: KitRequestSource;
  irmItemId?: string;
  /** The CATALOGUE item asked for on a `rental` line — never a particular hire. */
  rentalItemId?: string;
  customerStockEntryId?: string;
  itemName: string;
  qty: number;
}

export interface CreateKitRequestPayload {
  jobId: string;
  reason: string;
  notes?: string;
  attachments?: string[];
  lines: KitRequestLinePayload[];
}

export interface KitItemIrmOption {
  source: "irm";
  irmItemId: string;
  code: string;
  name: string;
  sku: string | null;
  uom: string | null;
  // Live availability, net of other jobs' planned demand (server-side): free
  // warehouse stock, and spare stock on OTHER engineers' vans.
  quantityOnHand: number;
  heldByEngineers: number;
}

export interface KitItemCustomerStockOption {
  source: "customer_stock";
  customerStockEntryId: string;
  name: string;
  sku: string | null;
  uom: string | null;
  qty: number;
  warehouseName: string;
  warehouseCode: string | null;
  serialNumber: string | null;
}

export interface KitItemRentalOption {
  source: "rental";
  rentalItemId: string;
  /** RNT-#### — the printed label's code, and what the warehouse scans. */
  code: string;
  name: string;
  /** Always null: a rental master carries no SKU by design; its `code` is the identifier. */
  sku: null;
  uom: string | null;
  /** Free units across every LIVE hire of this item, at every depot. */
  quantityOnHand: number;
  /**
   * ALWAYS 0, and present rather than omitted so the composer can render "none on a van" instead of
   * treating an absent field as unknown. Hired kit is never transferable engineer-to-engineer:
   * custody is anchored to the depot that took delivery and the provider collects it from there.
   */
  heldByEngineers: 0;
  /** Which depots hold those units, fullest first. */
  depots: { warehouseId: string; warehouseName: string | null; available: number }[];
}

export type KitItemOption = KitItemIrmOption | KitItemRentalOption | KitItemCustomerStockOption;
