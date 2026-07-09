import type { Prisma } from "@prisma/client";

import * as supplierRepo from "./supplier.repository.js";
import type { SupplierWithRelations } from "./supplier.repository.js";
import * as supplierTypeService from "#modules/supplier-type/supplier-type.service.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import type { CreateSupplierInput, UpdateSupplierInput } from "./supplier.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const STATUSES = ["active", "inactive"] as const;

// An owner as surfaced on a supplier (resolved live from the User record).
export interface PublicSupplierOwner {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null; // designation or role name — for the "Name — Role" dropdown
}

// The supplier's classification (resolved from the SupplierType master).
export interface PublicSupplierTypeRef {
  id: string;
  name: string;
}

export interface PublicSupplier {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  description: string | null;
  type: PublicSupplierTypeRef | null;
  typeId: string | null;
  status: string;
  // Contact.
  contactPerson: string | null;
  contactJobTitle: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  // Business.
  companyRegistrationNumber: string | null;
  vatNumber: string | null;
  website: string | null;
  // Address (UK).
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  // Payment.
  paymentTerms: string | null;
  customPaymentTerms: string | null;
  currency: string | null;
  // Operational.
  leadTimeDays: number | null;
  notes: string | null;
  // Internal owner.
  ownerUserId: string | null;
  owner: PublicSupplierOwner | null;
  // Audit.
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagedSuppliers {
  suppliers: PublicSupplier[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toOwner(o: SupplierWithRelations["owner"]): PublicSupplierOwner | null {
  if (!o) return null;
  return {
    id: o.id,
    name: `${o.firstName} ${o.lastName}`.trim() || o.email,
    email: o.email,
    jobTitle: o.jobTitle ?? o.role?.name ?? null,
  };
}

function toPublic(s: SupplierWithRelations): PublicSupplier {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    legalName: s.legalName,
    description: s.description,
    type: s.supplierType ? { id: s.supplierType.id, name: s.supplierType.name } : null,
    typeId: s.typeId,
    status: s.status ?? "active",
    contactPerson: s.contactPerson,
    contactJobTitle: s.contactJobTitle,
    contactEmail: s.contactEmail,
    contactPhone: s.contactPhone,
    companyRegistrationNumber: s.companyRegistrationNumber,
    vatNumber: s.vatNumber,
    website: s.website,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    county: s.county,
    postcode: s.postcode,
    country: s.country,
    paymentTerms: s.paymentTerms,
    customPaymentTerms: s.customPaymentTerms,
    currency: s.currency ?? "GBP",
    leadTimeDays: s.leadTimeDays,
    notes: s.notes,
    ownerUserId: s.ownerUserId,
    owner: toOwner(s.owner),
    createdBy: s.createdBy,
    updatedBy: s.updatedBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const trimToNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

// Resolve + validate the optional owner. Returns the user id to store (or null).
// Throws if the id doesn't point to an active staff user.
async function resolveOwner(ownerUserId: string | null | undefined): Promise<string | null> {
  const id = ownerUserId?.trim();
  if (!id) return null;
  const user = await userRepo.findById(id); // excludes soft-deleted
  if (!user) throw badRequest("Selected owner no longer exists.");
  if (user.status !== "active") throw badRequest("Selected owner is not an active user.");
  return user.id;
}

// Common scalar columns from create input (name/type/owner set by the caller). Country
// defaults to United Kingdom; currency to GBP; customPaymentTerms only kept for "Custom".
function supplierColumns(input: CreateSupplierInput) {
  const paymentTerms = input.paymentTerms ?? null;
  return {
    legalName: trimToNull(input.legalName),
    description: trimToNull(input.description),
    contactPerson: trimToNull(input.contactPerson),
    contactJobTitle: trimToNull(input.contactJobTitle),
    contactEmail: trimToNull(input.contactEmail),
    contactPhone: trimToNull(input.contactPhone),
    companyRegistrationNumber: trimToNull(input.companyRegistrationNumber),
    vatNumber: trimToNull(input.vatNumber),
    website: trimToNull(input.website),
    addressLine1: trimToNull(input.addressLine1),
    addressLine2: trimToNull(input.addressLine2),
    city: trimToNull(input.city),
    county: trimToNull(input.county),
    postcode: trimToNull(input.postcode),
    country: trimToNull(input.country) ?? "United Kingdom",
    paymentTerms,
    customPaymentTerms: paymentTerms === "Custom" ? trimToNull(input.customPaymentTerms) : null,
    currency: input.currency ?? "GBP",
    leadTimeDays: input.leadTimeDays ?? null,
    notes: trimToNull(input.notes),
    status: input.status ?? "active",
  };
}

export interface ListSuppliersParams {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export async function listSuppliers(params: ListSuppliersParams = {}): Promise<PagedSuppliers> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const status =
    params.status && (STATUSES as readonly string[]).includes(params.status)
      ? params.status
      : undefined;
  const filters = { search: params.search, status, typeId: params.type };
  const total = await supplierRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const rows = await supplierRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { suppliers: rows.map(toPublic), total, page, pageSize, totalPages };
}

// Resolve by database id (24-hex) or supplier code (so pages can route by the code).
export async function getSupplier(idOrCode: string): Promise<PublicSupplier> {
  const s = OBJECT_ID_RE.test(idOrCode)
    ? await supplierRepo.findById(idOrCode)
    : await supplierRepo.findByCode(idOrCode);
  if (!s) throw notFound("Supplier not found.");
  return toPublic(s);
}

export async function createSupplier(
  input: CreateSupplierInput,
  actor?: AuditActor,
): Promise<PublicSupplier> {
  const name = input.name.trim();
  if (!name) throw badRequest("Supplier name is required.");

  // Type is required + must be an active SupplierType.
  await supplierTypeService.requireActiveSupplierType(input.typeId);
  const ownerUserId = await resolveOwner(input.ownerUserId);
  const actorLabel = actor?.email ?? null;

  const created = await supplierRepo.createWithCode({
    name,
    ...supplierColumns(input),
    supplierType: { connect: { id: input.typeId } },
    ...(ownerUserId ? { owner: { connect: { id: ownerUserId } } } : {}),
    createdBy: actorLabel,
    updatedBy: actorLabel,
  });

  audit.record({
    actor,
    action: "supplier.created",
    targetType: "supplier",
    targetId: created.id,
    targetLabel: `${created.name} (${created.code})`,
  });
  return toPublic(created);
}

export async function updateSupplier(
  id: string,
  input: UpdateSupplierInput,
  actor?: AuditActor,
): Promise<PublicSupplier> {
  const existing = await supplierRepo.findById(id);
  if (!existing) throw notFound("Supplier not found.");

  // Unchecked input lets us set the scalar `typeId` / `ownerUserId` FKs directly.
  const data: Prisma.SupplierUncheckedUpdateInput = {};
  if (typeof input.name === "string" && input.name.trim()) data.name = input.name.trim();
  if (input.legalName !== undefined) data.legalName = trimToNull(input.legalName);
  if (input.description !== undefined) data.description = trimToNull(input.description);
  if (input.contactPerson !== undefined) data.contactPerson = trimToNull(input.contactPerson);
  if (input.contactJobTitle !== undefined) data.contactJobTitle = trimToNull(input.contactJobTitle);
  if (input.contactEmail !== undefined) data.contactEmail = trimToNull(input.contactEmail);
  if (input.contactPhone !== undefined) data.contactPhone = trimToNull(input.contactPhone);
  if (input.companyRegistrationNumber !== undefined)
    data.companyRegistrationNumber = trimToNull(input.companyRegistrationNumber);
  if (input.vatNumber !== undefined) data.vatNumber = trimToNull(input.vatNumber);
  if (input.website !== undefined) data.website = trimToNull(input.website);
  if (input.addressLine1 !== undefined) data.addressLine1 = trimToNull(input.addressLine1);
  if (input.addressLine2 !== undefined) data.addressLine2 = trimToNull(input.addressLine2);
  if (input.city !== undefined) data.city = trimToNull(input.city);
  if (input.county !== undefined) data.county = trimToNull(input.county);
  if (input.postcode !== undefined) data.postcode = trimToNull(input.postcode);
  if (input.country !== undefined) data.country = trimToNull(input.country);
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.leadTimeDays !== undefined) data.leadTimeDays = input.leadTimeDays;
  if (input.notes !== undefined) data.notes = trimToNull(input.notes);

  // Payment terms: normalise the term + its custom text together. "Custom" requires the
  // free-text value (checked against the existing record for partial patches); any other
  // term clears the custom text so it can't linger.
  if (input.paymentTerms !== undefined) data.paymentTerms = input.paymentTerms;
  if (input.customPaymentTerms !== undefined) data.customPaymentTerms = trimToNull(input.customPaymentTerms);
  const finalTerms = input.paymentTerms !== undefined ? input.paymentTerms : existing.paymentTerms;
  if (finalTerms === "Custom") {
    const finalCustom =
      input.customPaymentTerms !== undefined
        ? trimToNull(input.customPaymentTerms)
        : existing.customPaymentTerms;
    if (!finalCustom) throw badRequest("Enter the custom payment terms.");
  } else if (existing.customPaymentTerms || input.customPaymentTerms !== undefined) {
    data.customPaymentTerms = null;
  }

  // Type: validate + change only when a different active type is chosen.
  if (input.typeId !== undefined && input.typeId !== existing.typeId) {
    await supplierTypeService.requireActiveSupplierType(input.typeId);
    data.typeId = input.typeId;
  }

  // --- granular events derived from old → new transitions -------------------
  const events: string[] = [];

  // Owner: only touch the relationship when it ACTUALLY changes (so editing other fields
  // still works after an owner was deactivated). Clear via the scalar FK.
  if (input.ownerUserId !== undefined && input.ownerUserId !== existing.ownerUserId) {
    const resolved = input.ownerUserId === null ? null : await resolveOwner(input.ownerUserId);
    data.ownerUserId = resolved;
    events.push(resolved ? "supplier.owner_assigned" : "supplier.owner_removed");
  }

  // Status: active ↔ inactive transitions are activate / deactivate events.
  if (input.status !== undefined && input.status !== existing.status) {
    data.status = input.status;
    events.push(input.status === "active" ? "supplier.activated" : "supplier.deactivated");
  }

  // Any non-transition field change is a generic "updated".
  const scalarChanged =
    (data.name !== undefined && data.name !== existing.name) ||
    (data.legalName !== undefined && data.legalName !== existing.legalName) ||
    (data.description !== undefined && data.description !== existing.description) ||
    (data.typeId !== undefined && data.typeId !== existing.typeId) ||
    (data.contactPerson !== undefined && data.contactPerson !== existing.contactPerson) ||
    (data.contactJobTitle !== undefined && data.contactJobTitle !== existing.contactJobTitle) ||
    (data.contactEmail !== undefined && data.contactEmail !== existing.contactEmail) ||
    (data.contactPhone !== undefined && data.contactPhone !== existing.contactPhone) ||
    (data.companyRegistrationNumber !== undefined &&
      data.companyRegistrationNumber !== existing.companyRegistrationNumber) ||
    (data.vatNumber !== undefined && data.vatNumber !== existing.vatNumber) ||
    (data.website !== undefined && data.website !== existing.website) ||
    (data.addressLine1 !== undefined && data.addressLine1 !== existing.addressLine1) ||
    (data.addressLine2 !== undefined && data.addressLine2 !== existing.addressLine2) ||
    (data.city !== undefined && data.city !== existing.city) ||
    (data.county !== undefined && data.county !== existing.county) ||
    (data.postcode !== undefined && data.postcode !== existing.postcode) ||
    (data.country !== undefined && data.country !== existing.country) ||
    (data.paymentTerms !== undefined && data.paymentTerms !== existing.paymentTerms) ||
    (data.customPaymentTerms !== undefined && data.customPaymentTerms !== existing.customPaymentTerms) ||
    (data.currency !== undefined && data.currency !== existing.currency) ||
    (data.leadTimeDays !== undefined && data.leadTimeDays !== existing.leadTimeDays) ||
    (data.notes !== undefined && data.notes !== existing.notes);
  if (scalarChanged) events.push("supplier.updated");

  data.updatedBy = actor?.email ?? null;

  const updated = await supplierRepo.update(id, data);

  // Record every transition that happened (fall back to "updated" for a no-op save).
  const label = `${updated.name} (${updated.code})`;
  for (const action of events.length ? events : ["supplier.updated"]) {
    audit.record({ actor, action, targetType: "supplier", targetId: id, targetLabel: label });
  }
  return toPublic(updated);
}

// A future dependency-checker: returns how many records of a given kind reference this
// supplier. Each procurement-era module registers one here; all are no-ops today.
type DependencyChecker = { label: string; count: (supplierId: string) => Promise<number> };
const DELETE_DEPENDENCY_CHECKERS: DependencyChecker[] = [
  { label: "catalogue items", count: (id) => irmRepo.countBySupplier(id) },
  { label: "purchase requests", count: (id) => prfRepo.countBySupplier(id) },
  { label: "purchase orders", count: (id) => poRepo.countBySupplier(id) },
  { label: "goods in", count: (id) => grnRepo.countBySupplier(id) },
  // Inventory is intentionally NOT checked here: InventoryBalance has no supplierId
  // (stock is tracked per item × warehouse, not per supplier), so an inventory-by-supplier
  // guard would be both impossible to express and redundant with the goods-in check above.
];

// Blocks deletion when ANY dependency still references the supplier. No-op today (the
// checker list is empty until the procurement-era modules ship), but the seam is here so
// adding a checker is the only change needed later.
async function assertSupplierDeletable(supplierId: string): Promise<void> {
  for (const checker of DELETE_DEPENDENCY_CHECKERS) {
    if ((await checker.count(supplierId)) > 0) {
      throw conflict("This supplier is in use. Remove dependencies first.");
    }
  }
}

// Soft-delete (history stays intact). Guarded by assertSupplierDeletable so that, once
// catalogue/POs/goods-in/inventory exist, an in-use supplier must be deactivated instead
// of deleted.
export async function deleteSupplier(id: string, actor?: AuditActor): Promise<void> {
  const s = await supplierRepo.findById(id);
  if (!s) throw notFound("Supplier not found.");

  await assertSupplierDeletable(id);

  await supplierRepo.softDelete(id);
  audit.record({
    actor,
    action: "supplier.deleted",
    targetType: "supplier",
    targetId: id,
    targetLabel: `${s.name} (${s.code})`,
  });
}

// Active staff users for the owner dropdown (id + display name + email + job title).
export async function listOwnerOptions(): Promise<PublicSupplierOwner[]> {
  const users = await supplierRepo.findOwnerOptions();
  return users.map((u) => ({
    id: u.id,
    name: `${u.firstName} ${u.lastName}`.trim() || u.email,
    email: u.email,
    jobTitle: u.jobTitle ?? u.role?.name ?? null,
  }));
}

// Plug-in seam for FUTURE procurement modules (IRM Catalogue, Goods In, Purchase Orders):
// assert a supplier id points to an existing ACTIVE supplier before recording a
// procurement record against it. Mirrors warehouseService.requireActiveWarehouse.
export async function requireActiveSupplier(supplierId: string): Promise<SupplierWithRelations> {
  if (!supplierId || !OBJECT_ID_RE.test(supplierId)) throw badRequest("Select a supplier.");
  const s = await supplierRepo.findById(supplierId);
  if (!s) throw badRequest("Selected supplier no longer exists.");
  if ((s.status ?? "active") !== "active") {
    throw conflict("Selected supplier is inactive and can't be used.");
  }
  return s;
}
