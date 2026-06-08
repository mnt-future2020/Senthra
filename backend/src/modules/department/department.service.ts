import type { Department } from "@prisma/client";

import * as departmentRepo from "./department.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { withTransaction } from "../../lib/prisma.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

export interface PublicDepartment {
  id: string;
  name: string;
  createdAt: string;
}

function toPublic(d: Department): PublicDepartment {
  return { id: d.id, name: d.name, createdAt: d.createdAt.toISOString() };
}

export async function listDepartments(): Promise<PublicDepartment[]> {
  const rows = await departmentRepo.findMany();
  return rows.map(toPublic);
}

export interface DepartmentInput {
  name: string;
}

export async function createDepartment(
  input: DepartmentInput,
  actor?: AuditActor,
): Promise<PublicDepartment> {
  const name = input.name.trim();
  if (!name) throw badRequest("Department name is required.");
  // Friendly pre-check (case-insensitive); the nameLower @unique index is the real
  // guard, re-checked in the catch below for the concurrent-write race.
  if (await departmentRepo.findByName(name)) {
    throw conflict(`A department named "${name}" already exists.`);
  }
  let created: Department;
  try {
    created = await departmentRepo.create(name);
  } catch (e) {
    if (departmentRepo.isNameConflict(e)) {
      throw conflict(`A department named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "department.created",
    targetType: "department",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublic(created);
}

export async function updateDepartment(
  id: string,
  input: DepartmentInput,
  actor?: AuditActor,
): Promise<PublicDepartment> {
  const existing = await departmentRepo.findById(id);
  if (!existing) throw notFound("Department not found.");
  const name = input.name.trim();
  if (!name) throw badRequest("Department name is required.");
  // Re-check uniqueness on rename, excluding this row.
  const clash = await departmentRepo.findByName(name);
  if (clash && clash.id !== id) {
    throw conflict(`A department named "${name}" already exists.`);
  }
  // Rename the record AND cascade to every user holding the old name in ONE atomic
  // transaction — User.department is the denormalized department name, so both writes
  // must commit together or roll back together, never leaving users stale. The user
  // cascade is skipped when the name didn't actually change.
  let updated: Department;
  try {
    updated = await withTransaction(async (tx) => {
      const renamed = await departmentRepo.update(id, name, tx);
      if (existing.name !== name) {
        await userRepo.renameDepartment(existing.name, name, tx);
      }
      return renamed;
    });
  } catch (e) {
    if (departmentRepo.isNameConflict(e)) {
      throw conflict(`A department named "${name}" already exists.`);
    }
    throw e;
  }
  audit.record({
    actor,
    action: "department.updated",
    targetType: "department",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublic(updated);
}

export async function deleteDepartment(id: string, actor?: AuditActor): Promise<void> {
  const existing = await departmentRepo.findById(id);
  if (!existing) throw notFound("Department not found.");
  // User.department stores the NAME (denormalized), so removing a department from
  // the master list never orphans a user — their stored department text is kept.
  await departmentRepo.remove(id);
  audit.record({
    actor,
    action: "department.deleted",
    targetType: "department",
    targetId: id,
    targetLabel: existing.name,
  });
}
