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
