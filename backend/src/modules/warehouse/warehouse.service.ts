import type { Prisma } from "@prisma/client";

import * as warehouseRepo from "./warehouse.repository.js";
import type { WarehouseWithRelations } from "./warehouse.repository.js";
import * as warehouseTypeService from "#modules/warehouse-type/warehouse-type.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as goodsOutRepo from "#modules/goods-out/goods-out.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { geocodePostcode } from "../../lib/geocode.js";
import type { CreateWarehouseInput, UpdateWarehouseInput } from "./warehouse.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const STATUSES = ["active", "inactive"] as const;

// A manager as surfaced on a warehouse (resolved live from the User record).
export interface PublicWarehouseManager {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" dropdown
}

// The warehouse's operational type (resolved from the WarehouseType master).
export interface PublicWarehouseTypeRef {
  id: string;
  name: string;
}

export interface PublicWarehouse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: PublicWarehouseTypeRef | null;
  typeId: string | null;
  isDefault: boolean;
  // Address (UK).
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  // Geolocation — derived from the postcode; read-only.
  latitude: number | null;
  longitude: number | null;
  // Contact.
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Operational metadata (display-only).
  operatingHours: string | null;
  timezone: string | null;
  notes: string | null;
  // Manager.
  managerUserId: string | null;
  manager: PublicWarehouseManager | null;
  status: string;
  // Stock rollups — ZERO until the inventory ledger module is built (master-data only).
  // Surfaced now so the list columns + future wiring stay stable.
  totalStockItems: number;
  totalStockQuantity: number;
  // Audit.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedWarehouses {
  warehouses: PublicWarehouse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toManager(m: WarehouseWithRelations["manager"]): PublicWarehouseManager | null {
  if (!m) return null;
  return {
    id: m.id,
    name: `${m.firstName} ${m.lastName}`.trim() || m.email,
    email: m.email,
    jobTitle: m.jobTitle ?? m.role?.name ?? null,
  };
}

