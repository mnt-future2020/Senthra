import { z } from "zod";

// IRM Type master-data validation — mirrors the Supplier Type / Category schema (required
// name, optional description + status; update fully optional).

const statusEnum = z.enum(["active", "inactive"]);

export const createIrmTypeSchema = z.object({
  name: z
    .string({ error: "IRM type name is required." })
    .trim()
    .min(1, "IRM type name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type CreateIrmTypeInput = z.infer<typeof createIrmTypeSchema>;

export const updateIrmTypeSchema = z.object({
  name: z.string().trim().min(1, "IRM type name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  status: statusEnum.optional(),
});
export type UpdateIrmTypeInput = z.infer<typeof updateIrmTypeSchema>;
