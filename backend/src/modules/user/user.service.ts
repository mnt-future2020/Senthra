import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { uploadToCloudinary } from "../../lib/cloudinary.js";
import * as roleRepo from "#modules/role/role.repository.js";
import { assertEmailNamespaceFree } from "#modules/auth/email-namespace.js";
import { ALL_PERMISSIONS } from "#modules/role/permissions.js";
import * as userRepo from "./user.repository.js";
import type { UserWithRole } from "./user.repository.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { getCloudinaryCreds, getEmployeeIdPrefix } from "#modules/settings/settings.service.js";

const STATUSES = ["active", "inactive", "suspended"] as const;
export type UserStatus = (typeof STATUSES)[number];

// Shape returned to the client — never includes the password hash or any token.
// Dates are serialised as ISO strings (or null).
export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  profileImageUrl: string | null;
  notes: string | null;
  mustResetPassword: boolean;
  role: { id: string; key: string; name: string } | null;
  // Employment
  employeeId: string | null;
  jobTitle: string | null;
  department: string | null;
  dateOfJoining: string | null;
  // Personal
  gender: string | null;
  dateOfBirth: string | null;
  // Address (UK)
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  createdAt: string;
  updatedAt: string;
}

function publicUser(u: UserWithRole): PublicUser {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    phone: u.phone,
    status: u.status,
    profileImageUrl: u.profileImageUrl,
    notes: u.notes,
    mustResetPassword: u.mustResetPassword,
    role: u.role ? { id: u.role.id, key: u.role.key, name: u.role.name } : null,
    employeeId: u.employeeId,
    jobTitle: u.jobTitle,
    department: u.department,
    dateOfJoining: isoOrNull(u.dateOfJoining),
    gender: u.gender,
    dateOfBirth: isoOrNull(u.dateOfBirth),
    addressLine1: u.addressLine1,
    addressLine2: u.addressLine2,
    city: u.city,
    postcode: u.postcode,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

function normalizeStatus(status?: string): UserStatus {
  return status && (STATUSES as readonly string[]).includes(status)
    ? (status as UserStatus)
    : "active";
}

// Trim a string field to its stored form: a non-empty trimmed value, or null.
function trimToNull(v?: string | null): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length ? t : null;
}

// Parse an optional date-string field to a Date, or null when blank.
function dateOrNull(v?: string | null): Date | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length ? new Date(t) : null;
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);


// Escalation guard: an actor must not assign a role that grants more than the
// actor itself holds. Anyone holding full access ("*") — the super-admin account
// or a staff user with a full-access role — may assign any role; everyone else is
// held to a strict no-escalation rule (subset of their own permissions).
function assertCanAssignRole(rolePermissions: string[], actor?: AuditActor): void {
  const granted = new Set(actor?.permissions ?? []);
  if (granted.has(ALL_PERMISSIONS)) return;

  // A delegated actor can never grant full access (mint another super-user)...
  if (rolePermissions.includes(ALL_PERMISSIONS)) {
    throw forbidden("You can't assign a role with full access. Ask a super-admin.");
  }
  // ...nor grant any individual permission it doesn't itself hold.
  const escalated = rolePermissions.filter((p) => !granted.has(p));
  if (escalated.length) {
    throw forbidden(
      `You can't assign a role that grants permissions you don't have: ${escalated.join(", ")}.`,
    );
  }
}

// Upload a profile image to Cloudinary (random public id, "users" folder) and
// return its secure URL. Reuses the same credential resolution as branding.
async function uploadAvatar(image: string): Promise<string> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your credentials in Settings → Integrations to upload profile images.",
    );
  }
  return uploadToCloudinary(image, crypto.randomUUID(), creds, "senthra/users");
}

export interface ListUsersParams {
  search?: string;
  status?: string;
  roleId?: string;
  page?: number;
  pageSize?: number;
  sort?: string; // newest (default) | oldest | name
}

export interface PagedUsers {
  users: PublicUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listUsers(params: ListUsersParams = {}): Promise<PagedUsers> {
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 20), 1), 100);
  const filters = {
    search: params.search,
    status: params.status,
    roleId: params.roleId,
  };
  const total = await userRepo.count(filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp the requested page so an out-of-range page returns the last page.
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const users = await userRepo.findMany(filters, (page - 1) * pageSize, pageSize, params.sort);
  return { users: users.map(publicUser), total, page, pageSize, totalPages };
}

