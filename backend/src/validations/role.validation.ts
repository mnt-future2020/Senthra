import { z } from "zod";

export const createRoleSchema = z.object({
  name: z
    .string({ error: "Role name is required." })
    .trim()
    .min(1, "Role name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, "Role name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
