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
  // The super admin's display name — what the issued documents print instead of a raw login. The
  // column existed and nothing ever wrote it, so every PO a super admin raised was signed by an
  // email address. Sent blank on purpose CLEARS it (back to printing the email); the service stores
  // that as null rather than "".
  name: z.string().trim().max(120, "Name must be 120 characters or fewer.").optional(),
});
export type ChangeCredentialsInput = z.infer<typeof changeCredentialsSchema>;

// Staff user changing their own password (first-login forced change + voluntary).
// currentPassword is optional: the first-login change is authorised by the active
// session; a voluntary change re-verifies it (enforced in the service).
export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z
    .string({ error: "New password is required." })
    .min(8, "New password must be at least 8 characters."),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

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
