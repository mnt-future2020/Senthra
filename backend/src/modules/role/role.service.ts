import type { Prisma, Role } from "@prisma/client";

import * as roleRepo from "./role.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as vanStockRequestRepo from "#modules/van-stock-request/van-stock-request.repository.js";
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
  splitByCapability,
  type PermissionGroup,
  type RoleCapabilities,
} from "./permissions.js";

// Changing a role CAPABILITY (what kind of role it is) is reserved for the super-admin, the same
// bar as editing a system role. A capability isn't delegatable like a permission — there is no
// "hold it to grant it" check that would make escalationViolations meaningful — and field_ops
// unlocks van stock, job assignment and the whole Engineer Portal including the mobile app.
function assertMayChangeCapabilities(actor?: AuditActor): void {
  if ((actor?.permissions ?? []).includes(ALL_PERMISSIONS)) return;
  throw forbidden("Only the super-admin can change a role's field-operations capability.");
}

// Revoking field-operations from a role whose holders still have van stock would strand it: every
// route that could move it back — engineer-to-engineer transfer, van-stock return, job issue —
// refuses a role that can't hold stock, so the balance would sit there with no way to clear it.
// This BLOCKS only; it never auto-returns or writes off stock. Mirrors assertNotHoldingStock in
// user.service, which guards the same hazard when a single engineer is deactivated.
async function assertNoHolderHasStock(roleId: string, roleName: string): Promise<void> {
  // includeDeleted: a soft-deleted engineer's balance does not disappear with them. Asking only for
  // LIVE holders would let the exact hazard through — delete the holder, then revoke the capability
  // and the guard reports safe while the stock becomes unreachable.
  const holders = await userRepo.findIdsByRole(roleId, { includeDeleted: true });
  const [held, openRequests] = await Promise.all([
    engineerStockRepo.countHeldStockForEngineers(holders),
    // A zero balance isn't enough. An approved-but-unscanned restock still credits the engineer's
    // van when the warehouse scans it out, and neither approve nor fulfil re-checks the role — so
    // revoking with one open would strand stock a moment after the guard said it was safe.
    vanStockRequestRepo.countOpenForEngineers(holders),
  ]);
  if (held > 0) {
    throw conflict(
      `Users with the "${roleName}" role still hold field stock. Return or transfer their stock before turning off the field-operations capability.`,
    );
  }
  if (openRequests > 0) {
    throw conflict(
      `Users with the "${roleName}" role have ${openRequests} open field-stock request${openRequests === 1 ? "" : "s"}. Complete or cancel them before turning off the field-operations capability.`,
    );
  }
}

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
  // Field-operations role → its users may hold van stock, be assigned jobs, and reach the
  // Engineer Portal. Drives the role editor's capability toggle AND which permission groups the
  // matrix offers (see FIELD_OPS capability in permissions.ts).
  canHoldStock: boolean;
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
    canHoldStock: Boolean(role.canHoldStock),
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
  canHoldStock?: boolean;
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
  // A new role is only field-operations if explicitly asked for, and only the super-admin may ask.
  const canHoldStock = input.canHoldStock === true;
  if (canHoldStock) assertMayChangeCapabilities(actor);

  // Granting any action also grants everything it depends on (transitively).
  const implied = applyImpliedPermissions(sanitized);
  // Drop anything this role's capabilities can't support (e.g. Engineer Portal keys on a role
  // that can't hold field stock) — see splitByCapability for why this strips instead of rejecting.
  const { kept: valid } = splitByCapability(implied, { field_ops: canHoldStock });
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
    canHoldStock,
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
  canHoldStock?: boolean;
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

  // Capability change — super-admin only, and only when the value actually moves (so a delegate
  // re-saving a role with its existing flag isn't refused for a no-op).
  //
  // Compared against the RAW column, which is `Boolean?`. Coercing it first would make `false` on a
  // legacy `null` row look like a no-op, so a revoke on such a role would write nothing and silently
  // do nothing — the admin sees the toggle go off, the row stays unset, and the portal keys survive.
  const capabilityChanged =
    typeof input.canHoldStock === "boolean" && input.canHoldStock !== role.canHoldStock;
  if (capabilityChanged) {
    assertMayChangeCapabilities(actor);
    // Turning it OFF is the destructive direction — check the holders before committing.
    if (input.canHoldStock === false) await assertNoHolderHasStock(role.id, role.name);
    data.canHoldStock = input.canHoldStock;
  }
  // Resolve the capabilities the role will have AFTER this write, so an admin can turn a role into
  // a field role and grant it the Engineer Portal in one save.
  const capabilities: RoleCapabilities = {
    field_ops: input.canHoldStock ?? Boolean(role.canHoldStock),
  };
  // Keys the role LOSES because its capabilities can't support them, measured against what is
  // currently STORED. Measuring against the incoming payload instead would almost always report
  // nothing: the editor already filters client-side, so by the time a revoke reaches the server the
  // keys are gone from the request — and the audit entry for the one change that removes access
  // would name none of it.
  const strippedByCapability = splitByCapability(role.permissions, capabilities).removed;

  // Permissions are editable for any role except super_admin, which always holds
  // full access ("*").
  if (input.permissions && role.key !== "super_admin") {
    const { valid: sanitized, unknown } = sanitizePermissions(input.permissions);
    if (unknown.length) {
      throw badRequest(
        `Unknown permission${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      );
    }
    // Pass the role's warehouse-scope flag so a warehouse-scoped role (e.g. Warehouse Manager)
    // isn't silently forced the global customers.view just for holding stock_requests.* — see
    // applyImpliedPermissions. An admin can still grant it deliberately (it's in `sanitized`).
    const implied = applyImpliedPermissions(sanitized, role.isWarehouseScoped === true);
    // Drop anything the role's capabilities can't support. Also repairs a legacy role that was
    // saved with Engineer Portal keys before this rule existed — see splitByCapability.
    const { kept: valid } = splitByCapability(implied, capabilities);
    const escalated = escalationViolations(valid, actor?.permissions ?? []);
    if (escalated.length) {
      throw forbidden(`You can't grant permissions you don't have: ${escalated.join(", ")}.`);
    }
    data.permissions = { set: valid };
  } else if (capabilityChanged && role.key !== "super_admin" && strippedByCapability.length > 0) {
    // Capability revoked with no permissions payload — strip what the role can no longer use, so
    // turning off "field role" never leaves the Engineer Portal keys behind as dead grants.
    data.permissions = { set: splitByCapability(role.permissions, capabilities).kept };
  }

  const updated = await roleRepo.update(id, data);
  audit.record({
    actor,
    // A capability change is a privilege event in its own right — it unlocks the Engineer Portal on
    // web AND mobile, van stock and job assignment — so record WHAT changed, not just that the role
    // was touched. Also records anything the capability filter dropped, so a permission that
    // silently disappears from a role is explainable afterwards rather than a mystery.
    metadata:
      capabilityChanged || strippedByCapability.length > 0
        ? {
            ...(capabilityChanged ? { canHoldStock: input.canHoldStock } : {}),
            ...(strippedByCapability.length > 0
              ? { permissionsRemovedByCapability: strippedByCapability }
              : {}),
          }
        : undefined,
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
