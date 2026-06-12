import { z } from "zod";

// Status mirrors every other model in the schema: a plain string constrained at the
// validation boundary (the schema deliberately uses no Prisma enums).
const statusEnum = z.enum(["active", "inactive"]);

export const createCategorySchema = z.object({
  name: z
    .string({ error: "Category name is required." })
    .trim()
    .min(1, "Category name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Category name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
