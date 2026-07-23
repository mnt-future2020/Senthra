import { Prisma, type Job } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";

// Data-access layer for Jobs (field-work job header + kit lines). The ONLY place Prisma is touched
// for job records. Soft-deleted jobs (deletedAt set) are excluded from normal reads. Header + kit
// lines are written atomically; the status machine + name snapshots live in the service. jobNumber
// is Counter-allocated per-year (JOB-2026-0001), same atomic mechanism as the GDN/PO codes.

// --- read slices -----------------------------------------------------------------------------
const customerSelect = { id: true, name: true } satisfies Prisma.CustomerSelect;
const projectSelect = { id: true, name: true } satisfies Prisma.CustomerProjectSelect;
const siteSelect = { id: true, name: true } satisfies Prisma.CustomerSiteSelect;
const supplierSelect = { id: true, name: true } satisfies Prisma.SupplierSelect;
const engineerSelect = { id: true, firstName: true, lastName: true, email: true } satisfies Prisma.UserSelect;
const irmItemSelect = { id: true, code: true, name: true } satisfies Prisma.IrmItemSelect;
// Per-kit-line pickup warehouse with its LIVE address — surfaced to the engineer (who has no
// warehouse-module access) so they know exactly where to collect each item.
const kitWarehouseSelect = {
  id: true,
  name: true,
  code: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  county: true,
  postcode: true,
  country: true,
  contactPhone: true,
} satisfies Prisma.WarehouseSelect;

const withRelations = {
  customer: { select: customerSelect },
  project: { select: projectSelect },
  site: { select: siteSelect },
  supplier: { select: supplierSelect },
  assignedEngineer: { select: engineerSelect },
  kitLines: { orderBy: { createdAt: "asc" }, include: { irmItem: { select: irmItemSelect }, warehouse: { select: kitWarehouseSelect } } },
} satisfies Prisma.JobInclude;

export type JobWithRelations = Prisma.JobGetPayload<{ include: typeof withRelations }>;

// LIST projection — the same header relations as withRelations but WITHOUT the kit lines (each of
// which carries an irmItem join + a full warehouse address block). List views render only header
// fields, so shipping kit lines per row is pure waste; the detail path keeps withRelations. toPublic
// tolerates the missing kitLines (defaults to []).
const listRelations = {
  customer: { select: customerSelect },
  project: { select: projectSelect },
  site: { select: siteSelect },
  supplier: { select: supplierSelect },
  assignedEngineer: { select: engineerSelect },
} satisfies Prisma.JobInclude;

export type JobListRow = Prisma.JobGetPayload<{ include: typeof listRelations }>;

// --- the kit-line row shape the service builds for create / replace --------------------------
export interface JobKitLineRow {
  lineType: string;
  seCode: string | null;
  itemName: string;
  description: string | null;
  customerStockEntryId: string | null;
  irmItemId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  qty: number;
  notes: string | null;
}

function lineCreateData(l: JobKitLineRow): Prisma.JobKitLineUncheckedCreateWithoutJobInput {
  return {
    lineType: l.lineType,
    seCode: l.seCode,
    itemName: l.itemName,
    description: l.description,
    customerStockEntryId: l.customerStockEntryId,
    irmItemId: l.irmItemId,
    warehouseId: l.warehouseId,
    warehouseName: l.warehouseName,
    warehouseCode: l.warehouseCode,
    qty: l.qty,
    notes: l.notes,
  };
}

// --- filters / reads -------------------------------------------------------------------------
export interface JobListFilters {
  search?: string;
  status?: string;
  customerId?: string;
  assignedEngineerId?: string;
  projectId?: string;
}

