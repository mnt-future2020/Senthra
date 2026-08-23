import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as jobService from "#modules/job/job.service.js";
import * as transferService from "#modules/engineer-transfer/engineer-transfer.service.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import { hireAvailable } from "#modules/purchase-order/rentalHire.allocation.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as goodsManagementService from "#modules/goods-management/goods-management.service.js";
// From the LEAF module, not the service re-export: demand.ts imports repositories only, so pulling it
// in directly keeps this free of the service↔service cycle its own header warns about.
import { getOpenDemand } from "#modules/goods-management/demand.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitAttentionChanged, emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import * as kitRequestRepo from "./job-kit-request.repository.js";
import type { CreateKitRequestData, CreateKitRequestLineData, KitRequestWithLines } from "./job-kit-request.repository.js";
import type { ApproveKitRequestInput, CreateKitRequestInput, DeclineKitRequestInput } from "./job-kit-request.validation.js";

// ---- DTOs ------------------------------------------------------------------------------------

export interface PublicKitRequestLine {
  id: string;
  source: string;
  irmItemId: string | null;
  /** The CATALOGUE item asked for on a `rental` line — never a particular hire. */
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  sku: string | null;
  uom: string | null;
  /** What the ENGINEER asked for. */
  qty: number;
  /** What the reviewer approved: null = in full (and every row predating the trim), 0 = excluded. */
  approvedQty: number | null;
  jobKitLineId: string | null;
  // For customer_stock lines: the warehouse the entry is stored in (where it will be issued from). The
  // planner can't change it — it's shown read-only so the approve modal reveals the pickup location.
  // Null for irm/misc lines. Populated on reads that feed the approve modal (list/getOne).
  warehouseName: string | null;
  warehouseCode: string | null;
  /** customer_stock only: what the entry has free — its quantity net of other jobs' planned demand.
   *  Null for irm/misc, and on reads that don't drive the approve modal. The IRM equivalent comes
   *  from the warehouse picker; consignment has no picker, so it had no figure at all. */
  availableQty: number | null;
  // Where this line was actually sourced (set on approve): "warehouse" | "engineer" | null (misc, or
  // a request approved before per-line sourcing shipped — fall back to the request's fulfillmentMode).
  sourceType: string | null;
  sourceWarehouseId: string | null;
  sourceEngineerId: string | null;
}

export interface PublicKitRequest {
  id: string;
  code: string;
  status: string;
  jobId: string;
  jobNumber: string;
  requestedByEngineerId: string;
  requestedByEngineerName: string;
  requestedByEngineerEmail: string | null;
  reason: string;
  notes: string | null;
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  fulfillmentMode: string | null;
  transferId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PublicKitRequestLine[];
}

export interface PagedKitRequests {
  requests: PublicKitRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// whByEntry: request-LINE id → its pickup location label, resolved by the caller in one batched query
// per pool (see resolveLineWarehouses) so toPublic stays synchronous and free of per-line DB hits.
// Absent map = no location labels (fine for responses that don't drive the approve modal).
function toPublic(
  r: KitRequestWithLines,
  whByEntry?: Map<string, { name: string | null; code: string | null; available: number }>,
): PublicKitRequest {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    jobId: r.jobId,
    jobNumber: r.jobNumber,
    requestedByEngineerId: r.requestedByEngineerId,
    requestedByEngineerName: r.requestedByEngineerName,
    requestedByEngineerEmail: r.requestedByEngineerEmail,
    reason: r.reason,
    notes: r.notes,
    reviewedByUserId: r.reviewedByUserId,
    reviewedByEmail: r.reviewedByEmail,
    reviewedAt: iso(r.reviewedAt),
    decisionNote: r.decisionNote,
    fulfillmentMode: r.fulfillmentMode,
    transferId: r.transferId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: r.lines.map((l) => {
      // Keyed by LINE id — see resolveLineWarehouses. Two pools resolve a location by different
      // means, and an entry-keyed map could only ever describe one of them.
      const wh = whByEntry?.get(l.id);
      return {
        id: l.id,
        source: l.source,
        irmItemId: l.irmItemId,
        rentalItemId: l.rentalItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        sku: l.sku,
        uom: l.uom,
        qty: l.qty,
        approvedQty: l.approvedQty ?? null,
        jobKitLineId: l.jobKitLineId,
        warehouseName: wh?.name ?? null,
        warehouseCode: wh?.code ?? null,
        availableQty: wh?.available ?? null,
        sourceType: l.sourceType,
        sourceWarehouseId: l.sourceWarehouseId,
        sourceEngineerId: l.sourceEngineerId,
      };
    }),
  };
}

// Batch-resolve the pickup location each line will be collected from — one query per pool for all
// lines across all given requests (no N+1).
//
// Keyed by LINE ID rather than by entry id, because two pools answer the question differently: a
// customer_stock line is located by its entry (which IS its warehouse), while an approved rental line
// is located by the depot the reviewer chose (`sourceWarehouseId`). Keying by entry could only ever
// describe the first. IRM/misc lines have no location to resolve here — IRM's is on the kit line the
// approval grows, and misc has none.
async function resolveLineWarehouses(
  requests: KitRequestWithLines[],
): Promise<Map<string, { name: string | null; code: string | null; available: number }>> {
  const allLines = requests.flatMap((r) => r.lines);
  const entryIds = [
    ...new Set(allLines.filter((l) => l.source === "customer_stock" && l.customerStockEntryId).map((l) => l.customerStockEntryId as string)),
  ];
  const rentalWhIds = [
    ...new Set(allLines.filter((l) => l.source === "rental" && l.sourceWarehouseId).map((l) => l.sourceWarehouseId as string)),
  ];

  const out = new Map<string, { name: string | null; code: string | null; available: number }>();

  // Approved rental lines: label the depot they were sourced from. `available` stays 0 — the figure
  // that mattered was the depot's free-on-hire AT REVIEW TIME, and re-deriving it here would show a
  // number that has moved on since the decision was made.
  if (rentalWhIds.length > 0) {
    const labels = await warehouseRepo.findLabelsByIds(rentalWhIds);
    for (const l of allLines) {
      if (l.source !== "rental" || !l.sourceWarehouseId) continue;
      const w = labels.get(l.sourceWarehouseId);
      if (w) out.set(l.id, { name: w.name, code: w.code, available: 0 });
    }
  }

  if (entryIds.length === 0) return out;
  // Netted against other jobs' planned demand, exactly like every other availability figure in the
  // app — the raw entry quantity would offer units already committed elsewhere.
  const [entries, demand] = await Promise.all([
    goodsManagementRepo.findCustomerEntryWarehousesByIds(entryIds),
    getOpenDemand().catch(() => new Map<string, { customerStockEntryId: string | null; demand: number }>()),
  ]);
  const planned = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.customerStockEntryId) continue;
    planned.set(d.customerStockEntryId, (planned.get(d.customerStockEntryId) ?? 0) + d.demand);
  }
  // Customer-stock lines are keyed by LINE id too, so the one map has a single key space.
  const byEntry = new Map<string, { name: string | null; code: string | null; available: number }>();
  for (const [id, e] of entries) {
    byEntry.set(id, { name: e.name, code: e.code, available: Math.max(0, e.quantity - (planned.get(id) ?? 0)) });
  }
  for (const l of allLines) {
    if (l.source !== "customer_stock" || !l.customerStockEntryId) continue;
    const w = byEntry.get(l.customerStockEntryId);
    if (w) out.set(l.id, w);
  }
  return out;
}

function emitUpdate(engineerId: string, jobId: string, data: { id: string; code: string; status: string }): void {
  const payload = { ...data, jobId };
  emitToUser(engineerId, "kit_request:updated", payload);
  emitToRoom(OFFICE_JOBS_ROOM, "kit_request:updated", payload);
  emitAttentionChanged("kit_requests");
}

