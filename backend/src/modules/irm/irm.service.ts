import type { Prisma } from "@prisma/client";

import * as irmRepo from "./irm.repository.js";
import type { IrmItemWithRelations, IrmItemListRow, SupplierLinkRow } from "./irm.repository.js";
import * as irmTypeService from "#modules/irm-type/irm-type.service.js";
import * as irmCategoryService from "#modules/irm-category/irm-category.service.js";
import * as supplierService from "#modules/supplier/supplier.service.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import { getIrmCodePrefix } from "#modules/settings/settings.service.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import type { CreateIrmItemInput, SupplierRowInput, UpdateIrmItemInput } from "./irm.validation.js";
import { buildSkuCandidate, normalizeSku, withSuffix } from "./sku.js";
import { roleGrants } from "#modules/role/permissions.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
// How many times a GENERATED SKU is re-derived after losing a race to the unique index. Two rivals
// landing on the same candidate is already unlikely; a third would mean something other than
// concurrency is wrong, and looping on it would just delay the error.
const SKU_RACE_RETRIES = 2;
const STATUSES = ["active", "inactive"] as const;

type SupplierLink = IrmItemWithRelations["suppliers"][number];

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
  // Stock policies (advisory).
  reorderLevel: number | null;
  maximumStock: number | null;
  criticalLevel: number | null;
  // Cost (internal only).
  standardCostPence: number | null;
  standardCost: number | null; // pounds, for display
  currency: string | null;
  vatRatePercent: number | null;
  // Tracking flags.
  trackInventory: boolean;
  // Operations.
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
    reorderLevel: i.reorderLevel,
    maximumStock: i.maximumStock,
    criticalLevel: i.criticalLevel,
    standardCostPence: i.standardCostPence,
    standardCost: i.standardCostPence != null ? i.standardCostPence / 100 : null,
    currency: i.currency ?? "GBP",
    vatRatePercent: i.vatRatePercent,
    trackInventory: i.trackInventory ?? true,
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

// Is this SKU free to use? Checks the two ways it can be taken:
//   1. another item already owns it as a SKU (global + forever, soft-deleted rows included), and
//   2. another item owns it as its display CODE — see irmRepo.findIdByCode for why that matters.
async function isSkuFree(sku: string, selfId?: string): Promise<boolean> {
  const clash = await irmRepo.findBySkuLower(sku.toLowerCase());
  if (clash && clash.id !== selfId) return false;
  const codeOwner = await irmRepo.findIdByCode(sku);
  return !codeOwner || codeOwner.id === selfId;
}

// Walk the generated candidate's suffixes (CAB-CAT6, CAB-CAT6-2, …) until one is free. Only ever
// used for SKUs the SERVER invented: a SKU a person typed is rejected on collision rather than
// silently renamed, because they need to know the one they chose was taken.
async function uniqueSku(candidate: string, selfId?: string): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const attempt = withSuffix(candidate, n);
    if (await isSkuFree(attempt, selfId)) return attempt;
  }
  throw conflict(`Could not generate a free SKU from "${candidate}". Enter one manually.`);
}

// `generated` separates a SKU the SERVER invented from one a PERSON chose. It decides who owns a
// losing race against the unique index: our value is ours to replace silently, theirs is not.
interface ResolvedSku {
  sku: string;
  skuLower: string;
  generated: boolean;
}

