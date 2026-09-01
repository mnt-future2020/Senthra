import crypto from "node:crypto";

import type { Prisma } from "@prisma/client";

import { uploadToCloudinary } from "../../lib/cloudinary.js";
import type { CloudinaryImageAsset } from "../../lib/cloudinary.js";
import * as roleRepo from "#modules/role/role.repository.js";
import * as adminRepo from "#modules/auth/admin.repository.js";
import * as sessionService from "#modules/auth/session.service.js";
import * as notificationService from "#modules/notification/notification.service.js";
import { assertEmailNamespaceFree } from "#modules/auth/email-namespace.js";
import { ALL_PERMISSIONS } from "#modules/role/permissions.js";
import * as userRepo from "./user.repository.js";
import type { UserWithRole } from "./user.repository.js";
import { JOINING_BEFORE_MIN_AGE_MESSAGE, joiningPrecedesMinAge } from "./user.validation.js";
import * as userWarehouseRepo from "./user-warehouse.repository.js";
import type { AssignedWarehouse } from "./user-warehouse.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as settingsService from "#modules/settings/settings.service.js";
import { resolveInstantWindow } from "../../utils/filter-date.js";
import { generateTempPassword } from "../../utils/generate-password.js";
import { badRequest, conflict, forbidden, notFound } from "../../utils/http-error.js";
import { paginate } from "../../utils/pagination.js";
import { hashPassword } from "../../utils/password.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import { sendTemplatedEmail } from "#modules/email/email.service.js";
import { getCloudinaryCreds, getEmployeeIdPrefix, getRegionalSettings } from "#modules/settings/settings.service.js";
import { formatDate } from "#modules/document/document.formatter.js";
import { EXPORT_MAX, EXPORT_PAGING, toCsv } from "../../utils/csv.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";

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

/**
 * One row of the STAFF DIRECTORY — who someone is and what they can do, and nothing else.
 *
 * Deliberately narrower than PublicUser, for the same reason exportUsersCsv is: a directory is not
 * a personnel file. The list endpoint is read by anyone holding `users.view`, so it must not carry
 * the record's personal data — date of birth, gender, home address, `notes` and phone are all
 * absent, and so is every credential/signature field.
 *
 * The export already applied that rule and the JSON list beside it did not, which is the whole
 * point of this shape. The FULL record still lives on the single-user read (GET /users/:id), where
 * it is fetched deliberately rather than handed out a page at a time.
 *
 * Every field here is one the staff-list UI actually renders. Adding to it is a decision about who
 * may see what, not a convenience — widen the single-user read instead.
 */
export interface DirectoryUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  profileImageUrl: string | null;
  role: { id: string; key: string; name: string } | null;
  employeeId: string | null;
  createdAt: string;
}

function directoryUser(u: UserWithRole): DirectoryUser {
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    status: u.status,
    profileImageUrl: u.profileImageUrl,
    role: u.role ? { id: u.role.id, key: u.role.key, name: u.role.name } : null,
    employeeId: u.employeeId,
    createdAt: u.createdAt.toISOString(),
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

// A stored Date → the "YYYY-MM-DD" the validation helpers compare on.
const storedDateToIso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

// Resolve a date field's value AFTER the patch is applied: the submitted value
// when the patch carries one ("" meaning cleared), otherwise what's on record.
function effectiveDate(patched: string | undefined, stored: Date | null | undefined): string | null {
  if (typeof patched === "string") return patched.trim() || null;
  return storedDateToIso(stored);
}

// The "joined before turning 16" rule across a PARTIAL update. The schema already
// catches a payload carrying both dates, but an edit that touches only one has to
// be checked against the half still in the database — otherwise you could set a
// valid-looking birth date that contradicts the joining date already stored.
function assertDatePairConsistent(input: UpdateUserInput, user: UserWithRole): void {
  const dob = effectiveDate(input.dateOfBirth, user.dateOfBirth);
  const joining = effectiveDate(input.dateOfJoining, user.dateOfJoining);
  if (!dob || !joining) return;
  if (joiningPrecedesMinAge(dob, joining)) throw badRequest(JOINING_BEFORE_MIN_AGE_MESSAGE);
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
async function uploadAvatar(image: string): Promise<CloudinaryImageAsset> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your credentials in Settings → Integrations to upload profile images.",
    );
  }
  return uploadToCloudinary(image, crypto.randomUUID(), creds, "senthra/users");
}

