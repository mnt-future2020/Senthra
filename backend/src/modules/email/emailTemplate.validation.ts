import { z } from "zod";

export const createTemplateSchema = z.object({
  name: z
    .string({ error: "Template name is required." })
    .trim()
    .min(1, "Template name is required.")
    .max(120),
  category: z.string().trim().max(40).optional(),
  subject: z
    .string({ error: "Subject is required." })
    .trim()
    .min(1, "Subject is required.")
    .max(300),
  // The editable plain-text message; the branded HTML is generated from it.
  textContent: z
    .string({ error: "Message is required." })
    .min(1, "Message is required.")
    .max(20000, "Message is too long (max 20,000 characters)."),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1, "Name can't be empty.").max(120).optional(),
  category: z.string().trim().max(40).optional(),
  subject: z.string().trim().min(1, "Subject can't be empty.").max(300).optional(),
  textContent: z.string().max(20000, "Message is too long (max 20,000 characters).").optional(),
  enabled: z.boolean().optional(),
});
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const setEnabledSchema = z.object({
  enabled: z.boolean({ error: "enabled must be true or false." }),
});
export type SetEnabledInput = z.infer<typeof setEnabledSchema>;

export const previewTemplateSchema = z.object({
  subject: z.string().optional(),
  textContent: z.string().optional(),
});
export type PreviewTemplateInput = z.infer<typeof previewTemplateSchema>;

export const testTemplateSchema = z.object({
  to: z
    .string({ error: "Recipient email is required." })
    .trim()
    .min(1, "Recipient email is required."),
});
export type TestTemplateInput = z.infer<typeof testTemplateSchema>;