// Resolve the SKU + its lowercase mirror. Every IRM item has one: a blank SKU is GENERATED from the
// item's name and category rather than stored as null. `selfId` excludes the item being edited.
async function resolveSku(
  raw: string | null | undefined,
  ctx: { name: string; categoryName?: string | null; codePrefix: string; selfId?: string },
): Promise<ResolvedSku> {
  const typed = normalizeSku(raw);

  // Nothing usable typed → generate. The form fills this in as you type, so in practice this is
  // the API-client path; it exists so "every item has a SKU" holds without trusting the caller.
  if (!typed) {
    const generated = await uniqueSku(buildSkuCandidate(ctx.name, ctx.categoryName), ctx.selfId);
    return { sku: generated, skuLower: generated.toLowerCase(), generated: true };
  }

  // Reserve the shape of a FUTURE item code (IRM-0042) as well as the codes already issued. The
  // code counter only ever climbs, so blocking the shape now is what stops a scan collision the
  // day it reaches that number — by then the SKU would be far too entrenched to change.
  if (new RegExp(`^${ctx.codePrefix}-\\d+$`).test(typed)) {
    throw badRequest(`"${typed}" is the shape of an item code, which would break barcode scanning. Choose a different SKU.`);
  }
  if (!(await isSkuFree(typed, ctx.selfId))) throw skuConflict(typed);
  return { sku: typed, skuLower: typed.toLowerCase(), generated: false };
}

// Friendly 409 for a duplicate SKU — used both by the app-level pre-check (resolveSku) and
// as the fallback when the DB partial-unique index catches a concurrent racing write (P2002).
const skuConflict = (sku: string | null | undefined) =>
  conflict(`SKU "${(sku ?? "").trim()}" is already in use. SKUs are never reused, even from removed items.`);

function irmColumns(
  input: CreateIrmItemInput,
  resolvedSku: { sku: string; skuLower: string },
  standardCostPence: number | null,
) {
  return {
    description: trimToNull(input.description),
    brand: trimToNull(input.brand),
    manufacturer: trimToNull(input.manufacturer),
    mpn: trimToNull(input.mpn),
    sku: resolvedSku.sku,
    skuLower: resolvedSku.skuLower,
    baseUnit: input.baseUnit,
    packSize: input.packSize ?? null,
    reorderLevel: input.reorderLevel ?? null,
    maximumStock: input.maximumStock ?? null,
    criticalLevel: input.criticalLevel ?? null,
    standardCostPence,
    currency: input.currency ?? "GBP",
    vatRatePercent: input.vatRatePercent ?? 20,
    trackInventory: input.trackInventory ?? true,
    notes: trimToNull(input.notes),
    status: input.status ?? "active",
  };
}

/** Upper bound on a single id lookup. Well past any real caller (a receipt's lines, a form's
 *  selected rows) and short of a request that could be used to sweep the catalogue in one query. */
export const MAX_IRM_IDS = 200;

/**
 * Who may READ the catalogue — wider than `irm.view`, and deliberately so.
 *
 * A role assembled in Users & Roles from the jobs capability alone holds neither `irm.view` nor
 * `rentals.view`, yet building a job kit is choosing IRM items. Before this the picker was simply
 * empty, with no error and nothing to say a permission was missing: the same silent failure that
 * `/rental-items`, `/suppliers/options` and `/customers/options` were widened to prevent.
 *
 * Reading the catalogue is not the same as reading what it COST, and that distinction is why this
 * list is safe. See `IRM_COST_PERMISSIONS`.
 */
export const IRM_PICKER_PERMISSIONS = [
  "irm.view",
  "purchase_requests.create",
  "purchase_requests.edit",
  "purchase_orders.create",
  "purchase_orders.edit",
  "goods_in.create",
  "jobs.create",
  "jobs.edit",
] as const;

/**
 * Who may additionally see an item's COST.
 *
 * The rental catalogue could be widened outright because its public shape carries no commercial
 * data at all. An IRM item carries `standardCost`, so widening the route the same way would have
 * handed item costs to every role that can open the job form — a new exposure wearing a bug fix's
 * clothes. Cost therefore rides on a second check.
 *
 * These are the callers who already see the figure on the document they are filling in: a purchase
 * request prices its own lines, an order carries the price it commits to, and a goods receipt is
 * matched against that order. Nothing is revealed that the same user could not already read. Job
 * planning is absent because a kit line is a quantity of an item, not a price.
 */
