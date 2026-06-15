import { z } from "zod";

// Supplier Type master-data validation — mirrors the Warehouse Type / Category schema
// (same shape: required name, optional description, optional status; update fully optional).

const statusEnum = z.enum(["active", "inactive"]);

export const createSupplierTypeSchema = z.object({
  name: z
    .string({ error: "Supplier type name is required." })
    .trim()
    .min(1, "Supplier type name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateSupplierTypeInput = z.infer<typeof createSupplierTypeSchema>;

export const updateSupplierTypeSchema = z.object({
  name: z.string().trim().min(1, "Supplier type name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateSupplierTypeInput = z.infer<typeof updateSupplierTypeSchema>;
