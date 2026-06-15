import type { Prisma, IrmCategory } from "@prisma/client";

import * as irmCategoryRepo from "./irm-category.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type {
  CreateIrmCategoryInput,
  UpdateIrmCategoryInput,
} from "./irm-category.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicIrmCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

function toPublic(c: IrmCategory, itemCount: number): PublicIrmCategory {
  return {
    id: c.id,
    key: c.key,
    name: c.name,
    description: c.description,
    status: c.status ?? "active",
    sortOrder: c.sortOrder,
    itemCount,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listIrmCategories(): Promise<PublicIrmCategory[]> {
  const [categories, counts] = await Promise.all([
    irmCategoryRepo.findMany(),
    irmCategoryRepo.countItemsByCategoryMap(),
  ]);
  return categories.map((c) => toPublic(c, counts[c.id] ?? 0));
}

export async function getIrmCategory(idOrKey: string): Promise<PublicIrmCategory> {
  const c = OBJECT_ID_RE.test(idOrKey)
    ? await irmCategoryRepo.findById(idOrKey)
    : await irmCategoryRepo.findByKey(idOrKey);
  if (!c) throw notFound("IRM category not found.");
  return toPublic(c, await irmCategoryRepo.countItems(c.id));
}

export async function createIrmCategory(
  input: CreateIrmCategoryInput,
  actor?: AuditActor,
): Promise<PublicIrmCategory> {
  const name = input.name.trim();
  if (!name) throw badRequest("IRM category name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("IRM category name must contain letters or numbers.");

  if (await irmCategoryRepo.findByName(name)) {
    throw conflict(`An IRM category named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await irmCategoryRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: IrmCategory;
  try {
    created = await irmCategoryRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    if (irmCategoryRepo.isNameConflict(e)) {
      throw conflict(`An IRM category named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "irm_category.created",
    targetType: "irm_category",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created, 0);
}

export async function updateIrmCategory(
  id: string,
  input: UpdateIrmCategoryInput,
  actor?: AuditActor,
): Promise<PublicIrmCategory> {
  const category = await irmCategoryRepo.findById(id);
  if (!category) throw notFound("IRM category not found.");

  const data: Prisma.IrmCategoryUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await irmCategoryRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`An IRM category named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  if (typeof input.status === "string") data.status = input.status;

  let updated: IrmCategory;
  try {
    updated = await irmCategoryRepo.update(id, data);
  } catch (e) {
    if (renameTo && irmCategoryRepo.isNameConflict(e)) {
      throw conflict(`An IRM category named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "irm_category.updated",
    targetType: "irm_category",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated, await irmCategoryRepo.countItems(id));
}

export async function deleteIrmCategory(id: string, actor?: AuditActor): Promise<void> {
  const category = await irmCategoryRepo.findById(id);
  if (!category) throw notFound("IRM category not found.");

  const used = await irmCategoryRepo.countItems(id);
  if (used > 0) {
    throw conflict(
      `This category is used by ${used} item${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await irmCategoryRepo.remove(id);
  audit.record({
    actor,
    action: "irm_category.deleted",
    targetType: "irm_category",
    targetId: id,
    targetLabel: category.name,
  });
}

// For the IRM module: assert a category id points to an existing ACTIVE category.
export async function requireActiveIrmCategory(categoryId: string): Promise<IrmCategory> {
  if (!categoryId || !OBJECT_ID_RE.test(categoryId)) throw badRequest("Select an IRM category.");
  const category = await irmCategoryRepo.findById(categoryId);
  if (!category) throw badRequest("Selected IRM category no longer exists.");
  if ((category.status ?? "active") !== "active") {
    throw badRequest("Selected IRM category is inactive.");
  }
  return category;
}
