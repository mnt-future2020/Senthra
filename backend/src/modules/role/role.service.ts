import type { Prisma, Role } from "@prisma/client";

import * as roleRepo from "./role.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { PERMISSIONS, sanitizePermissions, type PermissionDef } from "./permissions.js";

export interface PublicRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  sortOrder: number;
}

function toPublicRole(role: Role, userCount: number): PublicRole {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions,
    userCount,
    sortOrder: role.sortOrder,
  };
}

export async function listRoles(): Promise<PublicRole[]> {
  // One query for the roles + one grouped count for all of them (no per-role N+1).
  const [roles, counts] = await Promise.all([roleRepo.findMany(), userRepo.countByRoleMap()]);
  return roles.map((role) => toPublicRole(role, counts[role.id] ?? 0));
}

// The permission catalog, for the role-config UI (super-admin only at the route).
export function listPermissions(): PermissionDef[] {
  return PERMISSIONS;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions?: string[];
}

export async function createRole(
  input: CreateRoleInput,
  actor?: AuditActor,
): Promise<PublicRole> {
  const name = input.name.trim();
  if (!name) throw badRequest("Role name is required.");
  const baseKey = slugify(name);
  if (!baseKey) throw badRequest("Role name must contain letters or numbers.");

  // Uniqueness is on the human name (case-insensitive). The internal key is just
  // a stable slug — if two different names slug to the same key, suffix it so the
  // distinct names can both exist.
  if (await roleRepo.findByName(name)) {
    throw conflict(`A role named "${name}" already exists.`);
  }
  let key = baseKey;
  for (let n = 2; await roleRepo.findByKey(key); n++) key = `${baseKey}_${n}`;

  const { valid, unknown } = sanitizePermissions(input.permissions ?? []);
  if (unknown.length) {
    throw badRequest(
      `Unknown permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  const created = await roleRepo.create({
    key,
    name,
    description: input.description?.trim() || null,
    isSystem: false,
    permissions: valid,
  });
  audit.record({
    actor,
    action: "role.created",
    targetType: "role",
    targetId: created.id,
    targetLabel: created.name,
  });
  return toPublicRole(created, 0);
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

export async function updateRole(
  id: string,
  input: UpdateRoleInput,
  actor?: AuditActor,
): Promise<PublicRole> {
  const role = await roleRepo.findById(id);
  if (!role) throw notFound("Role not found.");

  const data: Prisma.RoleUpdateInput = {};
  // System roles keep a stable name/key; only their description is editable.
  if (typeof input.name === "string" && input.name.trim() && !role.isSystem) {
    const name = input.name.trim();
    // Re-check name uniqueness on rename (excluding this role itself).
    const clash = await roleRepo.findByName(name);
    if (clash && clash.id !== id) throw conflict(`A role named "${name}" already exists.`);
    data.name = name;
  }
  if (typeof input.description === "string") {
    data.description = input.description.trim() || null;
  }
  // Permissions are editable for any role except super_admin, which always holds
  // full access ("*").
  if (input.permissions && role.key !== "super_admin") {
    const { valid, unknown } = sanitizePermissions(input.permissions);
    if (unknown.length) {
      throw badRequest(
        `Unknown permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      );
    }
    data.permissions = { set: valid };
  }

  const updated = await roleRepo.update(id, data);
  audit.record({
    actor,
    action: "role.updated",
    targetType: "role",
    targetId: id,
    targetLabel: updated.name,
  });
  return toPublicRole(updated, await userRepo.countByRole(id));
}

export async function deleteRole(id: string, actor?: AuditActor): Promise<void> {
  const role = await roleRepo.findById(id);
  if (!role) throw notFound("Role not found.");
  if (role.isSystem) throw forbidden("System roles can't be deleted.");

  const assigned = await userRepo.countByRole(id);
  if (assigned > 0) {
    throw conflict(
      `This role is assigned to ${assigned} user${assigned === 1 ? "" : "s"}. Reassign them before deleting it.`,
    );
  }

  // Detach the role from any remaining (soft-deleted) holders first so no user
  // is left pointing at a non-existent role.
  await userRepo.clearRole(id);
  await roleRepo.remove(id);
  audit.record({
    actor,
    action: "role.deleted",
    targetType: "role",
    targetId: id,
    targetLabel: role.name,
  });
}