function isReviewer(actor: AuditActor): boolean {
  const perms = actor.permissions ?? [];
  return actor.type === "admin" || perms.includes("*") || perms.includes("jobs.kit_request.review");
}

// ---- create (field engineer) -----------------------------------------------------------------

export async function create(input: CreateKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const engineerId = actor.id ?? "";
  const job = await jobRepo.findById(input.jobId);
  if (!job) throw notFound("Job not found.");
  if (job.assignedEngineerId !== engineerId) throw forbidden("You can only request kit for a job assigned to you.");
  if (!["accepted", "in_progress"].includes(job.status)) {
    throw conflict("You can request extra kit once the job is accepted and in progress.");
  }
  // Reconciled goods lock the job — approving a kit request grows the kit (a goods write), which the
  // reconciled lock rejects downstream. Block it HERE so the request is never raised on a locked job,
  // instead of failing only when the PM tries to approve it. Mirrors the lock in job.service.
  if ((await goodsManagementService.getGoodsStatus(input.jobId)) === "reconciled") {
    throw conflict("This job's goods have been reconciled and locked — no more kit can be requested.");
  }

  // Resolve fresh item snapshots — the per-line lookups are independent, so run them in parallel
  // (preserving order) rather than one round-trip at a time.
  const lines: CreateKitRequestLineData[] = await Promise.all(
    input.lines.map(async (l): Promise<CreateKitRequestLineData> => {
      if (l.source === "irm") {
        const item = await irmRepo.findById(l.irmItemId!);
        if (!item) throw badRequest(`The IRM item for "${l.itemName}" no longer exists.`);
        if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
        return { source: "irm", irmItemId: item.id, itemName: item.name, sku: item.sku ?? null, uom: item.baseUnit ?? null, qty: l.qty };
      }
      if (l.source === "customer_stock") {
        const entry = await goodsManagementRepo.findCustomerStockEntryById(l.customerStockEntryId!);
        if (!entry) throw badRequest(`The customer stock item for "${l.itemName}" no longer exists.`);
        if (entry.customerId !== job.customerId) throw badRequest(`"${entry.itemName}" doesn't belong to this job's customer.`);
        return { source: "customer_stock", customerStockEntryId: entry.id, itemName: entry.itemName, sku: entry.sku ?? entry.barcode ?? null, uom: entry.uom ?? null, qty: l.qty };
      }
      if (l.source === "rental") {
        const item = await rentalItemRepo.findById(l.rentalItemId!);
        if (!item) throw badRequest(`The rental item for "${l.itemName}" no longer exists.`);
        // Same rule the job kit line applies: a retired hire item stays readable everywhere (live
        // hires still reference it) but must not be planned onto new work.
        if (item.status !== "active") throw badRequest(`"${item.name}" is not active.`);
        // No SKU on a rental master by design; the snapshot carries the code instead, which is what
        // the label is printed from and what the warehouse scans.
        return { source: "rental", rentalItemId: item.id, itemName: item.name, sku: item.code, uom: item.baseUnit ?? null, qty: l.qty };
      }
      return { source: "misc", itemName: l.itemName.trim(), qty: l.qty };
    }),
  );

  const data: CreateKitRequestData = {
    code: "",
    status: "pending",
    jobId: job.id,
    jobNumber: job.jobNumber,
    requestedByEngineerId: engineerId,
    requestedByEngineerName: job.assignedEngineerName ?? "",
    requestedByEngineerEmail: job.assignedEngineerEmail ?? actor.email ?? null,
    reason: input.reason,
    notes: input.notes ?? null,
    createdBy: actor.email ?? null,
  };

  const req = await kitRequestRepo.createKitRequest(data, lines);
  audit.record({ actor, action: "job_kit_request.created", targetType: "job", targetId: job.id, targetLabel: req.code, metadata: { jobNumber: job.jobNumber, lineCount: lines.length } });
  emitUpdate(engineerId, job.id, { id: req.id, code: req.code, status: req.status });
  return toPublic(req);
}

// Which stock-tracked request lines the given engineer can't cover from their van — powers the
// pre-claim transfer holdings check. Labels read `CAT6 (needs 3, holds 1)`.
// `vanQtyByLine` is what is actually being asked of THIS engineer — a split line draws only part of
// its quantity from them, and testing the full line would reject a colleague who can comfortably
// cover the portion requested.
async function findHolderShortages(
  engineerId: string,
  stockLines: KitRequestWithLines["lines"],
  vanQtyByLine?: Map<string, number>,
  approvedQtyByLine?: Map<string, number>,
): Promise<string[]> {
  // Load the engineer's whole van ONCE (two queries in parallel) rather than one round-trip per line —
  // matters on a high-latency DB link where per-line queries serialise.
  // Netted against the holder's OWN job commitments, exactly as holdersByLine does for the picker.
  // Reading the raw balance made this guard laxer than the dialog: a colleague the UI would never
  // offer could still be named directly, and the approval went through — stripping the job those
  // units were being held for.
  const [irmBalances, customerHoldings, committed] = await Promise.all([
    engineerStockRepo.findEngineerBalances(engineerId),
    goodsManagementRepo.findCustomerHoldingsByEngineer(engineerId),
    goodsManagementService.jobCommittedByEngineer(engineerId).catch(() => new Map<string, number>()),
  ]);
  const irmHeld = new Map(irmBalances.map((b) => [b.irmItemId, Math.max(0, b.quantityOnHand - (committed.get(b.irmItemId) ?? 0))]));
  const customerHeld = new Map(customerHoldings.map((h) => [h.customerStockEntryId, h.quantityOnHand]));
  const out: string[] = [];
  for (const l of stockLines) {
    // Rental can never reach here — approve() refuses `sourceType: "engineer"` on a hired line before
    // any holder is checked. Pinned to 0 anyway rather than left to the customer branch, where it
    // would look up `customerHeld.get(undefined)` and report a shortage for the wrong reason.
    const held =
      l.source === "rental" ? 0 : l.source === "irm" ? irmHeld.get(l.irmItemId!) ?? 0 : customerHeld.get(l.customerStockEntryId!) ?? 0;
    const need = vanQtyByLine?.get(l.id) ?? approvedQtyByLine?.get(l.id) ?? l.qty;
    if (held < need) out.push(`${l.itemName} (needs ${need}, holds ${held})`);
  }
  return out;
}

// A nominal home warehouse for a transfer-fulfilled IRM kit line (a van transfer picks no warehouse,
// but the kit line still needs one for returns). Prefer: the item's existing kit-line warehouse on this
// job → the warehouse holding the most of it → any warehouse the job already uses → any active warehouse.
async function deriveHomeWarehouse(irmItemId: string, job: NonNullable<Awaited<ReturnType<typeof jobRepo.findById>>>): Promise<string> {
  const onKit = (job.kitLines ?? []).find((k) => k.irmItemId === irmItemId && k.warehouseId);
  if (onKit?.warehouseId) return onKit.warehouseId;
  const balances = await inventoryRepo.findAllBalances({ irmItemId });
  const top = [...balances].filter((b) => b.quantityOnHand > 0).sort((a, b) => b.quantityOnHand - a.quantityOnHand)[0];
  if (top) return top.warehouseId;
  const jobWh = (job.kitLines ?? []).find((k) => k.warehouseId)?.warehouseId;
  if (jobWh) return jobWh;
  const [any] = await warehouseRepo.findMany({ status: "active" }, 0, 1);
  if (any) return any.id;
  throw conflict("No warehouse available to home this item — add a warehouse or issue from stock instead.");
}

