import * as goodsOutRepo from "./goods-out.repository.js";
import type { GoodsOutWithRelations, GONLineRow } from "./goods-out.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type { CreateGoodsOutInput, GoodsOutLineInput, UpdateGoodsOutInput } from "./goods-out.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ── Status state machine (forward-only; backend-enforced). Inventory is written ONCE, at Dispatch.
// Dispatched + Cancelled are terminal & immutable. Cancel is only from Draft. ──────────────────────
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["dispatched", "cancelled"],
  dispatched: [],
  cancelled: [],
};
function assertTransition(from: string, to: string): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Can't move a ${from} dispatch to ${to}.`);
  }
}

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────
export interface PublicGoodsOutWarehouse {
  id: string;
  code: string;
  name: string;
}
export interface PublicGoodsOutEngineer {
  id: string;
  name: string;
  email: string | null;
  employeeId: string | null;
}
export interface PublicGoodsOutItem {
  id: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  quantity: number;
  notes: string | null;
  irmItem: { id: string; code: string; name: string; status: string; trackInventory: boolean; trackSerialNumbers: boolean; trackBatchNumbers: boolean } | null;
}
export interface PublicGoodsOut {
  id: string;
  code: string;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string | null;
  warehouse: PublicGoodsOutWarehouse | null;
  engineerId: string;
  engineerName: string;
  engineerEmail: string | null;
  engineerEmployeeId: string | null;
  engineer: PublicGoodsOutEngineer | null;
  status: string;
  dispatchDate: string;
  dispatchReason: string;
  expectedReturnDate: string | null;
  authorizedById: string | null;
  authorizedByName: string | null;
  jobId: string | null;
  projectId: string | null;
  customerStockRequestId: string | null;
  referenceNumber: string | null;
  description: string | null;
  internalNotes: string | null;
  items: PublicGoodsOutItem[];
  totalQuantity: number;
  createdBy: string | null;
  dispatchedBy: string | null;
  dispatchedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicEngineerStockBalance {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string | null;
  quantityOnHand: number;
}

export interface PagedGoodsOut {
  goodsOut: PublicGoodsOut[];
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

function toPublic(g: GoodsOutWithRelations): PublicGoodsOut {
  let totalQuantity = 0;
  for (const i of g.items) totalQuantity += i.quantity;
  const eng = g.engineer;
  return {
    id: g.id,
    code: g.code,
    warehouseId: g.warehouseId,
    warehouseName: g.warehouseName,
    warehouseCode: g.warehouseCode,
    warehouse: g.warehouse ? { id: g.warehouse.id, code: g.warehouse.code, name: g.warehouse.name } : null,
    engineerId: g.engineerId,
    engineerName: g.engineerName,
    engineerEmail: g.engineerEmail,
    engineerEmployeeId: g.engineerEmployeeId,
    engineer: eng ? { id: eng.id, name: `${eng.firstName} ${eng.lastName}`.trim(), email: eng.email, employeeId: eng.employeeId } : null,
    status: g.status ?? "draft",
    dispatchDate: g.dispatchDate.toISOString(),
    dispatchReason: g.dispatchReason,
    expectedReturnDate: iso(g.expectedReturnDate),
    authorizedById: g.authorizedById,
    authorizedByName: g.authorizedByName,
    jobId: g.jobId,
    projectId: g.projectId,
    customerStockRequestId: g.customerStockRequestId,
    referenceNumber: g.referenceNumber,
    description: g.description,
    internalNotes: g.internalNotes,
    items: g.items.map((i) => ({
      id: i.id,
      irmItemId: i.irmItemId,
      itemName: i.itemName,
      sku: i.sku,
      baseUnit: i.baseUnit,
      quantity: i.quantity,
      notes: i.notes,
      irmItem: i.irmItem
        ? {
            id: i.irmItem.id,
            code: i.irmItem.code,
            name: i.irmItem.name,
            status: i.irmItem.status ?? "active",
            trackInventory: i.irmItem.trackInventory,
            trackSerialNumbers: i.irmItem.trackSerialNumbers,
            trackBatchNumbers: i.irmItem.trackBatchNumbers,
          }
        : null,
    })),
    totalQuantity,
    createdBy: g.createdBy,
    dispatchedBy: g.dispatchedBy,
    dispatchedAt: iso(g.dispatchedAt),
    cancelledBy: g.cancelledBy,
    cancelledAt: iso(g.cancelledAt),
    cancelReason: g.cancelReason,
    updatedBy: g.updatedBy,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

// ── Engineer (dispatch recipient) ───────────────────────────────────────────────────────────────
// The recipient must be an ACTIVE staff member whose role grants the field-operations
// stock-holding capability (canHoldStock) — not just any active user. Enforced on both
// create and (re-validated) dispatch, so admins / warehouse managers / finance etc. can
// never end up holding van stock.
async function requireActiveEngineer(engineerId: string) {
  if (!OBJECT_ID_RE.test(engineerId)) throw badRequest("Select an engineer.");
  const u = await userRepo.findById(engineerId);
  if (!u) throw badRequest("Selected engineer no longer exists.");
  if ((u.status ?? "active") !== "active") throw conflict("Selected engineer is inactive and can't receive stock.");
  if (!u.role?.canHoldStock) {
    throw conflict("Selected staff member isn't authorised to hold stock. Assign a field-operations role first.");
  }
  return u;
}

// ── Line building + validation ────────────────────────────────────────────────────────────────
// For each requested line: the item must be an ACTIVE, inventory-tracked IRM item that is NOT
// serial/batch tracked (blocked in v1), and the warehouse must have enough AVAILABLE stock. Snapshots
// the item name / sku / unit onto the row.
async function buildLineRows(items: GoodsOutLineInput[], warehouseId: string, warehouseName: string): Promise<GONLineRow[]> {
  const rows: GONLineRow[] = [];
  for (const line of items) {
    const item = await irmService.requireActiveIrmItem(line.irmItemId);
    if (!item.trackInventory) throw conflict(`${item.name} isn't inventory-tracked and can't be dispatched.`);
    if (item.trackSerialNumbers || item.trackBatchNumbers) {
      throw conflict(`${item.name} is serial- or batch-tracked — those items can't be dispatched yet (serialised dispatch is a future feature).`);
    }
    const balance = await inventoryRepo.findBalancePair(item.id, warehouseId);
    const available = (balance?.quantityOnHand ?? 0) - (balance?.quantityReserved ?? 0);
    if (line.quantity > available) {
      throw conflict(`${item.name}: only ${available} available at ${warehouseName}. Reduce the quantity.`);
    }
    rows.push({ irmItemId: item.id, itemName: item.name, sku: item.sku, baseUnit: item.baseUnit, quantity: line.quantity, notes: trimToNull(line.notes) });
  }
  return rows;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────
export interface ListGoodsOutParams {
  search?: string;
  status?: string;
  warehouse?: string;
  engineer?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listGoodsOut(params: ListGoodsOutParams = {}): Promise<PagedGoodsOut> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = { search: params.search, status: params.status, warehouseId: params.warehouse, engineerId: params.engineer };
  const total = await goodsOutRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await goodsOutRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { goodsOut: rows.map(toPublic), total, page, pageSize, totalPages };
}

export async function getGoodsOut(idOrCode: string): Promise<PublicGoodsOut> {
  const g = OBJECT_ID_RE.test(idOrCode) ? await goodsOutRepo.findById(idOrCode) : await goodsOutRepo.findByCode(idOrCode);
  if (!g) throw notFound("Dispatch not found.");
  return toPublic(g);
}

async function loadOrThrow(id: string): Promise<GoodsOutWithRelations> {
  const g = await goodsOutRepo.findById(id);
  if (!g) throw notFound("Dispatch not found.");
  return g;
}

// ── Create / update (draft only) ────────────────────────────────────────────────────────────
export async function createGoodsOut(input: CreateGoodsOutInput, actor?: AuditActor): Promise<PublicGoodsOut> {
  const wh = await warehouseService.requireActiveWarehouse(input.warehouseId);
  const engineer = await requireActiveEngineer(input.engineerId);
  const rows = await buildLineRows(input.items, wh.id, wh.name);
  const actorEmail = actor?.email ?? null;

  const created = await goodsOutRepo.createWithCode(
    {
      warehouseId: wh.id,
      warehouseName: wh.name,
      warehouseCode: wh.code,
      engineerId: engineer.id,
      engineerName: `${engineer.firstName} ${engineer.lastName}`.trim(),
      engineerEmail: engineer.email,
      engineerEmployeeId: engineer.employeeId,
      status: "draft",
      dispatchDate: new Date(input.dispatchDate),
      dispatchReason: input.dispatchReason,
      expectedReturnDate: input.expectedReturnDate ? new Date(input.expectedReturnDate) : null,
      authorizedById: input.authorizedById ?? null,
      authorizedByName: trimToNull(input.authorizedByName),
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      customerStockRequestId: input.customerStockRequestId ?? null,
      referenceNumber: trimToNull(input.referenceNumber),
      description: trimToNull(input.description),
      internalNotes: trimToNull(input.internalNotes),
      createdBy: actorEmail,
      updatedBy: actorEmail,
    },
    rows,
  );
  audit.record({ actor, action: "goods_out.created", targetType: "goods_out", targetId: created.id, targetLabel: created.code });
  return toPublic(created);
}

export async function updateGoodsOut(id: string, input: UpdateGoodsOutInput, actor?: AuditActor): Promise<PublicGoodsOut> {
  const existing = await goodsOutRepo.findById(id);
  if (!existing) throw notFound("Dispatch not found.");
  if (existing.status !== "draft") throw conflict("Only draft dispatches can be edited.");

  // If the engineer or warehouse changes, re-validate them and refresh the snapshots.
  const headerPatch: Record<string, unknown> = { updatedBy: actor?.email ?? null };
  let warehouseId = existing.warehouseId;
  let warehouseName = existing.warehouseName;
  if (input.warehouseId !== undefined) {
    const wh = await warehouseService.requireActiveWarehouse(input.warehouseId);
    warehouseId = wh.id;
    warehouseName = wh.name;
    headerPatch.warehouseId = wh.id;
    headerPatch.warehouseName = wh.name;
    headerPatch.warehouseCode = wh.code;
  }
  if (input.engineerId !== undefined) {
    const engineer = await requireActiveEngineer(input.engineerId);
    headerPatch.engineerId = engineer.id;
    headerPatch.engineerName = `${engineer.firstName} ${engineer.lastName}`.trim();
    headerPatch.engineerEmail = engineer.email;
    headerPatch.engineerEmployeeId = engineer.employeeId;
  }
  if (input.dispatchDate !== undefined) headerPatch.dispatchDate = new Date(input.dispatchDate);
  if (input.dispatchReason !== undefined) headerPatch.dispatchReason = input.dispatchReason;
  if (input.expectedReturnDate !== undefined) headerPatch.expectedReturnDate = input.expectedReturnDate ? new Date(input.expectedReturnDate) : null;
  if (input.authorizedById !== undefined) headerPatch.authorizedById = input.authorizedById ?? null;
  if (input.authorizedByName !== undefined) headerPatch.authorizedByName = trimToNull(input.authorizedByName);
  if (input.jobId !== undefined) headerPatch.jobId = input.jobId ?? null;
  if (input.projectId !== undefined) headerPatch.projectId = input.projectId ?? null;
  if (input.customerStockRequestId !== undefined) headerPatch.customerStockRequestId = input.customerStockRequestId ?? null;
  if (input.referenceNumber !== undefined) headerPatch.referenceNumber = trimToNull(input.referenceNumber);
  if (input.description !== undefined) headerPatch.description = trimToNull(input.description);
  if (input.internalNotes !== undefined) headerPatch.internalNotes = trimToNull(input.internalNotes);

  let result: GoodsOutWithRelations;
  if (input.items !== undefined) {
    const rows = await buildLineRows(input.items, warehouseId, warehouseName);
    result = await goodsOutRepo.replaceItemsAndChildren(id, rows, headerPatch);
  } else {
    result = await goodsOutRepo.update(id, headerPatch);
  }
  audit.record({ actor, action: "goods_out.updated", targetType: "goods_out", targetId: id, targetLabel: result.code });
  return toPublic(result);
}

// ── Dispatch (the only inventory-writing action) ───────────────────────────────────────────────
export async function dispatchGoodsOut(id: string, actor?: AuditActor): Promise<PublicGoodsOut> {
  const gdn = await loadOrThrow(id);
  assertTransition(gdn.status, "dispatched");
  if (gdn.items.length === 0) throw badRequest("Add at least one item before dispatching.");
  const actorEmail = actor?.email ?? null;

  await withTransaction(async (tx) => {
    // 0) Re-read the GDN INSIDE the tx and revalidate — never trust the pre-tx snapshot. A concurrent
    //    dispatch (status no longer draft) or edit (updatedAt moved) must abort here so inventory can't
    //    be moved twice or from stale lines.
    const fresh = await goodsOutRepo.findByIdTx(tx, id);
    if (!fresh) throw conflict("This dispatch is no longer available. Refresh and try again.");
    if (fresh.status !== "draft") throw conflict("This dispatch was just dispatched or cancelled elsewhere. Refresh and try again.");
    if (fresh.updatedAt.getTime() !== gdn.updatedAt.getTime()) {
      throw conflict("This dispatch was just modified elsewhere. Refresh and try again.");
    }
    if (fresh.items.length === 0) throw conflict("This dispatch has no items.");

    // Re-validate the recipient + warehouse INSIDE the transaction, before any inventory
    // movement. A draft can sit for days; the engineer may have been suspended / lost the
    // stock-holding capability, or the warehouse deactivated, since it was drafted. Either
    // makes the whole dispatch abort (full rollback) instead of crediting stock to an
    // engineer/warehouse that's no longer eligible.
    await requireActiveEngineer(fresh.engineerId);
    await warehouseService.requireActiveWarehouse(fresh.warehouseId);

    for (const line of fresh.items) {
      // Defensive: serial/batch items are blocked at create; never let one slip through to a movement.
      if (line.irmItem && (line.irmItem.trackSerialNumbers || line.irmItem.trackBatchNumbers)) {
        throw conflict(`${line.itemName} is serial/batch-tracked and can't be dispatched.`);
      }
      // 1) Re-check the LIVE warehouse available inside the tx — concurrency-safe oversell guard
      //    (applyOutbound does not itself prevent negative stock).
      const live = await inventoryRepo.findBalancePairTx(tx, line.irmItemId, fresh.warehouseId);
      const available = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
      if (line.quantity > available) {
        throw conflict(`${line.itemName}: only ${available} available — stock changed since this dispatch was drafted.`);
      }
      // 2) Decrement the warehouse (writes a goods_out InventoryTransaction).
      await inventoryService.applyOutbound(tx, {
        irmItemId: line.irmItemId,
        warehouseId: fresh.warehouseId,
        quantity: line.quantity,
        sourceType: "goods_out",
        sourceId: fresh.id,
        sourceCode: fresh.code,
        createdBy: actorEmail,
      });
      // 3) Increment the engineer's holding + append the immutable engineer ledger row.
      const engBal = await goodsOutRepo.upsertEngineerBalanceTx(tx, line.irmItemId, fresh.engineerId, line.quantity);
      await goodsOutRepo.insertEngineerTxnTx(tx, {
        irmItemId: line.irmItemId,
        engineerId: fresh.engineerId,
        quantityDelta: line.quantity,
        type: "goods_out",
        sourceType: "goods_out",
        sourceId: fresh.id,
        sourceCode: fresh.code,
        balanceAfter: engBal.quantityOnHand,
        createdBy: actorEmail,
      });
    }
    // 4) Stamp the GDN dispatched.
    await goodsOutRepo.dispatchTx(tx, id, actorEmail);
  });

  audit.record({ actor, action: "goods_out.dispatched", targetType: "goods_out", targetId: id, targetLabel: gdn.code });
  return getGoodsOut(id);
}

export async function cancelGoodsOut(id: string, reason: string | undefined, actor?: AuditActor): Promise<PublicGoodsOut> {
  const gdn = await loadOrThrow(id);
  assertTransition(gdn.status, "cancelled");
  const updated = await goodsOutRepo.update(id, { status: "cancelled", cancelledBy: actor?.email ?? null, cancelledAt: new Date(), cancelReason: trimToNull(reason) });
  audit.record({ actor, action: "goods_out.cancelled", targetType: "goods_out", targetId: id, targetLabel: updated.code });
  return toPublic(updated);
}

export async function deleteGoodsOut(id: string, actor?: AuditActor): Promise<void> {
  const gdn = await loadOrThrow(id);
  if (gdn.status !== "draft") throw conflict("Only draft dispatches can be deleted.");
  await goodsOutRepo.softDelete(id);
  audit.record({ actor, action: "goods_out.deleted", targetType: "goods_out", targetId: id, targetLabel: gdn.code });
}

// ── Engineer stock (minimal read; the future Van Inventory module owns the full surface) ────────
export async function listEngineerStock(engineerId: string): Promise<PublicEngineerStockBalance[]> {
  if (!OBJECT_ID_RE.test(engineerId)) throw badRequest("Select an engineer.");
  const rows = await goodsOutRepo.findEngineerBalances(engineerId);
  return rows.map((r) => ({ irmItemId: r.irmItemId, itemCode: r.irmItem.code, itemName: r.irmItem.name, baseUnit: r.irmItem.baseUnit, quantityOnHand: r.quantityOnHand }));
}
