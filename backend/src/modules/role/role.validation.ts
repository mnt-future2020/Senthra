import { z } from "zod";

import { PERMISSION_KEYS } from "./permissions.js";

// Permission keys are validated against the catalog in the service (so the error
// can list the unknown ones); here we just bound the shape.
//
// The ceiling is DERIVED from the catalogue, never hardcoded. It used to be a flat 50; the
// catalogue grew past that and every role needing more than 50 keys became unsaveable through
// the API, failing with a bare "Too big: expected array to have <=50 items" that named neither
// the field nor the limit. It went unnoticed because the two paths that hold the most
// permissions both skip this schema: the super-admin holds the single "*" wildcard, and the
// seeder writes built-in roles straight through the repository.
//
// The largest meaningful payload is "every key in the catalogue, plus the wildcard". Anything
// beyond that is duplicates or unknown keys, which sanitizePermissions dedupes or rejects by
// name — a far better error than a length complaint. So the bound exists only to stop an
// absurd body, not to limit what an admin may grant.
const MAX_PERMISSIONS = PERMISSION_KEYS.length + 1;

// Longest real key is ~31 chars; 100 leaves generous room for new ones while keeping a single
// element from being a megabyte of text. Over-long values are junk, not a key a user could
// have picked from the matrix.
const MAX_PERMISSION_KEY_LENGTH = 100;

const permissionsField = z
  .array(z.string().max(MAX_PERMISSION_KEY_LENGTH, "Invalid permission key."))
  .max(MAX_PERMISSIONS, "Too many permissions.")
  .optional();

export const createRoleSchema = z.object({
  name: z
    .string({ error: "Role name is required." })
    .trim()
    .min(1, "Role name is required.")
    .max(60),
  description: z.string().trim().max(300).optional(),
  permissions: permissionsField,
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1, "Role name can't be empty.").max(60).optional(),
  description: z.string().trim().max(300).optional(),
  permissions: permissionsField,
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