export interface EligibleHolder {
  engineerId: string;
  name: string;
}
// Holders PER REQUEST LINE — sourcing is chosen per line, so this asks "who can supply THIS item?"
// rather than the old "who holds the entire request?" (which returned nobody the moment one item was
// missing, dead-ending the PM even when a colleague could cover most of it). `holders` lists only
// engineers with ENOUGH for that line, so the PM can never pick a short one. An empty list simply
// means no van option for that item; the warehouse remains available.
export interface LineHolders {
  requestLineId: string;
  holders: (EligibleHolder & { available: number })[];
}
export async function holdersByLine(requestId: string): Promise<LineHolders[]> {
  const req = await kitRequestRepo.findById(requestId);
  if (!req) throw notFound("Kit request not found.");
  const job = await jobRepo.findById(req.jobId);
  const exclude = job?.assignedEngineerId ?? ""; // the job's own engineer can't supply themselves
  const stockLines = req.lines.filter((l) => l.source !== "misc");
  if (stockLines.length === 0) return [];
  const perLine = await Promise.all(
    // IRM ONLY. Consignment never reaches an engineer except through a job — a field stock request
    // carries no customerStockEntryId, and the only writes to EngineerCustomerStockHolding are a job
    // issue and a job-scoped transfer — so everything a colleague holds is already committed to their
    // job. There is no spare to offer, and jobCommittedByEngineer deliberately excludes this pool, so
    // the figure couldn't even be netted: the reviewer saw "holds 2" in the same words used for
    // genuinely free IRM stock, and taking it would strip the job relying on it. The engineer's own
    // composer already treats consignment as warehouse-only; this makes the review step agree. A
    // deliberate re-allocation is still possible — as a job transfer, where it is explicit.
    stockLines.map((l) => (l.source === "irm" ? transferRepo.findHoldersForIrm(l.irmItemId!, exclude) : Promise.resolve([]))),
  );

  // `available` off the raw balance counts stock the holder is already holding AGAINST THEIR OWN
  // active job — it has to go back through that job's Close & Reconcile and can never be transferred
  // away. Offering it double-books the same units: the reviewer picks a colleague who looks well
  // stocked, and the transfer strands the job that was relying on them. Netted here so the shortage
  // filter below tests what is genuinely SPARE. IRM only — customer stock is a separate pool with its
  // own holdings, which jobCommittedByEngineer deliberately doesn't cover.
  const holderIds = [...new Set(perLine.flat().map((h) => h.engineerId))];
  const committedByEngineer = new Map<string, Map<string, number>>();
  await Promise.all(
    holderIds.map(async (engineerId) => {
      committedByEngineer.set(engineerId, await goodsManagementService.jobCommittedByEngineer(engineerId).catch(() => new Map<string, number>()));
    }),
  );

  return stockLines.map((l, i) => ({
    requestLineId: l.id,
    holders: perLine[i]
      .map((h) => {
        if (l.source !== "irm" || !l.irmItemId) return h;
        const committed = committedByEngineer.get(h.engineerId)?.get(l.irmItemId) ?? 0;
        return { ...h, available: Math.max(0, h.available - committed) };
      })
      .filter((h) => h.available >= l.qty)
      .map((h) => ({ engineerId: h.engineerId, name: h.name, available: h.available })),
  }));
}

// ---- approve (PM / planner) ------------------------------------------------------------------

