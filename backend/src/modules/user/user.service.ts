import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { uploadToCloudinary } from "../../lib/cloudinary.js";
import * as roleRepo from "#modules/role/role.repository.js";
import { assertEmailNamespaceFree } from "#modules/auth/email-namespace.js";
import { ALL_PERMISSIONS } from "#modules/role/permissions.js";
import * as userRepo from "./user.repository.js";
import type { UserWithRole } from "./user.repository.js";
import * as userWarehouseRepo from "./user-warehouse.repository.js";
import type { AssignedWarehouse } from "./user-warehouse.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
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
  // Personal signature (printed on issued documents); signatureUrl is the Cloudinary image.
  signatureUrl: string | null;
  signatureName: string | null;
  signatureMimeType: string | null;
  signatureFileSize: number | null;
  signatureUploadedAt: string | null;
  signatureUpdatedAt: string | null;
  mustResetPassword: boolean;
  role: { id: string; key: string; name: string } | null;
  // Warehouses this user is explicitly assigned (only populated for warehouse-scoped roles; empty
  // otherwise). Drives the edit form's "Assigned Warehouses" prefill. Rows persist across role changes.
  warehouses: AssignedWarehouse[];
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

// `warehouses` defaults to [] — only the single-user reads (get/create/update) pass the assigned
// set; the list keeps it empty to avoid an N+1 (the list never needs per-row assignments).
function publicUser(u: UserWithRole, warehouses: AssignedWarehouse[] = []): PublicUser {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    phone: u.phone,
    status: u.status,
    profileImageUrl: u.profileImageUrl,
    notes: u.notes,
    signatureUrl: u.signatureUrl,
    signatureName: u.signatureName,
    signatureMimeType: u.signatureMimeType,
    signatureFileSize: u.signatureFileSize,
    signatureUploadedAt: isoOrNull(u.signatureUploadedAt),
    signatureUpdatedAt: isoOrNull(u.signatureUpdatedAt),
    mustResetPassword: u.mustResetPassword,
    role: u.role ? { id: u.role.id, key: u.role.key, name: u.role.name } : null,
    warehouses,
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

// --- Warehouse assignment (warehouse-scoped roles, e.g. Warehouse Manager) -------------------
// A role is warehouse-scoped when Role.isWarehouseScoped is true. Such a user may ONLY access the
// warehouses assigned here; the assignment rows persist across role changes (removed only on
// permanent delete / explicit un-assignment).
function isWarehouseScopedRole(role: { isWarehouseScoped?: boolean | null } | null): boolean {
  return Boolean(role?.isWarehouseScoped);
}

const WAREHOUSE_ASSIGNMENT_REQUIRED =
  "Warehouse Manager must have at least one active warehouse assignment.";

// Validate + normalise the requested warehouse ids for a warehouse-scoped user. Dedupes, requires
// at least one, and rejects any id that isn't an ACTIVE, non-deleted warehouse (covers inactive,
// soft-deleted and non-existent). Returns the clean, unique id list ready to sync.
async function resolveWarehouseAssignmentIds(warehouseIds: string[] | undefined): Promise<string[]> {
  const unique = [...new Set((warehouseIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) throw badRequest(WAREHOUSE_ASSIGNMENT_REQUIRED);
  const active = await warehouseRepo.findActiveByIds(unique);
  if (active.length !== unique.length) {
    throw badRequest(
      "One or more selected warehouses are invalid, inactive or removed. Pick active warehouses only.",
    );
  }
  return unique;
}

// Audit the assignment delta produced by a sync (one entry per direction, only when non-empty).
function auditWarehouseAssignmentChanges(
  actor: AuditActor | undefined,
  userId: string,
  userEmail: string,
  changes: { added: string[]; removed: string[] },
): void {
  if (changes.added.length) {
    audit.record({
      actor,
      action: "user.warehouse_assigned",
      targetType: "user",
      targetId: userId,
      targetLabel: userEmail,
      metadata: { warehouseIds: changes.added },
    });
  }
  if (changes.removed.length) {
    audit.record({
      actor,
      action: "user.warehouse_unassigned",
      targetType: "user",
      targetId: userId,
      targetLabel: userEmail,
      metadata: { warehouseIds: changes.removed },
    });
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

// --- User signature (self-service; printed on issued documents) ------------------------------
// Upload under a DETERMINISTIC publicId so re-uploading overwrites the old asset (one signature
// per user, never a gallery). Reuses the same credential resolution as branding/avatar.
async function uploadSignatureImage(image: string, userId: string): Promise<string> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your credentials in Settings → Integrations to upload a signature.",
    );
  }
  return uploadToCloudinary(image, `signature-${userId}`, creds, "senthra/signatures");
}

// Derive the mime type + byte size from a base64 image data URI (data:image/png;base64,XXXX),
// so the stored signature metadata is accurate without trusting the client.
function parseImageDataUri(dataUri: string): { mimeType: string; sizeBytes: number } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri);
  const mimeType = match?.[1]?.trim() || "image/png";
  const payload = match?.[3] ?? "";
  if (match?.[2]) {
    const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return { mimeType, sizeBytes: Math.max(0, Math.floor((payload.length * 3) / 4) - pad) };
  }
  return { mimeType, sizeBytes: Buffer.byteLength(payload, "utf8") };
}