// A 24-char hex string is a Mongo ObjectId; anything else is treated as the human
// employee reference (e.g. "STR-0007"). The two formats never overlap (employee
// refs always contain a "-"), so resolution is unambiguous.
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Resolve a user by either its database id OR its employeeId, so callers (the edit
// page) can use the friendly reference in the URL while still working for legacy
// rows that have no employeeId (those fall back to the id).
export async function getUser(idOrEmployeeId: string): Promise<PublicUser> {
  const u = OBJECT_ID_RE.test(idOrEmployeeId)
    ? await userRepo.findById(idOrEmployeeId)
    : await userRepo.findByEmployeeIdWithRole(idOrEmployeeId);
  if (!u) throw notFound("User not found.");
  return publicUser(u);
}

// Optional profile fields shared by create + update. Dates arrive as ISO /
// "YYYY-MM-DD" strings; an empty string means "clear". employeeId is server-managed
// (auto-generated, read-only) and never accepted from the client.
export interface ProfileFieldsInput {
  phone?: string;
  status?: string;
  notes?: string;
  profileImage?: string; // data URI
  jobTitle?: string;
  department?: string;
  dateOfJoining?: string;
  gender?: string;
  dateOfBirth?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
}

export interface CreateUserInput extends ProfileFieldsInput {
  firstName: string;
  lastName: string;
  email: string;
  roleId?: string;
}

// The temporary password is returned ONCE so the admin can copy/relay it; it is
// never stored in plaintext or returned again.
export interface CreateUserResult {
  user: PublicUser;
  temporaryPassword: string;
}

export async function createUser(
  input: CreateUserInput,
  actor?: AuditActor,
): Promise<CreateUserResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = input.email.trim().toLowerCase();
  if (!firstName || !lastName) throw badRequest("First and last name are required.");
  if (!email) throw badRequest("Email is required.");

  // Reject an email claimed by the admin or a customer (keeps the login namespaces
  // disjoint). The user's OWN collection is handled separately: an ACTIVE user with
  // this email is a real conflict, while a SOFT-DELETED one is revived below
  // (re-adding a removed user reuses the record + a new password).
  await assertEmailNamespaceFree(email, { skip: { staff: true } });
  const existing = await userRepo.findByEmailIncludingDeleted(email);
  if (existing && !existing.deletedAt) {
    throw conflict("A user with that email already exists.");
  }

  let roleId: string | null = null;
  if (input.roleId) {
    const role = await roleRepo.findById(input.roleId);
    if (!role) throw badRequest("Selected role does not exist.");
    assertCanAssignRole(role.permissions, actor);
    roleId = role.id;
  }

  const temporaryPassword = generateTempPassword();
  // The password hash (CPU-bound bcrypt), avatar upload (network) and prefix lookup
  // (DB) are independent — run them concurrently rather than serially. The employeeId
  // itself is allocated by the repository at write time (race-safe against the unique
  // index), using this configured prefix.
  const [passwordHash, profileImageUrl, employeeIdPrefix] = await Promise.all([
    hashPassword(temporaryPassword),
    input.profileImage ? uploadAvatar(input.profileImage) : Promise.resolve(null),
    getEmployeeIdPrefix(),
  ]);

  const fields = {
    firstName,
    lastName,
    email,
    phone: trimToNull(input.phone),
    status: normalizeStatus(input.status),
    notes: trimToNull(input.notes),
    profileImageUrl,
    jobTitle: trimToNull(input.jobTitle),
    department: trimToNull(input.department),
    dateOfJoining: dateOrNull(input.dateOfJoining),
    gender: input.gender || null,
    dateOfBirth: dateOrNull(input.dateOfBirth),
    addressLine1: trimToNull(input.addressLine1),
    addressLine2: trimToNull(input.addressLine2),
    city: trimToNull(input.city),
    postcode: trimToNull(input.postcode),
    passwordHash,
    mustResetPassword: true,
  };

  let created: UserWithRole;
  if (existing) {
    // Revive: clear deletedAt and overwrite the record with the new details. The
    // repository re-allocates a collision-safe employeeId as part of the write.
    created = await userRepo.reviveWithEmployeeId(
      existing.id,
      {
        ...fields,
        deletedAt: null,
        role: roleId ? { connect: { id: roleId } } : { disconnect: true },
      },
      employeeIdPrefix,
    );
  } else {
    const data: Omit<Prisma.UserCreateInput, "employeeId"> = { ...fields };
    if (roleId) data.role = { connect: { id: roleId } };
    created = await userRepo.createWithEmployeeId(data, employeeIdPrefix);
  }

  audit.record({
    actor,
    action: "user.created",
    targetType: "user",
    targetId: created.id,
    targetLabel: created.email,
    metadata: { roleId, revived: Boolean(existing) },
  });

  // Account email — fire-and-forget so a slow/unconfigured SMTP never blocks the
  // response; the failure is captured in the email delivery log.
  void sendTemplatedEmail(
    "user.created",
    created.email,
    {
      firstName: created.firstName,
      lastName: created.lastName,
      email: created.email,
      roleName: created.role?.name ?? "No role assigned",
      temporaryPassword,
    },
    { force: true },
  ).catch((e) =>
    console.error("user.created email failed:", e instanceof Error ? e.message : e),
  );

  return { user: publicUser(created), temporaryPassword };
}

