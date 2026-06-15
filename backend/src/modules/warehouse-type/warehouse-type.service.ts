import type { Prisma, WarehouseType } from "@prisma/client";

import * as warehouseTypeRepo from "./warehouse-type.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type {
  CreateWarehouseTypeInput,
  UpdateWarehouseTypeInput,
} from "./warehouse-type.validation.js";

// Resolve by database id (24-hex) or stable key.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicWarehouseType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  warehouseCount: number;
  createdAt: string;
}

function toPublic(t: WarehouseType, warehouseCount: number): PublicWarehouseType {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    status: t.status ?? "active",
    sortOrder: t.sortOrder,
    warehouseCount,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listWarehouseTypes(): Promise<PublicWarehouseType[]> {
  const [types, counts] = await Promise.all([
    warehouseTypeRepo.findMany(),
    warehouseTypeRepo.countWarehousesByTypeMap(),
  ]);
  return types.map((t) => toPublic(t, counts[t.id] ?? 0));
}

export async function getWarehouseType(idOrKey: string): Promise<PublicWarehouseType> {
  const t = OBJECT_ID_RE.test(idOrKey)
    ? await warehouseTypeRepo.findById(idOrKey)
    : await warehouseTypeRepo.findByKey(idOrKey);
  if (!t) throw notFound("Warehouse type not found.");
  return toPublic(t, await warehouseTypeRepo.countWarehouses(t.id));
}

export async function createWarehouseType(
  input: CreateWarehouseTypeInput,
  actor?: AuditActor,
): Promise<PublicWarehouseType> {
  const name = input.name.trim();
  if (!name) throw badRequest("Warehouse type name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Warehouse type name must contain letters or numbers.");

  if (await warehouseTypeRepo.findByName(name)) {
    throw conflict(`A warehouse type named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await warehouseTypeRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: WarehouseType;
  try {
    created = await warehouseTypeRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    if (warehouseTypeRepo.isNameConflict(e)) {
      throw conflict(`A warehouse type named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "warehouse_type.created",
    targetType: "warehouse_type",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created, 0);
}

export async function updateWarehouseType(
  id: string,
  input: UpdateWarehouseTypeInput,
  actor?: AuditActor,
): Promise<PublicWarehouseType> {
  const type = await warehouseTypeRepo.findById(id);
  if (!type) throw notFound("Warehouse type not found.");

  const data: Prisma.WarehouseTypeUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await warehouseTypeRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A warehouse type named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  if (typeof input.status === "string") data.status = input.status;

  let updated: WarehouseType;
  try {
    updated = await warehouseTypeRepo.update(id, data);
  } catch (e) {
    if (renameTo && warehouseTypeRepo.isNameConflict(e)) {
      throw conflict(`A warehouse type named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "warehouse_type.updated",
    targetType: "warehouse_type",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated, await warehouseTypeRepo.countWarehouses(id));
}

export async function deleteWarehouseType(id: string, actor?: AuditActor): Promise<void> {
  const type = await warehouseTypeRepo.findById(id);
  if (!type) throw notFound("Warehouse type not found.");

  const used = await warehouseTypeRepo.countWarehouses(id);
  if (used > 0) {
    throw conflict(
      `This type is used by ${used} warehouse${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await warehouseTypeRepo.remove(id);
  audit.record({
    actor,
    action: "warehouse_type.deleted",
    targetType: "warehouse_type",
    targetId: id,
    targetLabel: type.name,
  });
}

// For the warehouse module: assert a type id points to an existing ACTIVE type.
// Mirrors categoryService.requireActiveCategory.
export async function requireActiveWarehouseType(typeId: string): Promise<WarehouseType> {
  if (!typeId || !OBJECT_ID_RE.test(typeId)) throw badRequest("Select a warehouse type.");
  const type = await warehouseTypeRepo.findById(typeId);
  if (!type) throw badRequest("Selected warehouse type no longer exists.");
  if ((type.status ?? "active") !== "active") throw badRequest("Selected warehouse type is inactive.");
  return type;
}
