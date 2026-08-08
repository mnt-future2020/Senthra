import type { Prisma, InventoryTransaction, StockTransfer } from "@prisma/client";

import * as inventoryRepo from "./inventory.repository.js";
import type { InventoryBalanceWithRelations } from "./inventory.repository.js";
import { computeReorderMath, REORDER_REASON_RANK, type ReorderReason } from "./reorder.js";
import * as poService from "#modules/purchase-order/purchase-order.service.js";
// REPO import (not the service) so purchase-request.service can consume getReorderSuggestions for
// its generate-time revalidation without a service↔service import cycle.
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
// LEAF import (repositories only, never a service) — the same cross-job planned-demand number the
// Warehouse Demand board uses. goods-management.service imports THIS service, so importing its leaf
// (not the service) is what keeps the graph cycle-free.
import { getOpenDemand } from "#modules/goods-management/demand.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as warehouseService from "#modules/warehouse/warehouse.service.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { emitAttentionChanged } from "../../lib/realtime.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type { AddStockInput, AdjustStockInput, CreateTransferInput } from "./inventory.validation.js";
import { csvEscape } from "../../utils/csv.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDateTime } from "#modules/document/document.formatter.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const EXPORT_MAX = 50_000;

// ── Inventory primitives (Goods In writes inbound; future Goods Out writes outbound) ──────────
export interface ApplyMovementInput {
  irmItemId: string;
  warehouseId: string;
  quantity: number; // POSITIVE magnitude
  sourceType: string;
  sourceId: string;
  sourceCode?: string | null;
  createdBy?: string | null;
  notes?: string | null;
}

async function applyDelta(tx: Prisma.TransactionClient, input: ApplyMovementInput, type: string, sign: 1 | -1): Promise<void> {
  if (input.quantity <= 0) return;
  const delta = sign * input.quantity;
  const balance = await inventoryRepo.upsertBalanceTx(tx, input.irmItemId, input.warehouseId, delta);
  await inventoryRepo.insertTransactionTx(tx, {
    irmItemId: input.irmItemId,
    warehouseId: input.warehouseId,
    quantityDelta: delta,
    type,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceCode: input.sourceCode ?? null,
    balanceAfter: balance.quantityOnHand,
    notes: input.notes ?? null,
    createdBy: input.createdBy ?? null,
  });
}

// Inbound (Goods In). Kept unchanged for the Goods In completion transaction.
export function applyInbound(tx: Prisma.TransactionClient, input: ApplyMovementInput): Promise<void> {
  return applyDelta(tx, input, "goods_in", 1);
}
// Outbound seam for FUTURE Goods Out / dispatch (not wired to any endpoint yet).
export function applyOutbound(tx: Prisma.TransactionClient, input: ApplyMovementInput): Promise<void> {
  return applyDelta(tx, input, "goods_out", -1);
}

// Read helpers (smoke + tooling).
export function getBalance(irmItemId: string, warehouseId: string) {
  return inventoryRepo.findBalance(irmItemId, warehouseId);
}
export function listTransactions(filters: { sourceType?: string; sourceId?: string; irmItemId?: string; warehouseId?: string } = {}) {
  return inventoryRepo.listTransactions(filters);
}

// ── DTOs ──────────────────────────────────────────────────────────────────────────────────────
export type InventoryStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface PublicInventoryBalance {
  id: string;
  irmItemId: string;
  warehouseId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  categoryName: string | null;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  /** The DB reservation field. Currently always 0 — the schema marks it "FUTURE (Goods Out /
   *  allocation)". Kept honest rather than repurposed: the reorder projection takes onHand, reserved
   *  and plannedDemand as three separate inputs, so conflating two of them would double-count. */
  reserved: number;
  /** Unissued quantity of active jobs' kit lines homed here — the real commitment against this row. */
  plannedDemand: number;
  /** What is genuinely free to commit: onHand − reserved − plannedDemand, floored at 0. */
  available: number;
  reorderLevel: number | null;
  unitCostPence: number;
  valuePence: number;
  value: number;
  currency: string;
  status: InventoryStatus;
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  lastMovementAt: string;
}

export interface PublicInventoryDetail extends PublicInventoryBalance {
  incoming: number;
  outgoing: number;
}