function toPublic(w: WarehouseWithRelations): PublicWarehouse {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    description: w.description,
    type: w.warehouseType ? { id: w.warehouseType.id, name: w.warehouseType.name } : null,
    typeId: w.typeId,
    isDefault: w.isDefault ?? false,
    addressLine1: w.addressLine1,
    addressLine2: w.addressLine2,
    city: w.city,
    county: w.county,
    postcode: w.postcode,
    country: w.country,
    latitude: w.latitude,
    longitude: w.longitude,
    contactPerson: w.contactPerson,
    contactEmail: w.contactEmail,
    contactPhone: w.contactPhone,
    operatingHours: w.operatingHours,
    timezone: w.timezone,
    notes: w.notes,
    managerUserId: w.managerUserId,
    manager: toManager(w.manager),
    status: w.status ?? "active",
    totalStockItems: 0,
    totalStockQuantity: 0,
    createdBy: w.createdBy,
    updatedBy: w.updatedBy,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

// Resolve + validate the optional manager. Returns the user id to store (or null).
// Throws if the id doesn't point to an active staff user.
async function resolveManager(managerUserId: string | null | undefined): Promise<string | null> {
  const id = managerUserId?.trim();
  if (!id) return null;
  const user = await userRepo.findById(id); // excludes soft-deleted
  if (!user) throw badRequest("Selected manager no longer exists.");
  if (user.status !== "active") throw badRequest("Selected manager is not an active user.");
  return user.id;
}

// Common scalar columns from create input (name/type/manager/default/coords set by the
// caller). Country defaults to United Kingdom; timezone to Europe/London.
function warehouseColumns(input: CreateWarehouseInput) {
  return {
    description: trimToNull(input.description),
    addressLine1: trimToNull(input.addressLine1),
    addressLine2: trimToNull(input.addressLine2),
    city: trimToNull(input.city),
    county: trimToNull(input.county),
    postcode: trimToNull(input.postcode),
    country: trimToNull(input.country) ?? "United Kingdom",
    contactPerson: trimToNull(input.contactPerson),
    contactEmail: trimToNull(input.contactEmail),
    contactPhone: trimToNull(input.contactPhone),
    operatingHours: trimToNull(input.operatingHours),
    timezone: input.timezone ?? "Europe/London",
    notes: trimToNull(input.notes),
    status: input.status ?? "active",
  };
}

export interface ListWarehousesParams {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listWarehouses(
  params: ListWarehousesParams = {},
  actor?: AuditActor,
): Promise<PagedWarehouses> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : undefined;
  // Warehouse-scoped users only ever see their assigned warehouses (undefined = unrestricted).
  const filters = { search: params.search, status, typeId: params.type, ids: warehouseScopeFilter(actor) };
  const total = await warehouseRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await warehouseRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { warehouses: rows.map(toPublic), total, page, pageSize, totalPages };
}

// Resolve by database id (24-hex) or warehouse code (so pages can route by the code). Enforces
// warehouse access on the RESOLVED id, so a scoped user can't reach an unassigned warehouse by
// either id OR code (direct-URL block).
export async function getWarehouse(idOrCode: string, actor?: AuditActor): Promise<PublicWarehouse> {
  const w = OBJECT_ID_RE.test(idOrCode)
    ? await warehouseRepo.findById(idOrCode)
    : await warehouseRepo.findByCode(idOrCode);
  if (!w) throw notFound("Warehouse not found.");
  assertWarehouseAccess(actor, w.id);
  return toPublic(w);
}

export async function createWarehouse(
  input: CreateWarehouseInput,
  actor?: AuditActor,
): Promise<PublicWarehouse> {
  const name = input.name.trim();
  if (!name) throw badRequest("Warehouse name is required.");

  // Type is required + must be an active WarehouseType.
  await warehouseTypeService.requireActiveWarehouseType(input.typeId);
  const managerUserId = await resolveManager(input.managerUserId);
  const coords = await geocodePostcode(input.postcode);
  const actorLabel = actor?.email ?? null;

  const created = await warehouseRepo.createWithCode({
    name,
    ...warehouseColumns(input),
    isDefault: input.isDefault ?? false,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    warehouseType: { connect: { id: input.typeId } },
    ...(managerUserId ? { manager: { connect: { id: managerUserId } } } : {}),
    createdBy: actorLabel,
    updatedBy: actorLabel,
  });

  // Enforce a single default: if this one is the default, demote the others. NOTE:
  // this create + demote is two ops, not one transaction, so a crash in between can
  // briefly leave two defaults. The ordering is deliberate (set first, demote second)
  // so the failure mode is two-defaults — never zero — and "find default" still
  // resolves. A transactional fix ($transaction needs a replica set) is deferred to the
  // inventory-era work, where a default warehouse first carries operational weight.
  if (created.isDefault) await warehouseRepo.unsetDefaultExcept(created.id);

  audit.record({
    actor,
    action: "warehouse.created",
    targetType: "warehouse",
    targetId: created.id,
    targetLabel: `${created.name} (${created.code})`,
  });
  return toPublic(created);
}

export async function updateWarehouse(
  id: string,
  input: UpdateWarehouseInput,
  actor?: AuditActor,
): Promise<PublicWarehouse> {
  const existing = await warehouseRepo.findById(id);
  if (!existing) throw notFound("Warehouse not found.");
  assertWarehouseAccess(actor, existing.id);

  // The default warehouse cannot become inactive — a default must always be live.
  const finalIsDefault = input.isDefault ?? existing.isDefault;
  const finalStatus = input.status ?? existing.status;
  if (finalIsDefault && finalStatus === "inactive") {
    throw conflict("Select another default warehouse first.");
  }

  // Unchecked input lets us set the scalar `typeId` / `managerUserId` FKs directly.
  const data: Prisma.WarehouseUncheckedUpdateInput = {};
  if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim();
  if (input.description !== undefined) data.description = trimToNull(input.description);
  if (input.addressLine1 !== undefined) data.addressLine1 = trimToNull(input.addressLine1);
  if (input.addressLine2 !== undefined) data.addressLine2 = trimToNull(input.addressLine2);
  if (input.city !== undefined) data.city = trimToNull(input.city);
  if (input.county !== undefined) data.county = trimToNull(input.county);
  if (input.country !== undefined) data.country = trimToNull(input.country);
  if (input.contactPerson !== undefined) data.contactPerson = trimToNull(input.contactPerson);
  if (input.contactEmail !== undefined) data.contactEmail = trimToNull(input.contactEmail);
  if (input.contactPhone !== undefined) data.contactPhone = trimToNull(input.contactPhone);
  if (input.operatingHours !== undefined) data.operatingHours = trimToNull(input.operatingHours);
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.notes !== undefined) data.notes = trimToNull(input.notes);

  // Type: validate + change only when a different active type is chosen.
  if (input.typeId !== undefined && input.typeId !== existing.typeId) {
    await warehouseTypeService.requireActiveWarehouseType(input.typeId);
    data.typeId = input.typeId;
  }

  // Re-geocode only when the postcode actually changed (best-effort; never blocks).
  if (input.postcode !== undefined) {
    const postcode = trimToNull(input.postcode);
    data.postcode = postcode;
    if (postcode !== existing.postcode) {
      const coords = await geocodePostcode(postcode);
      data.latitude = coords?.latitude ?? null;
      data.longitude = coords?.longitude ?? null;
    }
  }

  // --- granular events derived from old → new transitions -------------------
  const events: string[] = [];

  // Manager: only touch the relationship when it ACTUALLY changes (so editing other
  // fields still works after a manager was deactivated). Clear via the scalar FK.
  if (input.managerUserId !== undefined && input.managerUserId !== existing.managerUserId) {
    const resolved = input.managerUserId === null ? null : await resolveManager(input.managerUserId);
    data.managerUserId = resolved;
    events.push(resolved ? "warehouse.manager_assigned" : "warehouse.manager_removed");
  }

  // Default: setting this warehouse as the default is its own event.
  if (input.isDefault !== undefined) {
    data.isDefault = input.isDefault;
    if (input.isDefault && !existing.isDefault) events.push("warehouse.default_changed");
  }

  // Status: active ↔ inactive transitions are activate / deactivate events.
  if (input.status !== undefined && input.status !== existing.status) {
    data.status = input.status;
    events.push(input.status === "active" ? "warehouse.activated" : "warehouse.deactivated");
  }

  // Any non-transition field change is a generic "updated".
  const scalarChanged =
    (data.name !== undefined && data.name !== existing.name) ||
    (data.description !== undefined && data.description !== existing.description) ||
    (data.typeId !== undefined && data.typeId !== existing.typeId) ||
    (data.addressLine1 !== undefined && data.addressLine1 !== existing.addressLine1) ||
    (data.addressLine2 !== undefined && data.addressLine2 !== existing.addressLine2) ||
    (data.city !== undefined && data.city !== existing.city) ||
    (data.county !== undefined && data.county !== existing.county) ||
    (data.country !== undefined && data.country !== existing.country) ||
    (data.postcode !== undefined && data.postcode !== existing.postcode) ||
    (data.contactPerson !== undefined && data.contactPerson !== existing.contactPerson) ||
    (data.contactEmail !== undefined && data.contactEmail !== existing.contactEmail) ||
    (data.contactPhone !== undefined && data.contactPhone !== existing.contactPhone) ||
    (data.operatingHours !== undefined && data.operatingHours !== existing.operatingHours) ||
    (data.timezone !== undefined && data.timezone !== existing.timezone) ||
    (data.notes !== undefined && data.notes !== existing.notes);
  if (scalarChanged) events.push("warehouse.updated");

  data.updatedBy = actor?.email ?? null;

  const updated = await warehouseRepo.update(id, data);
  // Same non-atomic two-step as createWarehouse (set this default, then demote the rest):
  // fails safe to two-defaults, never zero. Transactional fix deferred to inventory-era.
  if (input.isDefault === true) await warehouseRepo.unsetDefaultExcept(updated.id);

  // Record every transition that happened (fall back to "updated" for a no-op save).
  const label = `${updated.name} (${updated.code})`;
  for (const action of events.length ? events : ["warehouse.updated"]) {
    audit.record({ actor, action, targetType: "warehouse", targetId: id, targetLabel: label });
  }
  return toPublic(updated);
}

