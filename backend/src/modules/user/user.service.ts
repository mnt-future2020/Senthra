import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { uploadToCloudinary } from "../../lib/cloudinary.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as userRepo from "./user.repository.js";
import type { UserWithRole } from "./user.repository.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { getCloudinaryCreds } from "#modules/settings/settings.service.js";

const STATUSES = ["active", "inactive", "suspended"] as const;
export type UserStatus = (typeof STATUSES)[number];

// Shape returned to the client — never includes the password hash or any token.
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
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

function normalizeStatus(status?: string): UserStatus {
  return status && (STATUSES as readonly string[]).includes(status)
    ? (status as UserStatus)
    : "active";
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
  const users = await userRepo.findMany(filters, (page - 1) * pageSize, pageSize);
  return { users: users.map(publicUser), total, page, pageSize, totalPages };
}

export async function getUser(id: string): Promise<PublicUser> {
  const u = await userRepo.findById(id);
  if (!u) throw notFound("User not found.");
  return publicUser(u);
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  roleId?: string;
  status?: string;
  notes?: string;
  profileImage?: string; // data URI
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

  // An ACTIVE user with this email is a real conflict. A SOFT-DELETED one is
  // revived below (re-adding a removed user reuses the record + a new password).
  const existing = await userRepo.findByEmailIncludingDeleted(email);
  if (existing && !existing.deletedAt) {
    throw conflict("A user with that email already exists.");
  }

  let roleId: string | null = null;
  if (input.roleId) {
    const role = await roleRepo.findById(input.roleId);
    if (!role) throw badRequest("Selected role does not exist.");
    roleId = role.id;
  }

  const temporaryPassword = generateTempPassword();
  // Hashing (CPU-bound) and the avatar upload (network) are independent — run them
  // concurrently instead of serially.
  const [passwordHash, profileImageUrl] = await Promise.all([
    hashPassword(temporaryPassword),
    input.profileImage ? uploadAvatar(input.profileImage) : Promise.resolve(null),
  ]);

  const fields = {
    firstName,
    lastName,
    email,
    phone: input.phone?.trim() || null,
    status: normalizeStatus(input.status),
    notes: input.notes?.trim() || null,
    profileImageUrl,
    passwordHash,
    mustResetPassword: true,
  };

  let created: UserWithRole;
  if (existing) {
    // Revive: clear deletedAt and overwrite the record with the new details.
    created = await userRepo.update(existing.id, {
      ...fields,
      deletedAt: null,
      role: roleId ? { connect: { id: roleId } } : { disconnect: true },
    });
  } else {
    const data: Prisma.UserCreateInput = { ...fields };
    if (roleId) data.role = { connect: { id: roleId } };
    created = await userRepo.create(data);
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

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  roleId?: string | null;
  status?: string;
  notes?: string;
  profileImage?: string; // new image to upload
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
      const clash = await userRepo.findByEmailIncludingDeleted(email);
      if (clash && clash.id !== id) throw conflict("A user with that email already exists.");
      data.email = email;
    }
  }
  if (typeof input.phone === "string") data.phone = input.phone.trim() || null;
  if (typeof input.notes === "string") data.notes = input.notes.trim() || null;
  if (typeof input.status === "string") data.status = normalizeStatus(input.status);

  if (input.roleId !== undefined) {
    if (!input.roleId) {
      data.role = { disconnect: true };
    } else {
      const role = await roleRepo.findById(input.roleId);
      if (!role) throw badRequest("Selected role does not exist.");
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
