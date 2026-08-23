import type { Prisma } from "@prisma/client";

import * as rentalRepo from "./rental-item.repository.js";
import type { RentalItemWithCategory } from "./rental-item.repository.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { requireActiveRentalCategory } from "#modules/rental-category/rental-category.service.js";
import { getRentalCodePrefix } from "#modules/settings/settings.service.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import { hireAvailable } from "#modules/purchase-order/rentalHire.allocation.js";
import type { CreateRentalItemInput, UpdateRentalItemInput } from "./rental-item.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicRentalItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  rentalCategoryId: string;
  rentalCategoryName: string | null;
  baseUnit: string;
  notes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublic(i: RentalItemWithCategory): PublicRentalItem {
  return {
    id: i.id,
    code: i.code,
    name: i.name,
    description: i.description,
    status: i.status ?? "active",
    rentalCategoryId: i.rentalCategoryId,
    rentalCategoryName: i.rentalCategory?.name ?? null,
    baseUnit: i.baseUnit,
    notes: i.notes,
    createdBy: i.createdBy,
    updatedBy: i.updatedBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export interface ListRentalItemsParams {
  status?: string;
  categoryId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  /**
   * Raises the 200-row page cap for a SERVER-INITIATED read — only the CSV export sets it.
   * Not reachable from the wire: the controller builds these params field by field out of
   * `req.query` and never copies this one. See EXPORT_PAGING in utils/csv.ts.
   */
  maxPageSize?: number;
}

export async function listRentalItems(
  params: ListRentalItemsParams,
): Promise<{ items: PublicRentalItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, params.page ?? 1);
  // 200 is the ceiling for anything a CLIENT can ask for; only a server-initiated read may lift it
  // by passing maxPageSize. Without that escape hatch the CSV export asked for the whole catalogue,
  // was silently clamped to 200, and reported the short file as complete.
  const pageSize = Math.min(params.maxPageSize ?? 200, Math.max(1, params.pageSize ?? 20));
  const { items, total } = await rentalRepo.findMany({
    status: params.status,
    categoryId: params.categoryId,
    search: params.search,
    page,
    pageSize,
  });
  return { items: items.map(toPublic), total, page, pageSize };
}

export async function getRentalItem(idOrCode: string): Promise<PublicRentalItem> {
  const item = OBJECT_ID_RE.test(idOrCode)
    ? await rentalRepo.findById(idOrCode)
    : await rentalRepo.findByCode(idOrCode);
  if (!item) throw notFound("Rental item not found.");
  return toPublic(item);
}

// ── The printable label ────────────────────────────────────────────────────────────────────────
//
// Hired kit arrives at our warehouse and needs a sticker on it, so a rental item has a barcode like
// an IRM item does. What it does NOT have is a stored image.
//
// The label is `Code128(code)` and nothing else, and `code` is allocated once and never freed — so
// the image is a pure function of a value that cannot change. IRM persists its own image because IRM
// also carries a MANUFACTURER barcode, a value no code can be derived from; that reason does not
// exist here. Persisting a deterministic render would buy nothing and cost the two problems that
// come with a cache: a "generate it first" step before anyone can print, and rows created before the
// column existed needing a backfill. Rendering on read means every rental item — the ones added
// today and the ones already in the database — has a label, always, with nothing to generate and
// nothing to migrate.
//
// Settings are IRM's, exactly: the same printer, the same 50×30mm stock, so the two labels are
// indistinguishable in a warehouse drawer.
const barcodeCache = new Map<string, string>();

/** Code128 of a rental item's code, as a base64 PNG data URI. */
export async function renderBarcode(idOrCode: string): Promise<{ code: string; barcodeDataUri: string }> {
  const item = OBJECT_ID_RE.test(idOrCode)
    ? await rentalRepo.findById(idOrCode)
    : await rentalRepo.findByCode(idOrCode);
  if (!item) throw notFound("Rental item not found.");

  // Keyed by the code, which is immutable — so a cache hit can never be a stale label. Bounded by the
  // size of the rental catalogue, and only ever holds codes someone has actually opened.
  const cached = barcodeCache.get(item.code);
  if (cached) return { code: item.code, barcodeDataUri: cached };

  const bwipjs = await import("bwip-js");
  const pngBuffer = await bwipjs.default.toBuffer({
    bcid: "code128",
    text: item.code,
    scale: 3,
    height: 10,
    includetext: true,
    textxalign: "center",
  });
  const barcodeDataUri = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  barcodeCache.set(item.code, barcodeDataUri);
  return { code: item.code, barcodeDataUri };
}

export async function createRentalItem(
  input: CreateRentalItemInput,
  actor?: AuditActor,
): Promise<PublicRentalItem> {
  await requireActiveRentalCategory(input.rentalCategoryId);

  // Configurable in Settings → Branding, like the IRM item, staff and stock-entry prefixes. Read at
  // CREATE time only: a code, once allocated, is permanent — the sticker on the kit says so.
  const codePrefix = await getRentalCodePrefix();

  const created = await rentalRepo.createWithCode({
    name: input.name.trim(),
    description: input.description?.trim() || null,
    status: input.status ?? "active",
    rentalCategory: { connect: { id: input.rentalCategoryId } },
    baseUnit: input.baseUnit.trim(),
    notes: input.notes?.trim() || null,
    createdBy: actor?.email ?? null,
    updatedBy: actor?.email ?? null,
  }, codePrefix);

  audit.record({
    actor,
    action: "rental_item.created",
    targetType: "rental_item",
    targetId: created.id,
    targetLabel: created.code,
  });
  return toPublic(created);
}

export async function updateRentalItem(
  id: string,
  input: UpdateRentalItemInput,
  actor?: AuditActor,
): Promise<PublicRentalItem> {
  const existing = await rentalRepo.findById(id);
  if (!existing) throw notFound("Rental item not found.");

  const data: Prisma.RentalItemUpdateInput = { updatedBy: actor?.email ?? null };
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description.trim() || null;
  if (input.status !== undefined) data.status = input.status;
  if (input.rentalCategoryId !== undefined && input.rentalCategoryId !== existing.rentalCategoryId) {
    await requireActiveRentalCategory(input.rentalCategoryId);
    data.rentalCategory = { connect: { id: input.rentalCategoryId } };
  }
  if (input.baseUnit !== undefined) data.baseUnit = input.baseUnit.trim();
  if (input.notes !== undefined) data.notes = input.notes.trim() || null;

  const updated = await rentalRepo.update(id, data);
  audit.record({
    actor,
    action: "rental_item.updated",
    targetType: "rental_item",
    targetId: id,
    targetLabel: updated.code,
  });
  return toPublic(updated);
}

// Anything that would be orphaned by removing the item. Mirrors the IRM dependency-checker shape:
// one entry per referencing table, so adding a future reference is one line here rather than a
// forgotten hole.
type DependencyChecker = { label: string; count: (itemId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "purchase requests", count: (id) => rentalRepo.countByPrfLines(id) },
  { label: "purchase orders", count: (id) => rentalRepo.countByPoLines(id) },
  // Both added when hired kit became plannable on jobs. Without them a rental item could be retired
  // out from under live work: a job's kit list left naming a catalogue entry no picker shows any
  // more, or — worse — an engineer still physically carrying one.
  { label: "job kit lists", count: (id) => rentalRepo.countByJobKitLines(id) },
  { label: "engineer-held hires", count: (id) => rentalCustodyRepo.countHeldRentalsByRentalItem(id) },
];

export async function deleteRentalItem(id: string, actor?: AuditActor): Promise<void> {
  const existing = await rentalRepo.findById(id);
  if (!existing) throw notFound("Rental item not found.");

  for (const checker of DELETE_DEPENDENCY_CHECKERS) {
    if ((await checker.count(id)) > 0) {
      throw conflict(`This rental item is in use by existing ${checker.label}. Remove dependencies first.`);
    }
  }
  await rentalRepo.softDelete(id, actor?.email ?? null);
  audit.record({
    actor,
    action: "rental_item.deleted",
    targetType: "rental_item",
    targetId: id,
    targetLabel: existing.code,
  });
}

/**
 * The live rows behind a set of ids, keyed by id — the snapshot source for a PRF rental line.
 *
 * Separate from `requireActiveRentalItems` so the caller validates once and reads once, rather
 * than a lookup per line.
 */
export async function getRentalItemsByIds(ids: string[]): Promise<Map<string, { name: string; baseUnit: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await rentalRepo.findActiveByIds(unique);
  // Name and unit only. There is no rate or VAT to snapshot — those belong to the line, which
  // carries the price actually agreed for that hire.
  return new Map(rows.map((r) => [r.id, { name: r.name, baseUnit: r.baseUnit }]));
}

/**
 * Every id must still be a live, ACTIVE rental item.
 *
 * Called at conversion so a purchase order is never issued for an item that was retired while the
 * request sat waiting for approval — the same guard `requireActiveIrmItems` gives the IRM lines.
 */
export async function requireActiveRentalItems(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await rentalRepo.findActiveByIds(unique);
  if (found.length !== unique.length) {
    throw badRequest("One or more rental items are no longer active. Remove them from the request.");
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────────────────────

// The row ceiling and the paging that reaches it both come from utils/csv.ts. A local copy is how
// two exports end up disagreeing about what "capped" means — the shared constant's own note says so.

export async function exportRentalItemsCsv(
  params: ListRentalItemsParams,
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: listRentalItems caps a page at 200 for anything a client
  // asks for, so without the maxPageSize this spreads, the export stopped at 200 rows.
  const { items, total } = await listRentalItems({ ...params, ...EXPORT_PAGING });
  const rows = items.slice(0, EXPORT_MAX).map((i) => [
    i.code,
    i.name,
    i.rentalCategoryName,
    i.status,
    i.baseUnit,
    i.description,
    i.notes,
  ]);
  const csv = toCsv(
    // No price column: this is a catalogue of what can be hired, not a rate card.
    ["Code", "Name", "Category", "Status", "Unit", "Description", "Notes"],
    rows,
  );
  audit.record({
    actor,
    action: "rental_item.exported",
    targetType: "rental_item",
    targetLabel: `${rows.length} items`,
  });
  return { csv, capped: total > rows.length };
}

/** One depot that currently holds this hired item, and how many units are free to take. */
export interface RentalItemWarehouseAvailability {
  warehouseId: string;
  warehouseName: string | null;
  warehouseCode: string | null;
  available: number;
  /** The soonest deadline among the hires stocking this depot — what a planner needs to see. */
  nextDueBack: string | null;
}

/**
 * Where a hired item can be collected right now, and how many are free at each depot.
 *
 * The rental twin of the inventory module's per-warehouse stock read, and it exists for the same
 * reason: the job form asks "which depot do I send the engineer to", and for a hire that question has
 * no answer in the catalogue — a RentalItem deliberately carries no quantity at all. The answer lives
 * on the live hires, whose warehouse is their ORDER's delivery warehouse.
 *
 * Depots with nothing free are omitted rather than listed as zero: this feeds a picker, and an option
 * that cannot be chosen is noise.
 */
export async function getRentalItemAvailability(idOrCode: string): Promise<RentalItemWarehouseAvailability[]> {
  const item = await getRentalItem(idOrCode);
  const hires = await poRepo.findLiveHiresByRentalItems([item.id]);

  const byWarehouse = new Map<string, RentalItemWarehouseAvailability>();
  for (const h of hires) {
    const free = hireAvailable(h);
    if (free <= 0) continue;
    const due = h.hireEndDate.toISOString();
    const row = byWarehouse.get(h.warehouseId);
    if (row) {
      row.available += free;
      if (!row.nextDueBack || due < row.nextDueBack) row.nextDueBack = due;
    } else {
      byWarehouse.set(h.warehouseId, {
        warehouseId: h.warehouseId,
        warehouseName: h.warehouseName,
        warehouseCode: h.warehouseCode,
        available: free,
        nextDueBack: due,
      });
    }
  }
  return [...byWarehouse.values()].sort((a, b) => (b.available - a.available) || (a.warehouseName ?? "").localeCompare(b.warehouseName ?? ""));
}