// A future dependency-checker: returns how many records of a given kind reference this
// warehouse. Each inventory-era module registers one here; all are no-ops today.
type DependencyChecker = { label: string; count: (warehouseId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "purchase orders", count: (id) => poRepo.countByWarehouse(id) },
  { label: "goods receipts", count: (id) => grnRepo.countByWarehouse(id) },
  { label: "inventory", count: (id) => inventoryRepo.countBalancesWithStockByWarehouse(id) },
  { label: "dispatches", count: (id) => goodsOutRepo.countByWarehouse(id) },
  // FUTURE: { label: "jobs", count: (id) => jobRepo.countByWarehouse(id) },
  // FUTURE: { label: "transfers", count: (id) => transferRepo.countOpenByWarehouse(id) },
  // FUTURE: { label: "allocations", count: (id) => allocationRepo.countByWarehouse(id) },
];

// Blocks deletion when ANY dependency still references the warehouse. No-op today (the
// checker list is empty until the inventory-era modules ship), but the seam is here so
// adding a checker is the only change needed later.
async function assertWarehouseDeletable(warehouseId: string): Promise<void> {
  for (const checker of DELETE_DEPENDENCY_CHECKERS) {
    if ((await checker.count(warehouseId)) > 0) {
      throw conflict("This warehouse is in use. Move inventory first.");
    }
  }
}

