import { z } from "zod";

export const createJobTitleSchema = z.object({
  name: z
    .string({ error: "Job title is required." })
    .trim()
    .min(1, "Job title is required.")
    .max(80),
});
export type CreateJobTitleInput = z.infer<typeof createJobTitleSchema>;

export const updateJobTitleSchema = z.object({
  name: z.string().trim().min(1, "Job title can't be empty.").max(80),
});
export type UpdateJobTitleInput = z.infer<typeof updateJobTitleSchema>;
