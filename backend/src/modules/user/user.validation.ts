import { z } from "zod";

import {
  addYearsIso,
  earliestClientToday,
  emailField,
  isCalendarDate,
  isValidPhone,
  latestClientToday,
  optionalIsoDateField,
  optionalPhoneField,
  yearsBetween,
} from "../../utils/validation.js";
import { postcodeField as ukPostcode } from "../../utils/postcode.js";

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

// ---------------------------------------------------------------------------
// Staff date policy — mirrored in the front-end's lib/validation.ts. Both sides
// MUST agree: the client validates for instant feedback, the server is the only
// thing an API call can't skip. If you change a bound here, change it there.
// ---------------------------------------------------------------------------

// 16 is the UK school-leaving / lawful-employment age, so it never blocks a real
// hire (apprentices included) while still catching a mistyped birth year.
export const MIN_STAFF_AGE = 16;
// An upper bound on age rather than a hardcoded earliest year: "before 1900"
// quietly becomes wrong as time passes, "older than 120" does not.
export const MAX_STAFF_AGE = 120;
// A confirmed hire can be recorded before they start, but a start date years out
// is a typo.
export const MAX_JOINING_YEARS_AHEAD = 1;

// Date of birth is optional (an empty string clears it), but any value given must
// be a real calendar date describing a plausibly-aged living person.
//
// Each bound is measured against the most permissive day a legitimate client could
// be calling "today" (see TZ_DAY_SKEW) — the browser validates on ITS local date,
// and a server rejecting what the user's own calendar accepted is a bug the user
// can neither understand nor act on.
const dateOfBirthField = optionalIsoDateField("date of birth").superRefine((v, ctx) => {
  if (v === "") return;
  if (v > latestClientToday()) {
    ctx.addIssue({ code: "custom", message: "Date of birth can't be in the future." });
    return;
  }
  // Old enough: judged against the latest "today" (most generous).
  if (yearsBetween(v, latestClientToday()) < MIN_STAFF_AGE) {
    ctx.addIssue({ code: "custom", message: `Staff must be at least ${MIN_STAFF_AGE} years old.` });
    return;
  }
  // Not implausibly old: judged against the earliest "today" (also most generous).
  if (yearsBetween(v, earliestClientToday()) > MAX_STAFF_AGE) {
    ctx.addIssue({ code: "custom", message: "Enter a valid date of birth — that's over 120 years ago." });
  }
});

// Shared bound-checking for date of joining, used by both the optional (update)
// and required (create) variants.
function checkDateOfJoining(v: string, ctx: z.RefinementCtx): void {
  if (v > addYearsIso(latestClientToday(), MAX_JOINING_YEARS_AHEAD)) {
    ctx.addIssue({ code: "custom", message: "Date of joining can't be more than a year in the future." });
  }
}

const dateOfJoiningField = optionalIsoDateField("date of joining").superRefine((v, ctx) => {
  if (v === "") return;
  checkDateOfJoining(v, ctx);
});

// The cross-field rule: nobody joined before their 16th birthday. Subsumes the
// weaker "born after they joined" check. Exported because the update path has to
// apply it against whichever half is still in the database — see user.service.ts.
export function joiningPrecedesMinAge(dobIso: string, joiningIso: string): boolean {
  return joiningIso < addYearsIso(dobIso, MIN_STAFF_AGE);
}

export const JOINING_BEFORE_MIN_AGE_MESSAGE = `Date of joining is before this person turned ${MIN_STAFF_AGE}. Check both dates.`;

// Applies the cross-field rule when a payload carries BOTH dates. A schema can
// only see what was submitted, so the update path re-checks in the service.
function refineDatePair(d: { dateOfBirth?: string; dateOfJoining?: string }, ctx: z.RefinementCtx): void {
  const dob = d.dateOfBirth;
  const joining = d.dateOfJoining;
  if (!dob || !joining) return;
  if (joiningPrecedesMinAge(dob, joining)) {
    ctx.addIssue({ code: "custom", path: ["dateOfJoining"], message: JOINING_BEFORE_MIN_AGE_MESSAGE });
  }
}

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
  dateOfJoining: dateOfJoiningField.optional(),
  // Personal
  gender: optionalGender,
  dateOfBirth: dateOfBirthField.optional(),
  // Address (UK)
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  // Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
  postcode: ukPostcode().optional(),
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
    .refine(isCalendarDate, "Enter a valid date of joining as a real calendar date.")
    .superRefine(checkDateOfJoining),
  // Optional here; required (≥1, active) for warehouse-scoped roles — enforced in the service.
  warehouseIds: warehouseIdsField,
}).superRefine(refineDatePair);
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
}).superRefine(refineDatePair);
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
  // Validates AND normalises to canonical form ("ls14dy" → "LS1 4DY") — see utils/postcode.ts.
  postcode: ukPostcode().optional(),
});
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
