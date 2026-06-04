import { z } from "zod";

// The schema-level `error` covers a missing field (undefined); `.min()` covers
// an empty/too-short value. Both surface the same friendly message.
export const loginSchema = z.object({
  email: z.string({ error: "Email is required" }).trim().min(1, "Email is required").toLowerCase(),
  password: z.string({ error: "Password is required" }).min(1, "Password is required"),
  remember: z.boolean().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const googleLoginSchema = z.object({
  credential: z
    .string({ error: "Missing Google credential." })
    .min(1, "Missing Google credential."),
  remember: z.boolean().optional(),
});
export type GoogleLoginInput = z.infer<typeof googleLoginSchema>;

export const changeCredentialsSchema = z.object({
  currentPassword: z
    .string({ error: "Current password is required." })
    .min(1, "Current password is required."),
  // A blank/whitespace email is treated as "not provided" (the service skips it),
  // matching the original behaviour rather than 400-rejecting the whole request.
  email: z.string().trim().optional(),
  newPassword: z.string().min(8, "New password must be at least 8 characters.").optional(),
});
export type ChangeCredentialsInput = z.infer<typeof changeCredentialsSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string({ error: "Email is required." }).min(1, "Email is required."),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z
    .string({ error: "Reset token and new password are required." })
    .min(1, "Reset token and new password are required."),
  newPassword: z
    .string({ error: "Reset token and new password are required." })
    .min(8, "New password must be at least 8 characters."),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