export interface UpdateUserInput extends ProfileFieldsInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  roleId?: string | null;
  removeProfileImage?: boolean;
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor?: AuditActor,
): Promise<PublicUser> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");

  const data: Prisma.UserUpdateInput = {};
  if (typeof input.firstName === "string" && input.firstName.trim()) {
    data.firstName = input.firstName.trim();
  }
  if (typeof input.lastName === "string" && input.lastName.trim()) {
    data.lastName = input.lastName.trim();
  }
  if (typeof input.email === "string" && input.email.trim()) {
    const email = input.email.trim().toLowerCase();
    if (email !== user.email) {
      await assertEmailNamespaceFree(email, { skip: { staff: true } });
      const clash = await userRepo.findByEmailIncludingDeleted(email);
      if (clash && clash.id !== id) throw conflict("A user with that email already exists.");
      data.email = email;
    }
  }
  if (typeof input.phone === "string") data.phone = trimToNull(input.phone);
  if (typeof input.notes === "string") data.notes = trimToNull(input.notes);
  if (typeof input.status === "string") data.status = normalizeStatus(input.status);
  // Employment
  if (typeof input.jobTitle === "string") data.jobTitle = trimToNull(input.jobTitle);
  if (typeof input.department === "string") data.department = trimToNull(input.department);
  if (typeof input.dateOfJoining === "string") data.dateOfJoining = dateOrNull(input.dateOfJoining);
  // Personal
  if (input.gender !== undefined) data.gender = input.gender || null;
  if (typeof input.dateOfBirth === "string") data.dateOfBirth = dateOrNull(input.dateOfBirth);
  // Address (UK)
  if (typeof input.addressLine1 === "string") data.addressLine1 = trimToNull(input.addressLine1);
  if (typeof input.addressLine2 === "string") data.addressLine2 = trimToNull(input.addressLine2);
  if (typeof input.city === "string") data.city = trimToNull(input.city);
  if (typeof input.postcode === "string") data.postcode = trimToNull(input.postcode);

  if (input.roleId !== undefined) {
    if (!input.roleId) {
      data.role = { disconnect: true };
    } else {
      const role = await roleRepo.findById(input.roleId);
      if (!role) throw badRequest("Selected role does not exist.");
      assertCanAssignRole(role.permissions, actor);
      data.role = { connect: { id: role.id } };
    }
  }

  if (input.removeProfileImage) data.profileImageUrl = null;
  else if (input.profileImage) data.profileImageUrl = await uploadAvatar(input.profileImage);

  const updated = await userRepo.update(id, data);
  audit.record({
    actor,
    action: "user.updated",
    targetType: "user",
    targetId: id,
    targetLabel: updated.email,
  });
  return publicUser(updated);
}

export async function setUserStatus(
  id: string,
  status: string,
  actor?: AuditActor,
): Promise<PublicUser> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");
  const next = normalizeStatus(status);
  const updated = await userRepo.update(id, { status: next });
  audit.record({
    actor,
    action: `user.status.${next}`,
    targetType: "user",
    targetId: id,
    targetLabel: updated.email,
    metadata: { from: user.status, to: next },
  });
  return publicUser(updated);
}

export async function deleteUser(id: string, actor?: AuditActor): Promise<void> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");
  await userRepo.softDelete(id);
  audit.record({
    actor,
    action: "user.deleted",
    targetType: "user",
    targetId: id,
    targetLabel: user.email,
  });
}

// Regenerate a temporary password and re-send the account email — used when an
// invite is lost or the temp password needs resetting.
export async function resendInvite(
  id: string,
  actor?: AuditActor,
): Promise<{ temporaryPassword: string }> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");

  const temporaryPassword = generateTempPassword();
  await userRepo.update(id, {
    passwordHash: await hashPassword(temporaryPassword),
    mustResetPassword: true,
  });
  audit.record({
    actor,
    action: "user.invite_resent",
    targetType: "user",
    targetId: id,
    targetLabel: user.email,
  });

  void sendTemplatedEmail(
    "user.created",
    user.email,
    {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleName: user.role?.name ?? "No role assigned",
      temporaryPassword,
    },
    { force: true },
  ).catch((e) =>
    console.error("resend invite email failed:", e instanceof Error ? e.message : e),
  );

  return { temporaryPassword };
}
