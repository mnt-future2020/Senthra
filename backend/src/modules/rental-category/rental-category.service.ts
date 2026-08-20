import type { Prisma, RentalCategory } from "@prisma/client";

import * as rentalCategoryRepo from "./rental-category.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type {
  CreateRentalCategoryInput,
  UpdateRentalCategoryInput,
} from "./rental-category.validation.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface PublicRentalCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

function toPublic(c: RentalCategory, itemCount: number): PublicRentalCategory {
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

export async function listRentalCategories(): Promise<PublicRentalCategory[]> {
  const [categories, counts] = await Promise.all([
    rentalCategoryRepo.findMany(),
    rentalCategoryRepo.countItemsByCategoryMap(),
  ]);
  return categories.map((c) => toPublic(c, counts[c.id] ?? 0));
}

export async function getRentalCategory(idOrKey: string): Promise<PublicRentalCategory> {
  const c = OBJECT_ID_RE.test(idOrKey)
    ? await rentalCategoryRepo.findById(idOrKey)
    : await rentalCategoryRepo.findByKey(idOrKey);
  if (!c) throw notFound("Rental category not found.");
  return toPublic(c, await rentalCategoryRepo.countItems(c.id));
}

export async function createRentalCategory(
  input: CreateRentalCategoryInput,
  actor?: AuditActor,
): Promise<PublicRentalCategory> {
  const name = input.name.trim();
  if (!name) throw badRequest("Rental category name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Rental category name must contain letters or numbers.");

  if (await rentalCategoryRepo.findByName(name)) {
    throw conflict(`A rental category named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await rentalCategoryRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: RentalCategory;
  try {
    created = await rentalCategoryRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    // The unique index is the real guard; the pre-check above only buys a friendlier message, and
    // two concurrent creates can still race past it.
    if (rentalCategoryRepo.isNameConflict(e)) {
      throw conflict(`A rental category named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "rental_category.created",
    targetType: "rental_category",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created, 0);
}

export async function updateRentalCategory(
  id: string,
  input: UpdateRentalCategoryInput,
  actor?: AuditActor,
): Promise<PublicRentalCategory> {
  const category = await rentalCategoryRepo.findById(id);
  if (!category) throw notFound("Rental category not found.");

  const data: Prisma.RentalCategoryUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    const clash = await rentalCategoryRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A rental category named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  if (typeof input.status === "string") data.status = input.status;

  let updated: RentalCategory;
  try {
    updated = await rentalCategoryRepo.update(id, data);
  } catch (e) {
    if (renameTo && rentalCategoryRepo.isNameConflict(e)) {
      throw conflict(`A rental category named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "rental_category.updated",
    targetType: "rental_category",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated, await rentalCategoryRepo.countItems(id));
}

export async function deleteRentalCategory(id: string, actor?: AuditActor): Promise<void> {
  const category = await rentalCategoryRepo.findById(id);
  if (!category) throw notFound("Rental category not found.");

  const used = await rentalCategoryRepo.countItems(id);
  if (used > 0) {
    throw conflict(
      `This category is used by ${used} rental item${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await rentalCategoryRepo.remove(id);
  audit.record({
    actor,
    action: "rental_category.deleted",
    targetType: "rental_category",
    targetId: id,
    targetLabel: category.name,
  });
}

// For the rental-item module: assert a category id points to an existing ACTIVE category.
export async function requireActiveRentalCategory(categoryId: string): Promise<RentalCategory> {
  if (!categoryId || !OBJECT_ID_RE.test(categoryId)) throw badRequest("Select a rental category.");
  const category = await rentalCategoryRepo.findById(categoryId);
  if (!category) throw badRequest("Selected rental category no longer exists.");
  if ((category.status ?? "active") !== "active") {
    throw badRequest("Selected rental category is inactive.");
  }
  return category;
}