// Soft-delete (history stays intact). Guarded by assertWarehouseDeletable so that, once
// inventory/jobs/transfers/allocations exist, an in-use warehouse must be deactivated
// instead of deleted.
export async function deleteWarehouse(id: string, actor?: AuditActor): Promise<void> {
  const w = await warehouseRepo.findById(id);
  if (!w) throw notFound("Warehouse not found.");
  assertWarehouseAccess(actor, w.id);

  // The default warehouse can never be removed — a default must always exist (mirrors
  // the deactivate-default guard in updateWarehouse). Promote another first.
  if (w.isDefault) {
    throw conflict("Select another default warehouse before deleting this warehouse.");
  }

  await assertWarehouseDeletable(id);

  await warehouseRepo.softDelete(id);
  audit.record({
    actor,
    action: "warehouse.deleted",
    targetType: "warehouse",
    targetId: id,
    targetLabel: `${w.name} (${w.code})`,
  });
}

// Active warehouses for a picker (id/code/name only) — e.g. the user form's "Assigned Warehouses"
// multi-select. Lean by design (mirrors listManagerOptions): never pages the full warehouse records.
export interface PublicWarehouseOption {
  id: string;
  code: string;
  name: string;
}
// Scoped to the actor: a warehouse-scoped user (e.g. Warehouse Manager) only gets their assigned
// warehouses; everyone else gets all active warehouses. Server-side — the picker can't be widened.
export async function listWarehouseOptions(actor?: AuditActor): Promise<PublicWarehouseOption[]> {
  return warehouseRepo.findOptions(warehouseScopeFilter(actor));
}

// Active staff users for the manager dropdown (id + display name + email + job title).
export async function listManagerOptions(): Promise<PublicWarehouseManager[]> {
  const users = await warehouseRepo.findManagerOptions();
  return users.map((u) => ({
    id: u.id,
    name: `${u.firstName} ${u.lastName}`.trim() || u.email,
    email: u.email,
    jobTitle: u.jobTitle ?? u.role?.name ?? null,
  }));
}

// Plug-in seam for FUTURE inventory modules (Goods In/Out, Transfers, Dispatch):
// assert a warehouse id points to an existing ACTIVE warehouse before recording a
// movement against it. Mirrors categoryService.requireActiveCategory.
export async function requireActiveWarehouse(warehouseId: string): Promise<WarehouseWithRelations> {
  if (!warehouseId || !OBJECT_ID_RE.test(warehouseId)) throw badRequest("Select a warehouse.");
  const w = await warehouseRepo.findById(warehouseId);
  if (!w) throw badRequest("Selected warehouse no longer exists.");
  if ((w.status ?? "active") !== "active") {
    throw conflict("Selected warehouse is inactive and can't be used for stock movements.");
  }
  return w;
}
