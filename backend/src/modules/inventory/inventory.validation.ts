import { z } from "zod";

// Warehouse Inventory validation. The module is READ + TRANSFER only — the sole write is a
// warehouse-to-warehouse stock transfer. Codes / status / balances / ledger rows are SYSTEM-owned
// and never accepted from the client.

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const INVENTORY_STATUSES = ["in_stock", "low_stock", "out_of_stock"] as const;

const requiredDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(Date.parse(v)), `Enter a valid ${label.toLowerCase()}.`);

export const createTransferSchema = z
  .object({
    irmItemId: z.string({ error: "Select an item." }).regex(OBJECT_ID_RE, "Select an item."),
    fromWarehouseId: z.string({ error: "Select a source warehouse." }).regex(OBJECT_ID_RE, "Select a source warehouse."),
    toWarehouseId: z.string({ error: "Select a destination warehouse." }).regex(OBJECT_ID_RE, "Select a destination warehouse."),
    quantity: z.coerce.number({ error: "Quantity is required." }).int("Use a whole number.").min(1, "Quantity must be at least 1.").max(10_000_000),
    movementDate: requiredDate("Movement date"),
    referenceNumber: z.string().trim().max(60).optional(),
    description: z.string().trim().max(2000).optional(),
    internalNotes: z.string().trim().max(2000).optional(),
  })
  .refine((d) => d.fromWarehouseId !== d.toWarehouseId, {
    message: "Source and destination warehouses must be different.",
    path: ["toWarehouseId"],
  });
export type CreateTransferInput = z.infer<typeof createTransferSchema>;