export interface PublicInventoryTransaction {
  id: string;
  date: string;
  type: string;
  quantityDelta: number;
  balanceAfter: number;
  warehouseName: string;
  reference: string | null;
  notes: string | null;
  createdBy: string | null;
}

export interface PublicPurchaseHistoryRow {
  grnCode: string;
  poCode: string | null;
  supplierName: string | null;
  receivedQuantity: number;
  receivedDate: string;
}

export interface PublicStockTransfer {
  id: string;
  code: string;
  irmItemId: string;
  itemName: string;
  sku: string | null;
  fromWarehouseId: string;
  fromWarehouseName: string;
  fromWarehouseCode: string | null;
  toWarehouseId: string;
  toWarehouseName: string;
  toWarehouseCode: string | null;
  quantity: number;
  movementDate: string;
  status: string;
  referenceNumber: string | null;
  description: string | null;
  internalNotes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface PublicStockAdjustment {
  id: string;
  code: string;
  warehouseId: string;
  warehouseName: string;
  irmItemId: string;
  itemName: string;
  quantity: number;
  balanceAfter: number;
  reason: string;
  movementDate: string;
  referenceNumber: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.trunc(n), lo), hi);

function statusOf(onHand: number, reorderLevel: number | null): InventoryStatus {
  if (onHand === 0) return "out_of_stock";
  if (onHand <= (reorderLevel ?? 0)) return "low_stock";
  return "in_stock";
}

function toBalanceDTO(b: InventoryBalanceWithRelations, plannedDemand = 0): PublicInventoryBalance {
  const onHand = b.quantityOnHand;
  const reserved = b.quantityReserved;
  const unitCostPence = b.irmItem.standardCostPence ?? 0;
  const valuePence = onHand * unitCostPence;
  return {
    id: b.id,
    irmItemId: b.irmItemId,
    warehouseId: b.warehouseId,
    itemCode: b.irmItem.code,
    itemName: b.irmItem.name,
    sku: b.irmItem.sku,
    baseUnit: b.irmItem.baseUnit,
    categoryName: b.irmItem.irmCategory?.name ?? null,
    warehouseName: b.warehouse.name,
    warehouseCode: b.warehouse.code,
    onHand,
    reserved,
    plannedDemand,
    // Server-authoritative, and floored: demand can exceed stock, and a negative Available helps
    // nobody read a table. Before this, `reserved` was the only deduction — and it is permanently 0 —
    // so an item with every unit planned onto a job rendered as fully available.
    available: Math.max(0, onHand - reserved - plannedDemand),
    reorderLevel: b.irmItem.reorderLevel,
    unitCostPence,
    valuePence,
    value: valuePence / 100,
    currency: b.irmItem.currency ?? "GBP",
    status: statusOf(onHand, b.irmItem.reorderLevel),
    trackSerialNumbers: b.irmItem.trackSerialNumbers,
    trackBatchNumbers: b.irmItem.trackBatchNumbers,
    lastMovementAt: b.updatedAt.toISOString(), // the balance only changes on a movement
  };
}

function toTransferDTO(t: StockTransfer): PublicStockTransfer {
  return {
    id: t.id,
    code: t.code,
    irmItemId: t.irmItemId,
    itemName: t.itemName,
    sku: t.sku,
    fromWarehouseId: t.fromWarehouseId,
    fromWarehouseName: t.fromWarehouseName,
    fromWarehouseCode: t.fromWarehouseCode,
    toWarehouseId: t.toWarehouseId,
    toWarehouseName: t.toWarehouseName,
    toWarehouseCode: t.toWarehouseCode,
    quantity: t.quantity,
    movementDate: t.movementDate.toISOString(),
    status: t.status ?? "completed",
    referenceNumber: t.referenceNumber,
    description: t.description,
    internalNotes: t.internalNotes,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
  };
}

// ── Inventory list (search / filters / status / pagination / total value) ──────────────────────
export interface ListInventoryParams {
  search?: string;
  warehouse?: string;
  irmItem?: string; // exact item id — restricts the result to that item's per-warehouse balances
  category?: string;
  status?: string; // in_stock | low_stock | out_of_stock
  page?: number;
  pageSize?: number;
}

