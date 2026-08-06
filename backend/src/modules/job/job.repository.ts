import { Prisma, type Job } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";
import { escapeRegex } from "../../utils/search.js";
import { startOfDayIn } from "../../utils/filter-date.js";

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
// `code` doubles as the string the goods queue offers for copy-into-scan — see scanCodeFor in
// goods-management.service. Deliberately NOT `barcode` too: that is the manufacturer's EAN, which
// nothing here reads, so fetching it would load a column on every job query for no consumer.
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

// The goods queue's job projection — see findActiveForGoodsManagement below for why it is narrow.
const goodsQueueSelect = {
  id: true,
  jobNumber: true,
  name: true,
  status: true,
  customerId: true,
  customerName: true,
  createdAt: true,
  completionDate: true,
  assignedEngineerId: true,
  assignedEngineerName: true,
  assignedEngineerEmail: true,
  // Fallback display name for jobs assigned before assignedEngineerName was snapshotted.
  assignedEngineer: { select: { id: true, firstName: true, lastName: true, email: true } },
  kitLines: {
    // SAME ordering as withRelations — dropping it would let the queue render a job's kit lines in a
    // different order from the job detail and the engineer's view, for no reason anyone could see.
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      lineType: true,
      qty: true,
      itemName: true,
      irmItemId: true,
      customerStockEntryId: true,
      warehouseId: true,
      warehouseName: true,
      warehouseCode: true,
      hasVanSource: true,
      // `code` ONLY — the queue copies it into the scan box (scanCodeFor) and strips it off the
      // snapshotted line name (stripCodePrefix). Deliberately NOT `irmItemSelect`, which also carries
      // id + name for the detail views: reusing that shared slice here would mean widening it for a
      // detail view silently widens every queue load too.
      irmItem: { select: { code: true } },
    },
  },
} satisfies Prisma.JobSelect;
export type GoodsQueueJob = Prisma.JobGetPayload<{ select: typeof goodsQueueSelect }>;

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
export function findActiveForGoodsManagement(warehouseId: string, search?: string): Promise<GoodsQueueJob[]> {
  const candidateOr: Prisma.JobWhereInput[] = [
    { kitLines: { some: { OR: [{ warehouseId }, { lineType: "misc" }] } } },
    { kitLines: { some: { hasVanSource: true } } },
  ];
  // `cancelled` is in the window so the warehouse can still take the kit BACK. Cancelling doesn't
  // return anything, and the job is unreachable from every other flow afterwards, so leaving it out
  // meant the one screen that can scan the stock in could no longer find the job. listQueue then drops
  // the cancelled jobs that never had stock issued, and postIssue keeps issuing shut regardless.
  const where: Prisma.JobWhereInput = {
    deletedAt: null,
    status: { in: ["accepted", "in_progress", "completed", "cancelled"] },
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
  // Projection is EXACTLY what goods-management reads (verified against the service: it never touches
  // job.site, job.project or job.supplier, and kit lines carry warehouseName/warehouseCode as their own
  // snapshot columns, so the warehouse relation is dead weight here too). `withRelations` was pulling
  // all of that for every candidate job — 353 KB and ~384ms per queue load against a remote cluster,
  // versus 23 KB and ~168ms for this.
  //
  // A LEAN projection is only safe while it stays in step with the consumer: if listQueue ever needs
  // another field, add it HERE — the typechecker will say so rather than silently handing back
  // undefined, because this returns its own type and not the full Job row.
  return prisma.job.findMany({ where, select: goodsQueueSelect, orderBy: { createdAt: "desc" } });
}

// --- open-demand read: every active job that may still draw warehouse stock ------------------
// Jobs from assignment through completion (NOT draft / cancelled / rejected) — the service then keeps
// only the ones whose goods aren't fully issued and sums their not-yet-issued kit lines into "open
// demand" per item+warehouse. excludeJobId drops the job currently being edited from the totals.
/**
 * Every active job's kit lines, in the shape `getOpenDemand` reads — and nothing else.
 *
 * This is the widest read in the app: EVERY active job, and it runs on every kit-request approval,
 * every availability check and the demand board. It used to return `withRelations`, so each job also
 * carried its customer, project, site, supplier, engineer and every kit line's IRM item plus the
 * warehouse's full address block — none of which the demand maths touches. `itemName` and
 * `warehouseName` are SNAPSHOT COLUMNS on the kit line, not relations, so they survive the narrowing.
 */
export interface ActiveKitLinesForDemand {
  id: string;
  kitLines: {
    id: string;
    lineType: string;
    qty: number;
    irmItemId: string | null;
    customerStockEntryId: string | null;
    warehouseId: string | null;
    itemName: string;
    warehouseName: string | null;
  }[];
}
export function findActiveWithKitLines(excludeJobId?: string): Promise<ActiveKitLinesForDemand[]> {
  return prisma.job.findMany({
    where: {
      deletedAt: null,
      status: { in: ["assigned", "accepted", "in_progress", "completed"] },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: {
      id: true,
      kitLines: {
        // SAME ordering as withRelations. The demand maths only SUMS, so nothing here depends on it —
        // but leaving it off would make this the one kit-line read in the file with a different order
        // for no stated reason, and the next person to add a first-match or a display to this read
        // would inherit that silently.
        orderBy: { createdAt: "asc" },
        select: {
          id: true, lineType: true, qty: true, irmItemId: true,
          customerStockEntryId: true, warehouseId: true, itemName: true, warehouseName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Ids of every job whose goods can still be out — stock is only issued from `accepted` onward, so the
// earlier statuses can't be holding any and are what keeps this read from degrading into "every job".
//
// This is the overdue read's starting point. Driving from JOBS rather than from JobStockSummary rows
// matters: a summary is created on first issue, but the engineer-transfer attribution path creates it
// through a best-effort `recomputeGoodsStatus` that swallows its own failure, so a job CAN hold an
// unreturned issue with no summary row. Starting from summaries made those jobs invisible; starting
// here keeps them, matching how listQueue treats a missing summary (defaults to open, not excluded).
// Still bounded by work in flight rather than by the movement ledger, which is the point of the change.
//
// `cancelled` is in the list, which is where this DIVERGES from findActiveForGoodsManagement — and it
// has to. That one answers "what work is live?", so a cancelled job rightly drops off the Queue. This
// one answers "whose stock is unaccounted for?", and cancelling is the moment stock is most likely to
// be stranded: `cancelJob` is reachable from accepted/in_progress, has no guard on outstanding stock,
// and the engineer is simply still holding the kit for a job nobody is tracking any more. Mirroring the
// Queue's window here dropped exactly that stock off the chase list and out of the Hub's overdue count.
// `completed` is likewise terminal and already listed, so the cost argument doesn't distinguish the two
// — and cancelled is by far the smaller set.
//
// Listing it here is only worth anything if the chase can END somewhere: cancelJob now moves the
// summary to `awaiting_return` (goodsManagementService.openReturnsOnCancel) and postReturn accepts a
// cancelled job, so the scan-in and the write-off both work. An earlier version of this comment
// asserted that goods-management "doesn't gate on job status" — it does, and that gate was the dead
// end this list used to point at.
export function findGoodsActiveJobIds(): Promise<{ id: string }[]> {
  return prisma.job.findMany({
    where: { deletedAt: null, status: { in: ["accepted", "in_progress", "completed", "cancelled"] } },
    select: { id: true },
  });
}

// Kit-line TYPES for a set of jobs, and nothing else. The overdue read needs to know which lines are
// `misc` so it can leave them out of "is anything still out?" — misc is free-text, never stock-tracked,
// so it can never be returned and would otherwise keep a job overdue forever. Deliberately lean: no
// `withRelations` (customer/site/supplier/engineer joins) for a question that only needs two columns.
export function findKitLineTypesByJobs(jobIds: string[]): Promise<{ id: string; kitLines: { id: string; lineType: string }[] }[]> {
  if (jobIds.length === 0) return Promise.resolve([]);
  return prisma.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, kitLines: { select: { id: true, lineType: true } } },
  });
}

// Jobs assigned to one engineer that may still have stock out with them — the goods-active statuses,
// with kit lines. Powers "how much is this engineer holding against jobs" (the field-stock RETURN flow
// subtracts it so job stock can't be handed back outside the job). Statuses mirror
// findActiveForGoodsManagement — goods are only issued once accepted/in progress; a reconciled or older
// job's movements net to 0 and contribute nothing.
//
// `cancelled` is included, and that is a correctness requirement rather than a nicety. A cancel doesn't
// move a single unit: the engineer walks away still holding the kit. Dropping the status here released
// all of it in one step — the field-stock return flow stopped subtracting it (job stock could be handed
// back outside its job) and kit-request availability began offering the same units to other jobs as
// "on another van". The stock is committed until it is physically returned, not until the paperwork
// says the work is off.
/**
 * The engineer's live kit lines — ONLY the four fields `jobCommittedByEngineer` actually reads.
 *
 * It used to hand back `withRelations`: every job's customer, project, site, supplier, engineer and
 * each kit line's full IRM item and warehouse ADDRESS block. For one engineer with 13 jobs that was
 * 294 KB over the wire to add up quantities, and it runs inside kit-request approval — once per
 * holding engineer — against a remote Atlas cluster where every round trip already costs ~70ms.
 *
 * Keep the WHERE exactly as it is. `cancelled` belongs in the list: those units are still on the van
 * (see job.repository.test), and dropping the status would offer the same stock to another job.
 */
export interface EngineerCommittedKitLines {
  id: string;
  kitLines: { id: string; lineType: string; irmItemId: string | null }[];
}
export function findActiveByEngineerWithKitLines(engineerId: string): Promise<EngineerCommittedKitLines[]> {
  return prisma.job.findMany({
    where: { deletedAt: null, assignedEngineerId: engineerId, status: { in: ["accepted", "in_progress", "completed", "cancelled"] } },
    // Kit lines keep withRelations' ordering for the same reason as findActiveWithKitLines above: the
    // committed tally only sums, but a kit-line read that quietly orders differently from every other
    // one is a trap for whoever extends it.
    select: { id: true, kitLines: { orderBy: { createdAt: "asc" }, select: { id: true, lineType: true, irmItemId: true } } },
    orderBy: { createdAt: "asc" },
  });
}

// --- engineer-scoped reads (engineer portal) -------------------------------------------------
// Jobs assigned to one engineer, filtered + PAGED (an engineer accumulates hundreds of completed
// jobs over time — never return the unbounded set). Scoped on assignedEngineerId so an engineer can
// only ever read their OWN jobs. Search matches job number / name / customer, like the admin list.
export interface EngineerJobFilters {
  status?: string;
  search?: string;
  /**
   * Start of today, for the derived "overdue" status. Supplied by the SERVICE rather than computed
   * here: "what day is it" depends on the company timezone (a settings read), and a repository is a
   * query builder — it holds no business decisions and reads no settings. REQUIRED whenever
   * `status === "overdue"`; see the throw below for why it isn't quietly defaulted.
   */
  overdueBefore?: Date;
}
function buildEngineerWhere(engineerId: string, filters: EngineerJobFilters): Prisma.JobWhereInput {
  const where: Prisma.JobWhereInput = { assignedEngineerId: engineerId, deletedAt: null };
  if (filters.status === "overdue") {
    // "Overdue" is a DERIVED pseudo-status (never stored): an active job whose completion date has
    // passed. The boundary comes from the caller so this shares ONE definition of "start of today"
    // with the dashboard card and the warehouse Due filter — all three read the company timezone.
    // It used to compute a UTC day here, which drifted a day behind for the first hour of every BST
    // day and made this filter disagree with the very card it was written to match.
    // Loud, not lenient. A missing boundary is a WIRING mistake, not user input, and every quiet
    // default lies: an epoch floor reports "no overdue jobs" and a UTC day is wrong for the first
    // hour of each BST day. Both are invisible — an engineer would simply believe they were on top
    // of their work. Throwing surfaces it the moment the call is wrong.
    if (!filters.overdueBefore) throw new Error("buildEngineerWhere: overdueBefore is required for the overdue filter.");
    where.status = { in: ["assigned", "accepted", "in_progress"] };
    where.completionDate = { lt: filters.overdueBefore };
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

/** Active jobs past / approaching their completionDate. Jobs with no completionDate count in neither
 *  bucket — there is nothing to be overdue against.
 *
 *  Day boundaries come from the COMPANY timezone, not UTC: for the first hour of every BST day a
 *  UTC-derived "today" is a day behind, so this card and the warehouse queue both reported yesterday.
 *  They must share `startOfDayIn` — a card reading "3 overdue" above a queue listing 4 is worse than
 *  either being an hour out. Not per-warehouse: a job belongs to no warehouse (only its kit lines do),
 *  so this company-wide count would have none to read. */
export async function dueBreakdown(now: Date, timeZone: string): Promise<{ overdue: number; dueThisWeek: number }> {
  const startToday = startOfDayIn(timeZone, now);
  const in7Days = new Date(startToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const active = { status: { in: [...ACTIVE_JOB_STATUSES] }, deletedAt: null };
  const [overdue, dueThisWeek] = await Promise.all([
    prisma.job.count({ where: { ...active, completionDate: { lt: startToday } } }),
    prisma.job.count({ where: { ...active, completionDate: { gte: startToday, lt: in7Days } } }),
  ]);
  return { overdue, dueThisWeek };
}