export async function approve(id: string, input: ApproveKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const job = await jobRepo.findById(req.jobId);
  if (!job) throw notFound("The job for this request no longer exists.");
  if (!job.assignedEngineerId) throw conflict("This job has no assigned engineer to receive the kit.");

  const irmLines = req.lines.filter((l) => l.source === "irm");
  const rentalLines = req.lines.filter((l) => l.source === "rental");
  const stockLines = req.lines.filter((l) => l.source !== "misc");
  // Every pool that is collected FROM A DEPOT and therefore needs the reviewer to pick one. Customer
  // stock is excluded because its entry already IS a location; misc has none.
  const depotLines = [...irmLines, ...rentalLines];

  // Resolve every line's SOURCE and its pickup/home warehouse BEFORE we claim + grow, so any problem
  // leaves the request pending and nothing is half-applied.
  //
  // Stock for one request rarely sits in one place — the warehouse may hold some items while another
  // engineer's van holds the rest — so the source is chosen PER LINE. `lineSources` expresses that
  // directly; the legacy request-level fulfillmentMode is normalised into the same per-line shape
  // below so there is exactly ONE code path from here on.
  const engineerByLine = new Map<string, string>(); // request-line id → source engineer (transfer lines)
  // How many units of a line come off the van. Absent ⇒ the whole line, which is the non-split case.
  // A PARTIAL split leaves a remainder that must still be collectable, so it also requires a warehouse.
  const vanQtyByLine = new Map<string, number>();
  // The reviewer's TRIM — how many of the requested units are actually approved. Absent ⇒ all of them.
  // The kit grows by this, and any van split has to fit inside it.
  const approvedQtyByLine = new Map<string, number>();
  const whByLine = new Map<string, string>(); // request-line id → pickup/home warehouse (IRM lines)

  const explicit = new Map((input.lineSources ?? []).map((s) => [s.requestLineId, s]));
  if (explicit.size > 0) {
    // Every line must be accounted for — a missing one would silently fall through to no source.
    for (const l of req.lines) {
      if (l.source === "misc") continue; // misc is handed over with the kit; it has no stock source
      if (!explicit.has(l.id)) throw badRequest(`Choose where "${l.itemName}" will be fulfilled from.`);
    }
    for (const [lineId, s] of explicit) {
      const line = req.lines.find((l) => l.id === lineId);
      if (!line) throw badRequest("A chosen source refers to an item that isn't on this request.");
      if (line.source === "misc") continue; // ignore a stray source on a misc line
      // Trim first — every downstream quantity (the kit grow, and the van split's cap) is measured
      // against what was APPROVED, not what was asked for.
      if (s.approvedQty !== undefined) {
        if (s.approvedQty > line.qty) {
          throw badRequest(`"${line.itemName}" — can't approve more than the ${line.qty} requested.`);
        }
        approvedQtyByLine.set(lineId, s.approvedQty);
        // Nothing is collected, transferred or grown for an excluded line, so it needs no source.
        // Demanding a pickup warehouse for an item the planner just refused is asking where to
        // collect something nobody is collecting.
        if (s.approvedQty === 0) continue;
      }
      if (s.sourceType === "engineer") {
        // The UI no longer offers this for consignment, but "the client stopped sending it" is not a
        // guarantee — a stale tab or a direct call would otherwise open a transfer that strips
        // another job's committed stock.
        if (line.source === "rental") {
          // Not a UI restriction — a property of the pool. Custody of a hire is anchored to the depot
          // that took delivery and the provider collects it from there, so it is never transferable
          // engineer-to-engineer. A stale tab or a direct call would otherwise open a transfer of
          // equipment we do not own, against a hire that could then never be handed back.
          throw badRequest(`"${line.itemName}" is a rental item — hired equipment is collected from the depot holding it, not transferred from a van.`);
        }
        if (line.source !== "irm") {
          throw badRequest(`"${line.itemName}" is customer stock — it can only be issued from the warehouse it's stored at, not from a van.`);
        }
        if (!s.engineerId) throw badRequest(`Pick the engineer to transfer "${line.itemName}" from.`);
        engineerByLine.set(lineId, s.engineerId);
        if (s.engineerQty !== undefined) {
          // Against the APPROVED quantity, not the requested one: approving 1 while transferring 2
          // would put more on the kit line than the planner agreed to.
          const cap = approvedQtyByLine.get(lineId) ?? line.qty;
          if (s.engineerQty > cap) {
            throw badRequest(`"${line.itemName}" — can't take more than the ${cap} approved from a van.`);
          }
          // A partial split needs somewhere to collect the rest; without it the remaining units have
          // no pickup location and the engineer turns up short with nothing explaining why.
          if (s.engineerQty < cap && !s.warehouseId) {
            throw badRequest(`"${line.itemName}" — pick a warehouse for the ${cap - s.engineerQty} not coming from the van.`);
          }
          vanQtyByLine.set(lineId, s.engineerQty);
          if (s.warehouseId) whByLine.set(lineId, s.warehouseId);
        }
      } else if (line.source === "irm" || line.source === "rental") {
        // Rental belongs in this arm, not the customer-stock fallthrough below. Left out, a rental line
        // took the "derived downstream" path — but nothing derives a depot for a hire, so the kit line
        // was grown with no warehouse and the engineer was told to collect it from nowhere.
        if (!s.warehouseId) throw badRequest(`Choose a pickup warehouse for "${line.itemName}".`);
        whByLine.set(lineId, s.warehouseId);
      }
      // customer_stock + warehouse source: the warehouse is the entry's own — derived downstream.
    }
  } else if (input.fulfillmentMode === "warehouse_issue") {
    // Legacy shorthand: every IRM item issued from a warehouse the PM picked PER LINE (different items
    // can come from different warehouses). Customer-stock derives from the entry; misc needs none.
    const picked = new Map((input.lineWarehouses ?? []).map((w) => [w.requestLineId, w.warehouseId]));
    for (const l of depotLines) {
      const wh = picked.get(l.id);
      if (!wh) throw badRequest(`Choose a pickup warehouse for "${l.itemName}".`);
      whByLine.set(l.id, wh);
    }
  } else {
    // Legacy shorthand: ALL stock-tracked lines transfer from one engineer's van.
    if (!input.fromEngineerId) throw badRequest("Pick the engineer to transfer stock from.");
    if (stockLines.length === 0) throw badRequest("These are all misc items — they must be issued from a warehouse, not transferred from a van.");
    // …except consignment, which cannot come off a van at all. The per-line `sourceType: "engineer"`
    // path refuses it (see above); this shorthand assigned the engineer to EVERY non-misc line and
    // walked straight past that, opening a transfer that strips stock another job has already been
    // issued. Same rule, same wording — the shape of the request must not change the answer.
    const hired = stockLines.find((l) => l.source === "rental");
    if (hired) {
      throw badRequest(`"${hired.itemName}" is a rental item — hired equipment is collected from the depot holding it, not transferred from a van.`);
    }
    const consignment = stockLines.find((l) => l.source !== "irm");
    if (consignment) {
      throw badRequest(`"${consignment.itemName}" is customer stock — it can only be issued from the warehouse it's stored at, not from a van.`);
    }
    for (const l of stockLines) engineerByLine.set(l.id, input.fromEngineerId);
  }

  // Validate the transfer side ONCE PER SOURCE ENGINEER, against only the lines they actually supply —
  // checking their whole-request coverage would wrongly reject an engineer who covers just their share.
  // The chosen warehouse has to be able to supply its share. A kit line homes at ONE warehouse, so
  // anything approved beyond what that site holds is unissuable and sits on the job as a permanent
  // shortfall. This lived only in the approve dialog, which a stale tab or a direct call bypasses.
  //
  // Measured against the WAREHOUSE portion — a van covering part of the line is not the warehouse's
  // problem — and netted against other jobs' planned demand, so it agrees with the figure the dialog
  // shows and with every other availability surface.
  {
    const wanted = new Map<string, { itemId: string; whId: string; qty: number; name: string }>();
    for (const l of irmLines) {
      if (approvedQtyByLine.get(l.id) === 0) continue; // excluded — nothing to supply
      const whId = whByLine.get(l.id);
      if (!whId || !l.irmItemId) continue;
      if (engineerByLine.has(l.id) && !vanQtyByLine.has(l.id)) continue; // wholly from a van
      const approved = approvedQtyByLine.get(l.id) ?? l.qty;
      const fromWarehouse = approved - (vanQtyByLine.get(l.id) ?? 0);
      if (fromWarehouse > 0) wanted.set(l.id, { itemId: l.irmItemId, whId, qty: fromWarehouse, name: l.itemName });
    }
    if (wanted.size > 0) {
      const items = [...new Set([...wanted.values()].map((w) => w.itemId))];
      const whIds = [...new Set([...wanted.values()].map((w) => w.whId))];
      const [balances, demand] = await Promise.all([
        inventoryRepo.findBalancesByItemsAndWarehouses(items, whIds),
        getOpenDemand().catch(() => new Map<string, { irmItemId: string | null; warehouseId: string | null; demand: number }>()),
      ]);
      const demandByKey = new Map<string, number>();
      for (const d of demand.values()) {
        if (!d.irmItemId || !d.warehouseId) continue;
        const k = `${d.warehouseId}:${d.irmItemId}`;
        demandByKey.set(k, (demandByKey.get(k) ?? 0) + d.demand);
      }
      const freeByKey = new Map<string, number>();
      for (const b of balances) {
        const k = `${b.warehouseId}:${b.irmItemId}`;
        freeByKey.set(k, Math.max(0, b.quantityOnHand - (demandByKey.get(k) ?? 0)));
      }
      for (const w of wanted.values()) {
        const free = freeByKey.get(`${w.whId}:${w.itemId}`) ?? 0;
        if (w.qty > free) {
          throw badRequest(`"${w.name}" — that warehouse has only ${free} free, but ${w.qty} would be issued from it. Lower the quantity, take more from a van, or pick another warehouse.`);
        }
      }
    }
  }

  // The same check for HIRED KIT. A rental has no stock balance, so the depot's capacity is assembled
  // from its LIVE HIRES (`received − returned − issued`) and netted against other jobs' planned demand
  // — the identical figure the composer and the goods scan show. Without it a planner could approve
  // more testers than the depot has hired, and the shortfall would only surface at the scan, after the
  // engineer had already been told the kit was coming.
  {
    const wantByDepot = new Map<string, { itemId: string; whId: string; qty: number; name: string }>();
    for (const l of rentalLines) {
      if (approvedQtyByLine.get(l.id) === 0) continue; // excluded — nothing to supply
      const whId = whByLine.get(l.id);
      if (!whId || !l.rentalItemId) continue;
      const approved = approvedQtyByLine.get(l.id) ?? l.qty;
      if (approved > 0) wantByDepot.set(l.id, { itemId: l.rentalItemId, whId, qty: approved, name: l.itemName });
    }
    if (wantByDepot.size > 0) {
      const items = [...new Set([...wantByDepot.values()].map((w) => w.itemId))];
      const avail = await itemAvailability([], [], undefined, items);
      for (const w of wantByDepot.values()) {
        const depot = avail.rental.get(w.itemId)?.depots.find((d) => d.warehouseId === w.whId);
        const free = depot?.available ?? 0;
        if (w.qty > free) {
          throw badRequest(
            `"${w.name}" — that depot has only ${free} free on hire, but ${w.qty} would be issued from it. Lower the quantity, pick another depot, or raise a purchase request to hire more.`,
          );
        }
      }
    }
  }

  // The same check for CONSIGNMENT. It has no warehouse picker — the entry IS its location, and it
  // can't be van-sourced — so the whole approved quantity comes off the entry. This lived only in the
  // approve dialog, leaving the one source a direct call could still over-approve against.
  {
    const cseLines = req.lines.filter(
      (l) => l.source === "customer_stock" && l.customerStockEntryId && approvedQtyByLine.get(l.id) !== 0,
    );
    if (cseLines.length > 0) {
      const ids = [...new Set(cseLines.map((l) => l.customerStockEntryId!))];
      const [entries, demand] = await Promise.all([
        goodsManagementRepo.findCustomerStockEntriesByIds(ids).catch(() => []),
        getOpenDemand().catch(() => new Map<string, { customerStockEntryId: string | null; demand: number }>()),
      ]);
      // Netted like every other availability figure — the raw entry quantity would offer units
      // another job has already planned against the same consignment.
      const planned = new Map<string, number>();
      for (const d of demand.values()) {
        if (!d.customerStockEntryId) continue;
        planned.set(d.customerStockEntryId, (planned.get(d.customerStockEntryId) ?? 0) + d.demand);
      }
      const freeByEntry = new Map(entries.map((e) => [e.id, Math.max(0, e.quantity - (planned.get(e.id) ?? 0))]));
      for (const l of cseLines) {
        const want = approvedQtyByLine.get(l.id) ?? l.qty;
        const free = freeByEntry.get(l.customerStockEntryId!) ?? 0;
        if (want > free) {
          throw badRequest(`"${l.itemName}" — that customer stock has only ${free} free, but ${want} would be issued. Lower the quantity or exclude the item.`);
        }
      }
    }
  }

  // approvedQty 0 EXCLUDES a line: the planner refuses that item and approves the rest. Excluded
  // lines grow no kit, join no transfer and are exempt from every stock check — nothing is being
  // moved for them.
  const isExcluded = (lineId: string) => approvedQtyByLine.get(lineId) === 0;
  // Excluding everything is a decline wearing an approval's clothes: it would stamp the request
  // "approved" while handing the engineer nothing, and strand the reason in the wrong field.
  if (req.lines.length > 0 && req.lines.every((l) => isExcluded(l.id))) {
    throw badRequest("Every item is excluded — decline the request instead, so the engineer gets the reason.");
  }

  const linesByEngineer = new Map<string, KitRequestWithLines["lines"]>();
  for (const l of stockLines) {
    const eng = engineerByLine.get(l.id);
    if (!eng || isExcluded(l.id)) continue;
    const bucket = linesByEngineer.get(eng);
    if (bucket) bucket.push(l);
    else linesByEngineer.set(eng, [l]);
  }
  for (const [engineerId, lines] of linesByEngineer) {
    if (engineerId === job.assignedEngineerId) throw badRequest("Pick a different engineer — the job's own engineer can't transfer to themselves.");
    await transferService.assertTransferEngineers(engineerId, job.assignedEngineerId);
    const shortages = await findHolderShortages(engineerId, lines, vanQtyByLine, approvedQtyByLine);
    if (shortages.length > 0) throw badRequest(`That engineer doesn't hold enough of: ${shortages.join("; ")}.`);
  }

  // IRM lines coming from a van still need a nominal home warehouse (for returns), same as before.
  // Only lines coming ENTIRELY from a van need a derived home — a split line already carries the
  // warehouse the reviewer picked for its remainder, and overwriting that would send the engineer to
  // collect the leftover units somewhere they were never allocated.
  const vanIrmLines = irmLines.filter((l) => engineerByLine.has(l.id) && !whByLine.has(l.id));
  const homeWarehouses = await Promise.all(vanIrmLines.map((l) => deriveHomeWarehouse(l.irmItemId!, job)));
  vanIrmLines.forEach((l, i) => whByLine.set(l.id, homeWarehouses[i]));

  // Request-level summary for list views + history; the per-line detail is authoritative.
  const usesWarehouse = stockLines.some((l) => !engineerByLine.has(l.id)) || (stockLines.length === 0 && irmLines.length === 0);
  const usesEngineer = linesByEngineer.size > 0;
  const resolvedMode = usesEngineer && usesWarehouse ? "mixed" : usesEngineer ? "engineer_transfer" : "warehouse_issue";

  // Claim atomically — flips pending → approved so two concurrent approvals can't both grow the kit.
  const claimed = await kitRequestRepo.claimPending(id);
  if (claimed === 0) throw conflict("This request was just handled by someone else.");

  try {
    // The steps below are RESUMABLE and each side effect is checkpointed ATOMICALLY: the kit-grow stamps
    // the request lines in the SAME transaction, and the transfer stamps req.transferId in the SAME
    // transaction. So a crash can never leave a grow un-stamped or a transfer un-recorded, and a retry
    // resumes from the failed step — never re-growing the kit or opening a duplicate transfer.

    // 1. Grow the kit — skip if a prior attempt already grew it.
    //
    // ONE stamped line proves the WHOLE grow landed: the stamping runs inside the grow's transaction,
    // so they commit together or not at all. Asking whether EVERY line is stamped would be wrong now
    // that an excluded line is deliberately never stamped — one exclusion and the request could never
    // look grown, so a retry after a crash past this step would grow the kit a second time, and
    // appendKitFromRequest ADDS to the kit line it matches. That inflates the quantity on the job.
    const alreadyGrown = req.lines.some((l) => l.jobKitLineId);
    const includedLines = req.lines.filter((l) => !isExcluded(l.id));
    // Which JobKitLine each request line grew, for the transfer below. Built from the SAME list the
    // ids came from in either branch — resuming reads the stamps off req.lines (which still holds the
    // excluded line), while a fresh grow returns ids positional to includedLines.
    let kitLineIdByRequestLine: Map<string, string | null>;
    if (alreadyGrown) {
      kitLineIdByRequestLine = new Map(req.lines.map((l) => [l.id, l.jobKitLineId]));
    } else {
      // ONE list drives both the grow and the stamping. appendKitFromRequest returns kit-line ids
      // positionally (`ids[i]`), so filtering the grow while stamping from req.lines would shift every
      // line after an exclusion onto its neighbour's kit line — silently attributing a transfer to the
      // wrong item. Derive both from `includedLines` and they cannot drift.
      const appendLines: jobService.KitAppendLine[] = includedLines.map((l) => ({
        source: l.source as "irm" | "customer_stock" | "rental" | "misc",
        irmItemId: l.irmItemId,
        rentalItemId: l.rentalItemId,
        customerStockEntryId: l.customerStockEntryId,
        itemName: l.itemName,
        // The reviewer's trim, falling back to what was requested.
        qty: approvedQtyByLine.get(l.id) ?? l.qty,
        // Rental sits beside irm here: both are collected from a depot the reviewer picked. Customer
        // stock derives its own from the entry, and misc has none.
        warehouseId: l.source === "irm" || l.source === "rental" ? whByLine.get(l.id) ?? null : null,
      }));
      // stampTx runs inside the grow's transaction → grow + stamp are atomic.
      const grown = await jobService.appendKitFromRequest(job.id, appendLines, actor, (tx, ids) =>
        kitRequestRepo.stampLineKitIdsTx(tx, includedLines.map((l, i) => ({ id: l.id, jobKitLineId: ids[i] }))),
      );
      kitLineIdByRequestLine = new Map(includedLines.map((l, i) => [l.id, grown.jobKitLineIds[i]]));
    }

    // 2. Fulfilment — ONE transfer per distinct source engineer (warehouse-sourced lines need no
    // transfer; they're collected via Goods Management once the kit has grown).
    //
    // Resumability: each transfer APPENDS its id to req.transferIds inside its own transaction, and
    // we skip any engineer already recorded there. So a crash midway through a two-engineer approval
    // resumes by opening only the transfer that never got created — never a duplicate.
    // Transfers already opened by a previous attempt, keyed by their SOURCE engineer — the only
    // reliable way to tell which of several transfers survived a crash. Reads from the transfer
    // records themselves rather than inferring from request state.
    const priorIds = [...(req.transferIds ?? []), ...(req.transferId ? [req.transferId] : [])];
    const priorByEngineer = new Map<string, string>();
    for (const t of await transferRepo.findSourcesByIds([...new Set(priorIds)])) {
      priorByEngineer.set(t.fromEngineerId, t.id);
    }
    const transferIds: string[] = [];
    for (const [engineerId, lines] of linesByEngineer) {
      const existing = priorByEngineer.get(engineerId);
      if (existing) { transferIds.push(existing); continue; } // already opened — resume past it
      const transferLines = lines
        .map((l) => ({ l, jobKitLineId: kitLineIdByRequestLine.get(l.id) }))
        .filter((x) => x.l.source !== "misc" && !isExcluded(x.l.id));
      if (transferLines.some((x) => !x.jobKitLineId)) throw conflict("Couldn't link a requested item to its kit line — refresh and try again.");
      const transfer = await transferService.createJobTransfer(
        {
          fromEngineerId: engineerId,
          toEngineerId: job.assignedEngineerId,
          jobId: job.id,
          customerId: job.customerId,
          reason: `Kit request ${req.code} — ${job.jobNumber}`,
          notes: input.decisionNote ?? null,
          lines: transferLines.map((x) => ({
            ownership: x.l.source === "irm" ? "company" : "customer",
            irmItemId: x.l.irmItemId ?? undefined,
            customerStockEntryId: x.l.customerStockEntryId ?? undefined,
            quantity: vanQtyByLine.get(x.l.id) ?? approvedQtyByLine.get(x.l.id) ?? x.l.qty,
            jobKitLineId: x.jobKitLineId ?? undefined,
          })),
        },
        actor,
        // afterCreate runs inside the transfer's transaction → transfer + checkpoint are atomic.
        (tx, tid) => kitRequestRepo.appendTransferIdTx(tx, id, tid),
      );
      transferIds.push(transfer.id);
    }
    // Keep the legacy single-id field meaningful for existing readers (first transfer wins).
    const transferId: string | null = transferIds[0] ?? null;

    // 3. Persist review metadata + the per-line sources (line stamps / transfer ids checkpointed above).
    const finalized = await kitRequestRepo.finalizeApproval(id, {
      reviewedByUserId: actor.id ?? null,
      reviewedByEmail: actor.email ?? null,
      reviewedAt: new Date(),
      decisionNote: input.decisionNote ?? null,
      fulfillmentMode: resolvedMode,
      transferId,
      transferIds,
      lineSources: req.lines.map((l) => ({
        id: l.id,
        sourceType: l.source === "misc" ? null : engineerByLine.has(l.id) ? "engineer" : "warehouse",
        sourceEngineerId: engineerByLine.get(l.id) ?? null,
        // A SPLIT line has both, and both matter afterwards: the engineer needs to know a colleague
        // is handing over part of it AND where to collect the rest. Nulling the warehouse because a
        // van is involved would erase the pickup location for the remainder. Only a line coming
        // wholly from a van has no warehouse of its own (its home is derived for returns).
        sourceWarehouseId: engineerByLine.has(l.id) && !vanQtyByLine.has(l.id) ? null : whByLine.get(l.id) ?? null,
        // Recorded so the request stays a faithful record of ask-versus-granted. An EXCLUDED line
        // grows no kit line at all, so without this the refusal would vanish from the history.
        approvedQty: approvedQtyByLine.get(l.id) ?? null,
      })),
    });

    audit.record({ actor, action: "job_kit_request.approved", targetType: "job", targetId: job.id, targetLabel: req.code, metadata: { fulfillmentMode: resolvedMode, transferIds, jobNumber: job.jobNumber } });
    emitUpdate(req.requestedByEngineerId, job.id, { id, code: req.code, status: "approved" });
    notify(req.requestedByEngineerId, { title: "Kit request approved", body: `Your kit request ${req.code} for ${job.jobNumber} was approved.`, data: { type: "job", jobId: job.id } });
    // Resolve the pickup labels for the response too. The approve reply is what the review card
    // re-renders from, so without this an approved rental line came back with no depot name — the one
    // moment a reviewer most wants to see WHERE they just sent the engineer.
    return toPublic(finalized, await resolveLineWarehouses([finalized]));
  } catch (e) {
    // Roll the status back to pending so the PM can retry. The grow + transfer are checkpointed on the
    // request (stamped line ids / transferId), so the retry RESUMES from the failed step, never repeating
    // the already-committed work — no kit inflation, no duplicate transfer.
    await kitRequestRepo.revertToPending(id).catch(() => {});
    throw e;
  }
}

