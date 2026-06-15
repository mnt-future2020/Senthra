import type { Prisma, IrmType } from "@prisma/client";

import * as irmTypeRepo from "./irm-type.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type { CreateIrmTypeInput, UpdateIrmTypeInput } from "./irm-type.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicIrmType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

function toPublic(t: IrmType, itemCount: number): PublicIrmType {
  return {
    id: t.id,
    key: t.key,
    name: t.name,
    description: t.description,
    status: t.status ?? "active",
    sortOrder: t.sortOrder,
    itemCount,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listIrmTypes(): Promise<PublicIrmType[]> {
  const [types, counts] = await Promise.all([
    irmTypeRepo.findMany(),
    irmTypeRepo.countItemsByTypeMap(),
  ]);
  return types.map((t) => toPublic(t, counts[t.id] ?? 0));
}

export async function getIrmType(idOrKey: string): Promise<PublicIrmType> {
  const t = OBJECT_ID_RE.test(idOrKey)
    ? await irmTypeRepo.findById(idOrKey)
    : await irmTypeRepo.findByKey(idOrKey);
  if (!t) throw notFound("IRM type not found.");
  return toPublic(t, await irmTypeRepo.countItems(t.id));
}

export async function createIrmType(
  input: CreateIrmTypeInput,
  actor?: AuditActor,
): Promise<PublicIrmType> {
  const name = input.name.trim();
  if (!name) throw badRequest("IRM type name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("IRM type name must contain letters or numbers.");

  if (await irmTypeRepo.findByName(name)) {
    throw conflict(`An IRM type named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await irmTypeRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: IrmType;
  try {
    created = await irmTypeRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    if (irmTypeRepo.isNameConflict(e)) {
      throw conflict(`An IRM type named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "irm_type.created",
    targetType: "irm_type",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created, 0);
}

export async function updateIrmType(
  id: string,
  input: UpdateIrmTypeInput,
  actor?: AuditActor,
): Promise<PublicIrmType> {
  const type = await irmTypeRepo.findById(id);
  if (!type) throw notFound("IRM type not found.");

  const data: Prisma.IrmTypeUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await irmTypeRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`An IRM type named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  if (typeof input.status === "string") data.status = input.status;

  let updated: IrmType;
  try {
    updated = await irmTypeRepo.update(id, data);
  } catch (e) {
    if (renameTo && irmTypeRepo.isNameConflict(e)) {
      throw conflict(`An IRM type named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "irm_type.updated",
    targetType: "irm_type",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated, await irmTypeRepo.countItems(id));
}

export async function deleteIrmType(id: string, actor?: AuditActor): Promise<void> {
  const type = await irmTypeRepo.findById(id);
  if (!type) throw notFound("IRM type not found.");

  const used = await irmTypeRepo.countItems(id);
  if (used > 0) {
    throw conflict(
      `This type is used by ${used} item${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await irmTypeRepo.remove(id);
  audit.record({
    actor,
    action: "irm_type.deleted",
    targetType: "irm_type",
    targetId: id,
    targetLabel: type.name,
  });
}

// For the IRM module: assert a type id points to an existing ACTIVE type.
export async function requireActiveIrmType(typeId: string): Promise<IrmType> {
  if (!typeId || !OBJECT_ID_RE.test(typeId)) throw badRequest("Select an IRM type.");
  const type = await irmTypeRepo.findById(typeId);
  if (!type) throw badRequest("Selected IRM type no longer exists.");
  if ((type.status ?? "active") !== "active") throw badRequest("Selected IRM type is inactive.");
  return type;
}
