import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";

// Data-access for UserWarehouseAssignment (the user↔warehouse many-to-many). The ONLY place Prisma
// touches this junction. Rows PERSIST across role changes — they are removed ONLY on a permanent
// user delete (clearForUser) or an explicit admin un-assignment (via syncAssignments dropping ids).

export interface AssignedWarehouse {
  id: string;
  code: string;
  name: string;
}

// The staff slice surfaced as a warehouse's manager (a thin slice of User — never the whole
// record). jobTitle + role.name drive the "Name · Role" label; the name parts + image let the UI
// render the same avatar chip as every other staff listing.
const managerUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  jobTitle: true,
  profileImageUrl: true,
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;

export interface WarehouseManagerAssignment {
  warehouseId: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    jobTitle: string | null;
    profileImageUrl: string | null;
    role: { name: string } | null;
  };
}

// The people who manage the given warehouses — the SINGLE source of truth for "who runs this
// warehouse", derived from the assignments an admin makes under Users & Roles (there is no
// manager field on the Warehouse record).
//
// The user filter is what makes this correct: assignment rows PERSIST across role changes (see the
// note at the top), so a user moved off a warehouse-scoped role — or deactivated — would otherwise
// keep showing up as a manager forever. Only an ACTIVE, non-deleted user on a warehouse-scoped role
// actually manages a warehouse today.
export function listManagersForWarehouses(warehouseIds: string[]): Promise<WarehouseManagerAssignment[]> {
  if (!warehouseIds.length) return Promise.resolve([]);
  return prisma.userWarehouseAssignment.findMany({
    where: {
      warehouseId: { in: warehouseIds },
      user: {
        is: { status: "active", deletedAt: null, role: { is: { isWarehouseScoped: true } } },
      },
    },
    select: { warehouseId: true, user: { select: managerUserSelect } },
    orderBy: { assignedAt: "asc" },
  });
}

// Just the assigned warehouse ids (for populating the principal's accessible-warehouse set).
export function listWarehouseIds(userId: string): Promise<string[]> {
  if (!userId) return Promise.resolve([]);
  return prisma.userWarehouseAssignment
    .findMany({ where: { userId }, select: { warehouseId: true } })
    .then((rows) => rows.map((r) => r.warehouseId));
}

// Assigned warehouses (id/code/name) for the user — used to prefill the edit form / DTO.
export function listForUser(userId: string): Promise<AssignedWarehouse[]> {
  if (!userId) return Promise.resolve([]);
  return prisma.userWarehouseAssignment
    .findMany({
      where: { userId },
      include: { warehouse: { select: { id: true, code: true, name: true } } },
      orderBy: { assignedAt: "asc" },
    })
    .then((rows) => rows.map((r) => r.warehouse));
}

// Reconcile the user's assignment set to EXACTLY `warehouseIds` (add new, remove gone, keep existing).
// Diff-based so the assignedAt/assignedBy of kept rows are preserved. Returns what changed (for audit).
// The @@unique([userId, warehouseId]) index is the defence-in-depth against a racing duplicate add.
export async function syncAssignments(
  userId: string,
  warehouseIds: string[],
  assignedBy: string | null,
): Promise<{ added: string[]; removed: string[] }> {
  const existing = await prisma.userWarehouseAssignment.findMany({
    where: { userId },
    select: { warehouseId: true },
  });
  const existingIds = new Set(existing.map((r) => r.warehouseId));
  const target = new Set(warehouseIds);
  const toAdd = [...target].filter((id) => !existingIds.has(id));
  const toRemove = [...existingIds].filter((id) => !target.has(id));

  if (toRemove.length) {
    await prisma.userWarehouseAssignment.deleteMany({
      where: { userId, warehouseId: { in: toRemove } },
    });
  }
  if (toAdd.length) {
    await prisma.userWarehouseAssignment.createMany({
      data: toAdd.map((warehouseId) => ({ userId, warehouseId, assignedBy })),
    });
  }
  return { added: toAdd, removed: toRemove };
}

// Remove ALL assignments for a user — the permanent-delete cascade (no Mongo FK cascade).
export function clearForUser(userId: string): Promise<Prisma.BatchPayload> {
  return prisma.userWarehouseAssignment.deleteMany({ where: { userId } });
}