export interface PagedInventory {
  inventory: PublicInventoryBalance[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totalValuePence: number;
  totalValue: number;
}

// All filtered balance DTOs (warehouse/category/search at the DB; status computed in-service because
// `onHand ≤ irmItem.reorderLevel` is a cross-document comparison Mongo can't express in a `where`).
// Bounded by items×warehouses; the result is paginated/serialised by the callers.
async function filteredBalanceDTOs(params: ListInventoryParams, actor?: AuditActor): Promise<PublicInventoryBalance[]> {
  const rows = await inventoryRepo.findAllBalances({
    search: params.search?.trim() || undefined,
    warehouseId: params.warehouse,
    irmItemId: params.irmItem,
    irmCategoryId: params.category,
    warehouseIds: warehouseScopeFilter(actor),
  });
  const status = params.status && ["in_stock", "low_stock", "out_of_stock"].includes(params.status) ? (params.status as InventoryStatus) : undefined;
  const planned = await plannedDemandByKey();
  const dtos = rows.map((b) => toBalanceDTO(b, planned.get(`${b.irmItemId}|${b.warehouseId}`) ?? 0));
  return status ? dtos.filter((d) => d.status === status) : dtos;
}

// Planned demand keyed `irmItemId|warehouseId`.
//
// Read live on every call, NOT memoised. A short TTL was tried and removed: this figure is the one
// deciding whether an item reads as available, so serving a stale one is the same class of lie the
// permanently-zero `reserved` column already was — and the window would sit exactly where a planner
// adds a kit line then checks stock. The reorder summary below does memoise, but its maths is far
// heavier (PO + PRF lookups on top of this) and it answers "should we buy more?", where seconds of
// lag cost nothing. If profiling ever says otherwise, memoise deliberately with an invalidation hook
// rather than a blind TTL.
async function plannedDemandByKey(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    for (const d of (await getOpenDemand()).values()) {
      if (!d.irmItemId || !d.warehouseId) continue; // customer consignment isn't an InventoryBalance row
      const k = `${d.irmItemId}|${d.warehouseId}`;
      out.set(k, (out.get(k) ?? 0) + d.demand);
    }
  } catch {
    return out; // advisory — a failed lookup must not break the inventory list
  }
  return out;
}

export async function listInventory(params: ListInventoryParams = {}, actor?: AuditActor): Promise<PagedInventory> {
  const pageSize = clamp(params.pageSize ?? 20, 1, 100);
  const all = await filteredBalanceDTOs(params, actor);
  const total = all.length;
  const totalValuePence = all.reduce((s, d) => s + d.valuePence, 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(params.page ?? 1, 1, totalPages);
  const inventory = all.slice((page - 1) * pageSize, page * pageSize);
  return { inventory, total, page, pageSize, totalPages, totalValuePence, totalValue: totalValuePence / 100 };
}

async function loadBalanceOrThrow(balanceId: string): Promise<InventoryBalanceWithRelations> {
  const b = OBJECT_ID_RE.test(balanceId) ? await inventoryRepo.findBalanceById(balanceId) : null;
  if (!b) throw notFound("Inventory record not found.");
  return b;
}

export async function getInventory(balanceId: string, actor?: AuditActor): Promise<PublicInventoryDetail> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  // Same demand netting as the list — the detail card is the same row opened up, and two screens
  // disagreeing about one item's availability is the whole problem this fixes.
  const dto = toBalanceDTO(b, (await plannedDemandByKey()).get(`${b.irmItemId}|${b.warehouseId}`) ?? 0);
  const incoming = await poService.incomingForItemWarehouse(b.irmItemId, b.warehouseId);
  return { ...dto, incoming, outgoing: b.quantityReserved };
}

// ── Reorder workbench (suggestions read) ──────────────────────────────────────────────────────
// Per Item × Warehouse: what should be bought, netted against reservations, incoming open POs and
// open PRFs. Only pairs with an existing InventoryBalance are evaluated (no cartesian noise), only
// ACTIVE, inventory-tracked items, and only rows that are at least physically low. Actionable rows
// (covered=false) carry a suggested qty; "covered" rows (physically low but already covered by the
// pipeline) are returned too for the workbench's optional "show covered" view. Sorted worst-first:
// actionable before covered, critical before the rest, then by reason.
export interface PublicReorderSuggestion {
  irmItemId: string;
  itemCode: string;
  itemName: string;
  sku: string | null;
  baseUnit: string | null;
  categoryId: string | null;
  categoryName: string | null;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  openPrf: number;
  plannedDemand: number;
  projected: number;
  reorderLevel: number | null;
  target: number;
  packSize: number | null;
  suggestedQty: number;
  reason: ReorderReason;
  covered: boolean;
  critical: boolean;
  unitCostPence: number;
  // Transfer-eligibility flags for the workbench's "Create Transfer" shortcut (the move endpoint
  // rejects serial/batch-tracked items, so the button hides for them).
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  primarySupplier: { id: string; name: string; status: string; leadTimeDays: number | null } | null;
}

