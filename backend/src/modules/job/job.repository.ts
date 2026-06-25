import { Prisma, type Job } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

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
    const q = filters.search;
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
// `warehouseIds` = undefined means unrestricted; [] means no-match (scoped user with no warehouses).
export function findActiveForGoodsManagement(warehouseIds?: string[]): Promise<JobWithRelations[]> {
  // We filter kit lines per-warehouse in the service after fetch; here just fetch active jobs.
  // If the actor is scoped (warehouseIds is an array) filter to jobs that have ANY kit line for those warehouses.
  const where: Prisma.JobWhereInput = {
    deletedAt: null,
    status: { in: ["accepted", "in_progress", "completed"] },
    ...(warehouseIds !== undefined && {
      kitLines: {
        some: {
          warehouseId: { in: warehouseIds },
        },
      },
    }),
  };
  return prisma.job.findMany({ where, include: withRelations, orderBy: { createdAt: "desc" } });
}

// --- engineer-scoped reads (engineer portal) -------------------------------------------------
// Every job assigned to one engineer, newest first. Scoped on assignedEngineerId so an engineer can
// only ever read their OWN jobs.
export function findManyByEngineer(engineerId: string): Promise<JobWithRelations[]> {
  return prisma.job.findMany({ where: { assignedEngineerId: engineerId, deletedAt: null }, include: withRelations, orderBy: { createdAt: "desc" } });
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
    data: { status: "in_progress" },
  });
  if (res.count !== 1) return null;
  return findById(id);
}

// Atomic, race-safe complete (tx-aware): flips status in_progress → completed ONLY when the job is
// still owned by this engineer AND still in "in_progress".
export function completeIfInProgressTx(tx: Prisma.TransactionClient, id: string, engineerId: string): Promise<{ count: number }> {
  return tx.job.updateMany({
    where: { id, assignedEngineerId: engineerId, status: "in_progress", deletedAt: null },
    data: { status: "completed" },
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

// Replace ALL kit lines + patch the header, atomically (full re-save edit).
export async function replaceKitLines(
  id: string,
  lines: JobKitLineRow[],
  headerPatch: Prisma.JobUncheckedUpdateInput,
): Promise<JobWithRelations> {
  return withTransaction(async (tx) => {
    await tx.jobKitLine.deleteMany({ where: { jobId: id } });
    for (const line of lines) {
      await tx.jobKitLine.create({ data: { jobId: id, ...lineCreateData(line) } });
    }
    await tx.job.update({ where: { id }, data: headerPatch });
    return tx.job.findUniqueOrThrow({ where: { id }, include: withRelations });
  });
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
