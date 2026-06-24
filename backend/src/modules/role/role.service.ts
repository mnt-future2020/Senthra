import type { Prisma, Role } from "@prisma/client";

import * as roleRepo from "./role.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { slugify } from "../../utils/slugify.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import {
  ALL_PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_GROUPS,
  applyImpliedPermissions,
  escalationViolations,
  sanitizePermissions,
  type PermissionGroup,
} from "./permissions.js";

export interface PublicRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
  sortOrder: number;
  // Warehouse-scoped role → its users must be assigned warehouses and may access only those.
  // Drives the user form's conditional "Assigned Warehouses" field.
  isWarehouseScoped: boolean;
  createdAt: string;
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
    isWarehouseScoped: Boolean(role.isWarehouseScoped),
    createdAt: role.createdAt.toISOString(),
  };
}

export async function listRoles(): Promise<PublicRole[]> {
  // One query for the roles + one grouped count for all of them (no per-role N+1).
  const [roles, counts] = await Promise.all([roleRepo.findMany(), userRepo.countByRoleMap()]);
  return roles.map((role) => toPublicRole(role, counts[role.id] ?? 0));
}

// The grouped permission catalog + the ordered category list, for the role-editor
// matrix. Categories drive the order of the collapsible sections in the UI.
export function listPermissionCatalog(): {
  groups: PermissionGroup[];
  categories: string[];
} {
  return { groups: PERMISSION_GROUPS, categories: PERMISSION_CATEGORIES };
}

// Resolve a role by either its database id (24-hex) or its stable key (e.g.
// "user_managers"), so pages can route by the readable key. The two formats never
// collide (keys are name-derived slugs), so resolution is unambiguous.
const ROLE_OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export async function getRole(idOrKey: string): Promise<PublicRole> {
  const role = ROLE_OBJECT_ID_RE.test(idOrKey)
    ? await roleRepo.findById(idOrKey)
    : await roleRepo.findByKey(idOrKey);
  if (!role) throw notFound("Role not found.");
  return toPublicRole(role, await userRepo.countByRole(role.id));
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

  const { valid: sanitized, unknown } = sanitizePermissions(input.permissions ?? []);
  if (unknown.length) {
    throw badRequest(
      `Unknown permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  // Granting any action also grants its module's view (manage implies view).
  const valid = applyImpliedPermissions(sanitized);
  // No-escalation: a delegate can only grant permissions it holds (the super-admin
  // holds "*" and may grant anything).
  const escalated = escalationViolations(valid, actor?.permissions ?? []);
  if (escalated.length) {
    throw forbidden(`You can't grant permissions you don't have: ${escalated.join(", ")}.`);
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

  // System roles are configuration-critical — only the super-admin account (a "*"
  // holder) may edit them at all; a delegate is refused even if it holds roles.edit.
  const actorHasAll = (actor?.permissions ?? []).includes(ALL_PERMISSIONS);
  if (role.isSystem && !actorHasAll) {
    throw forbidden("Only the super-admin can edit system roles.");
  }

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
    const { valid: sanitized, unknown } = sanitizePermissions(input.permissions);
    if (unknown.length) {
      throw badRequest(
        `Unknown permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      );
    }
    const valid = applyImpliedPermissions(sanitized);
    const escalated = escalationViolations(valid, actor?.permissions ?? []);
    if (escalated.length) {
      throw forbidden(`You can't grant permissions you don't have: ${escalated.join(", ")}.`);
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

  // Only someone who could manage this role may delete it: a delegate can't remove
  // a role that grants permissions it doesn't itself hold (the super-admin can).
  const escalated = escalationViolations(role.permissions, actor?.permissions ?? []);
  if (escalated.length) {
    throw forbidden("You can't delete a role that grants permissions you don't have.");
  }

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
