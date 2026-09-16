import { Prisma, type PurchaseOrderCustomField } from "@prisma/client";

import { prisma, withTransaction } from "../../lib/prisma.js";

// Data-access for PO custom-field DEFINITIONS. The `labelLower` mirror is derived here so it can never
// drift from the label (the same pattern as warehouse-type.repository's `nameLower`).

export function findMany(): Promise<PurchaseOrderCustomField[]> {
  return prisma.purchaseOrderCustomField.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

export function findById(id: string): Promise<PurchaseOrderCustomField | null> {
  return prisma.purchaseOrderCustomField.findUnique({ where: { id } });
}

export function create(
  data: Omit<Prisma.PurchaseOrderCustomFieldCreateInput, "labelLower">,
): Promise<PurchaseOrderCustomField> {
  return prisma.purchaseOrderCustomField.create({ data: { ...data, labelLower: data.label.toLowerCase() } });
}

export function update(id: string, data: Prisma.PurchaseOrderCustomFieldUpdateInput): Promise<PurchaseOrderCustomField> {
  const patch: Prisma.PurchaseOrderCustomFieldUpdateInput = { ...data };
  if (typeof patch.label === "string") patch.labelLower = patch.label.toLowerCase();
  return prisma.purchaseOrderCustomField.update({ where: { id }, data: patch });
}

// Rewrite every definition's position to its index in `ids`, in ONE transaction — a failure part-way
// must never leave two fields sharing a position.
export async function setSortOrders(ids: string[], updatedBy: string | null): Promise<void> {
  await withTransaction(async (tx) => {
    for (const [sortOrder, id] of ids.entries()) {
      await tx.purchaseOrderCustomField.update({ where: { id }, data: { sortOrder, updatedBy } });
    }
  });
}

// True when a write hit the `labelLower` unique index (P2002) — two saves racing to the same name.
export function isLabelConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