/**
 * Apply an avatar change, and release the picture it replaces.
 *
 * An avatar's public id is a fresh randomUUID, so a new upload does NOT overwrite the old asset — it
 * simply stops being referenced. Changing your picture is an ordinary success path, so before this the
 * app leaked one file every time anyone did it, forever.
 *
 * Released AFTER the row is written, and only when the id actually changes; `releaseAsset` never throws,
 * so a storage failure cannot fail the profile update. Its reference count reads the attachment tables
 * and finds nothing, which is the correct answer here: an avatar is referenced by exactly one user row,
 * and randomUUID means no other record can ever name the same asset.
 */
async function applyAvatarChange(
  data: Prisma.UserUpdateInput,
  current: { profileImagePublicId: string | null; profileImageResourceType: string | null },
  input: { removeProfileImage?: boolean; profileImage?: string },
): Promise<attachmentService.AssetRef | null> {
  const previous: attachmentService.AssetRef = {
    publicId: current.profileImagePublicId,
    resourceType: current.profileImageResourceType,
  };
  if (input.removeProfileImage) {
    data.profileImageUrl = null;
    data.profileImagePublicId = null;
    data.profileImageResourceType = null;
    return previous.publicId ? previous : null;
  }
  if (!input.profileImage) return null;
  const asset = await uploadAvatar(input.profileImage);
  data.profileImageUrl = asset.url;
  data.profileImagePublicId = asset.publicId;
  data.profileImageResourceType = asset.resourceType;
  // Only when the id actually moved. A legacy row has no stored id and is skipped — the same
  // conservative direction the attachment path takes.
  return previous.publicId && previous.publicId !== asset.publicId ? previous : null;
}

// --- User signature (self-service; printed on issued documents) ------------------------------

/**
 * The ONE place a signature asset is named. Both the upload and the removal derive from these, so
 * the id used to store the file and the id used to destroy it cannot drift apart.
 *
 * Deterministic on purpose (one signature per user, never a gallery): re-uploading overwrites the
 * same asset in place, so a REPLACEMENT leaks nothing and needs no stored identity — which is why
 * there is no `signaturePublicId` column, unlike the avatar.
 */
const SIGNATURE_FOLDER = "senthra/signatures";
const signatureAssetName = (userId: string): string => `signature-${userId}`;

/**
 * The Cloudinary identity of a user's signature, rebuilt from the same constants the upload used.
 *
 * NOT the URL-parsing guess `releaseAsset` warns about — nothing is read back out of a delivery URL
 * (where versions, transformations and folders all live in one string). This reconstructs the exact
 * `folder` + `public_id` pair that was passed to the upload, both of which are the literals directly
 * above. `resource_type` is `image` because `uploadToCloudinary` is image-only.
 */
function signatureAssetRef(userId: string): attachmentService.AssetRef {
  return {
    publicId: `${SIGNATURE_FOLDER}/${signatureAssetName(userId)}`,
    resourceType: "image",
  };
}