// ---- decline (PM / planner) ------------------------------------------------------------------

export async function decline(id: string, input: DeclineKitRequestInput, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const count = await kitRequestRepo.declinePending(id, { reviewedByUserId: actor.id ?? null, reviewedByEmail: actor.email ?? null, decisionNote: input.decisionNote ?? null });
  if (count === 0) throw conflict("This request was just handled by someone else.");
  const updated = await kitRequestRepo.findById(id);

  audit.record({ actor, action: "job_kit_request.declined", targetType: "job", targetId: req.jobId, targetLabel: req.code, metadata: { jobNumber: req.jobNumber, decisionNote: input.decisionNote } });
  emitUpdate(req.requestedByEngineerId, req.jobId, { id, code: req.code, status: "declined" });
  notify(req.requestedByEngineerId, { title: "Kit request declined", body: `Your kit request ${req.code} was declined.${input.decisionNote ? ` ${input.decisionNote}` : ""}`, data: { type: "job", jobId: req.jobId } });
  return toPublic(updated!);
}

// Decline everything still waiting on a job that has just been cancelled. A pending request on a dead
// job is a dead end from both ends: Approve can only ever fail (appendKitFromRequest refuses a
// cancelled job), so it sat in the review queue as a permanent 409, while the engineer watched a
// request that was never going to be answered. Cancelling the job IS the answer — record it as one.
// Mirrors transferService.cancelPendingForJob, which withdraws the van handovers for the same reason.
export async function declinePendingForJob(jobId: string, actor: AuditActor): Promise<number> {
  // Pending requests per job are a handful, not a page — take enough that none is silently left behind.
  const { requests } = await kitRequestRepo.listRequests({ jobId, status: "pending", pageSize: 200 });
  let declined = 0;
  for (const req of requests) {
    try {
      const count = await kitRequestRepo.declinePending(req.id, {
        reviewedByUserId: actor.id ?? null,
        reviewedByEmail: actor.email ?? null,
        decisionNote: "The job was cancelled.",
      });
      if (count === 0) continue; // a race — someone reviewed it a moment ago, and their decision stands
      declined += 1;
      audit.record({ actor, action: "job_kit_request.declined", targetType: "job", targetId: req.jobId, targetLabel: req.code, metadata: { jobNumber: req.jobNumber, reason: "job cancelled" } });
      emitUpdate(req.requestedByEngineerId, req.jobId, { id: req.id, code: req.code, status: "declined" });
      notify(req.requestedByEngineerId, { title: "Kit request declined", body: `The job was cancelled — kit request ${req.code} is no longer needed.`, data: { type: "job", jobId: req.jobId } });
    } catch (e) {
      // One request failing must not abandon the rest. Logged, never swallowed: the engineer's queue
      // still shows it as pending, and this line is the only trace of why.
      console.error(`Declining kit request ${req.code} after job ${jobId} was cancelled failed:`, e instanceof Error ? e.message : e);
    }
  }
  return declined;
}

