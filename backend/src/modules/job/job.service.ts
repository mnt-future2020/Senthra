import { Prisma } from "@prisma/client";

import * as jobRepo from "./job.repository.js";
import type { JobWithRelations, JobListRow, JobKitLineRow } from "./job.repository.js";
import { withTransaction } from "../../lib/prisma.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as supplierRepo from "#modules/supplier/supplier.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import * as uploadService from "#modules/upload/upload.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { notify } from "#modules/notification/notification.service.js";
import { roleGrants } from "#modules/role/permissions.js";
import { emitAttentionChanged, emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import { conflict, forbidden, notFound, badRequest } from "../../utils/http-error.js";
import { startOfDayIn } from "../../utils/filter-date.js";
import { jobOverdue } from "./job-overdue.js";
import { safeHttpUrls } from "../../utils/http-url.js";
import { uploadFileToCloudinary } from "../../lib/cloudinary.js";
import { getCloudinaryCreds, getCompanyTimezone, getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { paginate } from "../../utils/pagination.js";
import type { CreateJobInput, JobKitLineInput, UpdateJobInput, CompleteJobInput } from "./job.validation.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
import * as kitRequestRepo from "#modules/job-kit-request/job-kit-request.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
// Cyclic with this module (approve() grows the kit through jobService), which ESM resolves because
// both sides only ever reach across inside a function body — never at module top level.
import * as kitRequestService from "#modules/job-kit-request/job-kit-request.service.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Every office-visible job event also moves a job attention queue (awaiting
// acceptance, rejected, overdue), so the two signals travel together through one wrapper rather than
// each of the ~10 call sites remembering to fire both. Same shape as emitPoUpdated / emitPrfUpdated.
function emitJobsRoom(event: string, payload: unknown): void {
  emitToRoom(OFFICE_JOBS_ROOM, event, payload);
  emitAttentionChanged("jobs");
}

// ── Status state machine (forward-only; backend-enforced). A job is born "assigned" (it always has
// an engineer). Completed + Cancelled are terminal. Re-assign keeps it at "assigned". ───────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["assigned", "cancelled"],
  assigned: ["accepted", "rejected", "assigned", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  rejected: ["assigned", "cancelled"], // PM reassigns (→assigned) or gives up (→cancelled)
  completed: [],
  cancelled: [],
};
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${from} job to ${to}.`);
  }
}

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────
// A hand-over of this line's stock from another engineer's van (job-scoped transfer).
export interface KitLineVanSource {
  transferCode: string;
  engineerName: string;
  quantity: number;
  status: string; // pending (awaiting their approval) | completed (already handed over)
}

export interface PublicJobKitLine {
  id: string;
  lineType: string;
  seCode: string | null;
  itemName: string;
  description: string | null;
  customerStockEntryId: string | null;
  irmItemId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  // Live pickup-warehouse address (null for misc lines / removed warehouses) — lets the engineer
  // open the warehouse and see the full address + map without warehouse-module access.
  warehouse: {
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
  } | null;
  qty: number;
  notes: string | null;
  // Goods-management tallies for this line (0 until the warehouse issues stock against it): issued to
  // the engineer, used (consumed) on site, returned to the warehouse, and remaining still held.
  // Invariant: issued = used + returned + remaining.
  issued: number;
  used: number;
  returned: number;
  remaining: number;
  // Van hand-overs feeding this line. Non-empty ⇒ some/all of this stock comes from another
  // engineer, NOT the warehouse above (which is only the return location for a van-sourced line).
  // Populated on the job detail; empty on list responses.
  vanSources: KitLineVanSource[];
}

export interface PublicJob {
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
   * Past its completion date and still active — the same predicate `?status=overdue` filters on and
   * the "Jobs overdue" badge counts. Sent so the LIST can mark the rows: a client that derived this
   * from its own clock would draw the red marks against a different midnight than the badge counted
   * against, for anyone not sitting in the company's timezone. Populated on the list reads only
   * (false elsewhere, like goodsStatus).
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
  // Goods-lifecycle status from JobStockSummary ("not_issued" until stock moves). Populated on the
  // jobs list + single-job detail so the PM can see issuance at a glance. Not part of the raw record.
  goodsStatus: string;
  // Count of PENDING field-engineer kit requests on this job (jobs-list badge). 0 unless enriched.
  pendingKitRequestCount: number;
  plannerName: string | null;
  plannerPhone: string | null;
  notes: string | null;
  attachments: string[];
  kitLines: PublicJobKitLine[];
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
  jobs: PublicJob[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// Accepts a full detail row OR a LIST row (no kit lines). List callers get kitLines: [] — the list
// UIs render only header fields, so this is intentional, not a missing include.
function toPublic(j: JobWithRelations | JobListRow): PublicJob {
  const kitLines: JobWithRelations["kitLines"] = "kitLines" in j ? j.kitLines : [];
  const eng = j.assignedEngineer;
  return {
    id: j.id,
    jobNumber: j.jobNumber,
    customerRef: j.customerRef,
    schemeNo: j.schemeNo,
    name: j.name,
    jobType: j.jobType,
    technology: j.technology,
    customerId: j.customerId,
    customerName: j.customer?.name ?? j.customerName ?? null,
    projectId: j.projectId,
    projectName: j.project?.name ?? null,
    siteId: j.siteId,
    siteName: j.site?.name ?? j.siteName ?? null,
    trsArea: j.trsArea,
    addressLine1: j.addressLine1,
    addressLine2: j.addressLine2,
    city: j.city,
    county: j.county,
    postcode: j.postcode,
    country: j.country,
    latitude: j.latitude,
    longitude: j.longitude,
    floor: j.floor,
    suite: j.suite,
    rack: j.rack,
    shelf: j.shelf,
    completionDate: iso(j.completionDate),
    // Overwritten by the list reads, which resolve the company-timezone day boundary. Defaulting to
    // "not overdue" is the safe direction: a detail view that never marks late is merely quiet, while
    // one that marked late from the wrong clock would contradict the badge beside it.
    overdue: false,
    daysLate: null,
    priority: j.priority ?? "normal",
    assignedEngineerId: j.assignedEngineerId,
    assignedEngineerName: eng ? `${eng.firstName} ${eng.lastName}`.trim() : j.assignedEngineerName ?? null,
    assignedEngineerEmail: eng?.email ?? j.assignedEngineerEmail ?? null,
    supplierId: j.supplierId,
    supplierName: j.supplier?.name ?? j.supplierName ?? null,
    installerType: j.installerType ?? "internal",
    status: j.status ?? "assigned",
    goodsStatus: "not_issued", // overwritten by listJobs / withGoodsTallies from the stock summary
    pendingKitRequestCount: 0, // overwritten by listJobs from a batched count
    plannerName: j.plannerName,
    plannerPhone: j.plannerPhone,
    notes: j.notes,
    // Same scheme filter as the portal read, and for the same reason: these render as `href`s, and a
    // row written before the validation rule existed can still hold a `javascript:`/`data:` link.
    // Staff click their own job pages far more often than customers do, so exempting the office side
    // would leave the bigger surface as the unguarded one.
    // Legacy strings first, then the rows. Both are URLs on the wire — the form and every viewer
    // still speak that shape — with `#internal` re-appended so the staff-only marker survives the
    // move from a URL fragment to a column.
    attachments: [
      ...safeHttpUrls(j.attachments),
      ...safeHttpUrls((j.attachmentRows ?? []).map((a) => (a.internal ? `${a.url}#internal` : a.url))),
    ],
    kitLines: kitLines.map((l) => ({
      id: l.id,
      lineType: l.lineType,
      seCode: l.seCode,
      itemName: l.itemName,
      description: l.description,
      customerStockEntryId: l.customerStockEntryId,
      irmItemId: l.irmItemId,
      warehouseId: l.warehouseId,
      warehouseName: l.warehouseName,
      warehouseCode: l.warehouseCode,
      warehouse: l.warehouse
        ? {
            id: l.warehouse.id,
            name: l.warehouse.name,
            code: l.warehouse.code,
            addressLine1: l.warehouse.addressLine1 ?? null,
            addressLine2: l.warehouse.addressLine2 ?? null,
            city: l.warehouse.city ?? null,
            county: l.warehouse.county ?? null,
            postcode: l.warehouse.postcode ?? null,
            country: l.warehouse.country ?? null,
            contactPhone: l.warehouse.contactPhone ?? null,
          }
        : null,
      qty: l.qty,
      notes: l.notes,
      issued: 0,
      used: 0,
      returned: 0,
      remaining: 0,
      vanSources: [], // overwritten by withGoodsTallies on the job detail
    })),
    assignedAt: iso(j.assignedAt),
    acceptedAt: iso(j.acceptedAt),
    acceptedBy: j.acceptedBy,
    rejectedAt: iso(j.rejectedAt),
    rejectedBy: j.rejectedBy,
    rejectReason: j.rejectReason,
    startedAt: iso(j.startedAt),
    completedAt: iso(j.completedAt),
    cancelledAt: iso(j.cancelledAt),
    cancelReason: j.cancelReason,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

// ── Validation of referenced entities ───────────────────────────────────────────────────────────
async function requireCustomer(customerId: string) {
  if (!OBJECT_ID_RE.test(customerId)) throw badRequest("Select a customer.");
  const c = await customerRepo.findById(customerId);
  if (!c) throw badRequest("Selected customer no longer exists.");
  return c;
}

// The assigned engineer must be an ACTIVE staff member whose role grants the field-operations
// capability (canHoldStock) — the same gate the Job Pack issue flow enforces for stock recipients. This keeps
// admins / finance / warehouse managers off jobs even if a client bypasses the filtered dropdown.
async function requireEngineer(engineerId: string) {
  if (!OBJECT_ID_RE.test(engineerId)) throw badRequest("Select an engineer.");
  const u = await userRepo.findById(engineerId);
  if (!u) throw badRequest("Selected engineer no longer exists.");
  if ((u.status ?? "active") !== "active") throw conflict("Selected engineer is inactive and can't be assigned jobs.");
  if (!u.role?.canHoldStock) {
    throw conflict("Selected staff member isn't a field engineer. Assign a field-operations role first.");
  }
  return u;
}

async function requireProject(projectId: string, customerId: string) {
  if (!OBJECT_ID_RE.test(projectId)) throw badRequest("Select a project.");
  const p = await customerRepo.findProjectById(projectId);
  if (!p) throw badRequest("Selected project no longer exists.");
  if (p.customerId !== customerId) throw badRequest("Selected project doesn't belong to that customer.");
  return p;
}

async function requireSite(siteId: string, customerId: string) {
  if (!OBJECT_ID_RE.test(siteId)) throw badRequest("Select a site.");
  const s = await customerRepo.findSiteById(siteId);
  if (!s) throw badRequest("Selected site no longer exists.");
  if (s.customerId !== customerId) throw badRequest("Selected site doesn't belong to that customer.");
  return s;
}

async function requireSupplier(supplierId: string) {
  if (!OBJECT_ID_RE.test(supplierId)) throw badRequest("Select a supplier.");
  const s = await supplierRepo.findById(supplierId);
  if (!s) throw badRequest("Selected supplier no longer exists.");
  return s;
}

// Validate each kit line's source + pickup warehouse, and build the persisted rows with warehouse
// snapshots. customer_stock: the warehouse is DERIVED from the chosen entry (authoritative — that's
// where the stock physically is) and seCode falls back to the entry's SKU. irm: the PM-chosen
// warehouse is validated + snapshotted. misc: no source, no warehouse. Mirrors requireSite/
// requireSupplier — throws badRequest on a missing/foreign reference (defence-in-depth beyond the
// zod lineType⇄id/warehouse guarantees).
async function resolveKitLineRows(lines: JobKitLineInput[], customerId: string): Promise<JobKitLineRow[]> {
  const rows: JobKitLineRow[] = [];
  for (const l of lines) {
    const row: JobKitLineRow = {
      lineType: l.lineType,
      seCode: trimToNull(l.seCode),
      itemName: l.itemName.trim(),
      description: trimToNull(l.description),
      customerStockEntryId: null,
      irmItemId: null,
      warehouseId: null,
      warehouseName: null,
      warehouseCode: null,
      qty: l.qty,
      notes: trimToNull(l.notes),
    };
    if (l.lineType === "customer_stock" && l.customerStockEntryId) {
      const entry = await customerRepo.findStockEntryById(l.customerStockEntryId);
      if (!entry) throw badRequest(`Customer stock item "${l.itemName}" no longer exists.`);
      if (entry.customerId !== customerId) throw badRequest(`Customer stock item "${l.itemName}" doesn't belong to this customer.`);
      // The engineer needs a pickup location; a consignment entry not yet binned to a warehouse
      // can't be put on a job (it would show no warehouse on the engineer's kit list).
      if (!entry.warehouseId) throw badRequest(`Customer stock item "${l.itemName}" has no warehouse assigned yet.`);
      row.customerStockEntryId = entry.id;
      row.seCode = row.seCode ?? entry.sku ?? null;
      row.warehouseId = entry.warehouseId;
      row.warehouseName = entry.warehouse?.name ?? null;
      row.warehouseCode = entry.warehouse?.code ?? null;
    } else if (l.lineType === "irm" && l.irmItemId) {
      const item = await irmRepo.findById(l.irmItemId);
      if (!item) throw badRequest(`Kit item "${l.itemName}" no longer exists.`);
      row.irmItemId = item.id;
      if (l.warehouseId) {
        const wh = await warehouseRepo.findById(l.warehouseId);
        if (!wh) throw badRequest(`The pickup warehouse for "${l.itemName}" no longer exists.`);
        if (wh.status !== "active") throw badRequest(`The pickup warehouse for "${l.itemName}" is not active.`);
        row.warehouseId = wh.id;
        row.warehouseName = wh.name;
        row.warehouseCode = wh.code;
      }
    }
    rows.push(row);
  }
  return rows;
}

// Physical free stock at a kit line's location: on-hand − reserved for IRM, consignment qty for
// customer stock. Infinity for misc / unresolved lines (no stock limit). The form already caps planned
// qty at this (minus other jobs' demand), so this server-side guard never blocks a real form submit —
// it just stops a direct API call from promising more stock than physically exists.
type AvailabilityLine = { irmItemId: string | null; warehouseId: string | null; customerStockEntryId: string | null };

/**
 * Availability for a whole kit list in TWO queries, whatever its length.
 *
 * Callers used to `await availableForLine(...)` inside a `for` over the kit lines, so a 20-line job
 * cost 20 sequential round trips — ~1.4s of pure latency on a remote cluster, on every job save,
 * before anything was written. The lookups are independent, so they batch cleanly.
 *
 * Returns a reader keyed the same way the per-line check reads it, so the callers keep their existing
 * "throw on the FIRST line that exceeds" order and error message.
 */
async function availabilityReader(lines: readonly AvailabilityLine[]): Promise<(line: AvailabilityLine) => number> {
  const irmItemIds = [...new Set(lines.map((l) => l.irmItemId).filter((v): v is string => !!v))];
  const warehouseIds = [...new Set(lines.map((l) => l.warehouseId).filter((v): v is string => !!v))];
  const cseIds = [...new Set(lines.map((l) => l.customerStockEntryId).filter((v): v is string => !!v))];

  const [balances, entries] = await Promise.all([
    inventoryRepo.findBalancesByItemsAndWarehouses(irmItemIds, warehouseIds),
    customerRepo.findStockEntryQuantitiesByIds(cseIds),
  ]);
  const freeByPair = new Map(balances.map((b) => [`${b.irmItemId}|${b.warehouseId}`, b.quantityOnHand - b.quantityReserved]));
  const qtyByEntry = new Map(entries.map((e) => [e.id, e.quantity]));

  return (line) => {
    if (line.irmItemId && line.warehouseId) return freeByPair.get(`${line.irmItemId}|${line.warehouseId}`) ?? 0;
    if (line.customerStockEntryId) return qtyByEntry.get(line.customerStockEntryId) ?? 0;
    return Infinity; // misc — free text, nothing to run out of
  };
}

// ── Notify the assigned engineer (fire-and-forget; never blocks/rolls back) ───────────────────
function notifyAssignedEngineer(job: PublicJob): void {
  if (!job.assignedEngineerEmail) return;
  void sendTemplatedEmail("job.assigned", job.assignedEngineerEmail, {
    engineerName: job.assignedEngineerName ?? "",
    jobNumber: job.jobNumber,
    jobName: job.name,
  }).catch((e) => console.error(`Job ${job.jobNumber} assignment email failed:`, e instanceof Error ? e.message : e));
}

// ── Notify the job's creator (PM/admin) that the engineer declined it (fire-and-forget) ────────
// The rejection is an exception that leaves the job unassigned and needs human action, so the
// creator is emailed. Prefers the creator's CURRENT email/name (via createdByUserId) and falls
// back to the email captured at creation time (e.g. admin-created jobs).
function notifyJobCreatorOfRejection(job: PublicJob, createdByUserId: string | null): void {
  void (async () => {
    let toEmail = job.createdBy;
    let recipientName = "";
    if (createdByUserId) {
      const creator = await userRepo.findById(createdByUserId);
      if (creator) {
        toEmail = creator.email;
        recipientName = creator.firstName;
      }
    }
    if (!toEmail) return;
    await sendTemplatedEmail("job.rejected", toEmail, {
      recipientName,
      jobNumber: job.jobNumber,
      jobName: job.name,
      engineerName: job.assignedEngineerName ?? "the engineer",
      rejectReason: job.rejectReason || "No reason provided.",
    });
  })().catch((e) => console.error(`Job ${job.jobNumber} rejection email failed:`, e instanceof Error ? e.message : e));
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────
export interface ListJobsParams {
  search?: string;
  status?: string;
  customer?: string;
  engineer?: string;
  project?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export async function listJobs(params: ListJobsParams = {}, _actor?: AuditActor): Promise<PagedJobs> {
  // "Overdue" is derived, not stored — resolve the company-timezone day boundary here (the service
  // owns settings, the repository doesn't) exactly as listJobsForEngineer does.
  //
  // Resolved for EVERY list read, not just `?status=overdue`, because each row now carries its own
  // `overdue` flag so the table can mark late work in place. Before that, the count in the badge was
  // the only way to know any job was late: the Due date column rendered every date in the same grey,
  // so "Jobs overdue 4" could only be resolved by clicking it. One settings read, already memoised.
  const dayStart = startOfDayIn(await getCompanyTimezone(), new Date());
  const filters = {
    search: params.search,
    status: params.status,
    customerId: params.customer,
    assignedEngineerId: params.engineer,
    projectId: params.project,
    overdueBefore: params.status === "overdue" ? dayStart : undefined,
  };
  const total = await jobRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await jobRepo.findMany(filters, skip, pageSize, params.sort);
  const ids = rows.map((r) => r.id);
  // Merge each job's goods-lifecycle status + pending kit-request count in batched queries (no N+1).
  const [goodsStatusByJob, pendingByJob] = await Promise.all([
    goodsManagementService.getGoodsStatusByJobs(ids),
    kitRequestRepo.countPendingByJobs(ids),
  ]);
  const jobs = rows.map((r) => {
    const pub = toPublic(r);
    pub.goodsStatus = goodsStatusByJob.get(r.id) ?? "not_issued";
    pub.pendingKitRequestCount = pendingByJob.get(r.id) ?? 0;
    Object.assign(pub, jobOverdue(r.completionDate, pub.status, dayStart));
    return pub;
  });
  return { jobs, total, page, pageSize, totalPages };
}

/**
 * The SAME filtered list as a CSV, minus paging. Delegates to listJobs with one oversized page
 * rather than re-deriving the filters — the derived "overdue" pseudo-status needs a company-timezone
 * day boundary that only the service can resolve, and a second copy of that is a second thing to get
 * wrong by an hour every BST morning.
 */
export async function exportJobsCsv(
  params: ListJobsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  const { jobs } = await listJobs({ ...params, ...EXPORT_PAGING }, actor);
  const rows = jobs.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const date = (v: string | null) => formatDate(v, regional.dateFormat, regional.timezone);
  const csv = toCsv(
    [
      "Job Number", "Name", "Type", "Status", "Priority", "Overdue",
      "Customer", "Project", "Site", "City", "Postcode",
      "Customer Reference", "Scheme Number", "Technology",
      "Engineer", "Installer Type", "Supplier", "Goods Status",
      `Completion Date (${regional.timezone})`, `Work Completed (${regional.timezone})`, `Created (${regional.timezone})`,
    ],
    rows.map((j) => [
      j.jobNumber,
      j.name,
      j.jobType,
      j.status,
      j.priority,
      // The derived flag the list marks late work with, carried into the file so a filtered "all
      // jobs" export still says which are late — otherwise the reader has to redo the date maths
      // in a spreadsheet, in whatever timezone their machine happens to be in.
      j.overdue ? "Yes" : "No",
      j.customerName,
      j.projectName,
      j.siteName,
      j.city,
      j.postcode,
      j.customerRef,
      j.schemeNo,
      j.technology,
      j.assignedEngineerName,
      j.installerType,
      j.supplierName,
      j.goodsStatus,
      date(j.completionDate),
      date(j.completedAt),
      date(j.createdAt),
    ]),
  );

  // `notes`, `rejectReason` and `cancelReason` are absent: office-to-engineer and internal free
  // text, of the kind a forwarded spreadsheet should never carry.
  audit.record({ actor, action: "job.exported", targetType: "job", targetLabel: `${rows.length} rows` });
  return { csv, capped: jobs.length > EXPORT_MAX };
}

// Fill in each kit line's goods tallies (issued/used/returned/remaining) + the job's goods-lifecycle
// status from its stock movements. Used on the single-job detail views (office + engineer "job pack").
async function withGoodsTallies(pub: PublicJob): Promise<PublicJob> {
  const [tallies, goodsStatus, vanSources] = await Promise.all([
    goodsManagementService.getJobKitTallies(pub.id),
    goodsManagementService.getGoodsStatus(pub.id),
    // Which lines are being handed over from another engineer's van. Batched with the rest so the
    // detail stays at a fixed number of round-trips.
    transferRepo.findVanSourcesByKitLines(pub.kitLines.map((l) => l.id)),
  ]);
  pub.goodsStatus = goodsStatus;
  for (const kl of pub.kitLines) {
    const t = tallies[kl.id];
    if (t) {
      kl.issued = t.issued;
      kl.used = t.used;
      kl.returned = t.returned;
      kl.remaining = t.remaining;
    }
    kl.vanSources = vanSources.get(kl.id) ?? [];
  }
  return pub;
}

export async function getJob(idOrCode: string, _actor?: AuditActor): Promise<PublicJob> {
  const j = OBJECT_ID_RE.test(idOrCode) ? await jobRepo.findById(idOrCode) : await jobRepo.findByNumber(idOrCode);
  if (!j) throw notFound("Job not found.");
  return withGoodsTallies(toPublic(j));
}

// ── Create / update ─────────────────────────────────────────────────────────────────────────
export async function createJob(input: CreateJobInput, actor?: AuditActor): Promise<PublicJob> {
  const customer = await requireCustomer(input.customerId);
  const project = await requireProject(input.projectId, customer.id);
  const engineer = await requireEngineer(input.assignedEngineerId);
  const site = input.siteId ? await requireSite(input.siteId, customer.id) : null;
  const supplier = input.supplierId ? await requireSupplier(input.supplierId) : null;
  const rows = await resolveKitLineRows(input.kitLines, customer.id);
  // Can't plan more than physically exists at the warehouse (server-side backstop for the form cap).
  // Availability for the WHOLE kit list is read up front in two queries; the loop below then only does
  // arithmetic, so a 20-line job costs the same two round trips as a 1-line one.
  const availableFor = await availabilityReader(rows);
  for (const r of rows) {
    if (r.lineType === "misc") continue;
    const avail = availableFor(r);
    if (r.qty > avail) throw badRequest(`"${r.itemName}" — only ${avail} in stock at that warehouse, but ${r.qty} planned.`);
  }
  const actorEmail = actor?.email ?? null;
  const now = new Date();

  const created = await jobRepo.createWithCode(
    {
      name: input.name.trim(),
      jobType: input.jobType ?? "installation",
      technology: trimToNull(input.technology),
      customerRef: trimToNull(input.customerRef),
      schemeNo: trimToNull(input.schemeNo),
      customerId: customer.id,
      customerName: customer.name,
      projectId: project.id,
      projectName: project.name,
      siteId: site?.id ?? null,
      siteName: site ? site.name : trimToNull(input.siteName),
      trsArea: trimToNull(input.trsArea),
      addressLine1: trimToNull(input.addressLine1),
      addressLine2: trimToNull(input.addressLine2),
      city: trimToNull(input.city),
      county: trimToNull(input.county),
      postcode: trimToNull(input.postcode),
      country: trimToNull(input.country),
      latitude: null,
      longitude: null,
      floor: trimToNull(input.floor),
      suite: trimToNull(input.suite),
      rack: trimToNull(input.rack),
      shelf: trimToNull(input.shelf),
      // Required by createJobSchema — no `: null` fallback, because a job that reached here without a
      // date would be one the validation says cannot exist, and quietly writing null would hide it.
      completionDate: new Date(input.completionDate),
      priority: input.priority ?? "normal",
      assignedEngineerId: engineer.id,
      assignedEngineerName: `${engineer.firstName} ${engineer.lastName}`.trim(),
      assignedEngineerEmail: engineer.email,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      installerType: input.installerType ?? "internal",
      status: "assigned",
      plannerName: trimToNull(input.plannerName),
      plannerPhone: trimToNull(input.plannerPhone),
      notes: trimToNull(input.notes),
      // Rows, not this array — see the Attachments section. Reconciled after the job has an id.
      attachments: [],
      assignedAt: now,
      createdByUserId: actor?.id ?? null,
      createdBy: actorEmail,
      updatedBy: actorEmail,
    },
    rows,
  );

  // After the job exists — the rows need its id — and before the DTO is built, so the response and
  // every realtime payload already describe the attachments that were just committed.
  await reconcileAttachments(created.id, input.attachments ?? [], created.jobNumber, actor);
  const job = toPublic((await jobRepo.findById(created.id)) ?? created);
  if (job.assignedEngineerId) {
    emitToUser(job.assignedEngineerId, "job:new", job); // engineer's portal list
    notify(job.assignedEngineerId, { title: "New job assigned", body: `${job.jobNumber} · ${job.name}`, data: { type: "job", jobId: job.id } });
  }
  emitJobsRoom("job:new", job); // every office Jobs-list watcher
  audit.record({ actor, action: "job.created", targetType: "job", targetId: created.id, targetLabel: created.jobNumber });
  notifyAssignedEngineer(job);
  return job;
}

// Signature of a kit line over the fields a planner controls (item identity + warehouse + qty +
// labels). Used to tell whether an incoming kit list actually differs from what's stored.
function kitLineSignature(l: {
  lineType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  qty: number;
  itemName: string;
  seCode: string | null;
  description: string | null;
  notes: string | null;
}): string {
  return [
    l.lineType,
    l.irmItemId ?? "",
    l.customerStockEntryId ?? "",
    l.warehouseId ?? "",
    l.qty,
    l.itemName,
    l.seCode ?? "",
    l.description ?? "",
    l.notes ?? "",
  ].join("|");
}

// True when the incoming (already-resolved) kit lines differ from the stored ones in any
// planner-controlled field — an added/removed line, or a changed item / warehouse / qty / label.
// Order-independent. A no-op resend (the edit form re-sending the same kit list while only header
// fields changed) returns false, so the kit-line ids aren't needlessly regenerated.
export function kitLinesChanged(
  incoming: Array<Parameters<typeof kitLineSignature>[0]>,
  existing: Array<Parameters<typeof kitLineSignature>[0]>,
): boolean {
  if (incoming.length !== existing.length) return true;
  const a = incoming.map(kitLineSignature).sort();
  const b = existing.map(kitLineSignature).sort();
  return a.some((sig, i) => sig !== b[i]);
}

// Identity of a kit line = the item it represents (NOT its quantity). Used to match an incoming kit
// list against the stored one so a line's quantity can be edited in place (keeping its id). irm and
// customer lines are unique by item (+warehouse) — guaranteed by validation; misc has no id, so it's
// matched greedily by name.
function kitLineIdentity(l: { irmItemId: string | null; customerStockEntryId: string | null; warehouseId: string | null; itemName: string }): string {
  if (l.irmItemId) return `irm|${l.irmItemId}|${l.warehouseId ?? ""}`;
  if (l.customerStockEntryId) return `customer|${l.customerStockEntryId}|${l.warehouseId ?? ""}`;
  return `misc|${l.itemName}`;
}

type ExistingKitLine = NonNullable<JobWithRelations["kitLines"]>[number];
export interface KitLineDiff {
  updates: { id: string; qty: number; existingQty: number; itemName: string; seCode: string | null; description: string | null; notes: string | null }[];
  creates: JobKitLineRow[];
  removed: { id: string; itemName: string }[];
}

// Diff an incoming (already-resolved) kit list against the stored one, matching by item identity:
// matched → update (qty/labels may differ); unmatched incoming → create; unmatched stored → removed.
// This lets the caller preserve ids (no orphaned movements) and enforce per-line edit rules.
export function diffKitLines(incoming: JobKitLineRow[], existing: ExistingKitLine[]): KitLineDiff {
  const pool = new Map<string, ExistingKitLine[]>();
  for (const e of existing) {
    const k = kitLineIdentity(e);
    const bucket = pool.get(k);
    if (bucket) bucket.push(e);
    else pool.set(k, [e]);
  }
  const updates: KitLineDiff["updates"] = [];
  const creates: JobKitLineRow[] = [];
  for (const inc of incoming) {
    const match = pool.get(kitLineIdentity(inc))?.shift();
    if (match) {
      updates.push({ id: match.id, qty: inc.qty, existingQty: match.qty, itemName: inc.itemName, seCode: inc.seCode, description: inc.description, notes: inc.notes });
    } else {
      creates.push(inc);
    }
  }
  const removed: KitLineDiff["removed"] = [];
  for (const bucket of pool.values()) for (const e of bucket) removed.push({ id: e.id, itemName: e.itemName });
  return { updates, creates, removed };
}

export async function updateJob(id: string, input: UpdateJobInput, actor?: AuditActor): Promise<PublicJob> {
  const existing = await jobRepo.findById(id);
  if (!existing) throw notFound("Job not found.");
  // Terminal jobs are frozen — a completed/cancelled job's record (incl. its kit pack) must stay
  // trustworthy. Re-assignment / edits go through the live states only.
  if (existing.status === "completed" || existing.status === "cancelled") {
    throw conflict(`A ${existing.status} job can't be edited.`);
  }
  // Reconciled goods lock the job too (it can be reconciled before the job status is "completed").
  if ((await goodsManagementService.getGoodsStatus(id)) === "reconciled") {
    throw conflict("This job's goods have been reconciled and locked — it can no longer be edited.");
  }

  const headerPatch: Record<string, unknown> = { updatedBy: actor?.email ?? null };
  const customerId = existing.customerId;
  // A job's customer is fixed after creation — changing it would orphan the project, site and
  // customer-stock kit lines (which belong to the original customer). Re-create the job instead.
  if (input.customerId !== undefined && input.customerId !== existing.customerId) {
    throw badRequest("A job's customer can't be changed after creation. Create a new job for a different customer.");
  }
  // A job must ALWAYS name a destination — a saved site or a typed address — not just at creation.
  // This can't live in updateJobSchema: an update is a PATCH, so a payload omitting both keys says
  // nothing about them, and the rule is only decidable against the MERGED result (existing + patch).
  // That needs the existing row, which a zod schema never sees. Same either/or as createJobSchema
  // (a site's own address fields are optional, so "has a site" is a complete destination).
  const nextSiteId = input.siteId !== undefined ? input.siteId : existing.siteId;
  const nextAddressLine1 = input.addressLine1 !== undefined ? input.addressLine1 : existing.addressLine1;
  if (!nextSiteId && !nextAddressLine1?.trim()) {
    throw badRequest("Pick a site, or enter an address for where the work happens — a job can't be left without a destination.");
  }
  if (input.projectId !== undefined) {
    const project = await requireProject(input.projectId, customerId);
    headerPatch.projectId = project.id;
    headerPatch.projectName = project.name;
  }
  // Changing the engineer is a RE-ASSIGNMENT — it must follow the same semantics as assignJob (reset
  // to "assigned", clear acceptance, notify + emit), not a silent header swap that leaves a stale
  // "accepted" status pointing at an un-notified engineer. No-op when the id is unchanged.
  let reassigned = false;
  if (input.assignedEngineerId !== undefined && input.assignedEngineerId !== existing.assignedEngineerId) {
    // Reassignment is a privileged action — it must require jobs.assign even though it's reachable
    // via this jobs.edit PATCH (otherwise an edit-only role could bypass the dedicated /assign gate).
    if (actor?.type !== "admin" && !roleGrants(actor?.permissions ?? [], "jobs.assign")) {
      throw forbidden("Reassigning a job requires the Assign permission.");
    }
    const engineer = await requireEngineer(input.assignedEngineerId);
    assertTransition(existing.status, "assigned");
    headerPatch.assignedEngineerId = engineer.id;
    headerPatch.assignedEngineerName = `${engineer.firstName} ${engineer.lastName}`.trim();
    headerPatch.assignedEngineerEmail = engineer.email;
    headerPatch.status = "assigned";
    headerPatch.assignedAt = new Date();
    headerPatch.acceptedAt = null;
    headerPatch.acceptedBy = null;
    headerPatch.rejectedAt = null;
    headerPatch.rejectedBy = null;
    headerPatch.rejectReason = null;
    reassigned = true;
  }
  if (input.siteId !== undefined) {
    if (input.siteId) {
      const site = await requireSite(input.siteId, customerId);
      headerPatch.siteId = site.id;
      headerPatch.siteName = site.name;
    } else {
      // Un-picking the site must take its NAME with it. siteName holds the chosen site's name, so
      // leaving it behind would show the old site's label next to whatever address replaced it —
      // two different places on one job. The manual "Site name" box (if the user typed one) wins.
      headerPatch.siteId = null;
      headerPatch.siteName = input.siteName !== undefined ? trimToNull(input.siteName) : null;
    }
  }
  if (input.supplierId !== undefined) {
    if (input.supplierId) {
      const supplier = await requireSupplier(input.supplierId);
      headerPatch.supplierId = supplier.id;
      headerPatch.supplierName = supplier.name;
    } else {
      headerPatch.supplierId = null;
      headerPatch.supplierName = null;
    }
  }
  if (input.name !== undefined) headerPatch.name = input.name.trim();
  if (input.jobType !== undefined) headerPatch.jobType = input.jobType;
  if (input.technology !== undefined) headerPatch.technology = trimToNull(input.technology);
  if (input.customerRef !== undefined) headerPatch.customerRef = trimToNull(input.customerRef);
  if (input.schemeNo !== undefined) headerPatch.schemeNo = trimToNull(input.schemeNo);
  if (input.siteName !== undefined && input.siteId === undefined) headerPatch.siteName = trimToNull(input.siteName);
  if (input.trsArea !== undefined) headerPatch.trsArea = trimToNull(input.trsArea);
  if (input.addressLine1 !== undefined) headerPatch.addressLine1 = trimToNull(input.addressLine1);
  if (input.addressLine2 !== undefined) headerPatch.addressLine2 = trimToNull(input.addressLine2);
  if (input.city !== undefined) headerPatch.city = trimToNull(input.city);
  if (input.county !== undefined) headerPatch.county = trimToNull(input.county);
  if (input.postcode !== undefined) headerPatch.postcode = trimToNull(input.postcode);
  if (input.country !== undefined) headerPatch.country = trimToNull(input.country);
  if (input.floor !== undefined) headerPatch.floor = trimToNull(input.floor);
  if (input.suite !== undefined) headerPatch.suite = trimToNull(input.suite);
  if (input.rack !== undefined) headerPatch.rack = trimToNull(input.rack);
  if (input.shelf !== undefined) headerPatch.shelf = trimToNull(input.shelf);
  // Absent = leave the existing date alone. It can no longer arrive empty — updateJobSchema rejects a
  // blanked box rather than letting it clear the field, so there is nothing to null out here.
  if (input.completionDate !== undefined) headerPatch.completionDate = new Date(input.completionDate);
  if (input.priority !== undefined) headerPatch.priority = input.priority;
  if (input.installerType !== undefined) headerPatch.installerType = input.installerType;
  if (input.plannerName !== undefined) headerPatch.plannerName = trimToNull(input.plannerName);
  if (input.plannerPhone !== undefined) headerPatch.plannerPhone = trimToNull(input.plannerPhone);
  if (input.notes !== undefined) headerPatch.notes = trimToNull(input.notes);
  // `attachments` is NOT patched onto the header at all: it lives in rows now, reconciled below once
  // the header write has settled. The legacy array is retired AFTER that reconcile, not here — see
  // the note at the call site for why the order is the safety property.

  let result: JobWithRelations;
  if (input.kitLines !== undefined) {
    const rows = await resolveKitLineRows(input.kitLines, customerId);
    if (!kitLinesChanged(rows, existing.kitLines ?? [])) {
      // Kit list unchanged (only header fields differ) — header patch only, ids untouched.
      result = await jobRepo.update(id, headerPatch);
    } else {
      const diff = diffKitLines(rows, existing.kitLines ?? []);
      // Stock cap: new lines must fit current stock; an increase to an existing line needs only the
      // INCREMENT to fit (its prior qty was validated when set — re-checking unchanged lines would
      // false-block on later stock drift). Only changed/added lines are checked.
      // ONE read covering both loops — the added lines and the existing lines whose qty is growing.
      const growingLines = diff.updates
        .filter((u) => u.qty - u.existingQty > 0)
        .map((u) => (existing.kitLines ?? []).find((k) => k.id === u.id))
        .filter((kl): kl is NonNullable<typeof kl> => !!kl);
      const availableFor = await availabilityReader([...diff.creates, ...growingLines]);
      for (const c of diff.creates) {
        if (c.lineType === "misc") continue;
        const avail = availableFor(c);
        if (c.qty > avail) throw badRequest(`"${c.itemName}" — only ${avail} in stock at that warehouse, but ${c.qty} planned.`);
      }
      for (const u of diff.updates) {
        const inc = u.qty - u.existingQty;
        if (inc <= 0) continue;
        const kl = (existing.kitLines ?? []).find((k) => k.id === u.id);
        if (!kl || kl.lineType === "misc") continue;
        const avail = availableFor(kl);
        if (inc > avail) throw badRequest(`"${u.itemName}" — only ${avail} more available to add at that warehouse (have ${u.existingQty}, requested ${u.qty}).`);
      }
      // Once a kit line has had stock ISSUED against it, it's locked: it can't be removed and its
      // quantity can only INCREASE (never decrease). New items and lines that have never been issued
      // stay fully editable. (Changing an issued line's item/warehouse reads as remove+add, so the
      // removal guard blocks it.) This protects the posted stock movements + the engineer's holdings.
      const goodsStatus = await goodsManagementService.getGoodsStatus(id);
      if (goodsStatus !== "not_issued") {
        const tallies = await goodsManagementService.getJobKitTallies(id);
        const issued = (lineId: string) => (tallies[lineId]?.issued ?? 0) > 0;

        const removedIssued = diff.removed.find((r) => issued(r.id));
        if (removedIssued) {
          throw conflict(`"${removedIssued.itemName}" has already had stock issued, so it can't be removed from this job. You can add new items or increase quantities, but issued items must stay.`);
        }
        const reduced = diff.updates.find((u) => issued(u.id) && u.qty < u.existingQty);
        if (reduced) {
          throw conflict(`"${reduced.itemName}" has already had stock issued (qty ${reduced.existingQty}) — its quantity can only be increased, not reduced. Return and reconcile the issued stock first if you need fewer.`);
        }
      }
      result = await jobRepo.mergeKitLines(
        id,
        {
          updates: diff.updates.map((u) => ({ id: u.id, qty: u.qty, seCode: u.seCode, description: u.description, notes: u.notes })),
          creates: diff.creates,
          deleteIds: diff.removed.map((r) => r.id),
        },
        headerPatch,
      );
    }
  } else {
    result = await jobRepo.update(id, headerPatch);
  }
  audit.record({ actor, action: "job.updated", targetType: "job", targetId: id, targetLabel: result.jobNumber });

  // Attachments are reconciled AFTER the header write, so a failed edit never orphans a claim, and
  // the DTO is rebuilt from a fresh read so the response shows exactly what now exists.
  if (input.attachments !== undefined) {
    await reconcileAttachments(id, input.attachments, result.jobNumber, actor);
    // Retire the legacy array only NOW, once every URL it held has a row of its own.
    //
    // These are two writes with no transaction across them, so whichever runs first is the one that
    // survives a failure in the other. Emptying the array in the header write meant a reconcile that
    // threw part-way left the URLs in NEITHER place — the array already cleared, only some rows
    // written, and nothing anywhere else holding them. This way round the worst case is a URL listed
    // twice (toPublic concatenates the legacy strings and the rows) until the next successful save.
    //
    // Guarded on the array actually having held something, so an ordinary edit to an already-migrated
    // job does not take a second write to set an empty field empty.
    if (existing.attachments?.length) await jobRepo.update(id, { attachments: [] });
    result = (await jobRepo.findById(id)) ?? result;
  }
  const job = toPublic(result);
  // A re-assignment via PATCH fires the same realtime + notification as assignJob.
  if (reassigned) {
    // The engineer who LOST the job isn't in OFFICE_JOBS_ROOM — without a personal emit it would
    // linger (stale, now-unowned) in their list/detail. job:deleted drops it off their surface.
    const prevEngineerId = existing.assignedEngineerId;
    if (prevEngineerId && prevEngineerId !== job.assignedEngineerId) emitToUser(prevEngineerId, "job:deleted", job);
    if (job.assignedEngineerId) {
      emitToUser(job.assignedEngineerId, "job:new", job);
      notify(job.assignedEngineerId, { title: "New job assigned", body: `${job.jobNumber} · ${job.name}`, data: { type: "job", jobId: job.id } });
    }
    emitJobsRoom("job:new", job);
    audit.record({
      actor,
      action: "job.assigned",
      targetType: "job",
      targetId: id,
      targetLabel: result.jobNumber,
      metadata: { engineerId: job.assignedEngineerId },
    });
    notifyAssignedEngineer(job);
  } else {
    // A plain header/kit edit (reschedule, address, kit-line change) must reach the assigned
    // engineer's open list/detail and every office watcher — dual-emit like the status transitions.
    if (job.assignedEngineerId) emitToUser(job.assignedEngineerId, "job:updated", job);
    emitJobsRoom("job:updated", job);
  }
  return job;
}

// ── Grow the kit from an approved Field-Engineer kit request ──────────────────────────────────
// The bottom-up counterpart to updateJob's top-down edit: an approved JobKitRequest either INCREASES
// a matching existing kit line or ADDS a new one, reusing the same resolve + merge path (so ids are
// preserved and posted movements keep pointing at their lines). It only ever adds/increases, so the
// issued-line locks can't be violated. Unlike edit-job it does NOT cap against warehouse stock: a
// request may be fulfilled from another engineer's van (a job-scoped transfer), where warehouse
// availability is irrelevant — the real stock check happens at fulfilment (postIssue / transfer
// completion). Returns the updated job + the resulting jobKitLineId per input line (in order), which
// the caller threads into the transfer lines so completion can attribute the qty to the right line.
export interface KitAppendLine {
  source: "irm" | "customer_stock" | "misc";
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  qty: number;
  warehouseId: string | null; // required for irm lines (the PM-chosen pickup/home warehouse)
}
export interface KitAppendResult {
  job: PublicJob;
  jobKitLineIds: (string | null)[];
}

type MatchableKitLine = { id: string; lineType: string; itemName: string; irmItemId: string | null; customerStockEntryId: string | null; warehouseId: string | null; qty: number; seCode: string | null; description: string | null; notes: string | null };

// Find the existing kit line a resolved row would MERGE INTO: same IRM item + warehouse, same
// customer-stock entry, or a misc line with the same name. Undefined ⇒ it becomes a new line.
function findMatchingKitLine(lines: MatchableKitLine[], row: JobKitLineRow): MatchableKitLine | undefined {
  if (row.irmItemId) return lines.find((k) => k.irmItemId === row.irmItemId && k.warehouseId === row.warehouseId);
  if (row.customerStockEntryId) return lines.find((k) => k.customerStockEntryId === row.customerStockEntryId);
  return lines.find((k) => k.lineType === "misc" && k.itemName.trim().toLowerCase() === row.itemName.trim().toLowerCase());
}

export async function appendKitFromRequest(
  jobId: string,
  lines: KitAppendLine[],
  actor?: AuditActor,
  // Optional: runs INSIDE the same transaction as the kit-grow, receiving the resulting jobKitLineIds.
  // The kit-request approve uses it to stamp its request lines atomically with the grow, so a crash
  // can't leave the kit grown-but-unstamped (which would let a retry re-grow it).
  stampTx?: (tx: Prisma.TransactionClient, jobKitLineIds: (string | null)[]) => Promise<void>,
): Promise<KitAppendResult> {
  const existing = await jobRepo.findById(jobId);
  if (!existing) throw notFound("Job not found.");
  if (existing.status === "completed" || existing.status === "cancelled") {
    throw conflict(`A ${existing.status} job can't take on more kit.`);
  }
  if ((await goodsManagementService.getGoodsStatus(jobId)) === "reconciled") {
    throw conflict("This job's goods have been reconciled and locked — it can no longer be edited.");
  }

  // Reuse the kit-line resolver (warehouse snapshots + source validation) via the JobKitLineInput shape.
  const asInputs: JobKitLineInput[] = lines.map((l) => ({
    lineType: l.source,
    itemName: l.itemName,
    qty: l.qty,
    seCode: undefined,
    description: undefined,
    customerStockEntryId: l.customerStockEntryId ?? undefined,
    irmItemId: l.irmItemId ?? undefined,
    warehouseId: l.warehouseId ?? undefined,
    notes: undefined,
  }));
  const rows = await resolveKitLineRows(asInputs, existing.customerId);
  // Defence-in-depth (we bypass the zod kit-line refinement): an IRM line must have a pickup warehouse.
  for (const row of rows) {
    if (row.lineType === "irm" && !row.warehouseId) throw badRequest(`Choose a pickup warehouse for "${row.itemName}".`);
  }

  const existingLines = (existing.kitLines ?? []) as MatchableKitLine[];
  const updates: { id: string; qty: number; seCode: string | null; description: string | null; notes: string | null }[] = [];
  const creates: JobKitLineRow[] = [];
  const rowTargets: (string | null)[] = []; // existing line id per row, or null when it becomes a create

  for (const row of rows) {
    const match = findMatchingKitLine(existingLines, row);
    if (match) {
      const pending = updates.find((u) => u.id === match.id);
      if (pending) pending.qty += row.qty;
      else updates.push({ id: match.id, qty: match.qty + row.qty, seCode: match.seCode, description: match.description, notes: match.notes });
      rowTargets.push(match.id);
    } else {
      creates.push(row);
      rowTargets.push(null);
    }
  }

  const headerPatch: Record<string, unknown> = { updatedBy: actor?.email ?? null };
  let result: JobWithRelations;
  let jobKitLineIds: (string | null)[];
  if (updates.length || creates.length) {
    // Grow the kit, resolve the resulting jobKitLineId per input row, and run the caller's stamp — ALL
    // in one transaction. If any part fails the whole thing rolls back, so the kit is never left grown
    // with the request lines unstamped (the state that would let a retry re-grow the kit).
    const out = await withTransaction(async (tx) => {
      const merged = await jobRepo.mergeKitLinesTx(tx, jobId, { updates, creates, deleteIds: [] }, headerPatch);
      const mergedLines = (merged.kitLines ?? []) as MatchableKitLine[];
      const ids = rows.map((row, i) => rowTargets[i] ?? findMatchingKitLine(mergedLines, row)?.id ?? null);
      if (stampTx) await stampTx(tx, ids);
      return { merged, ids };
    });
    result = out.merged;
    jobKitLineIds = out.ids;
  } else {
    // No structural change (unreachable for a non-empty request — every line is an update or a create —
    // but handled defensively): reuse the existing lines and stamp in a standalone transaction.
    result = existing;
    jobKitLineIds = rows.map((row, i) => rowTargets[i] ?? findMatchingKitLine(existingLines, row)?.id ?? null);
    if (stampTx) await withTransaction((tx) => stampTx(tx, jobKitLineIds));
  }

  audit.record({
    actor,
    action: "job.kit_line_added",
    targetType: "job",
    targetId: jobId,
    targetLabel: result.jobNumber,
    metadata: { added: creates.length, increased: updates.length, lines: rows.map((r) => ({ itemName: r.itemName, qty: r.qty })) },
  });

  const pub = await withGoodsTallies(toPublic(result));
  return { job: pub, jobKitLineIds };
}

// ── Assign (re-snapshot engineer; back to "assigned"; re-notify) ──────────────────────────────
export async function assignJob(id: string, engineerId: string, actor?: AuditActor): Promise<PublicJob> {
  const existing = await jobRepo.findById(id);
  if (!existing) throw notFound("Job not found.");
  assertTransition(existing.status, "assigned");
  const engineer = await requireEngineer(engineerId);

  const updated = await jobRepo.update(id, {
    assignedEngineerId: engineer.id,
    assignedEngineerName: `${engineer.firstName} ${engineer.lastName}`.trim(),
    assignedEngineerEmail: engineer.email,
    status: "assigned",
    assignedAt: new Date(),
    acceptedAt: null,
    acceptedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectReason: null,
    updatedBy: actor?.email ?? null,
  });

  // WITH tallies, for the same reason as cancelJob below: JobDetail's Reassign puts this response
  // straight into state, and the bare toPublic defaults would blank the goods columns of a job whose
  // kit has already been issued.
  const job = await withGoodsTallies(toPublic(updated));
  if (job.assignedEngineerId) {
    emitToUser(job.assignedEngineerId, "job:new", job);
    notify(job.assignedEngineerId, { title: "New job assigned", body: `${job.jobNumber} · ${job.name}`, data: { type: "job", jobId: job.id } });
  }
  emitJobsRoom("job:new", job);
  audit.record({
    actor,
    action: "job.assigned",
    targetType: "job",
    targetId: updated.id,
    targetLabel: updated.jobNumber,
    metadata: { engineerId: engineer.id, engineerEmail: engineer.email },
  });
  notifyAssignedEngineer(job);
  return job;
}

export async function cancelJob(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicJob> {
  const existing = await jobRepo.findById(id);
  if (!existing) throw notFound("Job not found.");
  assertTransition(existing.status, "cancelled");
  const updated = await jobRepo.update(id, {
    status: "cancelled",
    cancelledAt: new Date(),
    cancelReason: trimToNull(reason),
    updatedBy: actor?.email ?? null,
  });
  audit.record({ actor, action: "job.cancelled", targetType: "job", targetId: id, targetLabel: updated.jobNumber });

  // Cancelling moves no stock — the engineer walks away still holding the kit — and a cancelled job can
  // never reach `completed`, so it can never get to `awaiting_return` through them. That left the kit
  // with no way home at all: postReturn refused the job, and closeReconcile (which only unlocks from
  // awaiting_return) refused it too, so it couldn't even be written off, while the overdue list chased
  // it forever. Cancelling is precisely when the stock should be coming back, so open the return here.
  // Best-effort: a summary write must not cost the planner their cancel, and the job stays on the chase
  // list regardless (findGoodsActiveJobIds keeps cancelled), so nothing goes unseen if this fails.
  // LOGGED, not swallowed. Best-effort means the cancel still succeeds, not that the failure is
  // invisible: a job that never reached `awaiting_return` looks completely normal on screen while its
  // stock is quietly unreturnable, so the one trace of it has to end up somewhere a human will look.
  await goodsManagementService
    .openReturnsOnCancel(id)
    .catch((e) => console.error(`Opening returns after job ${updated.jobNumber} was cancelled failed:`, e instanceof Error ? e.message : e));

  // Withdraw the pending van handovers this job asked other engineers for. They are to-dos on someone
  // else's list ("hand N units from your van to this job"), and the job going away is exactly what
  // makes them pointless — left pending, they sat there forever and both kit lists kept showing
  // "awaiting handover" for stock that was never coming. No balance moves; a pending transfer has
  // never touched one. Best-effort for the same reason as the return above.
  // Same reasoning: cancelPendingForJob logs each transfer it can't close, but a failure to READ the
  // pending set would otherwise vanish, leaving another engineer holding a to-do nobody knows about.
  await transferService
    .cancelPendingForJob(id, actor ?? {})
    .catch((e) => console.error(`Withdrawing pending handovers after job ${updated.jobNumber} was cancelled failed:`, e instanceof Error ? e.message : e));

  // And the requests still waiting on a decision. Approving one after this point cannot work — the
  // grow refuses a cancelled job — so a pending request was a permanent error in the review queue and
  // an unanswered question for the engineer. Best-effort for the same reason as the two above.
  await kitRequestService
    .declinePendingForJob(id, actor ?? {})
    .catch((e) => console.error(`Declining pending kit requests after job ${updated.jobNumber} was cancelled failed:`, e instanceof Error ? e.message : e));

  // WITH tallies: the office job detail puts this response straight into state, and toPublic alone
  // carries the constructor defaults (issued/used/returned/remaining 0, goodsStatus "not_issued",
  // no van sources). Returning that zeroed every goods column on screen the moment a cancel was
  // confirmed, reading as "the stock went back" when nothing had moved.
  const pub = await withGoodsTallies(toPublic(updated));
  if (pub.assignedEngineerId) {
    emitToUser(pub.assignedEngineerId, "job:updated", pub);
    // Body is just the job's identity — the title carries the verb. Folding the
    // name into a sentence misreads when the name itself is a phrase
    // ("Server Change was cancelled").
    notify(pub.assignedEngineerId, { title: "Job cancelled", body: `${pub.jobNumber} · ${pub.name}`, data: { type: "job", jobId: pub.id } });
  }
  emitJobsRoom("job:updated", pub); // office Jobs-list watchers
  return pub;
}

// Deletable until the engineer has engaged with it: draft / assigned / rejected / cancelled. Once
// the work is live or done (accepted / in_progress / completed) it must be cancelled, never deleted,
// so the history stays intact.
const DELETABLE_STATUSES = new Set(["draft", "assigned", "rejected", "cancelled"]);

// Anything that would be left pointing at nothing. One entry per referencing table, mirroring the
// supplier / warehouse delete guards.
type DependencyChecker = { label: string; count: (jobId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "purchase requests", count: (id) => prfRepo.countByJob(id) },
  { label: "purchase orders", count: (id) => poRepo.countByJob(id) },
];

export async function deleteJob(id: string, actor?: AuditActor): Promise<void> {
  const existing = await jobRepo.findById(id);
  if (!existing) throw notFound("Job not found.");
  if (!DELETABLE_STATUSES.has(existing.status)) {
    throw conflict(`A ${existing.status.replace("_", " ")} job can't be deleted — cancel it instead.`);
  }

  // A job holding stock cannot be deleted, WHATEVER its status.
  //
  // The status list above protects a live job's history, but it was walked around in two clicks:
  // cancelling has no stock guard and `cancelled` is deletable, so accepted → cancel → delete removed
  // a job with units still out with the engineer. Every read filters `deletedAt: null`, so the job
  // vanished from the goods queue and could never be scanned back or reconciled.
  //
  // Worse than stranding it: `jobCommittedByEngineer` also filters deleted jobs out, so those units
  // silently stopped counting as job-committed and became FREE van stock — walking straight around the
  // field-return guard that exists precisely to stop job stock going back that way ("else it'd be
  // stranded", van-stock-request.service). The stock came home as anonymous van stock and the job it
  // belonged to was gone.
  //
  // Measured with the SAME tally the reconcile screen uses, so it can't disagree with what the user is
  // told to do about it: `remaining` is already capped at the engineer's real holding, which keeps a
  // phantom shortfall (stock handed back under another job) from making a job undeletable. `misc` is
  // excluded — free text, never stock-tracked, never returnable, so counting it would freeze such a
  // job as undeletable for ever.
  //
  // The job is handed over rather than re-fetched — `existing` above is already the full record, and
  // without it getJobKitTallies loads the whole thing again (every kit line's irmItem join and each
  // pickup warehouse's address block) to read one scalar and four fields per line. Same reason
  // getJobForCustomer prefetches.
  const tallies = await goodsManagementService.getJobKitTallies(id, {
    assignedEngineerId: existing.assignedEngineerId,
    kitLines: existing.kitLines,
  });
  const outstanding = (existing.kitLines ?? [])
    .filter((kl) => kl.lineType !== "misc")
    .reduce((n, kl) => n + (tallies[kl.id]?.remaining ?? 0), 0);
  if (outstanding > 0) {
    throw conflict(
      `This job still has ${outstanding} unit${outstanding === 1 ? "" : "s"} out with the engineer. ` +
        `Return the stock, or write it off from Goods Management, before deleting.`,
    );
  }

  // A job named on a purchase request or order cannot be deleted either.
  //
  // Those documents render the job as a LINK ("JOB-0031 — Fibre pull"), and every job read filters
  // `deletedAt`, so deleting it left the request pointing at a record the loader refuses — a click
  // to "Job not found." with nothing on the request saying why. It also erases the answer to the
  // question a buyer asks about a spend: what was this bought FOR.
  //
  // Same shape as the supplier and warehouse guards, and for the same reason they list every
  // referencing table: adding a future reference should be one line here rather than a hole nobody
  // notices until a link dies.
  for (const checker of DELETE_DEPENDENCY_CHECKERS) {
    if ((await checker.count(id)) > 0) {
      throw conflict(`This job is named on existing ${checker.label} and can't be deleted — cancel it instead.`);
    }
  }

  await jobRepo.softDelete(id);
  // Dual-emit (same contract as job:new): the assigned engineer isn't in OFFICE_JOBS_ROOM, so a
  // room-only emit would leave a now-deleted job sitting in their list (and 404 on click).
  const pub = toPublic(existing);
  if (existing.assignedEngineerId) emitToUser(existing.assignedEngineerId, "job:deleted", pub);
  emitJobsRoom("job:deleted", pub);
  audit.record({ actor, action: "job.deleted", targetType: "job", targetId: id, targetLabel: existing.jobNumber });
}

// ── Engineer portal (scoped to the signed-in engineer's own id) ───────────────────────────────
export interface ListEngineerJobsParams {
  status?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}
// Paged like the admin list (same clamping) — an engineer's job history grows unbounded, so the
// portal list must never fetch it all at once.
export async function listJobsForEngineer(engineerId: string, params: ListEngineerJobsParams = {}): Promise<PagedJobs> {
  // "Today" for the derived overdue filter is a company-timezone question, so it's resolved here and
  // handed to the repository — the same boundary the dashboard card and the warehouse Due filter use.
  // Resolved for every read, not just the overdue filter — the engineer's rows carry the same flag as
  // the office list, so the two surfaces can never mark different jobs late.
  const dayStart = startOfDayIn(await getCompanyTimezone(), new Date());
  const filters = {
    status: params.status,
    search: params.search,
    overdueBefore: params.status === "overdue" ? dayStart : undefined,
  };
  const total = await jobRepo.countByEngineer(engineerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  // LIST projection (no kit lines) — the engineer's list renders only header fields.
  const rows = await jobRepo.findManyByEngineerList(engineerId, filters, skip, pageSize, params.sort);
  const jobs = rows.map((r) => {
    const pub = toPublic(r);
    Object.assign(pub, jobOverdue(r.completionDate, pub.status, dayStart));
    return pub;
  });
  return { jobs, total, page, pageSize, totalPages };
}

// The engineer's ACTIVE jobs (assigned / accepted / in_progress) as slim public rows — one bounded,
// kit-line-free query the dashboard overview derives all its numbers from. Not paged: the active set
// is small by nature (the unbounded history is completed/cancelled, which this excludes).
export async function listActiveJobsForEngineer(engineerId: string): Promise<PublicJob[]> {
  const rows = await jobRepo.findActiveSummaryByEngineer(engineerId);
  return rows.map(toPublic);
}

export async function getJobForEngineer(engineerId: string, jobId: string): Promise<PublicJob> {
  const j = await jobRepo.findByIdForEngineer(jobId, engineerId);
  if (!j) throw notFound("Job not found.");
  return withGoodsTallies(toPublic(j));
}

export async function acceptJobForEngineer(engineerId: string, jobId: string, actor?: AuditActor): Promise<PublicJob> {
  const existing = await jobRepo.findByIdForEngineer(jobId, engineerId);
  if (!existing) throw notFound("Job not found.");
  assertTransition(existing.status, "accepted"); // only "assigned" → "accepted" is legal

  // Ownership + status are re-checked atomically at the DB: if a planner reassigned the job (or a
  // concurrent accept landed) between the scoped read above and this write, count === 0 and we 409
  // instead of flipping a job the engineer no longer owns.
  const accepted = await jobRepo.acceptIfAssigned(jobId, engineerId, {
    status: "accepted",
    acceptedAt: new Date(),
    acceptedBy: actor?.email ?? null,
    updatedBy: actor?.email ?? null,
  });
  if (accepted === 0) throw conflict("This job is no longer available to accept.");

  const updated = await jobRepo.findByIdForEngineer(jobId, engineerId);
  if (!updated) throw notFound("Job not found.");

  const job = toPublic(updated);
  emitJobsRoom("job:accepted", job); // every office Jobs-list watcher (incl. the creator)
  audit.record({ actor, action: "job.accepted", targetType: "job", targetId: updated.id, targetLabel: updated.jobNumber });
  return job;
}

export async function rejectJobForEngineer(
  engineerId: string,
  jobId: string,
  reason: string | undefined,
  actor?: AuditActor,
): Promise<PublicJob> {
  const existing = await jobRepo.findByIdForEngineer(jobId, engineerId);
  if (!existing) throw notFound("Job not found.");
  assertTransition(existing.status, "rejected"); // only "assigned" → "rejected" is legal

  // Atomic ownership + status guard (same race protection as accept): a reassignment landing in the
  // gap makes count === 0, so we 409 instead of rejecting a job the engineer no longer owns.
  const rejected = await jobRepo.rejectIfAssigned(jobId, engineerId, {
    status: "rejected",
    rejectedAt: new Date(),
    rejectedBy: actor?.email ?? null,
    rejectReason: trimToNull(reason),
    updatedBy: actor?.email ?? null,
  });
  if (rejected === 0) throw conflict("This job is no longer available to reject.");

  const updated = await jobRepo.findByIdForEngineer(jobId, engineerId);
  if (!updated) throw notFound("Job not found.");

  const job = toPublic(updated);
  // Notify every office Jobs-list watcher (incl. the creator), so they can reassign or cancel.
  emitJobsRoom("job:rejected", job);
  // Email the creator too — a rejection needs prompt reassignment and they may not be watching.
  notifyJobCreatorOfRejection(job, updated.createdByUserId ?? null);
  audit.record({
    actor,
    action: "job.rejected",
    targetType: "job",
    targetId: updated.id,
    targetLabel: updated.jobNumber,
    metadata: { reason: job.rejectReason },
  });
  return job;
}

// ── Engineer Start (accepted → in_progress) ───────────────────────────────────────────────────
export async function startJobForEngineer(jobId: string, engineerId: string, actor?: AuditActor): Promise<PublicJob> {
  const job = await jobRepo.findById(jobId);
  if (!job || job.deletedAt) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("This job isn't assigned to you.");
  assertTransition(job.status, "in_progress");

  // Engineer can't start until they've COLLECTED the kit — every stock-tracked line (IRM / customer
  // stock) must be fully issued to them by the warehouse first. Misc/free-text lines aren't warehouse
  // stock, so they don't block; a job with no stock lines starts freely.
  const stockLines = (job.kitLines ?? []).filter((l) => l.lineType === "irm" || l.lineType === "customer_stock");
  if (stockLines.length > 0) {
    const tallies = await goodsManagementService.getJobKitTallies(jobId);
    const allCollected = stockLines.every((l) => (tallies[l.id]?.issued ?? 0) >= l.qty);
    if (!allCollected) throw conflict("Collect the kit from the warehouse before starting work — not all items have been issued to you yet.");
  }

  // Atomic ownership + status guard: if the job was reassigned or someone else started it between
  // the read above and this write, startIfAccepted returns null and we 409.
  const updated = await jobRepo.startIfAccepted(jobId, engineerId);
  if (!updated) throw conflict("This job can't be started right now. Refresh and try again.");

  // Enrich with goods tallies (issued/used/returned/remaining) — the engineer's Complete form reads
  // `remaining` to cap declared usage, so a bare toPublic (all tallies 0) would leave it unusable.
  const pub = await withGoodsTallies(toPublic(updated));
  emitToUser(engineerId, "job:updated", pub);
  emitJobsRoom("job:updated", pub);
  audit.record({ actor, action: "job.started", targetType: "job", targetId: jobId, targetLabel: job.jobNumber });
  return pub;
}

// ── Engineer Complete (in_progress → completed + consume movement) ────────────────────────────
export async function completeJobForEngineer(jobId: string, engineerId: string, input: CompleteJobInput, actor?: AuditActor): Promise<PublicJob> {
  const job = await jobRepo.findById(jobId);
  if (!job || job.deletedAt) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("This job isn't assigned to you.");
  assertTransition(job.status, "completed");
  const actorEmail = actor?.email ?? null;
  const used = input.usedLines.filter((l) => l.qty > 0).map((l) => ({
    source: l.source,
    irmItemId: l.irmItemId,
    customerStockEntryId: l.customerStockEntryId,
    jobKitLineId: l.jobKitLineId,
    qty: l.qty,
  }));

  // Delegate the transactional consume + job-stamp to goods-management.service to avoid a circular
  // dependency (goods-management.service never imports back from job.service).
  await goodsManagementService.recordConsumeAndComplete(job, engineerId, input.workSummary ?? null, used, actorEmail);

  const updated = await jobRepo.findById(jobId);
  // Enrich with the post-consume tallies so the returned job (and the office/engineer refetch) reflect
  // the used/remaining state, consistent with getJobForEngineer.
  const pub = await withGoodsTallies(toPublic(updated!));
  emitToUser(engineerId, "job:updated", pub);
  emitJobsRoom("job:updated", pub);
  audit.record({ actor, action: "job.completed", targetType: "job", targetId: jobId, targetLabel: job.jobNumber });
  return pub;
}

// ── Customer portal (scoped to the signed-in customer's own company) ──────────────────────────
//
// Two things separate this from every other read in the module, and both are deliberate:
//
//  1. It never returns `PublicJob`. That DTO carries `notes`, `attachments`, `cancelReason`,
//     `rejectReason`, `plannerPhone`, `createdBy` and the engineer's email — internal to a fault.
//     The portal gets its own narrow shape, fed by a narrow SELECT (job.repository), so a field
//     added to Job or to PublicJob later cannot arrive here without someone deciding it should.
//  2. It never returns the raw `status`. See PortalJobStage below.

/**
 * What a job looks like from the outside.
 *
 * The stored status machine has six states, three of which are about OUR staffing rather than the
 * customer's work: `assigned` and `accepted` differ only by whether the engineer has tapped Accept,
 * and `rejected` means they declined and the office must reassign. To the customer all three mean
 * the same thing — the job is booked and hasn't started — so they collapse into one stage.
 *
 * Collapsing rather than relabelling matters. Sending `rejected` under a friendlier label would
 * still leak the event through anything that reads the value (a saved link, a CSV, the next
 * feature built on this payload) — and "Rejected" on a customer's own job reads as us refusing
 * their work, which is the opposite of what happened.
 */
export type PortalJobStage = "scheduled" | "in_progress" | "completed" | "cancelled";

const STAGE_OF: Record<string, PortalJobStage> = {
  assigned: "scheduled",
  accepted: "scheduled",
  rejected: "scheduled",
  in_progress: "in_progress",
  completed: "completed",
  cancelled: "cancelled",
};

/** Stored status → the stage the customer sees. Unknown statuses fall back to the least
 *  committal stage rather than throwing: a job the customer can see is a job they should see
 *  SOMETHING for, and a new internal state must never 500 their list. */
export function portalStage(status: string): PortalJobStage {
  return STAGE_OF[status] ?? "scheduled";
}

// Inverted from STAGE_OF rather than written out a second time — a hand-kept mirror is exactly the
// kind of pair that drifts when a status is added, and the drift is silent (a status quietly absent
// from every filter still shows in the unfiltered list, so nothing looks broken).
const STATUSES_IN_STAGE = Object.entries(STAGE_OF).reduce<Record<string, string[]>>((acc, [status, stage]) => {
  (acc[stage] ??= []).push(status);
  return acc;
}, {});

/** The stages that mean "still happening" — what the portal dashboard counts. */
const ACTIVE_STAGES: PortalJobStage[] = ["scheduled", "in_progress"];
const ACTIVE_STATUSES = ACTIVE_STAGES.flatMap((s) => STATUSES_IN_STAGE[s] ?? []);

// What the ?status filter accepts: the four stages, plus "active" as a pseudo-stage spanning two of
// them. It exists so the dashboard's Active-jobs card can link to a list showing exactly the jobs it
// counted — a figure the customer cannot trace is a figure they have to phone about. Resolved HERE,
// from the same ACTIVE_STATUSES the count uses, so the card and the list cannot disagree. (Same
// device as OPEN_REQUEST_STATUSES on the submissions list.)
const FILTERABLE_STATUSES: Record<string, string[]> = { ...STATUSES_IN_STAGE, active: ACTIVE_STATUSES };

export interface PortalJob {
  id: string;
  jobNumber: string;
  name: string;
  jobType: string;
  technology: string | null;
  customerRef: string | null;
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
  /** The date the job is due to be completed. */
  completionDate: string | null;
  /** When the work was actually finished. Null until it is. */
  completedAt: string | null;
  /**
   * Past its due date and still live — the SAME predicate the office and engineer lists use, so the
   * three surfaces can never disagree about whether a customer's job is late.
   *
   * Deliberately NO day count on this DTO, unlike the internal lists. The customer already knows the
   * date and can do the arithmetic; a "36d late" chip on their own job turns a status into an
   * accusation, and the portal's language is deliberately stages ("booked", "in progress") rather
   * than our internal SLA vocabulary. What they are owed is that the date is not presented as though
   * nothing were wrong — a red date says that, a running total performs it.
   */
  overdue: boolean;
  stage: PortalJobStage;
  /** The engineer attending, when there is one — see the note in toPortalJob. */
  engineerName: string | null;
  createdAt: string;
}

export interface PagedPortalJobs {
  jobs: PortalJob[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** One kit line as the customer's detail table renders it — the office's own columns. */
export interface PortalJobKitLine {
  id: string;
  lineType: string;
  seCode: string | null;
  itemName: string;
  description: string | null;
  warehouseName: string | null;
  qty: number;
  issued: number;
  used: number;
  returned: number;
  remaining: number;
}

/**
 * The detail payload — the list row plus everything the office's four cards show.
 *
 * A separate, wider type rather than widening PortalJob: the list is server-paged over an unbounded
 * history, so every field added there is paid for on every row of every page. The office makes the
 * same split (JobListRow vs JobWithRelations) for the same reason.
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
  /** Why the job was called off. Included where `rejectReason` is not: a cancellation is a decision
   *  about the customer's work, a rejection is one of our engineers declining to take it. */
  cancelReason: string | null;
  kitLines: PortalJobKitLine[];
}

/**
 * @param dayStart start of today in the COMPANY timezone, when the caller has resolved it.
 *
 * Optional because the single-job read has no reason to pay for a settings lookup — the detail page
 * shows one date the reader is already looking at, not a list to scan. Omitted means "not overdue",
 * which is the safe direction: a detail page that stays quiet is merely quiet, while one marking late
 * from the wrong clock would contradict the list the customer arrived from.
 */
function toPortalJob(j: jobRepo.PortalJobRow, dayStart?: Date): PortalJob {
  return {
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    jobType: j.jobType,
    technology: j.technology,
    customerRef: j.customerRef,
    schemeNo: j.schemeNo,
    projectId: j.projectId,
    // Live relation first, snapshot second — same precedence as toPublic, so a renamed project
    // reads the same on both surfaces instead of the customer and the office quoting each other
    // different names for it.
    projectName: j.project?.name ?? j.projectName ?? null,
    siteId: j.siteId,
    siteName: j.site?.name ?? j.siteName ?? null,
    addressLine1: j.addressLine1,
    addressLine2: j.addressLine2,
    city: j.city,
    county: j.county,
    postcode: j.postcode,
    country: j.country,
    completionDate: iso(j.completionDate),
    completedAt: iso(j.completedAt),
    // Same rule as the office and engineer lists, so all three agree about a customer's job. The day
    // count jobOverdue also returns is deliberately dropped here — see the `overdue` field's note.
    overdue: dayStart ? jobOverdue(j.completionDate, j.status, dayStart).overdue : false,
    stage: portalStage(j.status),
    // Blanked while the job is between engineers. `assignedEngineerName` is a snapshot that SURVIVES
    // a rejection, so a rejected job still names the engineer who declined it — presenting them as
    // the customer's engineer would be wrong twice over: they are not attending, and the customer
    // would chase someone with no part in the job.
    engineerName: j.status === "rejected" ? null : j.assignedEngineerName,
    createdAt: j.createdAt.toISOString(),
  };
}

export interface ListCustomerJobsParams {
  /** A PortalJobStage, or the "active" pseudo-stage. Anything else is ignored (see below). */
  status?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

/**
 * The customer's own jobs, paged. Scoped by the customerId taken from the SESSION — never from the
 * query string — so the only jobs reachable here are the signed-in company's.
 *
 * An unrecognised `status` widens to all stages rather than matching nothing. This value comes from
 * a URL the customer can edit or share, and an empty table is the one response that misleads: "no
 * jobs" is a statement about their account, not about a typo in a query string.
 */
export async function listJobsForCustomer(customerId: string, params: ListCustomerJobsParams = {}): Promise<PagedPortalJobs> {
  const filters = { search: params.search, statuses: params.status ? FILTERABLE_STATUSES[params.status] : undefined };
  const total = await jobRepo.countByCustomerPortal(customerId, filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await jobRepo.findManyByCustomerPortal(customerId, filters, skip, pageSize, params.sort);
  // Resolved once for the page, from the COMPANY timezone — the same boundary the office and engineer
  // lists use. A customer in another timezone must not see a different set of jobs marked late than
  // the people working them do.
  const dayStart = startOfDayIn(await getCompanyTimezone(), new Date());
  return { jobs: rows.map((r) => toPortalJob(r, dayStart)), total, page, pageSize, totalPages };
}

/**
 * The customer's own jobs as a CSV — the portal Jobs list, minus paging.
 *
 * Built from the SAME listJobsForCustomer the page renders, so the file cannot contain a job the
 * screen would not have shown: the customer scope, the hidden `draft` status and the stage filter
 * all live in there. Nothing about the columns is decided here either — they come from PortalJob,
 * which is the shape that already excludes cost, staff contacts, internal notes and the raw status.
 *
 * The stage, not the stored status, for exactly the reason portalStage exists: a file is the most
 * forwardable artifact this app produces, and "rejected" on a customer's own job would be read as
 * us refusing their work.
 */
export async function exportOwnJobsCsv(
  customerId: string,
  params: ListCustomerJobsParams = {},
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  const { jobs } = await listJobsForCustomer(customerId, { ...params, ...EXPORT_PAGING });
  const rows = jobs.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const date = (v: string | null) => formatDate(v, regional.dateFormat, regional.timezone);
  const csv = toCsv(
    [
      "Job Number", "Name", "Job Type", "Technology",
      "Your Reference", "Scheme Number",
      "Project", "Site", "Address", "City", "Postcode",
      "Status", "Engineer",
      `Due (${regional.timezone})`, `Completed (${regional.timezone})`, `Raised (${regional.timezone})`,
    ],
    rows.map((j) => [
      j.jobNumber,
      j.name,
      j.jobType,
      j.technology,
      // "Your reference", not "Customer reference" — on the customer's own file, "customer" is us.
      j.customerRef,
      j.schemeNo,
      j.projectName,
      j.siteName,
      j.addressLine1,
      j.city,
      j.postcode,
      j.stage,
      j.engineerName,
      date(j.completionDate),
      date(j.completedAt),
      date(j.createdAt),
    ]),
  );

  return { csv, capped: jobs.length > EXPORT_MAX };
}

/**
 * One of the customer's jobs, for the portal detail page.
 *
 * "Not found" covers every way a job can be out of reach — another company's, soft-deleted, still a
 * draft — because they are one answer to the customer: there is no such job here. Distinguishing
 * them would turn this into an oracle for guessing at job ids that exist but aren't theirs.
 *
 * The kit tallies come from goods-management in ONE batched call, exactly as the office detail does
 * (withGoodsTallies) — the alternative, a tally lookup per line, is a round-trip per row.
 */
export async function getJobForCustomer(customerId: string, jobId: string): Promise<PortalJobDetail> {
  const job = await jobRepo.findByIdForCustomer(jobId, customerId);
  if (!job) throw notFound("Job not found.");

  // The job is handed over rather than re-fetched: without it, getJobKitTallies loads the WHOLE job
  // again — every kit line with its irmItem join and each pickup warehouse's full address block — to
  // read four fields off it. On a remote Atlas that is a wasted round-trip on every page view.
  const tallies = await goodsManagementService.getJobKitTallies(job.id, {
    assignedEngineerId: job.assignedEngineerId,
    kitLines: job.kitLines,
  });
  return {
    ...toPortalJob(job),
    customerName: job.customer?.name ?? job.customerName ?? null,
    priority: job.priority ?? "normal",
    trsArea: job.trsArea,
    floor: job.floor,
    suite: job.suite,
    rack: job.rack,
    shelf: job.shelf,
    plannerName: job.plannerName,
    plannerPhone: job.plannerPhone,
    // Filtered, not just passed through. Validation only guards WRITES, so rows stored before the
    // http(s) rule existed still hold whatever was typed — and this surface renders them as links in
    // a customer's browser. Dropping the ones we can't vouch for is the only version of this that
    // covers data already in the database. Internal-only attachments (#internal hash) are withheld.
    attachments: safeHttpUrls([
      // Legacy rows still carry the marker in the URL; new rows carry it as a column. Both are
      // withheld from the customer — the office decides who sees a file, not the storage shape.
      ...job.attachments.filter((url) => !url.toLowerCase().endsWith("#internal")),
      ...job.attachmentRows.filter((a) => !a.internal).map((a) => a.url),
    ]),
    assignedAt: iso(job.assignedAt),
    acceptedAt: iso(job.acceptedAt),
    startedAt: iso(job.startedAt),
    cancelledAt: iso(job.cancelledAt),
    cancelReason: job.cancelReason,
    kitLines: job.kitLines.map((l) => {
      // Zeroes, not nulls, for a line the warehouse has not touched — the same default the office
      // page shows. A null would render as an em dash, which in that table means "not applicable"
      // (misc lines), not "nothing issued yet".
      const t = tallies[l.id];
      return {
        id: l.id,
        lineType: l.lineType,
        seCode: l.seCode,
        itemName: l.itemName,
        description: l.description,
        warehouseName: l.warehouseName,
        qty: l.qty,
        issued: t?.issued ?? 0,
        used: t?.used ?? 0,
        returned: t?.returned ?? 0,
        remaining: t?.remaining ?? 0,
      };
    }),
  };
}

/** Count of the customer's jobs that are still happening — the portal dashboard's Jobs card. */
export function countActiveJobsForCustomer(customerId: string): Promise<number> {
  return jobRepo.countByCustomerPortal(customerId, { statuses: ACTIVE_STATUSES });
}

// ── Attachments ───────────────────────────────────────────────────────────────────────────────
//
// A job's files live in JobAttachment ROWS. The legacy `Job.attachments` string array is still READ
// (pre-migration jobs) but never written: a bare URL cannot be deleted from Cloudinary, because the
// destroy API addresses an asset by publicId + resourceType and neither survives in a URL you can
// safely parse back.
//
// The form still sends plain URLs, and that is deliberate — the identity does not have to travel
// through the browser at all. Finalize stamps it onto the pending-upload ledger row (keyed by the
// URL), and `reconcileAttachments` claims it back here at save time. One consequence worth naming:
// a URL the user PASTED by hand has no ledger row, so its row is created with a null identity and
// removing it deletes nothing from Cloudinary — which is correct, we never owned that file.

/** The `#internal` fragment the form appends is a marker, not part of the address. */
function splitInternalFragment(raw: string): { url: string; internal: boolean } {
  const trimmed = raw.trim();
  const internal = /#internal$/i.test(trimmed);
  return { url: internal ? trimmed.replace(/#internal$/i, "") : trimmed, internal };
}

/**
 * Bring a job's attachment rows in line with the URLs its form just submitted.
 *
 * Additions claim their ledger row, which both hands over the identity AND removes the pending
 * entry — so the reaper stops watching an asset that now has an owner. Removals go through
 * `releaseAsset`, which counts references across every attachment table before destroying anything.
 *
 * A form that is never submitted reaches none of this: its ledger rows stay pending and the reaper
 * reclaims them on its next pass. That is the whole point of `deferred-attach`.
 */
async function reconcileAttachments(
  jobId: string,
  submitted: string[],
  jobLabel: string,
  actor?: AuditActor,
): Promise<void> {
  const wanted = submitted.map(splitInternalFragment).filter((a) => a.url);
  const existing = await jobRepo.findAttachments(jobId);
  const byUrl = new Map(existing.map((a) => [a.url, a]));

  for (const { url, internal } of wanted) {
    const row = byUrl.get(url);
    if (row) {
      byUrl.delete(url); // survives this save
      if (row.internal !== internal) await jobRepo.setAttachmentInternal(row.id, internal);
      continue;
    }
    const claimed = await uploadService.claimDeferredUpload(url);
    if (!claimed) {
      // No ledger row: a hand-pasted link, or one already claimed. Recorded so the job still lists
      // it, with a null identity so removal never tries to destroy a file we did not upload.
      await jobRepo.addAttachment({
        jobId, url, internal, fileName: url.split("/").pop() || "attachment",
        fileType: "link", fileSizeBytes: 0, uploadedBy: actor?.email ?? null,
      });
      continue;
    }
    // ONE transaction: the row and the ledger removal together, with the lease re-asserted. A crash
    // between them would either strand the asset or let the reaper destroy a live one.
    await uploadService.commitAttachment(claimed, (tx) =>
      jobRepo.addAttachment(
        {
          jobId, url, internal,
          fileName: claimed.fileName,
          fileType: claimed.fileType,
          fileSizeBytes: claimed.fileSizeBytes,
          publicId: claimed.publicId,
          resourceType: claimed.resourceType,
          uploadedBy: actor?.email ?? null,
        },
        tx,
      ),
    );
  }

  // Whatever is left in the map was dropped from the form.
  for (const gone of byUrl.values()) {
    await jobRepo.removeAttachment(gone.id);
    await attachmentService.releaseAsset(gone, `job ${jobLabel}`);
  }
}

/**
 * Upload a job attachment file (data URI) to Cloudinary and return its secure URL.
 *
 * The file lands in Cloudinary BEFORE the job is saved, which is the right way round — an upload
 * that only committed on save would lose the file on any validation error, the failure users
 * actually notice. Abandon the form and the asset stays there unreferenced.
 *
 * ## Why the identity is thrown away here, unlike PRF/PO/GRN
 *
 * Those three store `publicId` + `resourceType` on an attachment ROW, so removing one can address
 * and delete its file. A job's attachments are a bare `String[]` on the Job (plus an `#internal`
 * URL fragment marking staff-only ones), edited by replacing the whole array — there is no discrete
 * "this attachment was removed" event to hang a cleanup on, and no row to hold identity in. Adding
 * one means changing the field's shape, its validation, the forms and the portal payload: a module
 * redesign, not a cleanup fix, and deliberately out of scope.
 *
 * So this remains DEFERRED lifecycle debt, in two parts: job attachments are never deleted, and —
 * shared with every module — a file uploaded into an abandoned form is never reclaimed. Closing
 * either needs the PENDING → ATTACHED lifecycle and a scheduled sweep, neither of which exists.
 */
export async function uploadAttachment(dataUri: string, fileName?: string): Promise<{ url: string }> {
  if (!dataUri.startsWith("data:")) throw badRequest("Upload a valid file.");
  const creds = await getCloudinaryCreds();
  if (!creds) throw badRequest("Cloudinary isn't configured. Add your credentials in Settings → Integrations first.");

  let baseName = "job-attach";
  if (fileName && fileName.trim()) {
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "").trim();
    const sanitized = nameWithoutExt.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (sanitized) baseName = sanitized.slice(0, 60);
  }
  // The FULL uuid, not a slice of it. `uploadFileToCloudinary` leaves `overwrite` unset, which
  // Cloudinary defaults to true — so a publicId two uploads can agree on means the second silently
  // destroys the first. Truncating to 8 hex characters left 32 bits, which two files sharing a name
  // would collide on about once in four billion: unlikely rather than impossible, and there is nothing
  // to gain by clipping it. The readable part is the name in front.
  const publicId = `${baseName}-${crypto.randomUUID()}`;

  // Only the URL is kept — `Job.attachments` is a `String[]` with nowhere to put the rest. See above.
  const asset = await uploadFileToCloudinary(dataUri, publicId, creds, "senthra/jobs");
  return { url: asset.url };
}