// Reuses the same credential resolution as branding/avatar.
async function uploadSignatureImage(image: string, userId: string): Promise<string> {
  const creds = await getCloudinaryCreds();
  if (!creds) {
    throw badRequest(
      "Cloudinary isn't configured. Add your credentials in Settings → Integrations to upload a signature.",
    );
  }
  return (await uploadToCloudinary(image, signatureAssetName(userId), creds, SIGNATURE_FOLDER)).url;
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

// Resolve a batch of actor emails to display names, keyed by the LOWERCASED email. Documents record
// who raised / approved / issued them as an email, and a raw login is not a name the reader can ask
// for. Batched on purpose: a PO PDF is rendered on every send, download and archive, and it names
// three people — one query, not three. An email with no account (or an account with no name) is
// simply absent from the map, which is the caller's signal to fall back to the email itself.
export interface DocumentPerson {
  name: string;
  /** Designation ("Procurement Manager"), NOT the permission role. Null when unset. */
  jobTitle: string | null;
}

export async function getDisplayNamesForEmails(
  emails: (string | null | undefined)[],
): Promise<Record<string, DocumentPerson>> {
  const wanted = [...new Set(emails.map((e) => e?.trim().toLowerCase()).filter((e): e is string => Boolean(e)))];
  if (wanted.length === 0) return {};
  // BOTH identity stores, because a super admin is not a User — a purchase order raised by one
  // resolved to nothing here and printed a raw login instead of a person.
  const [users, admins] = await Promise.all([
    userRepo.findNamesByEmails(wanted),
    adminRepo.findNamesByEmails(wanted),
  ]);

  const staffName = (r: { firstName: string; lastName: string }) => `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();

  // Precedence, and it matters: an email should normally belong to exactly one identity (the
  // namespace guard in auth keeps admin/staff/customer disjoint), but legacy rows predate it. Where
  // two claim the same address, whoever holds it NOW answers for it:
  //
  //   1. live staff  — the richest identity, and the one with a job title
  //   2. admin       — always live; has a name and nothing else
  //   3. deleted staff — only when nothing live claims the email, so a leaver is still named on
  //                      their own archived orders
  //
  // A LIVE identity with no name on file deliberately resolves to nothing rather than falling
  // through to a deleted row: the caller then prints the email, which names nobody — honest — where
  // the deleted row would name the wrong person. That is exactly how a soft-deleted test account
  // came to sign a purchase order sent to a supplier.
  const claimed = new Set<string>();
  const out: Record<string, DocumentPerson> = {};
  const claim = (email: string, person: DocumentPerson | null) => {
    const key = email.toLowerCase();
    if (claimed.has(key)) return;
    claimed.add(key);
    if (person) out[key] = person;
  };

  for (const r of users) {
    if (r.deletedAt) continue;
    claim(r.email, staffName(r) ? { name: staffName(r), jobTitle: r.jobTitle?.trim() || null } : null);
  }
  for (const a of admins) {
    claim(a.email, a.name?.trim() ? { name: a.name.trim(), jobTitle: null } : null);
  }
  for (const r of users) {
    if (!r.deletedAt) continue;
    claim(r.email, staffName(r) ? { name: staffName(r), jobTitle: r.jobTitle?.trim() || null } : null);
  }
  return out;
}

export interface ListUsersParams {
  search?: string;
  status?: string;
  roleId?: string;
  /** Inclusive calendar days on when the account was ADDED (`createdAt`, an instant). */
  addedFrom?: string;
  addedTo?: string;
  page?: number;
  pageSize?: number;
  sort?: string; // newest (default) | oldest | name
  /** Internal only — see EXPORT_PAGING. Controllers never read this from the query string. */
  maxPageSize?: number;
}

export interface PagedUsers {
  users: DirectoryUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The filtered, ordered, paged staff rows — the ONE query behind both the list endpoint and the
 * CSV export, so the two can never drift on filtering, ordering or the page clamp.
 *
 * Returns the RAW rows. Each caller projects them itself: the endpoint to `directoryUser`, the
 * export to its own column set. That is what lets the endpoint narrow without the export losing
 * the employment columns it has always carried.
 */
async function listUserRows(params: ListUsersParams = {}): Promise<{
  rows: UserWithRole[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const filters = {
    search: params.search,
    status: params.status,
    roleId: params.roleId,
    // createdAt is an INSTANT, so "added on the 3rd" is the COMPANY's 3rd — the same day boundary
    // every other "today" in this app resolves against, never the browser's.
    addedWindow: await resolveInstantWindow(params.addedFrom, params.addedTo, () => settingsService.getCompanyTimezone()),
  };
  const total = await userRepo.count(filters);
  // Clamp the requested page so an out-of-range page returns the last page.
  const { page, pageSize, totalPages, skip } = paginate(params.page, params.pageSize, total, params.maxPageSize);
  const rows = await userRepo.findMany(filters, skip, pageSize, params.sort);
  return { rows, total, page, pageSize, totalPages };
}

/**
 * The staff DIRECTORY page. Returns `DirectoryUser`, not `PublicUser` — see that type for why.
 *
 * The list also omits per-user warehouse assignments (avoids an N+1); the single-user reads
 * (get/create/update) populate them.
 */
export async function listUsers(params: ListUsersParams = {}): Promise<PagedUsers> {
  const { rows, total, page, pageSize, totalPages } = await listUserRows(params);
  return { users: rows.map((u) => directoryUser(u)), total, page, pageSize, totalPages };
}

/**
 * The SAME filtered staff list as a CSV, minus paging.
 *
 * Deliberately narrow. This is the export most likely to be forwarded to HR or an auditor, so it
 * carries who someone IS and what they can do — never the personal data the record also holds:
 * date of birth, gender, home address and `notes` are all absent, and so is anything about their
 * credentials. A staff list is not a personnel file.
 */
export async function exportUsersCsv(
  params: ListUsersParams = {},
  actor?: AuditActor,
): Promise<{ csv: string; capped: boolean }> {
  // EXPORT_PAGING, not a bare pageSize: `paginate` clamps anything a client could ask for to 100,
  // so without its maxPageSize every export silently stopped at 100 rows AND reported itself
  // complete (capped was measured on the same clamped length). See utils/csv.
  //
  // Reads the RAW rows rather than the list endpoint's DTO: the directory shape deliberately drops
  // phone / job title / department / joining date, and those columns have always been in this file.
  // Same query, same filters, same order — only the projection differs.
  const { rows: matched } = await listUserRows({ ...params, ...EXPORT_PAGING });
  const rows = matched.slice(0, EXPORT_MAX);

  const regional = await getRegionalSettings();
  const csv = toCsv(
    ["Employee ID", "First Name", "Last Name", "Email", "Phone", "Role", "Job Title", "Department", "Status", `Joined (${regional.timezone})`, `Added (${regional.timezone})`],
    rows.map((u) => [
      u.employeeId,
      u.firstName,
      u.lastName,
      u.email,
      u.phone,
      u.role?.name,
      u.jobTitle,
      u.department,
      u.status,
      formatDate(u.dateOfJoining, regional.dateFormat, regional.timezone),
      formatDate(u.createdAt, regional.dateFormat, regional.timezone),
    ]),
  );

  audit.record({ actor, action: "user.exported", targetType: "user", targetLabel: `${rows.length} rows` });
  return { csv, capped: matched.length > EXPORT_MAX };
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
  const [passwordHash, avatar, employeeIdPrefix] = await Promise.all([
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
    profileImageUrl: avatar?.url ?? null,
    profileImagePublicId: avatar?.publicId ?? null,
    profileImageResourceType: avatar?.resourceType ?? null,
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

  // Reviving overwrites the record, avatar included — so the picture the revived row USED to point at
  // stops being referenced exactly as it does on an ordinary edit, and has to be released the same way.
  // Only when the new write actually supplies a different asset: reviving without a photo keeps the old
  // one, and releasing it then would delete a live avatar.
  const replacedAvatar: attachmentService.AssetRef | null =
    existing?.profileImagePublicId && avatar && existing.profileImagePublicId !== avatar.publicId
      ? { publicId: existing.profileImagePublicId, resourceType: existing.profileImageResourceType }
      : null;

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

  // After the row is written. Never throws — a storage failure cannot fail the account creation.
  if (replacedAvatar) await attachmentService.releaseAsset(replacedAvatar, `user ${created.email}`);

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
  // HIRED equipment, checked separately and refused with its own message — because the consequence is
  // different in kind. Stranded van stock is our own asset sitting in a van; stranded hired kit belongs
  // to a provider who keeps billing for it and will charge us for the loss, and unlike van stock it
  // cannot be transferred to another engineer to clear. There is exactly one way out: scan it back.
  const hires = await rentalCustodyRepo.countHeldRentalsForEngineer(userId);
  if (hires > 0) {
    throw conflict(
      "This staff member still holds rental items. Hired equipment has to be scanned back to the warehouse before deactivating them — it belongs to the provider and can't be transferred to another engineer.",
    );
  }
}

// Moving a stock-holding engineer OFF a field-operations role strands their van stock in exactly the
// way deactivating them would: every route that could move it back (engineer transfer, van-stock
// return, job issue) refuses a role that can't hold stock. Same hazard, same block — this closes the
// reassignment path, which previously only checked escalation. Role changes that KEEP the capability
// (field role → field role) are unaffected.
async function assertRoleChangeKeepsStockHoldable(
  user: { id: string; role?: { canHoldStock?: boolean | null } | null },
  nextRole: { canHoldStock?: boolean | null } | null,
): Promise<void> {
  if (user.role?.canHoldStock !== true) return; // wasn't a field role — nothing to strand
  if (nextRole?.canHoldStock === true) return; // still a field role
  const held = await engineerStockRepo.countEngineerHeldStock(user.id);
  if (held > 0) {
    throw conflict(
      "This staff member still holds field stock. Return or transfer their stock before moving them off a field-operations role.",
    );
  }
  // Same hazard as deactivating: every route that could move a hire back (the job return scan) refuses
  // a role that can't hold stock, so moving them off strands the provider's equipment.
  const hires = await rentalCustodyRepo.countHeldRentalsForEngineer(user.id);
  if (hires > 0) {
    throw conflict(
      "This staff member still holds rental items. Scan the hired equipment back to the warehouse before moving them off a field-operations role.",
    );
  }
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor?: AuditActor,
): Promise<PublicUser> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");
  assertDatePairConsistent(input, user);

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
      // Losing the role entirely also loses the stock-holding capability.
      await assertRoleChangeKeepsStockHoldable(user, null);
      data.role = { disconnect: true };
      effectiveRole = null;
    } else {
      const role = await roleRepo.findById(input.roleId);
      if (!role) throw badRequest("Selected role does not exist.");
      assertCanAssignRole(role.permissions, actor);
      await assertRoleChangeKeepsStockHoldable(user, role);
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

  const staleAvatar = await applyAvatarChange(data, user, input);

  const updated = await userRepo.update(id, data);
  if (staleAvatar) await attachmentService.releaseAsset(staleAvatar, `user ${updated.email}`);
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
  // Deactivating/suspending already locks the account out at requireAuth. Clear the artefacts too —
  // but ONLY on the way out of "active": reinstating a user must not wipe anything, and the mobile
  // app re-registers its device on the next signed-in launch anyway.
  if (next !== "active") {
    await revokeSignInArtifacts(id, `user.status.${next}`);
  }
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

/**
 * Clear the sign-in artefacts of an account that can no longer authenticate.
 *
 * NOT an access-control change — `requireAuth` already refuses a soft-deleted user (findById
 * excludes them) and any status other than "active", so the account is locked out with or without
 * this. What it removes is what those artefacts still HOLD once they can never be used again: the
 * session row's IP address and user-agent, and the device tokens sitting in the push fan-out set
 * until FCM eventually reports them dead.
 *
 * Best-effort, exactly like the audit write beside it. The state change is the authoritative act and
 * has already been committed by the time this runs; making the caller fail because a cleanup failed
 * would report a delete/suspend that actually went through as an error, and the retry would then hit
 * "User not found". A failure is logged and the account stays locked out either way.
 */
async function revokeSignInArtifacts(userId: string, context: string): Promise<void> {
  try {
    await sessionService.endAll(userId, "user");
  } catch (e) {
    console.error(`[user] session cleanup failed for ${userId} (${context}):`, e instanceof Error ? e.message : e);
  }
  try {
    await notificationService.clearDevicesForUser(userId);
  } catch (e) {
    console.error(`[user] device-token cleanup failed for ${userId} (${context}):`, e instanceof Error ? e.message : e);
  }
}

export async function deleteUser(id: string, actor?: AuditActor): Promise<void> {
  const user = await userRepo.findById(id);
  if (!user) throw notFound("User not found.");
  // Same guard as deactivate/suspend and the role-capability revoke: deleting a stock-holding
  // engineer strands their van stock just as thoroughly, because every route that could move it back
  // resolves the holder and refuses a deleted one. This was the one path into that state that had no
  // check, which also made the role-capability guard bypassable (delete the holder, then revoke).
  await assertNotHoldingStock(id);
  await userRepo.softDelete(id);
  // The account can no longer authenticate; drop what its sessions and devices still hold.
  await revokeSignInArtifacts(id, "user.deleted");
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
  const staleAvatar = await applyAvatarChange(data, user, input);

  const updated = await userRepo.update(user.id, data);
  if (staleAvatar) await attachmentService.releaseAsset(staleAvatar, `user ${updated.email}`);
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

  // Whether there was actually a file to release. Read BEFORE the clear, since the clear is what
  // destroys the evidence — and it keeps "remove when nothing is set" a pure database no-op rather
  // than a pointless call to Cloudinary.
  const hadSignature = Boolean(user.signatureUrl);

  const updated = await userRepo.update(user.id, {
    signatureUrl: null,
    signatureName: null,
    signatureMimeType: null,
    signatureFileSize: null,
    signatureUploadedAt: null,
    signatureUpdatedAt: null,
  });

  /*
   * Destroy the stored image, now that nothing references it.
   *
   * Before this, "Remove signature" cleared the six columns and left the file live at its public
   * delivery URL forever — the user was told their signature was gone while it was still fetchable
   * by anyone holding the URL, which for a signature is a deterministic id built from a user id the
   * API hands out.
   *
   * AFTER the update has committed, never before: releasing first would leave a live `signatureUrl`
   * pointing at a destroyed asset if the write then failed — a broken image on every issued PO PDF.
   * The reverse can only ever leak an orphan file. That is the ordering rule attachment.service
   * documents, and it is why this is not folded into the update above.
   *
   * `releaseAsset` never throws, so a Cloudinary outage cannot fail a removal that has already
   * succeeded; it logs the asset instead. Its reference count reads the attachment tables and finds
   * nothing, which is the right answer here for the same reason it is for an avatar: a signature is
   * referenced by exactly one user row, and its id is derived from that user's own id, so no other
   * record can name it.
   */
  if (hadSignature) {
    await attachmentService.releaseAsset(signatureAssetRef(user.id), `user ${updated.email} signature`);
  }

  audit.record({
    actor,
    action: "user.signature_removed",
    targetType: "user",
    targetId: user.id,
    targetLabel: updated.email,
  });
  return publicUser(updated);
}