// ---- cancel (requester, while pending) -------------------------------------------------------

export async function cancel(id: string, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (req.status !== "pending") throw conflict(`This request has already been ${req.status}.`);

  const count = await kitRequestRepo.cancelPending(id, actor.id ?? "");
  if (count === 0) throw forbidden("Only the engineer who raised this request can cancel it, and only while it's pending.");
  const updated = await kitRequestRepo.findById(id);

  audit.record({ actor, action: "job_kit_request.cancelled", targetType: "job", targetId: req.jobId, targetLabel: req.code, metadata: { jobNumber: req.jobNumber } });
  emitUpdate(req.requestedByEngineerId, req.jobId, { id, code: req.code, status: "cancelled" });
  return toPublic(updated!);
}

// ---- reads -----------------------------------------------------------------------------------

async function paged(result: { requests: KitRequestWithLines[]; total: number }, page: number, pageSize: number): Promise<PagedKitRequests> {
  const whByEntry = await resolveLineWarehouses(result.requests);
  return {
    requests: result.requests.map((r) => toPublic(r, whByEntry)),
    total: result.total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
  };
}

export async function listMine(engineerId: string, params: { status?: string; jobId?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedKitRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const result = await kitRequestRepo.listRequests({ ...params, engineerId, page, pageSize });
  return paged(result, page, pageSize);
}

export async function listAll(params: { status?: string; jobId?: string; search?: string; sort?: string; page?: number; pageSize?: number }): Promise<PagedKitRequests> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 100);
  const page = Math.max(params.page ?? 1, 1);
  const result = await kitRequestRepo.listRequests({ ...params, page, pageSize });
  return paged(result, page, pageSize);
}