// Reusable reader for the Document Platform: resolve a SIGNER (a PO's `sentBy` email) to a
// printable signature — the person's name + the signature image URL. Returns null when the
// signer has no (non-deleted) account or no signature on file, so generation degrades gracefully.
export interface UserSignature {
  signerName: string;
  jobTitle: string | null;
  url: string;
  mimeType: string | null;
}
export async function getSignatureForEmail(
  email: string | null | undefined,
): Promise<UserSignature | null> {
  const e = email?.trim().toLowerCase();
  if (!e) return null;
  const u = await userRepo.findByEmailWithRole(e);
  if (!u || !u.signatureUrl) return null;
  return {
    signerName: `${u.firstName} ${u.lastName}`.trim(),
    jobTitle: u.jobTitle,
    url: u.signatureUrl,
    mimeType: u.signatureMimeType,
  };
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
  const filters = {
    search: params.search,
    status: params.status,
    roleId: params.roleId,
  };
  const total = await userRepo.count(filters);
  // Clamp the requested page so an out-of-range page returns the last page.
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total);
  const users = await userRepo.findMany(filters, skip, pageSize, params.sort);
  // The list intentionally omits per-user warehouse assignments (avoids an N+1); publicUser
  // defaults them to []. The single-user reads (get/create/update) populate them.
  return { users: users.map((u) => publicUser(u)), total, page, pageSize, totalPages };
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
  const warehouses = await userWarehouseRepo.listForUser(u.id);
  return publicUser(u, warehouses);
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
  // Warehouse ids to assign — REQUIRED (≥1) when the chosen role is warehouse-scoped, ignored otherwise.
  warehouseIds?: string[];
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

  let role: Awaited<ReturnType<typeof roleRepo.findById>> = null;
  let roleId: string | null = null;
  if (input.roleId) {
    role = await roleRepo.findById(input.roleId);
    if (!role) throw badRequest("Selected role does not exist.");
    assertCanAssignRole(role.permissions, actor);
    roleId = role.id;
  }

  // A warehouse-scoped role (e.g. Warehouse Manager) must be assigned ≥1 active warehouse —
  // validated BEFORE the write so we never create a half-provisioned account.
  const scoped = isWarehouseScopedRole(role);
  const assignmentIds = scoped ? await resolveWarehouseAssignmentIds(input.warehouseIds) : [];

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

  // Persist warehouse assignments for a scoped role (validated above). Revive reuses the same user
  // id, so sync overwrites any stale rows from a previous life.
  let warehouses: AssignedWarehouse[] = [];
  if (scoped) {
    const changes = await userWarehouseRepo.syncAssignments(created.id, assignmentIds, actor?.email ?? null);
    auditWarehouseAssignmentChanges(actor, created.id, created.email, changes);
    warehouses = await userWarehouseRepo.listForUser(created.id);
  }

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

  return { user: publicUser(created, warehouses), temporaryPassword };
}

