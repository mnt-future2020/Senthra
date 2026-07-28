import type { Prisma } from "@prisma/client";

import * as irmRepo from "./irm.repository.js";
import type { IrmItemWithRelations, IrmItemListRow, SupplierLinkRow } from "./irm.repository.js";
import * as irmTypeService from "#modules/irm-type/irm-type.service.js";
import * as irmCategoryService from "#modules/irm-category/irm-category.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import { getIrmCodePrefix } from "#modules/settings/settings.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import type { CreateIrmItemInput, SupplierRowInput, UpdateIrmItemInput } from "./irm.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const STATUSES = ["active", "inactive"] as const;

type SupplierLink = IrmItemWithRelations["suppliers"][number];

export interface PublicIrmOwner {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
}
export interface PublicIrmRef {
  id: string;
  name: string;
}
export interface PublicIrmSupplierLink {
  id: string;
  supplierId: string;
  supplier: { id: string; code: string; name: string } | null;
  isPrimary: boolean;
  priority: number;
  supplierSku: string | null;
  leadTimeDays: number | null;
}

export interface PublicIrmItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  brand: string | null;
  manufacturer: string | null;
  mpn: string | null;
  type: PublicIrmRef | null;
  typeId: string | null;
  category: PublicIrmRef | null;
  irmCategoryId: string | null;
  status: string;
  // Identification.
  sku: string | null;
  barcode: string | null;
  qrCode: string | null;
  barcodeDataUri: string | null; // rendered Code128 image (base64) of the item code, when generated
  // Suppliers (junction).
  suppliers: PublicIrmSupplierLink[];
  primarySupplier: { id: string; code: string; name: string } | null;
  // Unit.
  baseUnit: string | null;
  packSize: number | null;
  conversionRatio: number | null;
  // Stock policies (advisory).
  minimumStock: number | null;
  reorderLevel: number | null;
  reorderQuantity: number | null;
  maximumStock: number | null;
  safetyStock: number | null;
  criticalLevel: number | null;
  // Cost (internal only).
  standardCostPence: number | null;
  standardCost: number | null; // pounds, for display
  currency: string | null;
  vatRatePercent: number | null;
  // Tracking flags.
  trackInventory: boolean;
  trackSerialNumbers: boolean;
  trackBatchNumbers: boolean;
  allowNegativeStock: boolean;
  // Operations.
  ownerUserId: string | null;
  owner: PublicIrmOwner | null;
  notes: string | null;
  // Stock rollups — ZERO until the inventory ledger module is built (master-data only).
  onHand: number;
  available: number;
  totalValuePence: number;
  // Audit.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedIrmItems {
  items: PublicIrmItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

function toOwner(o: IrmItemWithRelations["owner"]): PublicIrmOwner | null {
  if (!o) return null;
  return { id: o.id, name: `${o.firstName} ${o.lastName}`.trim() || o.email, email: o.email, jobTitle: o.jobTitle ?? o.role?.name ?? null };
}

function toSupplierLink(l: SupplierLink): PublicIrmSupplierLink {
  return {
    id: l.id,
    supplierId: l.supplierId,
    supplier: l.supplier ? { id: l.supplier.id, code: l.supplier.code, name: l.supplier.name } : null,
    isPrimary: l.isPrimary,
    priority: l.priority,
    supplierSku: l.supplierSku,
    leadTimeDays: l.leadTimeDays,
  };
}

