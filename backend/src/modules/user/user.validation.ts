import { z } from "zod";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const statusEnum = z.enum(["active", "inactive", "suspended"]);
const genderEnum = z.enum(["male", "female", "other", "unspecified"]);
const profileImage = z
  .string()
  .startsWith("data:image/", "Profile image must be a data URI (data:image/...)");

const emailField = (required = "Email is required.") =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address.");

// A date as an ISO / "YYYY-MM-DD" string. An empty string is allowed and the
// service treats it as "clear"; any non-empty value must be a parseable date.
const dateField = z
  .string()
  .trim()
  .refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "Enter a valid date.");

// An optional <select> sends "" when nothing is chosen / when cleared. We accept
// it alongside the real values; the service maps "" to null ("not specified").
const optionalGender = genderEnum.or(z.literal("")).optional();

// Profile fields shared by create + update (all optional). The service converts
// empty strings to null (clear) and parses the date strings.
const sharedProfileFields = {
  phone: z.string().trim().max(40).optional(),
  status: statusEnum.optional(),
  notes: z.string().trim().max(1000).optional(),
  profileImage: profileImage.optional(),
  // Employment
  jobTitle: z.string().trim().max(80).optional(),
  department: z.string().trim().max(80).optional(),
  dateOfJoining: dateField.optional(),
  // Personal
  gender: optionalGender,
  dateOfBirth: dateField.optional(),
  // Address (UK)
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(12).optional(),
};

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
  roleId: z.string().trim().optional(),
  ...sharedProfileFields,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1, "First name can't be empty.").max(60).optional(),
  lastName: z.string().trim().min(1, "Last name can't be empty.").max(60).optional(),
  email: emailField().optional(),
  // null clears the role; a string assigns one.
  roleId: z.string().trim().nullable().optional(),
  removeProfileImage: z.boolean().optional(),
  ...sharedProfileFields,
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserStatusSchema = z.object({
  status: statusEnum,
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
