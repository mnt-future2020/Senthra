import { z } from "zod";

// Rental Category master-data validation. Mirrors the IRM Category schema — the two are separate
// masters on purpose (one category master per domain; see the design spec §2.2), not two names for
// one taxonomy.

export const RENTAL_CATEGORY_STATUSES = ["active", "inactive"] as const;
const statusEnum = z.enum(RENTAL_CATEGORY_STATUSES);

export const createRentalCategorySchema = z.object({
  name: z
    .string({ error: "Rental category name is required." })
    .trim()
    .min(1, "Rental category name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateRentalCategoryInput = z.infer<typeof createRentalCategorySchema>;

export const updateRentalCategorySchema = z.object({
  name: z.string().trim().min(1, "Rental category name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateRentalCategoryInput = z.infer<typeof updateRentalCategorySchema>;
