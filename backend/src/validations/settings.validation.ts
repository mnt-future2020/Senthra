import { z } from "zod";

// All fields optional — the settings update is a partial patch. Unknown keys are
// stripped by default. Business rules (e.g. required SMTP fields for a test send)
// live in the service, since they depend on merged saved + override values.
export const updateSettingsSchema = z.object({
  googleEnabled: z.boolean().optional(),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  smtpEnabled: z.boolean().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.union([z.string(), z.number()]).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().optional(),
  smtpFromName: z.string().optional(),
  smtpFromEmail: z.string().optional(),
  smtpPassword: z.string().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const testEmailSchema = z.object({
  to: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.union([z.string(), z.number()]).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFromName: z.string().optional(),
  smtpFromEmail: z.string().optional(),
});
export type TestEmailInput = z.infer<typeof testEmailSchema>;
