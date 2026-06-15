import { z } from "zod";

// Warehouse Type master-data validation — mirrors the Category schema (same shape:
// required name, optional description, optional status; update is fully optional).

const statusEnum = z.enum(["active", "inactive"]);

export const createWarehouseTypeSchema = z.object({
  name: z
    .string({ error: "Warehouse type name is required." })
    .trim()
    .min(1, "Warehouse type name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateWarehouseTypeInput = z.infer<typeof createWarehouseTypeSchema>;

export const updateWarehouseTypeSchema = z.object({
  name: z.string().trim().min(1, "Warehouse type name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateWarehouseTypeInput = z.infer<typeof updateWarehouseTypeSchema>;
