import type { Prisma } from "@prisma/client";

import * as warehouseRepo from "./warehouse.repository.js";
import type { WarehouseWithRelations } from "./warehouse.repository.js";
import * as warehouseTypeService from "#modules/warehouse-type/warehouse-type.service.js";
import * as userWarehouseRepo from "#modules/user/user-warehouse.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as goodsManagementRepo from "#modules/goods-management/goods-management.repository.js";
import * as vanStockRequestRepo from "#modules/van-stock-request/van-stock-request.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import { getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { geocodePostcode } from "../../lib/geocode.js";
import type { CreateWarehouseInput, UpdateWarehouseInput } from "./warehouse.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const STATUSES = ["active", "inactive"] as const;

// A staff user in a picker (the engineer dropdowns) — id + label only.
export interface PublicWarehouseManager {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" dropdown
}

// A warehouse's manager, DERIVED from the Users & Roles assignment. Carries the name parts +
// profile image on top of the picker shape so the UI can render the standard staff avatar chip
// and link through to the user's page.
export interface PublicWarehouseManagerRef extends PublicWarehouseManager {
  firstName: string;
  lastName: string;
  // The warehouse's own contact fields are separate data (they go to suppliers, couriers and the
  // engineers collecting a kit — a site contact isn't always a system user). This is here purely so
  // the form can OFFER to copy the manager's details into them; nothing derives from it.
  phone: string | null;
  profileImageUrl: string | null;
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
  // Managers — DERIVED, read-only. The staff assigned to this warehouse under Users & Roles
  // (warehouse-scoped roles only). Never set from the warehouse form; empty when nobody is
  // assigned. See userWarehouseRepo.listManagersForWarehouses.
  managers: PublicWarehouseManagerRef[];
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

function toManager(u: userWarehouseRepo.WarehouseManagerAssignment["user"]): PublicWarehouseManagerRef {
  return {
    id: u.id,
    name: `${u.firstName} ${u.lastName}`.trim() || u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    phone: u.phone,
    jobTitle: u.jobTitle ?? u.role?.name ?? null,
    profileImageUrl: u.profileImageUrl,
  };
}

// Managers per warehouse id, in assignment order. One query for the whole page (never per row).
async function managersByWarehouse(warehouseIds: string[]): Promise<Map<string, PublicWarehouseManagerRef[]>> {
  const rows = await userWarehouseRepo.listManagersForWarehouses(warehouseIds);
  const byWarehouse = new Map<string, PublicWarehouseManagerRef[]>();
  for (const row of rows) {
    const list = byWarehouse.get(row.warehouseId);
    if (list) list.push(toManager(row.user));
    else byWarehouse.set(row.warehouseId, [toManager(row.user)]);
  }
  return byWarehouse;
}

// Resolve the derived managers for a SINGLE warehouse (create/update/get responses).
async function withManagers(w: WarehouseWithRelations): Promise<PublicWarehouse> {
  const byWarehouse = await managersByWarehouse([w.id]);
  return toPublic(w, byWarehouse.get(w.id) ?? []);
}

function toPublic(w: WarehouseWithRelations, managers: PublicWarehouseManagerRef[]): PublicWarehouse {
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
    managers,
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

// Common scalar columns from create input (name/type/default/coords set by the
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
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export async function listWarehouses(
  params: ListWarehousesParams = {},
  actor?: AuditActor,
): Promise<PagedWarehouses> {
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : undefined;
  // Warehouse-scoped users only ever see their assigned warehouses (undefined = unrestricted).
  const filters = { search: params.search, status, typeId: params.type, ids: warehouseScopeFilter(actor) };
  const total = await warehouseRepo.count(filters);
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await warehouseRepo.findMany(filters, skip, pageSize, params.sort);
  const managers = await managersByWarehouse(rows.map((r) => r.id));
  return {
    warehouses: rows.map((r) => toPublic(r, managers.get(r.id) ?? [])),
    total,
    page,
    pageSize,
    totalPages,
  };
}

/**
 * The SAME filtered list as a CSV, minus paging. Delegates to listWarehouses with one oversized page
 * rather than re-deriving the filters — the warehouse SCOPE lives in there, so a scoped manager's
 * download stays their own warehouses and can never quietly widen to the company's.
 */
export async function exportWarehousesCsv(
  params: ListWarehousesParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  const { warehouses } = await listWarehouses({ ...params, ...EXPORT_PAGING }, actor);
  const rows = warehouses.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const csv = toCsv(
    [
      "Code", "Name", "Type", "Status", "Default",
      "Address 1", "Address 2", "City", "County", "Postcode", "Country",
      "Contact", "Email", "Phone", "Managers", `Added (${regional.timezone})`,
    ],
    rows.map((w) => [
      w.code,
      w.name,
      w.type?.name,
      w.status,
      w.isDefault ? "Yes" : "No",
      w.addressLine1,
      w.addressLine2,
      w.city,
      w.county,
      w.postcode,
      w.country,
      w.contactPerson,
      w.contactEmail,
      w.contactPhone,
      // Every assigned manager on one line — the column answers "who runs this site?", which is a
      // list, and one row per manager would turn a warehouse master into a duplicated one.
      w.managers.map((m) => m.name).filter(Boolean).join(" | "),
      formatDate(w.createdAt, regional.dateFormat, regional.timezone),
    ]),
  );

  // lat/long are omitted: derived from the postcode, never hand-entered, and nothing reads them
  // outside the map. The postcode above is the real, editable location.
  audit.record({ actor, action: "warehouse.exported", targetType: "warehouse", targetLabel: `${rows.length} rows` });
  return { csv, capped: warehouses.length > EXPORT_MAX };
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
  return withManagers(w);
}

export async function createWarehouse(
  input: CreateWarehouseInput,
  actor?: AuditActor,
): Promise<PublicWarehouse> {
  const name = input.name.trim();
  if (!name) throw badRequest("Warehouse name is required.");

  // Type is required + must be an active WarehouseType.
  await warehouseTypeService.requireActiveWarehouseType(input.typeId);
  const coords = await geocodePostcode(input.postcode);
  const actorLabel = actor?.email ?? null;

  const created = await warehouseRepo.createWithCode({
    name,
    ...warehouseColumns(input),
    isDefault: input.isDefault ?? false,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    warehouseType: { connect: { id: input.typeId } },
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
  return withManagers(created);
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

  // Unchecked input lets us set the scalar `typeId` FK directly.
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
  return withManagers(updated);
}

// A dependency checker: how many records of a given kind still reference this warehouse. Each module
// that stores a warehouseId registers one here.
type DependencyChecker = { label: string; count: (warehouseId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "purchase requests", count: (id) => prfRepo.countByWarehouse(id) },
  { label: "purchase orders", count: (id) => poRepo.countByWarehouse(id) },
  { label: "goods receipts", count: (id) => grnRepo.countByWarehouse(id) },
  { label: "inventory", count: (id) => inventoryRepo.countBalancesWithStockByWarehouse(id) },
  // These two were left as FUTURE while the modules were being built. They have shipped, and the
  // comment going stale left a real hole: a warehouse holding NO stock but still named as the pickup
  // point on live job kit lines, or still storing a customer's consignment entries, could be deleted.
  // Every read filters deleted warehouses out, so those rows were left pointing at nothing — the
  // engineer's job pack could no longer say where to collect.
  { label: "jobs", count: (id) => jobRepo.countLiveKitLinesByWarehouse(id) },
  { label: "customer stock", count: (id) => customerRepo.countStockEntriesWithStockByWarehouse(id) },
  // The last two models that carry a warehouseId. Damaged stock is invisible to the `inventory`
  // checker above — a unit has already left InventoryBalance by the time it lands in the damaged
  // pool — so a warehouse holding nothing else reads as empty and deleting it strands the pool.
  // An open van-stock request is the job-kit-line case again: it names where the engineer collects.
  { label: "damaged stock", count: (id) => goodsManagementRepo.countDamagedByWarehouse(id) },
  { label: "van stock requests", count: (id) => vanStockRequestRepo.countOpenByWarehouse(id) },
  // Customer stock arriving, as opposed to customer stock already here. An unreceived assignment has
  // created no CustomerStockEntry yet, so the `customer stock` checker above reads zero for a
  // warehouse whose only tie to a customer is an inbound delivery — and deleting it loses that
  // delivery out of the Incoming queue.
  { label: "incoming customer deliveries", count: (id) => customerRepo.countOpenAssignmentsByWarehouse(id) },
  // Engineer-to-engineer transfers are van-to-van and hold no warehouse reference, so there is
  // nothing for them to check here.
  //
  // Not every model carrying a warehouseId is checked, and that is deliberate rather than a gap:
  //   - InventoryTransaction, StockAdjustment, JobStockMovement, DamagedStockTransaction are LEDGERS.
  //     They only ever grow, so blocking on them would make any warehouse that ever moved a unit
  //     permanently undeletable — a guard nobody could satisfy. They snapshot warehouseName/Code for
  //     exactly this reason and read correctly without the warehouse row.
  //   - UserWarehouseAssignment is a staff posting, not stock. The rows go inert on delete and no
  //     read breaks; demanding managers be unassigned first would be ceremony, not safety.
  // What IS covered is every model where a live row means physical stock, or a person, is still
  // expected at this warehouse. Add a checker when a new model joins THAT set.
];

// Blocks deletion when ANY dependency still references the warehouse. Sequential, not Promise.all:
// the first checker that finds something ends it, and the common case (a warehouse in active use)
// trips on the first or second, so there is nothing to gain by running the whole list every time.
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
// multi-select. Lean by design: never pages the full warehouse records.
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

// Active FIELD ENGINEERS (canHoldStock roles) for the "assign an engineer" dropdowns on jobs and
// dispatches — role-filtered so only assignable engineers show.
export async function listEngineerOptions(): Promise<PublicWarehouseManager[]> {
  const users = await warehouseRepo.findEngineerOptions();
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