// Accepts either a full item (detail/generate) or a list row that omits the barcode image.
// `barcodeDataUri` is only present on the full shape — list rows resolve to null in the DTO.
function toPublic(i: IrmItemWithRelations | IrmItemListRow): PublicIrmItem {
  const primary = i.suppliers.find((s) => s.isPrimary) ?? null;
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    description: i.description,
    brand: i.brand,
    manufacturer: i.manufacturer,
    mpn: i.mpn,
    type: i.irmType ? { id: i.irmType.id, name: i.irmType.name } : null,
    typeId: i.typeId,
    category: i.irmCategory ? { id: i.irmCategory.id, name: i.irmCategory.name } : null,
    irmCategoryId: i.irmCategoryId,
    status: i.status ?? "active",
    sku: i.sku,
    barcode: i.barcode,
    qrCode: i.qrCode,
    barcodeDataUri: "barcodeDataUri" in i ? i.barcodeDataUri : null,
    suppliers: i.suppliers.map(toSupplierLink),
    primarySupplier: primary?.supplier ? { id: primary.supplier.id, code: primary.supplier.code, name: primary.supplier.name } : null,
    baseUnit: i.baseUnit,
    packSize: i.packSize,
    conversionRatio: i.conversionRatio,
    minimumStock: i.minimumStock,
    reorderLevel: i.reorderLevel,
    reorderQuantity: i.reorderQuantity,
    maximumStock: i.maximumStock,
    safetyStock: i.safetyStock,
    criticalLevel: i.criticalLevel,
    standardCostPence: i.standardCostPence,
    standardCost: i.standardCostPence != null ? i.standardCostPence / 100 : null,
    currency: i.currency ?? "GBP",
    vatRatePercent: i.vatRatePercent,
    trackInventory: i.trackInventory ?? true,
    trackSerialNumbers: i.trackSerialNumbers ?? false,
    trackBatchNumbers: i.trackBatchNumbers ?? false,
    allowNegativeStock: i.allowNegativeStock ?? false,
    ownerUserId: i.ownerUserId,
    owner: toOwner(i.owner),
    notes: i.notes,
    onHand: 0,
    available: 0,
    totalValuePence: 0,
    createdBy: i.createdBy,
    updatedBy: i.updatedBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

async function resolveOwner(ownerUserId: string | null | undefined): Promise<string | null> {
  const id = ownerUserId?.trim();
  if (!id) return null;
  const user = await userRepo.findById(id);
  if (!user) throw badRequest("Selected owner no longer exists.");
  if (user.status !== "active") throw badRequest("Selected owner is not an active user.");
  return user.id;
}

// Normalise supplier rows to junction rows. Suppliers are optional, so the list may be empty;
// the zod schema guarantees at most one primary and no duplicate supplier. NEW links must be ACTIVE, but
// suppliers already on the item are preserved even if since deactivated — so editing the
// item's other fields keeps working (mirrors the owner/manager "only validate on change"
// rule). `preserveSupplierIds` holds the ids currently linked to the item (empty on create,
// so create stays active-only).
async function buildSupplierRows(
  rows: SupplierRowInput[],
  preserveSupplierIds: Set<string> = new Set(),
): Promise<SupplierLinkRow[]> {
  const out: SupplierLinkRow[] = [];
  for (const r of rows) {
    if (!preserveSupplierIds.has(r.supplierId)) {
      await supplierService.requireActiveSupplier(r.supplierId);
    }
    out.push({
      supplierId: r.supplierId,
      isPrimary: r.isPrimary === true,
      priority: r.priority ?? 0,
      supplierSku: trimToNull(r.supplierSku),
      leadTimeDays: r.leadTimeDays ?? null,
    });
  }
  return out;
}

function rowSig(r: { supplierId: string; isPrimary: boolean; priority: number; supplierSku: string | null; leadTimeDays: number | null }): string {
  return `${r.supplierId}:${r.isPrimary ? 1 : 0}:${r.priority}:${r.supplierSku ?? ""}:${r.leadTimeDays ?? ""}`;
}
function suppliersDiffer(existing: SupplierLink[], incoming: SupplierLinkRow[]): boolean {
  return existing.map(rowSig).sort().join("|") !== incoming.map(rowSig).sort().join("|");
}

const costToPence = (pounds: number | null | undefined): number | null =>
  pounds == null ? null : Math.round(pounds * 100);

// Resolve the SKU + its lowercase mirror; enforce GLOBAL FOREVER uniqueness (scans all rows
// incl. soft-deleted). `selfId` excludes the item being edited.
async function resolveSku(sku: string | null | undefined, selfId?: string): Promise<{ sku: string | null; skuLower: string | null }> {
  const trimmed = trimToNull(sku);
  if (!trimmed) return { sku: null, skuLower: null };
  const skuLower = trimmed.toLowerCase();
  const clash = await irmRepo.findBySkuLower(skuLower);
  if (clash && clash.id !== selfId) {
    throw skuConflict(trimmed);
  }
  return { sku: trimmed, skuLower };
}

// Friendly 409 for a duplicate SKU — used both by the app-level pre-check (resolveSku) and
// as the fallback when the DB partial-unique index catches a concurrent racing write (P2002).
const skuConflict = (sku: string | null | undefined) =>
  conflict(`SKU "${(sku ?? "").trim()}" is already in use. SKUs are never reused, even from removed items.`);

function irmColumns(input: CreateIrmItemInput, skuLower: string | null, standardCostPence: number | null) {
  return {
    description: trimToNull(input.description),
    brand: trimToNull(input.brand),
    manufacturer: trimToNull(input.manufacturer),
    mpn: trimToNull(input.mpn),
    sku: trimToNull(input.sku),
    skuLower,
    baseUnit: input.baseUnit,
    packSize: input.packSize ?? null,
    conversionRatio: input.conversionRatio ?? null,
    minimumStock: input.minimumStock ?? null,
    reorderLevel: input.reorderLevel ?? null,
    reorderQuantity: input.reorderQuantity ?? null,
    maximumStock: input.maximumStock ?? null,
    safetyStock: input.safetyStock ?? null,
    criticalLevel: input.criticalLevel ?? null,
    standardCostPence,
    currency: input.currency ?? "GBP",
    vatRatePercent: input.vatRatePercent ?? 20,
    trackInventory: input.trackInventory ?? true,
    trackSerialNumbers: input.trackSerialNumbers ?? false,
    trackBatchNumbers: input.trackBatchNumbers ?? false,
    allowNegativeStock: input.allowNegativeStock ?? false,
    notes: trimToNull(input.notes),
    status: input.status ?? "active",
  };
}

export interface ListIrmItemsParams {
  search?: string;
  status?: string;
  type?: string;
  category?: string;
  supplier?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listIrmItems(params: ListIrmItemsParams = {}): Promise<PagedIrmItems> {
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status) ? params.status : undefined;
  const filters = {
    search: params.search,
    status,
    typeId: params.type,
    categoryId: params.category,
    supplierId: params.supplier,
  };
  const total = await irmRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const rows = await irmRepo.findMany(filters, skip, pageSize, params.sort);
  return { items: rows.map(toPublic), total, page, pageSize, totalPages };
}

export async function getIrmItem(idOrCode: string): Promise<PublicIrmItem> {
  const i = OBJECT_ID_RE.test(idOrCode) ? await irmRepo.findById(idOrCode) : await irmRepo.findByCode(idOrCode);
  if (!i) throw notFound("IRM item not found.");
  return toPublic(i);
}

// Generate (or regenerate) the item's Code128 barcode image. The encoded value is the item's own
// permanent `code` (e.g. IRM-0004), so regenerating simply re-renders the PNG — useful when a stored
// image is missing/corrupt. The free-text `barcode`/`qrCode` fields are deliberately left untouched.
export async function generateBarcode(idOrCode: string, actor?: AuditActor): Promise<PublicIrmItem> {
  const item = OBJECT_ID_RE.test(idOrCode) ? await irmRepo.findById(idOrCode) : await irmRepo.findByCode(idOrCode);
  if (!item) throw notFound("IRM item not found.");

  const bwipjs = await import("bwip-js");
  const pngBuffer = await bwipjs.default.toBuffer({
    bcid: "code128",
    text: item.code,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
  const dataUri = `data:image/png;base64,${pngBuffer.toString("base64")}`;

  const updated = await irmRepo.updateBarcodeImage(item.id, dataUri);
  audit.record({
    actor,
    action: "irm.barcode_generated",
    targetType: "irm_item",
    targetId: item.id,
    targetLabel: `${item.name} (${item.code})`,
  });
  return toPublic(updated);
}

export async function createIrmItem(input: CreateIrmItemInput, actor?: AuditActor): Promise<PublicIrmItem> {
  const name = input.name.trim();
  if (!name) throw badRequest("Item name is required.");

  await irmTypeService.requireActiveIrmType(input.typeId);
  await irmCategoryService.requireActiveIrmCategory(input.irmCategoryId);
  const ownerUserId = await resolveOwner(input.ownerUserId);
  const { skuLower } = await resolveSku(input.sku);
  const supplierRows = await buildSupplierRows(input.suppliers ?? []);
  const standardCostPence = costToPence(input.standardCost);
  const codePrefix = await getIrmCodePrefix();
  const actorLabel = actor?.email ?? null;

  let created: IrmItemWithRelations;
  try {
    created = await irmRepo.createWithCode(
      {
        name,
        ...irmColumns(input, skuLower, standardCostPence),
        irmType: { connect: { id: input.typeId } },
        irmCategory: { connect: { id: input.irmCategoryId } },
        ...(ownerUserId ? { owner: { connect: { id: ownerUserId } } } : {}),
        createdBy: actorLabel,
        updatedBy: actorLabel,
      },
      codePrefix,
    );
  } catch (e) {
    if (irmRepo.isSkuConflict(e)) throw skuConflict(input.sku);
    throw e;
  }
  await irmRepo.replaceSuppliers(created.id, supplierRows);
  const full = (await irmRepo.findById(created.id))!;

  audit.record({
    actor,
    action: "irm.created",
    targetType: "irm_item",
    targetId: created.id,
    targetLabel: `${created.name} (${created.code})`,
  });
  return toPublic(full);
}

export async function updateIrmItem(id: string, input: UpdateIrmItemInput, actor?: AuditActor): Promise<PublicIrmItem> {
  const existing = await irmRepo.findById(id);
  if (!existing) throw notFound("IRM item not found.");

  const data: Prisma.IrmItemUncheckedUpdateInput = {};
  if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim();
  if (input.description !== undefined) data.description = trimToNull(input.description);
  if (input.brand !== undefined) data.brand = trimToNull(input.brand);
  if (input.manufacturer !== undefined) data.manufacturer = trimToNull(input.manufacturer);
  if (input.mpn !== undefined) data.mpn = trimToNull(input.mpn);
  if (input.baseUnit !== undefined) data.baseUnit = input.baseUnit;
  if (input.packSize !== undefined) data.packSize = input.packSize;
  if (input.conversionRatio !== undefined) data.conversionRatio = input.conversionRatio;
  if (input.minimumStock !== undefined) data.minimumStock = input.minimumStock;
  if (input.reorderLevel !== undefined) data.reorderLevel = input.reorderLevel;
  if (input.reorderQuantity !== undefined) data.reorderQuantity = input.reorderQuantity;
  if (input.maximumStock !== undefined) data.maximumStock = input.maximumStock;
  if (input.safetyStock !== undefined) data.safetyStock = input.safetyStock;
  if (input.criticalLevel !== undefined) data.criticalLevel = input.criticalLevel;

  // Cross-field: maximum ≥ minimum must hold on the MERGED record. A partial PATCH may send
  // only one of the two, so validate the effective values (incoming if present, else stored)
  // — not just what's in this request (the zod refine only sees the request).
  const effectiveMin = input.minimumStock !== undefined ? input.minimumStock : existing.minimumStock;
  const effectiveMax = input.maximumStock !== undefined ? input.maximumStock : existing.maximumStock;
  if (typeof effectiveMin === "number" && typeof effectiveMax === "number" && effectiveMax < effectiveMin) {
    throw badRequest("Maximum stock must be greater than or equal to minimum stock.");
  }

  if (input.currency !== undefined) data.currency = input.currency;
  if (input.vatRatePercent !== undefined) data.vatRatePercent = input.vatRatePercent;
  if (input.trackInventory !== undefined) data.trackInventory = input.trackInventory;
  if (input.trackSerialNumbers !== undefined) data.trackSerialNumbers = input.trackSerialNumbers;
  if (input.trackBatchNumbers !== undefined) data.trackBatchNumbers = input.trackBatchNumbers;
  if (input.allowNegativeStock !== undefined) data.allowNegativeStock = input.allowNegativeStock;
  if (input.notes !== undefined) data.notes = trimToNull(input.notes);

  // Cost: pounds → pence.
  if (input.standardCost !== undefined) data.standardCostPence = costToPence(input.standardCost);

  // SKU: global-forever uniqueness; only re-check when it actually changes.
  if (input.sku !== undefined) {
    const { sku, skuLower } = await resolveSku(input.sku, id);
    data.sku = sku;
    data.skuLower = skuLower;
  }

  // Type / category: validate + change only when a different active one is chosen.
  if (input.typeId !== undefined && input.typeId !== existing.typeId) {
    await irmTypeService.requireActiveIrmType(input.typeId);
    data.typeId = input.typeId;
  }
  if (input.irmCategoryId !== undefined && input.irmCategoryId !== existing.irmCategoryId) {
    await irmCategoryService.requireActiveIrmCategory(input.irmCategoryId);
    data.irmCategoryId = input.irmCategoryId;
  }

  const events: string[] = [];

  // Owner change-detection (mirror supplier/warehouse).
  if (input.ownerUserId !== undefined && input.ownerUserId !== existing.ownerUserId) {
    const resolved = input.ownerUserId === null ? null : await resolveOwner(input.ownerUserId);
    data.ownerUserId = resolved;
    events.push(resolved ? "irm.owner_assigned" : "irm.owner_removed");
  }

  // Status transitions.
  if (input.status !== undefined && input.status !== existing.status) {
    data.status = input.status;
    events.push(input.status === "active" ? "irm.activated" : "irm.deactivated");
  }

  // Suppliers reconcile (optional; an empty array clears every link. Uniqueness + at most one
  // primary already guaranteed by zod when present).
  // Suppliers already linked to this item are preserved even if since deactivated, so an
  // unrelated edit never fails on a stale link; only newly-added suppliers must be active.
  let supplierRows: SupplierLinkRow[] | null = null;
  let suppliersChanged = false;
  if (input.suppliers !== undefined) {
    const existingSupplierIds = new Set(existing.suppliers.map((s) => s.supplierId));
    supplierRows = await buildSupplierRows(input.suppliers, existingSupplierIds);
    suppliersChanged = suppliersDiffer(existing.suppliers, supplierRows);
  }

  // Generic "updated" when any non-transition scalar changed.
  const IGNORE = new Set(["updatedBy", "status", "ownerUserId", "skuLower"]);
  let scalarChanged = false;
  for (const [k, v] of Object.entries(data)) {
    if (IGNORE.has(k)) continue;
    if (v !== undefined && v !== (existing as unknown as Record<string, unknown>)[k]) {
      scalarChanged = true;
      break;
    }
  }
  if (scalarChanged || suppliersChanged) events.push("irm.updated");

  data.updatedBy = actor?.email ?? null;

  let result: IrmItemWithRelations;
  try {
    result = await irmRepo.update(id, data);
  } catch (e) {
    if (irmRepo.isSkuConflict(e)) throw skuConflict(input.sku);
    throw e;
  }
  if (suppliersChanged && supplierRows) {
    await irmRepo.replaceSuppliers(id, supplierRows);
    result = (await irmRepo.findById(id))!;
  }

  const label = `${result.name} (${result.code})`;
  for (const action of events.length ? events : ["irm.updated"]) {
    audit.record({ actor, action, targetType: "irm_item", targetId: id, targetLabel: label });
  }
  return toPublic(result);
}

// Future dependency-checkers (PO / Goods In / Inventory / Transfer / Goods Out / Rental).
type DependencyChecker = { label: string; count: (itemId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "purchase orders", count: (id) => poRepo.countByIrmItem(id) },
  { label: "goods receipts", count: (id) => grnRepo.countByIrmItem(id) },
  { label: "inventory", count: (id) => inventoryRepo.countBalancesWithStockByIrmItem(id) },
  { label: "engineer stock", count: (id) => engineerStockRepo.countEngineerStockWithStockByIrmItem(id) },
  // FUTURE: stock transfer (open), rental.
];

async function assertIrmItemDeletable(itemId: string): Promise<void> {
  for (const checker of DELETE_DEPENDENCY_CHECKERS) {
    if ((await checker.count(itemId)) > 0) {
      throw conflict("This item is in use. Remove dependencies first.");
    }
  }
}

export async function deleteIrmItem(id: string, actor?: AuditActor): Promise<void> {
  const i = await irmRepo.findById(id);
  if (!i) throw notFound("IRM item not found.");
  await assertIrmItemDeletable(id);
  await irmRepo.softDelete(id);
  audit.record({
    actor,
    action: "irm.deleted",
    targetType: "irm_item",
    targetId: id,
    targetLabel: `${i.name} (${i.code})`,
  });
}

export async function listOwnerOptions(): Promise<PublicIrmOwner[]> {
  const users = await irmRepo.findOwnerOptions();
  return users.map((u) => ({
    id: u.id,
    name: `${u.firstName} ${u.lastName}`.trim() || u.email,
    email: u.email,
    jobTitle: u.jobTitle ?? u.role?.name ?? null,
  }));
}

// Plug-in seam for FUTURE procurement/inventory modules: assert an item id points to an
// existing ACTIVE IRM item before referencing it.
export async function requireActiveIrmItem(itemId: string): Promise<IrmItemWithRelations> {
  if (!itemId || !OBJECT_ID_RE.test(itemId)) throw badRequest("Select an IRM item.");
  const i = await irmRepo.findById(itemId);
  if (!i) throw badRequest("Selected IRM item no longer exists.");
  if ((i.status ?? "active") !== "active") throw conflict("Selected IRM item is inactive.");
  return i;
}

// Batch counterpart to requireActiveIrmItem — validates many ids in ONE query instead of N, for
// the procurement write paths (a PRF/PO with many lines). Same guards and error messages as the
// singular form: every id must be a valid ObjectId, still exist, and be active. Returns a Map keyed
// by id so callers can look each line's item up in O(1).
export async function requireActiveIrmItems(itemIds: string[]): Promise<Map<string, IrmItemWithRelations>> {
  const uniqueIds = [...new Set(itemIds)];
  for (const id of uniqueIds) {
    if (!id || !OBJECT_ID_RE.test(id)) throw badRequest("Select an IRM item.");
  }
  const rows = await irmRepo.findByIds(uniqueIds);
  const byId = new Map(rows.map((i) => [i.id, i]));
  for (const id of uniqueIds) {
    const i = byId.get(id);
    if (!i) throw badRequest("Selected IRM item no longer exists.");
    if ((i.status ?? "active") !== "active") throw conflict("Selected IRM item is inactive.");
  }
  return byId;
}

// Scan-lookup helper for the goods-management flow: find an active IRM item by its display
// code (e.g. "IRM-0004"), free-text barcode field, or SKU (case-insensitive).
// Returns null if nothing matches — callers then try the customer-stock path.
export function findActiveByCodeOrBarcode(code: string): Promise<IrmItemWithRelations | null> {
  return irmRepo.findActiveByCodeOrBarcode(code);
}

// Reorder-workbench seam: each item's primary supplier (id/name/status + effective lead time) keyed
// by item id, one query for many items. Lead time prefers the item-supplier link's value over the
// supplier's general one (the link is the more specific quote). Items with no primary are absent.
export interface PrimarySupplierRef {
  id: string;
  name: string;
  status: string;
  leadTimeDays: number | null;
}
export async function primarySuppliersForItems(irmItemIds: string[]): Promise<Map<string, PrimarySupplierRef>> {
  const links = await irmRepo.findPrimarySupplierLinks(irmItemIds);
  const map = new Map<string, PrimarySupplierRef>();
  for (const l of links) {
    map.set(l.irmItemId, {
      id: l.supplier.id,
      name: l.supplier.name,
      status: l.supplier.status ?? "active",
      leadTimeDays: l.leadTimeDays ?? l.supplier.leadTimeDays ?? null,
    });
  }
  return map;
}