export interface UpdateUserInput extends ProfileFieldsInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  roleId?: string | null;
  removeProfileImage?: boolean;
  // Warehouse ids to sync (add/remove/keep). Honoured only when the EFFECTIVE role is warehouse-
  // scoped; omitted = leave assignments untouched. Assignments are NEVER auto-cleared on role change.
  warehouseIds?: string[];
}

// A staff member who still HOLDS field stock (EngineerStockBalance > 0) can't be moved to a
// non-active status — their van stock would be orphaned with no owner to return it. This only
// BLOCKS; it never auto-transfers, deletes or silently moves stock. Applied to every path that
// can deactivate / suspend a user.
async function assertNotHoldingStock(userId: string): Promise<void> {
  const held = await engineerStockRepo.countEngineerHeldStock(userId);
  if (held > 0) {
    throw conflict("This staff member still holds stock. Return or transfer their stock before deactivating.");
  }
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
  if (typeof input.status === "string") {
    const nextStatus = normalizeStatus(input.status);
    // Block deactivation / suspension while the user still holds field stock.
    if (nextStatus !== "active" && (user.status ?? "active") === "active") {
      await assertNotHoldingStock(id);
    }
    data.status = nextStatus;
  }
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

  // Resolve the EFFECTIVE role after this edit (the new role if changing, else the current one) so we
  // can decide warehouse-scoping correctly.
  let effectiveRole: { isWarehouseScoped?: boolean | null; permissions: string[] } | null = user.role;
  if (input.roleId !== undefined) {
    if (!input.roleId) {
      data.role = { disconnect: true };
      effectiveRole = null;
    } else {
      const role = await roleRepo.findById(input.roleId);
      if (!role) throw badRequest("Selected role does not exist.");
      assertCanAssignRole(role.permissions, actor);
      data.role = { connect: { id: role.id } };
      effectiveRole = role;
    }
  }

  // Warehouse assignments. Validate BEFORE the write so an invalid set never persists. When the role
  // is NOT scoped, assignments are PRESERVED, never auto-deleted (a later re-promotion restores them).
  // The ≥1-assignment invariant is enforced only at the moments it can be safely satisfied:
  //   • explicit warehouseIds sent → resolveWarehouseAssignmentIds requires a non-empty active set;
  //   • PROMOTING a user INTO a scoped role without warehouseIds → require existing assignments to
  //     restore (mirrors create), else the promotion has no warehouses.
  // An UNRELATED edit of an already-scoped user (e.g. phone/status) is NEVER blocked on a pre-existing
  // zero-assignment state — an admin must always be able to fix or deactivate such a user.
  const scoped = isWarehouseScopedRole(effectiveRole);
  const wasScoped = isWarehouseScopedRole(user.role);
  let assignmentIds: string[] | null = null;
  if (scoped) {
    if (input.warehouseIds !== undefined) {
      assignmentIds = await resolveWarehouseAssignmentIds(input.warehouseIds);
    } else if (!wasScoped && (await userWarehouseRepo.listWarehouseIds(id)).length === 0) {
      throw badRequest(WAREHOUSE_ASSIGNMENT_REQUIRED);
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

  if (scoped && assignmentIds !== null) {
    const changes = await userWarehouseRepo.syncAssignments(id, assignmentIds, actor?.email ?? null);
    auditWarehouseAssignmentChanges(actor, id, updated.email, changes);
  }

  const warehouses = await userWarehouseRepo.listForUser(id);
  return publicUser(updated, warehouses);
}

export async function setUserStatus(
  id: string,
  status: string,
  actor?: AuditActor,
): Promise<PublicUser> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");
  const next = normalizeStatus(status);
  // Block deactivation / suspension while the user still holds field stock.
  if (next !== "active" && (user.status ?? "active") === "active") {
    await assertNotHoldingStock(id);
  }
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

// --- Self-service profile (My Account / Engineer Portal) ------------------------------------
// A staff user reads + edits THEIR OWN profile. STRICT whitelist: phone, avatar and address only —
// role / status / email / employeeId / permissions / DOB are never touched here (the validation
// schema strips them, and this mapper only reads the safe fields). Signature has its own endpoints.
export async function getMyProfile(actor?: AuditActor): Promise<PublicUser> {
  if (actor?.type !== "user" || !actor.id) throw forbidden("Staff account required.");
  const user = await userRepo.findById(actor.id);
  if (!user) throw notFound("User not found.");
  return publicUser(user);
}

export interface UpdateMyProfileParams {
  phone?: string;
  profileImage?: string;
  removeProfileImage?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postcode?: string;
}

export async function updateMyProfile(
  input: UpdateMyProfileParams,
  actor?: AuditActor,
): Promise<PublicUser> {
  if (actor?.type !== "user" || !actor.id) throw forbidden("Staff account required.");
  const user = await userRepo.findById(actor.id);
  if (!user) throw notFound("User not found.");

  const data: Prisma.UserUpdateInput = {};
  if (typeof input.phone === "string") data.phone = trimToNull(input.phone);
  if (typeof input.addressLine1 === "string") data.addressLine1 = trimToNull(input.addressLine1);
  if (typeof input.addressLine2 === "string") data.addressLine2 = trimToNull(input.addressLine2);
  if (typeof input.city === "string") data.city = trimToNull(input.city);
  if (typeof input.postcode === "string") data.postcode = trimToNull(input.postcode);
  if (input.removeProfileImage) data.profileImageUrl = null;
  else if (input.profileImage) data.profileImageUrl = await uploadAvatar(input.profileImage);

  const updated = await userRepo.update(user.id, data);
  audit.record({
    actor,
    action: "user.profile_updated",
    targetType: "user",
    targetId: user.id,
    targetLabel: updated.email,
  });
  return publicUser(updated);
}

// --- Self-service signature (My Account) ----------------------------------------------------
// The acting staff user uploads / clears THEIR OWN signature. Gated by requireAuth only (no
// granular permission), like the self password change. Non-staff actors are rejected.
export interface UploadSignatureParams {
  signature: string; // data:image/... URI
  fileName?: string;
}

export async function uploadMySignature(
  input: UploadSignatureParams,
  actor?: AuditActor,
): Promise<PublicUser> {
  if (actor?.type !== "user" || !actor.id) {
    throw forbidden("Only a staff account can set a signature.");
  }
  const user = await userRepo.findById(actor.id);
  if (!user) throw notFound("User not found.");

  const url = await uploadSignatureImage(input.signature, user.id);
  const { mimeType, sizeBytes } = parseImageDataUri(input.signature);
  const now = new Date();
  const updated = await userRepo.update(user.id, {
    signatureUrl: url,
    signatureName: trimToNull(input.fileName),
    signatureMimeType: mimeType,
    signatureFileSize: sizeBytes,
    // First upload stamps "uploaded"; every save refreshes "updated".
    signatureUploadedAt: user.signatureUploadedAt ?? now,
    signatureUpdatedAt: now,
  });
  audit.record({
    actor,
    action: "user.signature_uploaded",
    targetType: "user",
    targetId: user.id,
    targetLabel: updated.email,
  });
  return publicUser(updated);
}

export async function removeMySignature(actor?: AuditActor): Promise<PublicUser> {
  if (actor?.type !== "user" || !actor.id) {
    throw forbidden("Only a staff account can set a signature.");
  }
  const user = await userRepo.findById(actor.id);
  if (!user) throw notFound("User not found.");

  const updated = await userRepo.update(user.id, {
    signatureUrl: null,
    signatureName: null,
    signatureMimeType: null,
    signatureFileSize: null,
    signatureUploadedAt: null,
    signatureUpdatedAt: null,
  });
  audit.record({
    actor,
    action: "user.signature_removed",
    targetType: "user",
    targetId: user.id,
    targetLabel: updated.email,
  });
  return publicUser(updated);
}
