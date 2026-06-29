import * as jobRepo from "./job.repository.js";
import type { JobWithRelations, JobKitLineRow } from "./job.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as supplierRepo from "#modules/supplier/supplier.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { roleGrants } from "#modules/role/permissions.js";
import { emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import { conflict, forbidden, notFound, badRequest } from "../../utils/http-error.js";
import type { CreateJobInput, JobKitLineInput, UpdateJobInput, CompleteJobInput } from "./job.validation.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

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
  address: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  floor: string | null;
  suite: string | null;
  rack: string | null;
  shelf: string | null;
  completionDate: string | null;
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

function toPublic(j: JobWithRelations): PublicJob {
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
    address: j.address,
    postcode: j.postcode,
    latitude: j.latitude,
    longitude: j.longitude,
    floor: j.floor,
    suite: j.suite,
    rack: j.rack,
    shelf: j.shelf,
    completionDate: iso(j.completionDate),
    priority: j.priority ?? "normal",
    assignedEngineerId: j.assignedEngineerId,
    assignedEngineerName: eng ? `${eng.firstName} ${eng.lastName}`.trim() : j.assignedEngineerName ?? null,
    assignedEngineerEmail: eng?.email ?? j.assignedEngineerEmail ?? null,
    supplierId: j.supplierId,
    supplierName: j.supplier?.name ?? j.supplierName ?? null,
    installerType: j.installerType ?? "internal",
    status: j.status ?? "assigned",
    goodsStatus: "not_issued", // overwritten by listJobs / withGoodsTallies from the stock summary
    plannerName: j.plannerName,
    plannerPhone: j.plannerPhone,
    notes: j.notes,
    attachments: j.attachments ?? [],
    kitLines: j.kitLines.map((l) => ({
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
// capability (canHoldStock) — the same gate goods-out enforces for dispatch recipients. This keeps
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
async function availableForLine(line: { irmItemId: string | null; warehouseId: string | null; customerStockEntryId: string | null }): Promise<number> {
  if (line.irmItemId && line.warehouseId) {
    const bal = await inventoryRepo.findBalancePair(line.irmItemId, line.warehouseId);
    return (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
  }
  if (line.customerStockEntryId) {
    const entry = await customerRepo.findStockEntryById(line.customerStockEntryId);
    return entry?.quantity ?? 0;
  }
  return Infinity;
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
}

export async function listJobs(params: ListJobsParams = {}, _actor?: AuditActor): Promise<PagedJobs> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = { search: params.search, status: params.status, customerId: params.customer, assignedEngineerId: params.engineer, projectId: params.project };
  const total = await jobRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await jobRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  // Merge each job's goods-lifecycle status in ONE batched query (so the PM sees issuance per row).
  const goodsStatusByJob = await goodsManagementService.getGoodsStatusByJobs(rows.map((r) => r.id));
  const jobs = rows.map((r) => {
    const pub = toPublic(r);
    pub.goodsStatus = goodsStatusByJob.get(r.id) ?? "not_issued";
    return pub;
  });
  return { jobs, total, page, pageSize, totalPages };
}

// Fill in each kit line's goods tallies (issued/used/returned/remaining) + the job's goods-lifecycle
// status from its stock movements. Used on the single-job detail views (office + engineer "job pack").
async function withGoodsTallies(pub: PublicJob): Promise<PublicJob> {
  const [tallies, goodsStatus] = await Promise.all([
    goodsManagementService.getJobKitTallies(pub.id),
    goodsManagementService.getGoodsStatus(pub.id),
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
  for (const r of rows) {
    if (r.lineType === "misc") continue;
    const avail = await availableForLine(r);
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
      address: trimToNull(input.address),
      postcode: trimToNull(input.postcode),
      latitude: null,
      longitude: null,
      floor: trimToNull(input.floor),
      suite: trimToNull(input.suite),
      rack: trimToNull(input.rack),
      shelf: trimToNull(input.shelf),
      completionDate: input.completionDate ? new Date(input.completionDate) : null,
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
      attachments: input.attachments ?? [],
      assignedAt: now,
      createdByUserId: actor?.id ?? null,
      createdBy: actorEmail,
      updatedBy: actorEmail,
    },
    rows,
  );

  const job = toPublic(created);
  if (job.assignedEngineerId) emitToUser(job.assignedEngineerId, "job:new", job); // engineer's portal list
  emitToRoom(OFFICE_JOBS_ROOM, "job:new", job); // every office Jobs-list watcher
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
      headerPatch.siteId = null;
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
  if (input.address !== undefined) headerPatch.address = trimToNull(input.address);
  if (input.postcode !== undefined) headerPatch.postcode = trimToNull(input.postcode);
  if (input.floor !== undefined) headerPatch.floor = trimToNull(input.floor);
  if (input.suite !== undefined) headerPatch.suite = trimToNull(input.suite);
  if (input.rack !== undefined) headerPatch.rack = trimToNull(input.rack);
  if (input.shelf !== undefined) headerPatch.shelf = trimToNull(input.shelf);
  if (input.completionDate !== undefined) headerPatch.completionDate = input.completionDate ? new Date(input.completionDate) : null;
  if (input.priority !== undefined) headerPatch.priority = input.priority;
  if (input.installerType !== undefined) headerPatch.installerType = input.installerType;
  if (input.plannerName !== undefined) headerPatch.plannerName = trimToNull(input.plannerName);
  if (input.plannerPhone !== undefined) headerPatch.plannerPhone = trimToNull(input.plannerPhone);
  if (input.notes !== undefined) headerPatch.notes = trimToNull(input.notes);
  if (input.attachments !== undefined) headerPatch.attachments = input.attachments;

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
      for (const c of diff.creates) {
        if (c.lineType === "misc") continue;
        const avail = await availableForLine(c);
        if (c.qty > avail) throw badRequest(`"${c.itemName}" — only ${avail} in stock at that warehouse, but ${c.qty} planned.`);
      }
      for (const u of diff.updates) {
        const inc = u.qty - u.existingQty;
        if (inc <= 0) continue;
        const kl = (existing.kitLines ?? []).find((k) => k.id === u.id);
        if (!kl || kl.lineType === "misc") continue;
        const avail = await availableForLine(kl);
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

  const job = toPublic(result);
  // A re-assignment via PATCH fires the same realtime + notification as assignJob.
  if (reassigned) {
    if (job.assignedEngineerId) emitToUser(job.assignedEngineerId, "job:new", job);
    emitToRoom(OFFICE_JOBS_ROOM, "job:new", job);
    audit.record({
      actor,
      action: "job.assigned",
      targetType: "job",
      targetId: id,
      targetLabel: result.jobNumber,
      metadata: { engineerId: job.assignedEngineerId },
    });
    notifyAssignedEngineer(job);
  }
  return job;
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

  const job = toPublic(updated);
  if (job.assignedEngineerId) emitToUser(job.assignedEngineerId, "job:new", job);
  emitToRoom(OFFICE_JOBS_ROOM, "job:new", job);
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
  return toPublic(updated);
}

// Deletable until the engineer has engaged with it: draft / assigned / rejected / cancelled. Once
// the work is live or done (accepted / in_progress / completed) it must be cancelled, never deleted,
// so the history stays intact.
const DELETABLE_STATUSES = new Set(["draft", "assigned", "rejected", "cancelled"]);

export async function deleteJob(id: string, actor?: AuditActor): Promise<void> {
  const existing = await jobRepo.findById(id);
  if (!existing) throw notFound("Job not found.");
  if (!DELETABLE_STATUSES.has(existing.status)) {
    throw conflict(`A ${existing.status.replace("_", " ")} job can't be deleted — cancel it instead.`);
  }
  await jobRepo.softDelete(id);
  emitToRoom(OFFICE_JOBS_ROOM, "job:deleted", toPublic(existing));
  audit.record({ actor, action: "job.deleted", targetType: "job", targetId: id, targetLabel: existing.jobNumber });
}

// ── Engineer portal (scoped to the signed-in engineer's own id) ───────────────────────────────
export async function listJobsForEngineer(engineerId: string): Promise<PublicJob[]> {
  const rows = await jobRepo.findManyByEngineer(engineerId);
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
  emitToRoom(OFFICE_JOBS_ROOM, "job:accepted", job); // every office Jobs-list watcher (incl. the creator)
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
  emitToRoom(OFFICE_JOBS_ROOM, "job:rejected", job);
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

  const pub = toPublic(updated);
  emitToUser(engineerId, "job:updated", pub);
  emitToRoom(OFFICE_JOBS_ROOM, "job:updated", pub);
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
  const pub = toPublic(updated!);
  emitToUser(engineerId, "job:updated", pub);
  emitToRoom(OFFICE_JOBS_ROOM, "job:updated", pub);
  audit.record({ actor, action: "job.completed", targetType: "job", targetId: jobId, targetLabel: job.jobNumber });
  return pub;
}
