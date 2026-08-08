// Job + kit-line types. The shape mirrors the backend PublicJob / PublicJobKitLine DTOs
// (Date columns serialised to ISO strings; every optional column is `| null`). Jobs are a
// staff/engineer-only surface — they carry no price/cost fields.

export type JobStatus =
  | "draft"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "completed"
  | "rejected"
  | "cancelled";

export type JobLineType = "customer_stock" | "irm" | "misc";

export type JobPriority = "low" | "normal" | "high" | "urgent";

export type JobType =
  | "installation"
  | "survey"
  | "maintenance"
  | "decommission"
  | "other";

export type InstallerType = "internal" | "external";

export interface JobKitLine {
  id: string;
  lineType: JobLineType;
  seCode: string | null;
  itemName: string;
  description: string | null;
  customerStockEntryId: string | null;
  irmItemId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  // Live pickup-warehouse address (null for misc lines) — powers the engineer's "where to collect" modal.
  warehouse: JobKitWarehouse | null;
  qty: number;
  notes: string | null;
  // Goods-management tallies (0 until stock is issued against this line). issued = used + returned + remaining.
  issued: number;
  used: number;
  returned: number;
  remaining: number;
  // Hand-overs of this line's stock from another engineer's van. Non-empty ⇒ it does NOT come from
  // the warehouse above — that's only where leftovers are returned to. Populated on the job detail.
  vanSources: KitLineVanSource[];
}

export interface KitLineVanSource {
  transferCode: string;
  engineerName: string;
  /** Snapshot from the transfer, so the engineer can call the holder to arrange the handover
   *  directly. Null when the holder had no phone on file. */
  engineerPhone: string | null;
  quantity: number;
  status: string; // pending (awaiting their approval) | completed (already handed over)
}

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
   * "Today" is the start of today in the COMPANY's timezone (a Settings value), which the browser
   * does not know. Deriving this from `new Date()` would mark a different set of rows than the "Jobs
   * overdue" badge counted, for anyone not sitting in that timezone. Populated on list reads; false
   * on the detail payloads.
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
  goodsStatus: string; // goods-lifecycle: not_issued | partially_issued | issued | awaiting_return | reconciled
  pendingKitRequestCount: number; // pending field-engineer kit requests on this job (jobs-list badge)
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

export type JobSummary = Job;

// ── Customer portal ──────────────────────────────────────────────────────────────────────────
// A deliberately different, much smaller type — NOT a Pick<Job, …>. The server sends the portal its
// own payload (see PortalJob in job.service.ts), and deriving this from `Job` would say the two
// travel together: widening one would silently widen the other's type while the wire stayed put,
// and every field the office adds would need re-excluding here to stay off a customer's screen.

/**
 * The four states a customer sees, standing in for six stored ones. `assigned`, `accepted` and
 * `rejected` all mean "booked, not started" to them — the differences are about which of OUR
 * engineers has the job, which is not their business and, in the case of `rejected`, actively
 * misleading (it is us re-staffing, not us refusing their work).
 */
export type PortalJobStage = "scheduled" | "in_progress" | "completed" | "cancelled";

export interface PortalJob {
  id: string;
  jobNumber: string;
  name: string;
  jobType: string;
  technology: string | null;
  /** The customer's own reference for this job. */
  customerRef: string | null;
  /** Their scheme / order number. */
  schemeNo: string | null;
  projectId: string;
  projectName: string | null;
  siteId: string | null;
  siteName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  /** When the job is due to be completed. */
  completionDate: string | null;
  /** When the work was actually finished. Null until it is. */
  completedAt: string | null;
  /**
   * Past its due date and still live — SERVER-DERIVED against the COMPANY timezone, like the office
   * and engineer lists, so a customer abroad never sees a different set marked late than the people
   * working the jobs do.
   *
   * No day count on purpose: the customer has the date and can do the arithmetic, and a "36d late"
   * chip on their own job turns a status into an accusation. A red date says the same thing without
   * performing it.
   */
  overdue: boolean;
  stage: PortalJobStage;
  /** The engineer attending. Null while the job is between engineers. */
  engineerName: string | null;
  createdAt: string;
}

/** One kit line as the portal's detail table renders it — the office's own columns. */
export interface PortalJobKitLine {
  id: string;
  lineType: JobLineType;
  seCode: string | null;
  itemName: string;
  description: string | null;
  warehouseName: string | null;
  qty: number;
  issued: number;
  used: number;
  returned: number;
  remaining: number;
  // No `notes`. The office table has that column, but it is a free-text box staff fill in for each
  // other — the same class of field as the job-level `notes` that is already withheld, so the
  // server doesn't send it here either.
}

/**
 * The detail payload — the list row plus everything the office's four cards show. Wider than
 * PortalJob because the list is server-paged over an unbounded history and pays for every field on
 * every row; the office splits JobListRow / Job for the same reason.
 */
export interface PortalJobDetail extends PortalJob {
  customerName: string | null;
  priority: string;
  trsArea: string | null;
  floor: string | null;
  suite: string | null;
  rack: string | null;
  shelf: string | null;
  /** Their own planner contact, snapshotted off their job pack — not one of ours. */
  plannerName: string | null;
  plannerPhone: string | null;
  /** The original job-pack files, which the customer sent us. */
  attachments: string[];
  assignedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  kitLines: PortalJobKitLine[];
}