export const IRM_COST_PERMISSIONS = [
  "irm.view",
  "purchase_requests.create",
  "purchase_requests.edit",
  "purchase_orders.create",
  "purchase_orders.edit",
  "goods_in.create",
] as const;

/** Whether this caller's permissions include any that carry item cost. */
export function canReadIrmCost(permissions: string[]): boolean {
  return IRM_COST_PERMISSIONS.some((p) => roleGrants(permissions, p));
}

/**
 * Fold a caller's id list into something safe to hand Prisma: valid ObjectIds only, de-duplicated,
 * and bounded.
 *
 * Returning an EMPTY array for "nothing valid was asked for" is deliberate and load-bearing — it
 * becomes `id: { in: [] }`, which matches nothing. Returning `undefined` would drop the filter and
 * answer a lookup for garbage ids with the whole first page of the catalogue.
 */
export function sanitiseIrmIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => OBJECT_ID_RE.test(id)))].slice(0, MAX_IRM_IDS);
}

export interface ListIrmItemsParams {
  search?: string;
  /**
   * Whether the caller may see `standardCost`. Defaults to TRUE so every existing caller — the
   * catalogue page, the CSV export, the internal reads — is unchanged; only the widened route passes
   * `false`, and only for a caller who holds none of `IRM_COST_PERMISSIONS`.
   */
  includeCost?: boolean;
  /** Restrict to these ids (narrowing only). Sanitised by `sanitiseIrmIds` before it reaches Prisma. */
  ids?: string[];
  status?: string;
  type?: string;
  category?: string;
  supplier?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export async function listIrmItems(params: ListIrmItemsParams = {}): Promise<PagedIrmItems> {
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status) ? params.status : undefined;
  const filters = {
    search: params.search,
    ids: params.ids ? sanitiseIrmIds(params.ids) : undefined,
    status,
    typeId: params.type,
    categoryId: params.category,
    supplierId: params.supplier,
  };
  const total = await irmRepo.count(filters);
  // An ID LOOKUP is not a browse, and must not be clamped like one. `paginate` bounds an ordinary
  // request at 100, which is right for paging a catalogue and silently wrong for "resolve exactly
  // these rows": a caller holding 150 saved lines got 100 back with nothing to say 50 were missing,
  // and GoodsReceiptForm read that short page as "these items track no serials". The set is already
  // bounded — `sanitiseIrmIds` caps it at MAX_IRM_IDS — so raising the ceiling to that same bound
  // grants no more than the filter itself allows. An explicit maxPageSize (the CSV export's) wins.
  const maxPageSize = params.maxPageSize ?? (filters.ids ? MAX_IRM_IDS : undefined);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, maxPageSize);
  const rows = await irmRepo.findMany(filters, skip, pageSize, params.sort);
  // Blanked, never zeroed. A 0 is a real price, and an item listed at £0.00 reads as free rather
  // than as withheld — the silent wrong answer this whole pass is about.
  const items = rows.map(toPublic).map((i) =>
    params.includeCost === false ? { ...i, standardCost: null, standardCostPence: null } : i,
  );
  return { items, total, page, pageSize, totalPages };
}

/**
 * The SAME filtered catalogue as a CSV, minus paging. Delegates to listIrmItems with one oversized
 * page rather than re-deriving the filters — the status whitelist above is real behaviour (an
 * unknown ?status is ignored, not matched), and a second copy of it would drift.
 */
