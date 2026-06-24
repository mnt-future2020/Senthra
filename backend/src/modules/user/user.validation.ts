import { z } from "zod";

import { emailField, isValidPhone, optionalPhoneField } from "../../utils/validation.js";

const statusEnum = z.enum(["active", "inactive", "suspended"]);
const genderEnum = z.enum(["male", "female", "other", "unspecified"]);
// Raster image data URIs only. SVG is excluded on purpose — it can embed script and is
// rendered raw in the UI, so it must never be accepted server-side (the client already
// limits the picker, but a direct API call would otherwise bypass that). base64 inflates
// ~33%, so ~3 MB of chars caps the binary near ~2.2 MB (above the 2 MB the UI allows).
const MAX_IMAGE_DATA_URI_CHARS = 3 * 1024 * 1024;
const profileImage = z
  .string()
  .regex(/^data:image\/(png|jpe?g|gif|webp);base64,/i, "Profile image must be a PNG, JPG, GIF or WEBP.")
  .max(MAX_IMAGE_DATA_URI_CHARS, "Profile image is too large (max ~2 MB).");
// A user's signature image as a data URI — PNG/JPG only (matches the signature pad/upload).
const signatureImage = z
  .string()
  .regex(/^data:image\/(png|jpe?g);base64,/i, "Signature must be a PNG or JPG image.")
  .max(MAX_IMAGE_DATA_URI_CHARS, "Signature is too large (max ~2 MB).");

// A date as an ISO / "YYYY-MM-DD" string. An empty string is allowed and the
// service treats it as "clear"; any non-empty value must be a parseable date.
const dateField = z
  .string()
  .trim()
  .refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "Enter a valid date.");

// An optional <select> sends "" when nothing is chosen / when cleared. We accept
// it alongside the real values; the service maps "" to null ("not specified").
const optionalGender = genderEnum.or(z.literal("")).optional();

// Warehouse ids assigned to a warehouse-scoped user. Each must be a Mongo ObjectId. The array is
// optional here (the field only appears for warehouse-scoped roles); the "≥1 active warehouse"
// requirement is enforced in the service, which knows the role. Capped to a sane upper bound.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const warehouseIdsField = z
  .array(z.string().trim().regex(OBJECT_ID_RE, "Select a valid warehouse."))
  .max(500)
  .optional();

// Profile fields shared by create + update (all optional). The service converts
// empty strings to null (clear) and parses the date strings.
const sharedProfileFields = {
  phone: optionalPhoneField,
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
  ...sharedProfileFields,
  // Required for new staff — these override the shared optional fields. (Gender,
  // date of birth and address stay optional.)
  roleId: z.string({ error: "Role is required." }).trim().min(1, "Role is required."),
  phone: z
    .string({ error: "Phone number is required." })
    .trim()
    .min(1, "Phone number is required.")
    .max(40)
    .refine(isValidPhone, "Enter a valid phone number."),
  jobTitle: z
    .string({ error: "Job title is required." })
    .trim()
    .min(1, "Job title is required.")
    .max(80),
  department: z
    .string({ error: "Department is required." })
    .trim()
    .min(1, "Department is required.")
    .max(80),
  dateOfJoining: z
    .string({ error: "Date of joining is required." })
    .trim()
    .min(1, "Date of joining is required.")
    .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date."),
  // Optional here; required (≥1, active) for warehouse-scoped roles — enforced in the service.
  warehouseIds: warehouseIdsField,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1, "First name can't be empty.").max(60).optional(),
  lastName: z.string().trim().min(1, "Last name can't be empty.").max(60).optional(),
  email: emailField().optional(),
  // null clears the role; a string assigns one.
  roleId: z.string().trim().nullable().optional(),
  removeProfileImage: z.boolean().optional(),
  // Synced (add/remove/keep) only for warehouse-scoped roles; omitted = leave assignments untouched.
  warehouseIds: warehouseIdsField,
  ...sharedProfileFields,
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserStatusSchema = z.object({
  status: statusEnum,
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

// Self-service signature upload (My Account). Only the image is required; the
// original filename is optional metadata stored alongside it.
export const uploadSignatureSchema = z.object({
  signature: signatureImage,
  fileName: z.string().trim().max(200).optional(),
});
export type UploadSignatureInput = z.infer<typeof uploadSignatureSchema>;

// Self-service profile edit (My Account / Engineer Portal). STRICT whitelist — only the fields a
// staff member may change about themselves. zod strips every other key, so a client can NEVER set
// email / role / status / employeeId / permissions / date-of-birth through this endpoint.
export const updateMyProfileSchema = z.object({
  phone: optionalPhoneField,
  profileImage: profileImage.optional(),
  removeProfileImage: z.boolean().optional(),
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(12).optional(),
});
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