export function countPending(jobId?: string): Promise<number> {
  return kitRequestRepo.countPending(jobId);
}

export async function getOne(id: string, actor: AuditActor): Promise<PublicKitRequest> {
  const req = await kitRequestRepo.findById(id);
  if (!req) throw notFound("Kit request not found.");
  if (!isReviewer(actor) && (actor.id ?? "") !== req.requestedByEngineerId) {
    throw forbidden("You don't have access to this request.");
  }
  return toPublic(req, await resolveLineWarehouses([req]));
}

// Item search for the request composer — lets a field engineer (who has no irm.view) pick a real item
// to request instead of free-typing a name. Read-only, name/code/sku only; capped, active-only. A blank
// term returns nothing (never enumerates a whole catalogue). Two sources, discriminated by `source`:
//   • irm            — the company IRM catalogue (always searched)
//   • customer_stock — the JOB'S OWN customer's active, in-stock consignment entries (only when jobId is
//                      given). Scoped HARD to the job's customerId — never leaks another customer's stock.
export type KitItemOption =
  | {
      source: "irm";
      irmItemId: string;
      code: string;
      name: string;
      sku: string | null;
      uom: string | null;
      /** Total on-hand across ACTIVE warehouses, network-wide. */
      quantityOnHand: number;
      /** Total on OTHER engineers' vans — the job's own engineer is excluded (see searchItems). */
      heldByEngineers: number;
    }
  | {
      source: "rental";
      rentalItemId: string;
      code: string;
      name: string;
      sku: null;
      uom: string | null;
      /**
       * Free units across every LIVE hire of this item, at every depot — `received − returned − issued`
       * summed. A rental item carries no stock level of its own, deliberately, so this is assembled
       * from the hires rather than read from a balance table that does not exist.
       */
      quantityOnHand: number;
      /**
       * ALWAYS 0, and structurally so rather than by omission — the composer renders one availability
       * row for every option and a missing field would read as "unknown" instead of "none".
       *
       * Hired kit is not transferable engineer-to-engineer: custody is anchored to a specific hire at
       * the depot that took delivery, and the provider collects it from there. So a colleague's van is
       * never a source for one, and offering a number here would advertise stock no approval could
       * actually draw on.
       */
      heldByEngineers: 0;
      /** Where those units actually are, soonest-expiring depot first — shown under the option. */
      depots: { warehouseId: string; warehouseName: string | null; available: number }[];
    }
  | {
      source: "customer_stock";
      customerStockEntryId: string;
      name: string;
      sku: string | null;
      uom: string | null;
      /** At the storing warehouse, net of other jobs' planned demand. Consignment has no van figure:
       *  it never reaches an engineer except through a job, so any holding is already committed. */
      qty: number;
      warehouseName: string;
      warehouseCode: string | null;
      serialNumber: string | null;
    };

// ---- availability (shared by the composer's SEARCH and its quantity steppers) -----------------
//
// ONE calculation, because the search decides what may be added and the steppers decide how much —
// and if those two disagreed the engineer would be told an item is available, then handed a cap that
// says otherwise (or worse, no cap at all, which is what the planned-item and cart rows had).
//
// approve() can source a line from exactly two places, so both are counted:
//   • the warehouse network — on-hand net of OTHER jobs' planned demand, floored per warehouse
//   • a COLLEAGUE's van — their holding net of what they owe their own job; never the requester's own
//
// Best-effort throughout: this is advisory metadata. If a lookup fails the engineer must still be able
// to work — approve() re-checks authoritatively before any stock moves, so a missing count here can
// never let a bad issue through.
export interface KitAvailability {
  irm: Map<string, { quantityOnHand: number; heldByEngineers: number }>;
  cse: Map<string, { qty: number }>;
  /** Per rental item: total free units, and which depots they sit at. */
  rental: Map<string, { quantityOnHand: number; depots: { warehouseId: string; warehouseName: string | null; available: number }[] }>;
}