export async function exportIrmItemsCsv(
  params: ListIrmItemsParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  // includeCost is forced ON, and the order matters — it must land AFTER the caller's params.
  //
  // The export shares `listParamsFrom` with the list route, so it arrives carrying whatever cost
  // flag that route computed. It must not act here: this endpoint has its own dedicated permission
  // (`irm.export`), granted deliberately over this catalogue, and was no part of the picker
  // widening. Honouring the flag would hand an exporter a file with a silently blank "Standard Cost"
  // column and nothing to say the figure was withheld rather than simply absent.
  const { items } = await listIrmItems({ ...params, ...EXPORT_PAGING, includeCost: true });
  const rows = items.slice(0, EXPORT_MAX);

  const csv = toCsv(
    [
      "Code", "Name", "Type", "Category", "Status",
      "Brand", "Manufacturer", "MPN", "SKU", "Barcode",
      "Primary Supplier", "Suppliers",
      "Unit", "Pack Size",
      "Critical Level", "Reorder Level", "Maximum Stock",
      "Standard Cost", "Currency", "VAT %",
      "Track Inventory", "On Hand",
    ],
    rows.map((i) => [
      i.code,
      i.name,
      i.type?.name,
      i.category?.name,
      i.status,
      i.brand,
      i.manufacturer,
      i.mpn,
      i.sku,
      i.barcode,
      i.primarySupplier?.name,
      // The alternatives, so a buyer can see the second source without opening the item.
      i.suppliers.map((sup) => sup.supplier?.name).filter(Boolean).join(" | "),
      i.baseUnit,
      i.packSize,
      // The three thresholds in the order they stack (critical ≤ reorder ≤ maximum), so the columns
      // read the way the rule does rather than in schema order.
      i.criticalLevel,
      i.reorderLevel,
      i.maximumStock,
      // Pounds, never the pence integer — this file is opened in a spreadsheet and multiplied out.
      i.standardCost == null ? "" : i.standardCost.toFixed(2),
      i.currency,
      i.vatRatePercent,
      i.trackInventory ? "Yes" : "No",
      i.onHand,
    ]),
  );

  // `notes` is deliberately absent, as on the supplier and customer exports: internal free text.
  audit.record({ actor, action: "irm.exported", targetType: "irm_item", targetLabel: `${rows.length} rows` });
  return { csv, capped: items.length > EXPORT_MAX };
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
  const category = await irmCategoryService.requireActiveIrmCategory(input.irmCategoryId);
  const codePrefix = await getIrmCodePrefix();
  const resolvedSku = await resolveSku(input.sku, { name, categoryName: category.name, codePrefix });
  const supplierRows = await buildSupplierRows(input.suppliers ?? []);
  const standardCostPence = costToPence(input.standardCost);
  const actorLabel = actor?.email ?? null;

  // The pre-check in resolveSku can lose a race to a concurrent create, and the partial unique
  // index then rejects the write. What happens next depends on WHO chose the SKU: one the server
  // generated is re-derived onto the next free suffix (the caller never picked it, so a 409 over it
  // would be nonsense), while one a person typed is reported back to them — silently renaming their
  // chosen identifier would be worse than failing.
  let resolved = resolvedSku;
  let created: IrmItemWithRelations | null = null;
  for (let attempt = 0; created === null; attempt++) {
    try {
      created = await irmRepo.createWithCode(
        {
          name,
          ...irmColumns(input, resolved, standardCostPence),
          irmType: { connect: { id: input.typeId } },
          irmCategory: { connect: { id: input.irmCategoryId } },
          createdBy: actorLabel,
          updatedBy: actorLabel,
        },
        codePrefix,
      );
    } catch (e) {
      if (!irmRepo.isSkuConflict(e)) throw e;
      if (!resolved.generated || attempt >= SKU_RACE_RETRIES) throw skuConflict(resolved.sku);
      resolved = await resolveSku(undefined, { name, categoryName: category.name, codePrefix });
    }
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
  if (input.reorderLevel !== undefined) data.reorderLevel = input.reorderLevel;
  if (input.maximumStock !== undefined) data.maximumStock = input.maximumStock;
  if (input.criticalLevel !== undefined) data.criticalLevel = input.criticalLevel;

  // Cross-field coherence on the MERGED record. A partial PATCH may send only one of a pair, so the
  // effective values (incoming if present, else stored) are what must stack — the zod refine only
  // ever sees this request. Previously this compared maximum against `minimumStock`, a field the
  // reorder engine never read, so the guard protected a number that changed nothing.
  //
  // Each rule only fires when this request TOUCHES one of its two fields. Rows saved before these
  // rules existed can violate them (nothing enforced max ≥ reorder, and criticalLevel had no rule at
  // all), and a guard that ran unconditionally would refuse to rename such an item — a 400 about
  // stock policy on a request that never mentioned it, with no way to clear it from the form. Same
  // reasoning as the supplier/type pickers: an old value you didn't touch never blocks the edit in
  // front of you. Touch either half of a pair and you own it, and the merged check applies in full.
  const eff = <K extends "reorderLevel" | "maximumStock" | "criticalLevel">(k: K) =>
    input[k] !== undefined ? input[k] : existing[k];
  const effReorder = eff("reorderLevel");
  const effMax = eff("maximumStock");
  const effCritical = eff("criticalLevel");
  const touched = (...keys: ("reorderLevel" | "maximumStock" | "criticalLevel")[]) =>
    keys.some((k) => input[k] !== undefined);
  if (touched("reorderLevel", "maximumStock") && typeof effReorder === "number" && typeof effMax === "number" && effMax < effReorder) {
    throw badRequest("Maximum stock must be greater than or equal to the reorder level — an order has to lift stock clear of the line that triggered it.");
  }
  if (touched("reorderLevel", "criticalLevel") && typeof effReorder === "number" && typeof effCritical === "number" && effCritical > effReorder) {
    throw badRequest("Critical level must be at or below the reorder level — it is the more urgent line, not a second trigger.");
  }
  // Closes the chain. Both rules above hinge on the reorder level, so with it blank nothing compared
  // these two and critical 200 against a maximum of 50 passed — an ordering the comment claimed but
  // the code only half-enforced. Same touched() gate: an untouched legacy pair never blocks an edit.
  if (touched("criticalLevel", "maximumStock") && typeof effCritical === "number" && typeof effMax === "number" && effCritical > effMax) {
    throw badRequest("Critical level must be at or below the maximum stock — it is the lowest of the three lines.");
  }

  if (input.currency !== undefined) data.currency = input.currency;
  if (input.vatRatePercent !== undefined) data.vatRatePercent = input.vatRatePercent;
  if (input.trackInventory !== undefined) data.trackInventory = input.trackInventory;
  if (input.notes !== undefined) data.notes = trimToNull(input.notes);

  // Cost: pounds → pence.
  if (input.standardCost !== undefined) data.standardCostPence = costToPence(input.standardCost);

  // SKU: required, and never clearable — an item that has one can't go back to having none.
  // Re-resolved ONLY when it actually changes, so the common edit (which resends the unchanged SKU)
  // costs no lookups. Note the value is normalized first, so re-sending 'FBR-SM12- G652D' as
  // 'FBR-SM12-G652D' is correctly seen as no change rather than a rename that burns the old one.
  if (input.sku !== undefined) {
    const typed = normalizeSku(input.sku);
    if (!typed) throw badRequest("SKU is required.");
    if (typed !== existing.sku) {
      const resolved = await resolveSku(typed, {
        name: input.name?.trim() || existing.name,
        categoryName: existing.irmCategory?.name,
        codePrefix: await getIrmCodePrefix(),
        selfId: id,
      });
      data.sku = resolved.sku;
      data.skuLower = resolved.skuLower;
    }
  }
  // What the write will actually try to store, for the racing-conflict message below. `input.sku` is
  // the raw request field: reporting that would quote 'fbr-sm12- g652d' back at someone who is
  // looking at FBR-SM12-G652D on screen.
  const attemptedSku = typeof data.sku === "string" ? data.sku : existing.sku;

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
  const IGNORE = new Set(["updatedBy", "status", "skuLower"]);
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
    // No retry here, unlike create: an update's SKU is always one a person typed (a blank is
    // rejected above), so it is never ours to silently replace.
    if (irmRepo.isSkuConflict(e)) throw skuConflict(attemptedSku);
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
