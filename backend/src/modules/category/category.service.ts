import type { Category, Prisma } from "@prisma/client";

import * as categoryRepo from "./category.repository.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import type { CreateCategoryInput, UpdateCategoryInput } from "./category.validation.js";

export interface PublicCategory {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
}

function toPublicCategory(c: Category, itemCount: number): PublicCategory {
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

export async function listCategories(): Promise<PublicCategory[]> {
  const [categories, counts] = await Promise.all([
    categoryRepo.findMany(),
    categoryRepo.countItemsByCategoryMap(),
  ]);
  return categories.map((c) => toPublicCategory(c, counts[c.id] ?? 0));
}

// Resolve by database id (24-hex) or stable key.
const CATEGORY_OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export async function getCategory(idOrKey: string): Promise<PublicCategory> {
  const category = CATEGORY_OBJECT_ID_RE.test(idOrKey)
    ? await categoryRepo.findById(idOrKey)
    : await categoryRepo.findByKey(idOrKey);
  if (!category) throw notFound("Category not found.");
  return toPublicCategory(category, await categoryRepo.countItems(category.id));
}

export async function createCategory(
  input: CreateCategoryInput,
  actor?: AuditActor,
): Promise<PublicCategory> {
  const name = input.name.trim();
  if (!name) throw badRequest("Category name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Category name must contain letters or numbers.");

  // Friendly pre-check (case-insensitive); the `nameLower` @unique index is the real
  // guard, re-checked in the catch below for the concurrent-write race.
  if (await categoryRepo.findByName(name)) {
    throw conflict(`A category named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await categoryRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  let created: Category;
  try {
    created = await categoryRepo.create({
      key,
      name,
      description: input.description?.trim() || null,
      status: input.status ?? "active",
    });
  } catch (e) {
    if (categoryRepo.isNameConflict(e)) {
      throw conflict(`A category named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "category.created",
    targetType: "category",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublicCategory(created, 0);
}

export async function updateCategory(
  id: string,
  input: UpdateCategoryInput,
  actor?: AuditActor,
): Promise<PublicCategory> {
  const category = await categoryRepo.findById(id);
  if (!category) throw notFound("Category not found.");

  const data: Prisma.CategoryUpdateInput = {};
  let renameTo: string | null = null;
  if (typeof input.name === "string" && input.name.trim()) {
    const name = input.name.trim();
    // Re-check uniqueness on rename, excluding this row; the `nameLower` @unique index
    // is the real guard, re-checked in the catch below for the concurrent-write race.
    const clash = await categoryRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A category named "${name}" already exists.`);
    data.name = name;
    renameTo = name;
  }
  if (typeof input.description === "string") {
    data.description = input.description.trim() || null;
  }
  if (typeof input.status === "string") {
    data.status = input.status;
  }

  let updated: Category;
  try {
    updated = await categoryRepo.update(id, data);
  } catch (e) {
    if (renameTo && categoryRepo.isNameConflict(e)) {
      throw conflict(`A category named "${renameTo}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "category.updated",
    targetType: "category",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublicCategory(updated, await categoryRepo.countItems(id));
}

export async function deleteCategory(id: string, actor?: AuditActor): Promise<void> {
  const category = await categoryRepo.findById(id);
  if (!category) throw notFound("Category not found.");

  const used = await categoryRepo.countItems(id);
  if (used > 0) {
    throw conflict(
      `This category is used by ${used} item${used === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }
  await categoryRepo.remove(id);
  audit.record({
    actor,
    action: "category.deleted",
    targetType: "category",
    targetId: id,
    targetLabel: category.name,
  });
}

// For other modules (customer stock entries, IRM): assert a category id points to an
// existing ACTIVE category. Returns the category. Throws badRequest otherwise.
export async function requireActiveCategory(categoryId: string): Promise<Category> {
  if (!categoryId || !CATEGORY_OBJECT_ID_RE.test(categoryId)) {
    throw badRequest("Select a category.");
  }
  const category = await categoryRepo.findById(categoryId);
  if (!category) throw badRequest("Selected category no longer exists.");
  if ((category.status ?? "active") !== "active") {
    throw badRequest("Selected category is inactive.");
  }
  return category;
}