export interface ReorderSuggestionsResult {
  suggestions: PublicReorderSuggestion[];
  calculatedAt: string;
}

export async function getReorderSuggestions(actor?: AuditActor): Promise<ReorderSuggestionsResult> {
  const [balances, incomingMap, openPrfMap, demandMap] = await Promise.all([
    inventoryRepo.findAllBalances({ warehouseIds: warehouseScopeFilter(actor), reorderManagedOnly: true }),
    poService.incomingByItemWarehouse(),
    prfRepo.openQuantitiesByItemWarehouse(),
    getOpenDemand(),
  ]);
  // Planned job demand (unissued kit remainders) per item|warehouse — irm entries only (customer-stock
  // demand draws consignment, not company inventory).
  const plannedByKey = new Map<string, number>();
  for (const d of demandMap.values()) {
    if (!d.irmItemId || !d.warehouseId) continue;
    const key = `${d.irmItemId}|${d.warehouseId}`;
    plannedByKey.set(key, (plannedByKey.get(key) ?? 0) + d.demand);
  }

  type Draft = Omit<PublicReorderSuggestion, "primarySupplier">;
  const drafts: Draft[] = [];
  for (const b of balances) {
    // Never suggest buying items that aren't stock-managed or are inactive in the catalogue.
    if (!b.irmItem.trackInventory || (b.irmItem.status ?? "active") !== "active") continue;
    const key = `${b.irmItemId}|${b.warehouseId}`;
    const math = computeReorderMath({
      onHand: b.quantityOnHand,
      reserved: b.quantityReserved,
      incoming: incomingMap.get(key) ?? 0,
      openPrf: openPrfMap.get(key) ?? 0,
      plannedDemand: plannedByKey.get(key) ?? 0,
      reorderLevel: b.irmItem.reorderLevel,
      criticalLevel: b.irmItem.criticalLevel,
      maximumStock: b.irmItem.maximumStock,
      packSize: b.irmItem.packSize,
    });
    if (!math) continue;
    drafts.push({
      irmItemId: b.irmItemId,
      itemCode: b.irmItem.code,
      itemName: b.irmItem.name,
      sku: b.irmItem.sku,
      baseUnit: b.irmItem.baseUnit,
      categoryId: b.irmItem.irmCategory?.id ?? null,
      categoryName: b.irmItem.irmCategory?.name ?? null,
      warehouseId: b.warehouseId,
      warehouseName: b.warehouse.name,
      warehouseCode: b.warehouse.code,
      onHand: b.quantityOnHand,
      reserved: b.quantityReserved,
      available: math.available,
      incoming: incomingMap.get(key) ?? 0,
      openPrf: openPrfMap.get(key) ?? 0,
      plannedDemand: plannedByKey.get(key) ?? 0,
      projected: math.projected,
      reorderLevel: b.irmItem.reorderLevel,
      target: math.target,
      packSize: b.irmItem.packSize,
      suggestedQty: math.suggestedQty,
      reason: math.reason,
      covered: math.covered,
      critical: math.critical,
      unitCostPence: b.irmItem.standardCostPence ?? 0,
      trackSerialNumbers: b.irmItem.trackSerialNumbers,
      trackBatchNumbers: b.irmItem.trackBatchNumbers,
    });
  }

  // Primary suppliers — fetched only for the surfaced items, in one query.
  const supplierMap = await irmService.primarySuppliersForItems([...new Set(drafts.map((d) => d.irmItemId))]);
  const rank = (b: boolean) => (b ? 0 : 1); // true sorts first
  const suggestions: PublicReorderSuggestion[] = drafts
    .map((d) => ({ ...d, primarySupplier: supplierMap.get(d.irmItemId) ?? null }))
    .sort(
      (a, b) =>
        rank(!a.covered) - rank(!b.covered) || // actionable rows before covered (informational) rows
        rank(a.critical) - rank(b.critical) || // then critical first
        REORDER_REASON_RANK[a.reason] - REORDER_REASON_RANK[b.reason] ||
        a.warehouseName.localeCompare(b.warehouseName) ||
        a.itemName.localeCompare(b.itemName),
    );
  return { suggestions, calculatedAt: new Date().toISOString() };
}

