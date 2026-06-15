import { z } from "zod";

// IRM Category master-data validation — the COMPANY-domain classification taxonomy
// (separate from the customer-domain Category master). Mirrors the Supplier Type schema.

const statusEnum = z.enum(["active", "inactive"]);

export const createIrmCategorySchema = z.object({
  name: z
    .string({ error: "IRM category name is required." })
    .trim()
    .min(1, "IRM category name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateIrmCategoryInput = z.infer<typeof createIrmCategorySchema>;

export const updateIrmCategorySchema = z.object({
  name: z.string().trim().min(1, "IRM category name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateIrmCategoryInput = z.infer<typeof updateIrmCategorySchema>;
