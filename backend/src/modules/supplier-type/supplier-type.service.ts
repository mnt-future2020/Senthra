import type { Prisma, SupplierType } from "@prisma/client";

import * as supplierTypeRepo from "./supplier-type.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type {
  CreateSupplierTypeInput,
  UpdateSupplierTypeInput,
} from "./supplier-type.validation.js";

// Resolve by database id (24-hex) or stable key.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicSupplierType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  supplierCount: number;
  createdAt: string;
}

function toPublic(t: SupplierType, supplierCount: number): PublicSupplierType {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    status: t.status ?? "active",
    sortOrder: t.sortOrder,
    supplierCount,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listSupplierTypes(): Promise<PublicSupplierType[]> {
  const [types, counts] = await Promise.all([
    supplierTypeRepo.findMany(),
    supplierTypeRepo.countSuppliersByTypeMap(),
  ]);
  return types.map((t) => toPublic(t, counts[t.id] ?? 0));
}

export async function getSupplierType(idOrKey: string): Promise<PublicSupplierType> {
  const t = OBJECT_ID_RE.test(idOrKey)
    ? await supplierTypeRepo.findById(idOrKey)
    : await supplierTypeRepo.findByKey(idOrKey);
  if (!t) throw notFound("Supplier type not found.");
  return toPublic(t, await supplierTypeRepo.countSuppliers(t.id));
}

export async function createSupplierType(
  input: CreateSupplierTypeInput,
  actor?: AuditActor,
): Promise<PublicSupplierType> {
  const name = input.name.trim();
  if (!name) throw badRequest("Supplier type name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Supplier type name must contain letters or numbers.");

  if (await supplierTypeRepo.findByName(name)) {
    throw conflict(`A supplier type named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await supplierTypeRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: SupplierType;
  try {
    created = await supplierTypeRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    if (supplierTypeRepo.isNameConflict(e)) {
      throw conflict(`A supplier type named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "supplier_type.created",
    targetType: "supplier_type",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created, 0);
}

export async function updateSupplierType(
  id: string,
  input: UpdateSupplierTypeInput,
  actor?: AuditActor,
): Promise<PublicSupplierType> {
  const type = await supplierTypeRepo.findById(id);
  if (!type) throw notFound("Supplier type not found.");

  const data: Prisma.SupplierTypeUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await supplierTypeRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A supplier type named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  if (typeof input.status === "string") data.status = input.status;

  let updated: SupplierType;
  try {
    updated = await supplierTypeRepo.update(id, data);
  } catch (e) {
    if (renameTo && supplierTypeRepo.isNameConflict(e)) {
      throw conflict(`A supplier type named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "supplier_type.updated",
    targetType: "supplier_type",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated, await supplierTypeRepo.countSuppliers(id));
}

export async function deleteSupplierType(id: string, actor?: AuditActor): Promise<void> {
  const type = await supplierTypeRepo.findById(id);
  if (!type) throw notFound("Supplier type not found.");

  const used = await supplierTypeRepo.countSuppliers(id);
  if (used > 0) {
    throw conflict(
      `This type is used by ${used} supplier${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await supplierTypeRepo.remove(id);
  audit.record({
    actor,
    action: "supplier_type.deleted",
    targetType: "supplier_type",
    targetId: id,
    targetLabel: type.name,
  });
}

// For the supplier module: assert a type id points to an existing ACTIVE type.
// Mirrors warehouseTypeService.requireActiveWarehouseType.
export async function requireActiveSupplierType(typeId: string): Promise<SupplierType> {
  if (!typeId || !OBJECT_ID_RE.test(typeId)) throw badRequest("Select a supplier type.");
  const type = await supplierTypeRepo.findById(typeId);
  if (!type) throw badRequest("Selected supplier type no longer exists.");
  if ((type.status ?? "active") !== "active") throw badRequest("Selected supplier type is inactive.");
  return type;
}
