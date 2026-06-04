import { z } from "zod";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const statusEnum = z.enum(["active", "inactive", "suspended"]);
const profileImage = z
  .string()
  .startsWith("data:image/", "Profile image must be a data URI (data:image/...)");

const emailField = (required = "Email is required.") =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address.");

export const createUserSchema = z.object({
  firstName: z
    .string({ error: "First name is required." })
    .trim()
    .min(1, "First name is required.")
    .max(60),
  lastName: z
    .string({ error: "Last name is required." })
    .trim()
    .min(1, "Last name is required.")
    .max(60),
  email: emailField(),
  phone: z.string().trim().max(40).optional(),
  roleId: z.string().trim().optional(),
  status: statusEnum.optional(),
  notes: z.string().trim().max(1000).optional(),
  profileImage: profileImage.optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1, "First name can't be empty.").max(60).optional(),
  lastName: z.string().trim().min(1, "Last name can't be empty.").max(60).optional(),
  email: emailField().optional(),
  phone: z.string().trim().max(40).optional(),
  // null clears the role; a string assigns one.
  roleId: z.string().trim().nullable().optional(),
  status: statusEnum.optional(),
  notes: z.string().trim().max(1000).optional(),
  profileImage: profileImage.optional(),
  removeProfileImage: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserStatusSchema = z.object({
  status: statusEnum,
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