function buildWhere(filters: JobListFilters): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = { deletedAt: null };
  if (filters.status) where.status = filters.status;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.assignedEngineerId) where.assignedEngineerId = filters.assignedEngineerId;
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.search) {
    const q = escapeRegex(filters.search);
    where.OR = [
      { jobNumber: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { schemeNo: { contains: q, mode: "insensitive" } },
      { customerRef: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
      { assignedEngineerName: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

function orderBy(sort?: string): Prisma.JobOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "number":
      return { jobNumber: "asc" };
    case "completion":
      return { completionDate: "desc" };
    default:
      return { createdAt: "desc" };
  }
}

export function findMany(filters: JobListFilters = {}, skip = 0, take = 20, sort?: string): Promise<JobWithRelations[]> {
  return prisma.job.findMany({ where: buildWhere(filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}
export function count(filters: JobListFilters = {}): Promise<number> {
  return prisma.job.count({ where: buildWhere(filters) });
}
export function findById(id: string): Promise<JobWithRelations | null> {
  if (!id) return Promise.resolve(null);
  return prisma.job.findFirst({ where: { id, deletedAt: null }, include: withRelations });
}
export function findByNumber(jobNumber: string): Promise<JobWithRelations | null> {
  return prisma.job.findFirst({ where: { jobNumber, deletedAt: null }, include: withRelations });
}

// --- goods-management queue read: active jobs (accepted / in_progress / completed) -----------
// Returns jobs whose kit lines have at least one line pointing at a warehouse the actor can access.
// Candidate jobs for ONE warehouse's Goods Management queue: any job with a kit line stocked at this
// warehouse OR any misc line (misc is actionable from any warehouse). Optional text search narrows by
// job number / name / customer / engineer at the DB level. goodsStatus filtering + pagination happen
// in the service, since goodsStatus lives in a separate summary collection.
// The candidate set is "has a kit line homed here OR a misc line OR a VAN-sourced line". The last arm
// (JobKitLine.hasVanSource, indexed) surfaces jobs whose van stock — returnable at ANY warehouse —
// isn't homed here; without it the queue could never find a van return away from its nominal home.
// It's an indexed boolean lookup, NOT a growing job-id list, so it stays O(1) as history grows. The
// service then confirms per line that van stock is actually still returnable before showing the row.
export function findActiveForGoodsManagement(warehouseId: string, search?: string): Promise<JobWithRelations[]> {
  const candidateOr: Prisma.JobWhereInput[] = [
    { kitLines: { some: { OR: [{ warehouseId }, { lineType: "misc" }] } } },
    { kitLines: { some: { hasVanSource: true } } },
  ];
  const where: Prisma.JobWhereInput = {
    deletedAt: null,
    status: { in: ["accepted", "in_progress", "completed"] },
    AND: [
      { OR: candidateOr },
      ...(search
        ? [{
            OR: [
              { jobNumber: { contains: escapeRegex(search), mode: "insensitive" as const } },
              { name: { contains: escapeRegex(search), mode: "insensitive" as const } },
              { customerName: { contains: escapeRegex(search), mode: "insensitive" as const } },
              { assignedEngineerName: { contains: escapeRegex(search), mode: "insensitive" as const } },
            ],
          }]
        : []),
    ],
  };
  return prisma.job.findMany({ where, include: withRelations, orderBy: { createdAt: "desc" } });
}

// --- open-demand read: every active job that may still draw warehouse stock ------------------
// Jobs from assignment through completion (NOT draft / cancelled / rejected) — the service then keeps
// only the ones whose goods aren't fully issued and sums their not-yet-issued kit lines into "open
// demand" per item+warehouse. excludeJobId drops the job currently being edited from the totals.
export function findActiveWithKitLines(excludeJobId?: string): Promise<JobWithRelations[]> {
  return prisma.job.findMany({
    where: {
      deletedAt: null,
      status: { in: ["assigned", "accepted", "in_progress", "completed"] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    include: withRelations,
    orderBy: { createdAt: "desc" },
  });
}

// --- engineer-scoped reads (engineer portal) -------------------------------------------------
// Jobs assigned to one engineer, filtered + PAGED (an engineer accumulates hundreds of completed
// jobs over time — never return the unbounded set). Scoped on assignedEngineerId so an engineer can
// only ever read their OWN jobs. Search matches job number / name / customer, like the admin list.
export interface EngineerJobFilters {
  status?: string;
  search?: string;
}
function buildEngineerWhere(engineerId: string, filters: EngineerJobFilters): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = { assignedEngineerId: engineerId, deletedAt: null };
  if (filters.status === "overdue") {
    // "Overdue" is a DERIVED pseudo-status (never stored): an active job whose completion date has
    // passed. Same definition as the dashboard overview's overdue count (active + completionDate <
    // start of today, UTC) so the filter and the "N jobs past the completion date" card agree exactly.
    const now = new Date();
    const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    where.status = { in: ["assigned", "accepted", "in_progress"] };
    where.completionDate = { lt: startToday };
  } else if (filters.status) {
    where.status = filters.status;
  }
  if (filters.search) {
    where.OR = [
      { jobNumber: { contains: escapeRegex(filters.search), mode: "insensitive" } },
      { name: { contains: escapeRegex(filters.search), mode: "insensitive" } },
      { customerName: { contains: escapeRegex(filters.search), mode: "insensitive" } },
    ];
  }
  return where;
}
export function findManyByEngineer(
  engineerId: string,
  filters: EngineerJobFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<JobWithRelations[]> {
  return prisma.job.findMany({ where: buildEngineerWhere(engineerId, filters), include: withRelations, orderBy: orderBy(sort), skip, take });
}
// List variant — the engineer's jobs list renders only header fields, so it uses the kit-line-free
// LIST projection (no per-row irmItem/warehouse-address hydration). Same where/order/paging as above.
export function findManyByEngineerList(
  engineerId: string,
  filters: EngineerJobFilters = {},
  skip = 0,
  take = 20,
  sort?: string,
): Promise<JobListRow[]> {
  return prisma.job.findMany({ where: buildEngineerWhere(engineerId, filters), include: listRelations, orderBy: orderBy(sort), skip, take });
}
// The engineer's ACTIVE jobs (assigned / accepted / in_progress) as a slim, kit-line-free set — the
// single bounded query the dashboard overview derives its counts, due-maths and "next up" list from
// (replacing three paged withRelations fetches that hydrated up to 300 jobs with all their kit lines).
export function findActiveSummaryByEngineer(engineerId: string): Promise<JobListRow[]> {
  return prisma.job.findMany({
    where: { assignedEngineerId: engineerId, deletedAt: null, status: { in: ["assigned", "accepted", "in_progress"] } },
    include: listRelations,
    orderBy: { createdAt: "desc" },
  });
}
export function countByEngineer(engineerId: string, filters: EngineerJobFilters = {}): Promise<number> {
  return prisma.job.count({ where: buildEngineerWhere(engineerId, filters) });
}
// An engineer's OPEN jobs only (assigned / accepted / in_progress) — bounded by nature (an engineer
// holds a handful of live jobs at a time, however many hundreds they've completed). Used by the
// Inventory Hub engineer detail, which must show EVERY active job — so this filters at the DB
// rather than page (the paged findManyByEngineer above would silently cap that list).
export function findActiveByEngineer(engineerId: string): Promise<JobWithRelations[]> {
  return prisma.job.findMany({
    where: { assignedEngineerId: engineerId, deletedAt: null, status: { in: ["assigned", "accepted", "in_progress"] } },
    include: withRelations,
    orderBy: { createdAt: "desc" },
  });
}
export function findByIdForEngineer(jobId: string, engineerId: string): Promise<JobWithRelations | null> {
  if (!jobId) return Promise.resolve(null);
  return prisma.job.findFirst({ where: { id: jobId, assignedEngineerId: engineerId, deletedAt: null }, include: withRelations });
}

// --- header / status writes ------------------------------------------------------------------
export function update(id: string, data: Prisma.JobUncheckedUpdateInput): Promise<JobWithRelations> {
  return prisma.job.update({ where: { id }, data, include: withRelations });
}
export function softDelete(id: string): Promise<Job> {
  return prisma.job.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Atomic, race-safe accept: flips status assigned → accepted ONLY when the job is still owned by this
// engineer AND still in "assigned" (a planner reassigning, or a concurrent accept, in the gap between
// the service's scoped read and this write makes count === 0). Keeps ownership + status one DB guard.
export async function acceptIfAssigned(
  jobId: string,
  engineerId: string,
  data: Prisma.JobUpdateManyMutationInput,
): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { id: jobId, assignedEngineerId: engineerId, status: "assigned", deletedAt: null },
    data,
  });
  return res.count;
}

// Atomic, race-safe start: flips status accepted → in_progress ONLY when the job is still owned by
// this engineer AND still in "accepted". Returns the updated job or null on a concurrent race.
export async function startIfAccepted(id: string, engineerId: string): Promise<JobWithRelations | null> {
  const res = await prisma.job.updateMany({
    where: { id, assignedEngineerId: engineerId, status: "accepted", deletedAt: null },
    data: { status: "in_progress", startedAt: new Date() },
  });
  if (res.count !== 1) return null;
  return findById(id);
}

// Atomic, race-safe complete (tx-aware): flips status in_progress → completed ONLY when the job is
// still owned by this engineer AND still in "in_progress".
export function completeIfInProgressTx(tx: Prisma.TransactionClient, id: string, engineerId: string): Promise<{ count: number }> {
  return tx.job.updateMany({
    where: { id, assignedEngineerId: engineerId, status: "in_progress", deletedAt: null },
    data: { status: "completed", completedAt: new Date() },
  });
}

// Atomic, race-safe reject — same guard as acceptIfAssigned (assigned + owned), flips to "rejected".
export async function rejectIfAssigned(
  jobId: string,
  engineerId: string,
  data: Prisma.JobUpdateManyMutationInput,
): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { id: jobId, assignedEngineerId: engineerId, status: "assigned", deletedAt: null },
    data,
  });
  return res.count;
}

// Apply a computed kit-line diff in ONE transaction: update matched lines IN PLACE (preserving their
// ids, so posted stock movements keep pointing at them), create genuinely new lines, and delete the
// ones the caller resolved as removable. This replaces the old delete-all/recreate approach, which
// regenerated every kit-line id and orphaned the job's stock movements.
export interface KitLineChanges {
  updates: { id: string; qty: number; seCode: string | null; description: string | null; notes: string | null }[];
  creates: JobKitLineRow[];
  deleteIds: string[];
}

// The tx-aware core: apply the kit-line diff + header patch within a PROVIDED transaction. Exposed so a
// caller (the kit-request approve) can run the grow ATOMICALLY with its own follow-up writes — stamping
// the request lines — in a single transaction, so a failure can't leave the kit grown-but-unrecorded.
export async function mergeKitLinesTx(
  tx: Prisma.TransactionClient,
  id: string,
  changes: KitLineChanges,
  headerPatch: Prisma.JobUncheckedUpdateInput,
): Promise<JobWithRelations> {
  if (changes.deleteIds.length > 0) {
    await tx.jobKitLine.deleteMany({ where: { id: { in: changes.deleteIds }, jobId: id } });
  }
  for (const u of changes.updates) {
    await tx.jobKitLine.update({
      where: { id: u.id },
      data: { qty: u.qty, seCode: u.seCode, description: u.description, notes: u.notes },
    });
  }
  for (const line of changes.creates) {
    await tx.jobKitLine.create({ data: { jobId: id, ...lineCreateData(line) } });
  }
  await tx.job.update({ where: { id }, data: headerPatch });
  return tx.job.findUniqueOrThrow({ where: { id }, include: withRelations });
}

export function mergeKitLines(id: string, changes: KitLineChanges, headerPatch: Prisma.JobUncheckedUpdateInput): Promise<JobWithRelations> {
  return withTransaction((tx) => mergeKitLinesTx(tx, id, changes, headerPatch));
}

// --- code allocation (atomic Counter, per-year key "JOB:<year>") -----------------------------
const JOB_CODE_PREFIX = "JOB";

function isCodeConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (target == null) return true;
  return String(target).includes("jobNumber");
}
function isRecordNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

async function highestJobNumber(year: number): Promise<number> {
  const head = `${JOB_CODE_PREFIX}-${year}-`;
  const rows = await prisma.job.findMany({ where: { jobNumber: { startsWith: head } }, select: { jobNumber: true } });
  let max = 0;
  for (const { jobNumber } of rows) {
    const suffix = jobNumber.slice(head.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

async function nextSequence(year: number): Promise<number> {
  const key = `${JOB_CODE_PREFIX}:${year}`;
  try {
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  } catch (e) {
    if (!isRecordNotFound(e)) throw e;
  }
  const start = await highestJobNumber(year);
  try {
    await prisma.counter.create({ data: { key, seq: start + 1 } });
    return start + 1;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
    const c = await prisma.counter.update({ where: { key }, data: { seq: { increment: 1 } }, select: { seq: true } });
    return c.seq;
  }
}

async function fastForwardCounter(year: number): Promise<void> {
  const key = `${JOB_CODE_PREFIX}:${year}`;
  const start = await highestJobNumber(year);
  try {
    await prisma.counter.upsert({ where: { key }, create: { key, seq: start }, update: { seq: start } });
  } catch {
    /* best-effort; the next nextSequence() increments anyway */
  }
}

// Create a Job + its kit lines atomically with a unique JOB-<year>-#### number. deletedAt: null is
// written EXPLICITLY — Prisma+Mongo `{deletedAt:null}` reads don't match an absent field, so without
// this a freshly-created job would be invisible to findById/list.
export async function createWithCode(
  header: Omit<Prisma.JobUncheckedCreateInput, "jobNumber" | "kitLines">,
  lines: JobKitLineRow[],
): Promise<JobWithRelations> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSequence(year);
    const jobNumber = `${JOB_CODE_PREFIX}-${year}-${String(seq).padStart(4, "0")}`;
    try {
      return await withTransaction(async (tx) => {
        const job = await tx.job.create({
          data: { deletedAt: null, ...header, jobNumber, kitLines: { create: lines.map(lineCreateData) } },
        });
        return tx.job.findUniqueOrThrow({ where: { id: job.id }, include: withRelations });
      });
    } catch (e) {
      if (!isCodeConflict(e)) throw e;
      await fastForwardCounter(year);
    }
  }
  throw new Error("Could not allocate a unique job number.");
}

// --- Inventory Hub: item-scoped job lookup ---------------------------------------------------
// Returns all non-deleted jobs that have at least one kit line referencing the given IRM item.
// Used by GET /inventory/items/:irmItemId/jobs in the aggregation service.
export function findJobsByIrmItem(irmItemId: string): Promise<JobWithRelations[]> {
  return prisma.job.findMany({
    where: { deletedAt: null, kitLines: { some: { irmItemId } } },
    include: withRelations,
    orderBy: { createdAt: "desc" },
  });
}

// Count of ACTIVE jobs (assigned / accepted / in_progress) per engineer — Inventory Hub engineer lens.
export async function countActiveJobsByEngineer(): Promise<Map<string, number>> {
  const rows = await prisma.job.groupBy({
    by: ["assignedEngineerId"],
    where: { deletedAt: null, assignedEngineerId: { not: null }, status: { in: ["assigned", "accepted", "in_progress"] } },
    _count: { _all: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) if (r.assignedEngineerId) m.set(r.assignedEngineerId, r._count._all);
  return m;
}

// --- Dashboard read-models — not a generic reporting API ---

const ACTIVE_JOB_STATUSES = ["assigned", "accepted", "in_progress"] as const;

/** Count of jobs currently in flight. */
export async function countActive(): Promise<number> {
  return prisma.job.count({ where: { status: { in: [...ACTIVE_JOB_STATUSES] }, deletedAt: null } });
}

/** createdAt of jobs since `since`, for the 8-week sparkline. */
export async function createdSince(since: Date): Promise<Array<{ at: Date }>> {
  const rows = await prisma.job.findMany({ where: { createdAt: { gte: since }, deletedAt: null }, select: { createdAt: true } });
  return rows.map((r) => ({ at: r.createdAt }));
}

/** Active jobs past / approaching their completionDate (UTC day boundaries). Jobs with no
 *  completionDate count in neither bucket — there is nothing to be overdue against. */
export async function dueBreakdown(now: Date): Promise<{ overdue: number; dueThisWeek: number }> {
  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const in7Days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7));
  const active = { status: { in: [...ACTIVE_JOB_STATUSES] }, deletedAt: null };
  const [overdue, dueThisWeek] = await Promise.all([
    prisma.job.count({ where: { ...active, completionDate: { lt: startToday } } }),
    prisma.job.count({ where: { ...active, completionDate: { gte: startToday, lt: in7Days } } }),
  ]);
  return { overdue, dueThisWeek };
}