// ── Reorder SUMMARY (dashboard card) ───────────────────────────────────────────────────────────
// The dashboard needs three counts, but deriving them requires the full suggestion maths: four
// aggregate reads (all in-scope balances + every open PO line + every open PRF line + all active-job
// kit demand) and an in-memory pass over the result. That cost is fine for the workbench — an
// operator opens it deliberately — but the dashboard is fetched on EVERY page load by every user
// holding inventory.view, which turns a routine GET into a repeated full-catalogue aggregation that
// gets worse as the catalogue grows. Every other card in dashboard.service is a cheap repo count;
// this one was the outlier.
//
// A short TTL memo, keyed by the caller's warehouse scope (the only input the maths depends on),
// collapses that to one computation per window regardless of how many dashboards are open. The card
// is a pulse figure like the counts beside it, so seconds of staleness are immaterial.
//
// The workbench read and the generate-time revalidation deliberately do NOT go through here — both
// call getReorderSuggestions directly and stay live, because generate must re-net against PRFs
// raised seconds ago.
const REORDER_SUMMARY_TTL_MS = 30_000;

export interface ReorderSummary {
  count: number;
  criticalCount: number;
  supplierGaps: number;
}

const reorderSummaryCache = new Map<string, { at: number; value: ReorderSummary }>();

// Exported for tests and for any future write path that wants the card to refresh immediately.
export function invalidateReorderSummary(): void {
  reorderSummaryCache.clear();
}

export async function getReorderSummary(actor?: AuditActor): Promise<ReorderSummary> {
  const scope = warehouseScopeFilter(actor);
  // undefined scope = unrestricted; otherwise the sorted id set IS the cache identity, so two users
  // with the same assignments share one computation and a user with different assignments never
  // reads another scope's numbers.
  const key = scope === undefined ? "*" : `w:${[...scope].sort().join(",")}`;
  const now = Date.now();
  const hit = reorderSummaryCache.get(key);
  if (hit && now - hit.at < REORDER_SUMMARY_TTL_MS) return hit.value;

  const { suggestions } = await getReorderSuggestions(actor);
  const actionable = suggestions.filter((s) => !s.covered);
  const value: ReorderSummary = {
    count: actionable.length,
    criticalCount: actionable.filter((s) => s.critical).length,
    supplierGaps: actionable.filter((s) => !s.primarySupplier || s.primarySupplier.status !== "active").length,
  };
  // Distinct scope keys are bounded by the number of distinct warehouse-assignment sets (small), but
  // drop expired entries so a long-lived process can't accumulate keys for roles that no longer exist.
  for (const [k, v] of reorderSummaryCache) if (now - v.at >= REORDER_SUMMARY_TTL_MS) reorderSummaryCache.delete(k);
  reorderSummaryCache.set(key, { at: now, value });
  return value;
}

