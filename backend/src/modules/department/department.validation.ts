import { z } from "zod";

export const createDepartmentSchema = z.object({
  name: z
    .string({ error: "Department name is required." })
    .trim()
    .min(1, "Department name is required.")
    .max(60),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(1, "Department name can't be empty.").max(60),
});
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