export async function itemAvailability(
  irmItemIds: string[],
  cseIds: string[],
  ownEngineerId?: string,
  rentalItemIds: string[] = [],
): Promise<KitAvailability> {
  const irm = new Map<string, { quantityOnHand: number; heldByEngineers: number }>();
  const cse = new Map<string, { qty: number }>();
  const rental = new Map<string, { quantityOnHand: number; depots: { warehouseId: string; warehouseName: string | null; available: number }[] }>();
  if (irmItemIds.length === 0 && cseIds.length === 0 && rentalItemIds.length === 0) return { irm, cse, rental };

  const [whRows, demand, vanRows, cseRows, hireRows] = await Promise.all([
    irmItemIds.length
      ? (async () => {
          const warehouses = await warehouseRepo.findMany({ status: "active" }, 0, 200);
          return inventoryRepo.findBalancesByItemsAndWarehouses(irmItemIds, warehouses.map((w) => w.id));
        })().catch(() => [])
      : Promise.resolve([]),
    getOpenDemand().catch(() => new Map<string, { irmItemId: string | null; rentalItemId: string | null; customerStockEntryId: string | null; warehouseId: string | null; demand: number }>()),
    irmItemIds.length ? engineerStockRepo.findBalancesByItems(irmItemIds, ownEngineerId).catch(() => []) : Promise.resolve([]),
    cseIds.length ? goodsManagementRepo.findCustomerStockEntriesByIds(cseIds).catch(() => []) : Promise.resolve([]),
    // A hire has no stock row, so "how many can we lend" is assembled from the LIVE hires themselves.
    // `findLiveHiresByRentalItems` composes the module's shared `onHireWhere()` predicate, so this
    // agrees with the badge, the on-hire list and the goods scan rather than restating a weaker rule.
    rentalItemIds.length ? poRepo.findLiveHiresByRentalItems(rentalItemIds).catch(() => []) : Promise.resolve([]),
  ]);

  // Demand, split by pool. IRM is keyed per warehouse so one over-committed site can't eat stock
  // standing at another; a consignment entry lives at exactly one warehouse, so it needs no split.
  const irmDemand = new Map<string, number>();
  const cseDemand = new Map<string, number>();
  for (const d of demand.values()) {
    if (d.irmItemId && d.warehouseId) {
      const k = `${d.warehouseId}:${d.irmItemId}`;
      irmDemand.set(k, (irmDemand.get(k) ?? 0) + d.demand);
    } else if (d.customerStockEntryId) {
      cseDemand.set(d.customerStockEntryId, (cseDemand.get(d.customerStockEntryId) ?? 0) + d.demand);
    }
  }

  for (const id of irmItemIds) irm.set(id, { quantityOnHand: 0, heldByEngineers: 0 });
  for (const b of whRows) {
    const free = Math.max(0, b.quantityOnHand - (irmDemand.get(`${b.warehouseId}:${b.irmItemId}`) ?? 0));
    const e = irm.get(b.irmItemId);
    if (e) e.quantityOnHand += free;
  }

  // A colleague's van only counts for what is SPARE — stock held against their own active job has to
  // return through that job's reconcile. Once per DISTINCT holder, not per balance row.
  const holderIds = [...new Set(vanRows.map((b) => b.engineerId))];
  const committed = new Map<string, Map<string, number>>();
  await Promise.all(
    holderIds.map(async (engineerId) => {
      committed.set(engineerId, await goodsManagementService.jobCommittedByEngineer(engineerId).catch(() => new Map<string, number>()));
    }),
  );
  for (const b of vanRows) {
    const spare = Math.max(0, b.quantityOnHand - (committed.get(b.engineerId)?.get(b.irmItemId) ?? 0));
    const e = irm.get(b.irmItemId);
    if (e) e.heldByEngineers += spare;
  }

  // Consignment is WAREHOUSE-ONLY. A field stock request carries no customerStockEntryId, so this
  // pool never reaches an engineer as free van stock — the only writes to EngineerCustomerStockHolding
  // are a job issue and a job-scoped transfer, meaning every unit an engineer holds is committed to
  // their job. jobCommittedByEngineer deliberately excludes this pool ("never field-returnable"), so
  // there is no commitment figure to net off; counting the raw holding would double-book another
  // job's stock. A planner can still re-allocate it deliberately via holdersByLine at approve time —
  // that is a decision, not availability.
  for (const id of cseIds) cse.set(id, { qty: 0 });
  for (const r of cseRows) {
    const e = cse.get(r.id);
    if (e) e.qty = Math.max(0, r.quantity - (cseDemand.get(r.id) ?? 0));
  }

  // ── Hired kit ────────────────────────────────────────────────────────────────────────────────
  //
  // Netted against planned demand exactly like the other two pools, and per DEPOT rather than in
  // total: a kit line homes at one warehouse, so units standing at a site another job has already
  // committed them at are not free for this one. Summing first and netting after would offer a total
  // no single depot could actually supply.
  for (const id of rentalItemIds) rental.set(id, { quantityOnHand: 0, depots: [] });
  const rentalDemand = new Map<string, number>();
  for (const d of demand.values()) {
    if (!d.rentalItemId || !d.warehouseId) continue;
    const k = `${d.warehouseId}:${d.rentalItemId}`;
    rentalDemand.set(k, (rentalDemand.get(k) ?? 0) + d.demand);
  }
  const byItemDepot = new Map<string, { warehouseId: string; warehouseName: string | null; gross: number }>();
  for (const h of hireRows) {
    const k = `${h.rentalItemId}|${h.warehouseId}`;
    const row = byItemDepot.get(k);
    if (row) row.gross += hireAvailable(h);
    else byItemDepot.set(k, { warehouseId: h.warehouseId, warehouseName: h.warehouseName, gross: hireAvailable(h) });
  }
  for (const [k, row] of byItemDepot) {
    const rentalItemId = k.slice(0, k.indexOf("|"));
    const free = Math.max(0, row.gross - (rentalDemand.get(`${row.warehouseId}:${rentalItemId}`) ?? 0));
    if (free <= 0) continue;
    const e = rental.get(rentalItemId);
    if (!e) continue;
    e.quantityOnHand += free;
    e.depots.push({ warehouseId: row.warehouseId, warehouseName: row.warehouseName, available: free });
  }
  // Fullest depot first — the one a reviewer will pick, and the one most likely to cover the line.
  for (const e of rental.values()) e.depots.sort((a, b) => b.available - a.available);

  return { irm, cse, rental };
}

export async function searchItems(q: string, jobId?: string): Promise<KitItemOption[]> {
  const term = (q ?? "").trim();
  if (term.length < 1) return [];

  const [irmRows, rentalPage] = await Promise.all([
    irmRepo.findMany({ search: term, status: "active" }, 0, 20, "name"),
    // Hired kit is offered here for the same reason IRM is: a depot holding a live hire with spare
    // units can supply it, and asking for one mid-job is an ordinary request. What a rental can NOT be
    // fulfilled from is a colleague's van — see the `heldByEngineers: 0` note on KitItemOption.
    rentalItemRepo.findMany({ search: term, status: "active", page: 1, pageSize: 20 }).catch(() => ({ items: [], total: 0 })),
  ]);
  const rentalRows = rentalPage.items;

  // Customer stock only when we can resolve the job's customer. If the job is missing/soft-deleted, stay
  // resilient and return IRM only rather than failing the whole search.
  let cseRows: Awaited<ReturnType<typeof goodsManagementRepo.searchActiveCustomerStock>> = [];
  let ownEngineerId: string | undefined;
  if (jobId) {
    const job = await jobRepo.findById(jobId);
    ownEngineerId = job?.assignedEngineerId ?? undefined;
    if (job?.customerId) cseRows = await goodsManagementRepo.searchActiveCustomerStock(job.customerId, term, 20);
  }

  // The SAME calculation the quantity steppers use — see itemAvailability. An item with neither a
  // warehouse nor a colleague's van behind it cannot be actioned by any planner: the approve dialog
  // has nothing to pick, its button stays disabled, and the request sits pending forever (JKR-0026).
  // Returned WITH zeroes rather than hidden, so the composer can render it disabled and say why —
  // an item that silently vanishes from a search just gets retyped.
  const avail = await itemAvailability(
    irmRows.map((r) => r.id),
    cseRows.map((r) => r.id),
    ownEngineerId,
    rentalRows.map((r) => r.id),
  );

  const irmOptions: KitItemOption[] = irmRows.map((r) => ({
    source: "irm",
    irmItemId: r.id,
    code: r.code,
    name: r.name,
    sku: r.sku ?? null,
    uom: r.baseUnit ?? null,
    quantityOnHand: avail.irm.get(r.id)?.quantityOnHand ?? 0,
    heldByEngineers: avail.irm.get(r.id)?.heldByEngineers ?? 0,
  }));

  const rentalOptions: KitItemOption[] = rentalRows.map((r) => ({
    source: "rental",
    rentalItemId: r.id,
    code: r.code,
    name: r.name,
    // A rental master carries no SKU by design — its printed label is Code128 of `code`.
    sku: null,
    uom: r.baseUnit ?? null,
    quantityOnHand: avail.rental.get(r.id)?.quantityOnHand ?? 0,
    heldByEngineers: 0,
    depots: avail.rental.get(r.id)?.depots ?? [],
  }));

  const customerOptions: KitItemOption[] = cseRows.map((r) => ({
    source: "customer_stock",
    customerStockEntryId: r.id,
    name: r.itemName,
    sku: r.sku,
    uom: r.uom,
    qty: avail.cse.get(r.id)?.qty ?? 0,
    warehouseName: r.warehouseName,
    warehouseCode: r.warehouseCode,
    serialNumber: r.serialNumber,
  }));

  return [...irmOptions, ...rentalOptions, ...customerOptions];
}

// Availability for a KNOWN set of items — the composer's planned-item rows and its cart, which come
// from the job's kit list rather than from a search. Resolves the job's own engineer so a colleague's
// van is counted but the requester's own never is, then defers to the one shared calculation, so a
// stepper's cap can never disagree with the search result that put the item there.
export async function itemAvailabilityFor(
  jobId: string | undefined,
  irmItemIds: string[],
  cseIds: string[],
  rentalItemIds: string[] = [],
): Promise<{
  irm: Record<string, { quantityOnHand: number; heldByEngineers: number }>;
  cse: Record<string, { qty: number }>;
  rental: Record<string, { quantityOnHand: number; depots: { warehouseId: string; warehouseName: string | null; available: number }[] }>;
}> {
  const ownEngineerId = jobId ? (await jobRepo.findById(jobId))?.assignedEngineerId ?? undefined : undefined;
  const a = await itemAvailability(irmItemIds, cseIds, ownEngineerId, rentalItemIds);
  return { irm: Object.fromEntries(a.irm), cse: Object.fromEntries(a.cse), rental: Object.fromEntries(a.rental) };
}