export interface PagedTransactions {
  transactions: PublicInventoryTransaction[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listInventoryTransactions(balanceId: string, page = 1, pageSize = 20, actor?: AuditActor): Promise<PagedTransactions> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  const size = clamp(pageSize, 1, 100);
  const total = await inventoryRepo.countTransactions(b.irmItemId, b.warehouseId);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = clamp(page, 1, totalPages);
  const rows = await inventoryRepo.findTransactions(b.irmItemId, b.warehouseId, (p - 1) * size, size);
  const toTx = (t: InventoryTransaction): PublicInventoryTransaction => ({
    id: t.id,
    date: t.createdAt.toISOString(),
    type: t.type,
    quantityDelta: t.quantityDelta,
    balanceAfter: t.balanceAfter,
    warehouseName: b.warehouse.name,
    reference: t.sourceCode,
    notes: t.notes,
    createdBy: t.createdBy,
  });
  return { transactions: rows.map(toTx), total, page: p, pageSize: size, totalPages };
}

export async function listPurchaseHistory(balanceId: string, actor?: AuditActor): Promise<PublicPurchaseHistoryRow[]> {
  const b = await loadBalanceOrThrow(balanceId);
  assertWarehouseAccess(actor, b.warehouseId);
  const rows = await grnRepo.receivedHistoryForItemWarehouse(b.irmItemId, b.warehouseId);
  return rows.map((r) => ({
    grnCode: r.goodsReceipt.code,
    poCode: r.goodsReceipt.poCode,
    supplierName: r.goodsReceipt.supplierName,
    receivedQuantity: r.receivedQuantity,
    receivedDate: r.goodsReceipt.receivedDate.toISOString(),
  }));
}

export interface AvailabilityResult {
  irmItemId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  available: number;
}
export async function getAvailability(irmItemId: string, warehouseId: string, actor?: AuditActor): Promise<AvailabilityResult> {
  if (!OBJECT_ID_RE.test(irmItemId) || !OBJECT_ID_RE.test(warehouseId)) throw badRequest("Select an item and warehouse.");
  assertWarehouseAccess(actor, warehouseId);
  const b = await inventoryRepo.findBalancePair(irmItemId, warehouseId);
  const onHand = b?.quantityOnHand ?? 0;
  const reserved = b?.quantityReserved ?? 0;
  return { irmItemId, warehouseId, onHand, reserved, available: onHand - reserved };
}

// ── Stock transfer (warehouse → warehouse, atomic) ─────────────────────────────────────────────
export async function transferStock(input: CreateTransferInput, actor?: AuditActor): Promise<PublicStockTransfer> {
  if (input.fromWarehouseId === input.toWarehouseId) throw badRequest("Source and destination warehouses must be different.");
  if (input.quantity <= 0) throw badRequest("Quantity must be greater than zero.");

  const fromWh = await warehouseService.requireActiveWarehouse(input.fromWarehouseId);
  const toWh = await warehouseService.requireActiveWarehouse(input.toWarehouseId);
  // A scoped user must own BOTH ends of the move (assert on the resolved canonical ids).
  assertWarehouseAccess(actor, fromWh.id);
  assertWarehouseAccess(actor, toWh.id);

  const source = await inventoryRepo.findBalancePairWithRelations(input.irmItemId, input.fromWarehouseId);
  if (!source) throw conflict("There is no stock of this item at the source warehouse.");
  const item = source.irmItem;
  if (item.trackSerialNumbers || item.trackBatchNumbers) {
    throw conflict("Serial-tracked and batch-tracked items can't be transferred yet — serial-level transfer is a future feature.");
  }
  // Stock a job has already PLANNED at the source can't be moved away — the kit line still points
  // here, so the shortfall would surface only at the scan gun, with the engineer already at the
  // counter. `quantityReserved` never covered this: the schema marks it "FUTURE … 0 now", so this
  // check was raw on-hand. Blocked rather than warned because a transfer is a deliberate action with
  // an operator-controlled quantity — "3 of 5 are planned" is something they can act on. Rebalancing
  // committed units is still possible; the planner re-homes the kit line first, which is the step
  // that keeps the job honest.
  const plannedHere = [...(await getOpenDemand()).values()]
    .filter((d) => d.irmItemId === input.irmItemId && d.warehouseId === fromWh.id)
    .reduce((n, d) => n + d.demand, 0);
  const available = Math.max(0, source.quantityOnHand - source.quantityReserved - plannedHere);
  if (input.quantity > available) {
    throw conflict(
      plannedHere > 0
        ? `Only ${available} available to move at ${fromWh.name} — ${plannedHere} of the ${source.quantityOnHand} on hand are planned for active jobs there. Reduce the quantity, or re-home those kit lines first.`
        : `Only ${available} available at ${fromWh.name}. Reduce the quantity.`,
    );
  }

  const actorEmail = actor?.email ?? null;
  const transfer = await inventoryRepo.createTransferWithCode(
    {
      irmItemId: input.irmItemId,
      itemName: item.name,
      sku: item.sku,
      fromWarehouseId: input.fromWarehouseId,
      fromWarehouseName: fromWh.name,
      fromWarehouseCode: fromWh.code,
      toWarehouseId: input.toWarehouseId,
      toWarehouseName: toWh.name,
      toWarehouseCode: toWh.code,
      quantity: input.quantity,
      movementDate: new Date(input.movementDate),
      status: "completed",
      referenceNumber: trimToNull(input.referenceNumber),
      description: trimToNull(input.description),
      internalNotes: trimToNull(input.internalNotes),
      createdBy: actorEmail,
    },
    { irmItemId: input.irmItemId, fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId, quantity: input.quantity, createdBy: actorEmail },
    // Concurrency backstop: re-read the LIVE source balance inside the transaction and re-check
    // available. Throwing here rolls back the whole transfer (balances + ledger + record).
    async (tx) => {
      const live = await inventoryRepo.findBalancePairTx(tx, input.irmItemId, input.fromWarehouseId);
      const liveAvail = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
      if (input.quantity > liveAvail) throw conflict("Source stock changed — not enough available to complete the transfer.");
    },
  );
  // Audit AFTER commit, fire-and-forget: a logging failure must never roll back a real stock move.
  audit.record({ actor, action: "inventory.transfer", targetType: "stock_transfer", targetId: transfer.id, targetLabel: transfer.code });
  emitAttentionChanged("inventory");
  return toTransferDTO(transfer);
}

// ── Manual stock add (existing / opening / legacy stock straight into a warehouse) ─────────────
// Inbound-only. Validates the item is active + inventory-tracked (and not serial/batch-tracked —
// those must come through Goods In), then atomically creates an ADJ-#### header, increments the
// (item, warehouse) balance and writes ONE "manual_add" ledger row.
export async function addStock(input: AddStockInput, actor?: AuditActor): Promise<PublicStockAdjustment> {
  if (input.quantity <= 0) throw badRequest("Quantity must be greater than zero.");

  const item = await irmService.requireActiveIrmItem(input.irmItemId);
  if (item.trackInventory === false) throw badRequest(`${item.name} isn't inventory-tracked, so stock can't be added for it.`);
  if (item.trackSerialNumbers || item.trackBatchNumbers) {
    throw conflict("Serial- and batch-tracked items can't be added this way yet — receive them via Goods In.");
  }
  const wh = await warehouseService.requireActiveWarehouse(input.warehouseId);
  assertWarehouseAccess(actor, wh.id);
  const actorEmail = actor?.email ?? null;
  const notes = trimToNull(input.notes);

  const { adjustment, balanceAfter } = await inventoryRepo.createStockAdjustmentWithCode(
    {
      warehouseId: input.warehouseId,
      reason: input.reason,
      movementDate: new Date(input.movementDate),
      referenceNumber: trimToNull(input.referenceNumber),
      notes,
      createdBy: actorEmail,
    },
    { irmItemId: input.irmItemId, warehouseId: input.warehouseId, quantity: input.quantity, notes, createdBy: actorEmail },
  );

  // Audit AFTER commit, fire-and-forget — a logging failure must never roll back a real stock add.
  audit.record({
    actor,
    action: "inventory.stock_added",
    targetType: "stock_adjustment",
    targetId: adjustment.id,
    targetLabel: `${adjustment.code} · +${input.quantity} ${item.name} @ ${wh.name}`,
  });
  emitAttentionChanged("inventory");

  return {
    id: adjustment.id,
    code: adjustment.code,
    warehouseId: input.warehouseId,
    warehouseName: wh.name,
    irmItemId: input.irmItemId,
    itemName: item.name,
    quantity: input.quantity,
    balanceAfter,
    reason: adjustment.reason,
    movementDate: adjustment.movementDate.toISOString(),
    referenceNumber: adjustment.referenceNumber,
    notes: adjustment.notes,
    createdBy: adjustment.createdBy,
    createdAt: adjustment.createdAt.toISOString(),
  };
}

// Downward correction (damage / shrinkage / miscount). Validates the item is active and not serial/
// batch-tracked, then atomically creates an ADJ-#### header, decrements the (item, warehouse) balance
// (−qty) and writes ONE "manual_adjust" ledger row. The repo guards available ≥ qty inside the tx.
export async function adjustStock(input: AdjustStockInput, actor?: AuditActor): Promise<PublicStockAdjustment> {
  if (input.quantity <= 0) throw badRequest("Quantity must be greater than zero.");

  const item = await irmService.requireActiveIrmItem(input.irmItemId);
  if (item.trackSerialNumbers || item.trackBatchNumbers) {
    throw conflict("Serial- and batch-tracked items can't be adjusted this way.");
  }
  const wh = await warehouseService.requireActiveWarehouse(input.warehouseId);
  assertWarehouseAccess(actor, wh.id);
  const actorEmail = actor?.email ?? null;
  const notes = trimToNull(input.notes);

  const { adjustment, balanceAfter } = await inventoryRepo.createNegativeAdjustmentWithCode(
    {
      warehouseId: input.warehouseId,
      reason: input.reason,
      movementDate: new Date(input.movementDate),
      referenceNumber: trimToNull(input.referenceNumber),
      notes,
      createdBy: actorEmail,
    },
    { irmItemId: input.irmItemId, warehouseId: input.warehouseId, quantity: input.quantity, notes, createdBy: actorEmail },
  );

  audit.record({
    actor,
    action: "inventory.stock_adjusted",
    targetType: "stock_adjustment",
    targetId: adjustment.id,
    targetLabel: `${adjustment.code} · −${input.quantity} ${item.name} @ ${wh.name}`,
  });
  emitAttentionChanged("inventory");

  return {
    id: adjustment.id,
    code: adjustment.code,
    warehouseId: input.warehouseId,
    warehouseName: wh.name,
    irmItemId: input.irmItemId,
    itemName: item.name,
    quantity: input.quantity,
    balanceAfter,
    reason: adjustment.reason,
    movementDate: adjustment.movementDate.toISOString(),
    referenceNumber: adjustment.referenceNumber,
    notes: adjustment.notes,
    createdBy: adjustment.createdBy,
    createdAt: adjustment.createdAt.toISOString(),
  };
}

// ── Movement history (transfers) ───────────────────────────────────────────────────────────────
export interface ListTransfersParams {
  search?: string;
  irmItem?: string;
  warehouse?: string;
  page?: number;
  pageSize?: number;
}
export interface PagedTransfers {
  transfers: PublicStockTransfer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export async function listTransfers(params: ListTransfersParams = {}, actor?: AuditActor): Promise<PagedTransfers> {
  const pageSize = clamp(params.pageSize ?? 20, 1, 100);
  const filters = { search: params.search?.trim() || undefined, irmItemId: params.irmItem, warehouseId: params.warehouse, warehouseIds: warehouseScopeFilter(actor) };
  const total = await inventoryRepo.countTransfers(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(params.page ?? 1, 1, totalPages);
  const rows = await inventoryRepo.findTransfers(filters, (page - 1) * pageSize, pageSize);
  return { transfers: rows.map(toTransferDTO), total, page, pageSize, totalPages };
}

export interface InventoryCsvResult {
  csv: string;
  count: number;
  capped: boolean;
}

export async function exportInventoryCsv(params: ListInventoryParams = {}, actor?: AuditActor): Promise<InventoryCsvResult> {
  const all = await filteredBalanceDTOs(params, actor);
  const rows = all.slice(0, EXPORT_MAX);
  // Company timezone + configured date format, like every generated artifact; the column names the
  // zone so a reader is never left guessing which one the timestamps are in.
  const regional = await getRegionalSettings();
  const header = ["Item Code", "Item", "SKU", "Warehouse", "Category", "Unit", "On Hand", "Reserved", "Available", "Value (GBP)", `Last Movement (${regional.timezone})`, "Status"];
  const lines = [header.map(csvEscape).join(",")];
  for (const d of rows) {
    lines.push(
      [
        d.itemCode,
        d.itemName,
        d.sku ?? "",
        `${d.warehouseName} (${d.warehouseCode})`,
        d.categoryName ?? "",
        d.baseUnit ?? "",
        String(d.onHand),
        String(d.reserved),
        String(d.available),
        d.value.toFixed(2),
        formatDateTime(d.lastMovementAt, regional),
        d.status,
      ]
        .map((v) => csvEscape(String(v)))
        .join(","),
    );
  }
  // Audit the deliberate data extraction (NOT per page view — see plan §9).
  audit.record({ actor, action: "inventory.viewed", targetType: "inventory", targetLabel: `${rows.length} rows` });
  return { csv: lines.join("\r\n"), count: rows.length, capped: all.length > EXPORT_MAX };
}
